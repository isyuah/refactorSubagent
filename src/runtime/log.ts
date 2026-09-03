import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import pino from "pino";
import type { Logger as PinoLogger } from "pino";

/**
 * Level-gated observability for long-running agent/e2e runs.
 *
 * One pino instance writes line-oriented JSON to `run.jsonl` (plus a human
 * `state.json` snapshot and an `artifacts/` tree). Level thresholds decide
 * how much AI-session detail is persisted (see the session event mapping in
 * driver.ts):
 *
 *   trace — full session transcript, including tool_result payloads
 *   debug — session skeleton: tool names, durations, result status (no payloads)
 *   info  — host-level phase/decision/error events only (no session internals)
 *
 * Default level is `info`; set RFR_LOG_LEVEL=trace|debug|info|warn|error to
 * raise verbosity. Emitted lines follow pino ({level,time,msg,...}) plus
 * host-owned fields (phase, event, details) for human/scripted readers.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Resolve effective log level from RFR_LOG_LEVEL (default info). */
export function resolveLogLevel(env: Record<string, string | undefined> = process.env): LogLevel {
  const raw = env["RFR_LOG_LEVEL"];
  if (raw === undefined || raw === "") return "info";
  const normalized = raw.trim().toLowerCase();
  if (isLogLevel(normalized)) return normalized;
  throw new Error(
    `invalid RFR_LOG_LEVEL '${raw}'; expected one of ${LOG_LEVELS.join(", ")}`,
  );
}

export interface Logger {
  /** Effective threshold; callers use it to decide payload verbosity. */
  readonly level: LogLevel;
  trace(message: string, details?: Record<string, unknown>): void;
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface E2EState {
  readonly kind: "e2e-state";
  readonly version: 2;
  readonly run_id: string;
  readonly status: string;
  readonly phase: string;
  readonly started_at: string;
  readonly updated_at: string;
  readonly elapsed_ms: number;
  readonly last_event: string;
}

/**
 * A run-scoped pino logger writing durable JSONL plus a state snapshot.
 *
 * Keeps the historical E2ELogger surface (phase/artifact/logFile/output/
 * command/startHeartbeat/finish) so existing call sites keep working while
 * the backing store moves to pino.
 */
export class E2ELogger implements Logger {
  readonly runDir: string;
  readonly artifactsDir: string;
  readonly logsDir: string;
  readonly level: LogLevel;
  private readonly pino: PinoLogger;
  private readonly statePath: string;
  private readonly startedAt = Date.now();
  private status = "running";
  private phaseName = "INIT";
  private lastEvent = "run started";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(root: string, runId: string, level: LogLevel = resolveLogLevel()) {
    this.level = level;
    this.runDir = join(root, runId);
    this.artifactsDir = join(this.runDir, "artifacts");
    this.logsDir = join(this.runDir, "logs");
    this.statePath = join(this.runDir, "state.json");
    mkdirSync(this.artifactsDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    const destination = pino.destination({ dest: join(this.runDir, "run.jsonl"), sync: true });
    this.pino = pino(
      {
        level,
        base: { run_id: runId },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
      },
      destination,
    );
    this.persistState();
  }

  phase(phase: string, message = `${phase} started`): void {
    this.phaseName = phase;
    this.emit("info", "phase", message);
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.emit("info", "progress", message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.emit("warn", "progress", message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.emit("error", "error", message, details);
  }

  trace(message: string, details?: Record<string, unknown>): void {
    this.emit("trace", "progress", message, details);
  }

  debug(message: string, details?: Record<string, unknown>): void {
    this.emit("debug", "progress", message, details);
  }

  command(message: string, details?: Record<string, unknown>): void {
    this.emit("info", "command", message, details);
  }

  output(stream: "stdout" | "stderr", chunk: string): void {
    const text = chunk.replace(/\r\n/g, "\n");
    if (text.length === 0) return;
    this.emit(stream === "stderr" ? "warn" : "info", "output", text, { stream });
  }

  artifact(name: string, value: unknown): string {
    const path = join(this.artifactsDir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    this.emit("info", "artifact", `saved artifact ${name}`, { path });
    return path;
  }

  logFile(name: string, content: string): string {
    const path = join(this.logsDir, name);
    writeFileSync(path, content, "utf8");
    return path;
  }

  appendLogFile(name: string, content: string): string {
    const path = join(this.logsDir, name);
    appendFileSync(path, content, "utf8");
    return path;
  }

  startHeartbeat(intervalMs = 10_000): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.emit("info", "heartbeat", `${this.phaseName} still running`);
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  finish(status: string, message: string): void {
    this.stopHeartbeat();
    this.status = status;
    const level: LogLevel = status === "aborted" || status === "rejected" ? "error" : "info";
    this.emit(level, "decision", message);
  }

  close(): void {
    this.stopHeartbeat();
  }

  private emit(
    level: LogLevel,
    event: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const obj = { event, phase: this.phaseName, ...details };
    switch (level) {
      case "trace": this.pino.trace(obj, message); break;
      case "debug": this.pino.debug(obj, message); break;
      case "info": this.pino.info(obj, message); break;
      case "warn": this.pino.warn(obj, message); break;
      case "error": this.pino.error(obj, message); break;
      case "fatal": this.pino.fatal(obj, message); break;
    }
    this.lastEvent = message;
    this.persistState();
  }

  private persistState(): void {
    const state: E2EState = {
      kind: "e2e-state",
      version: 2,
      run_id: basename(this.runDir),
      status: this.status,
      phase: this.phaseName,
      started_at: new Date(this.startedAt).toISOString(),
      updated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startedAt,
      last_event: this.lastEvent,
    };
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
