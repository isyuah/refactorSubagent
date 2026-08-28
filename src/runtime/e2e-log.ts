import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type E2EStatus = "running" | "accepted" | "rejected" | "aborted";

export interface E2ELogEvent {
  readonly ts: string;
  readonly elapsed_ms: number;
  readonly phase: string;
  readonly event: "phase" | "progress" | "command" | "output" | "heartbeat" | "artifact" | "error" | "decision";
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface E2EState {
  readonly kind: "e2e-state";
  readonly version: 1;
  readonly run_id: string;
  readonly status: E2EStatus;
  readonly phase: string;
  readonly started_at: string;
  readonly updated_at: string;
  readonly elapsed_ms: number;
  readonly last_event: string;
}

/** Durable, line-oriented observability for long-running end-to-end runs. */
export class E2ELogger {
  readonly runDir: string;
  readonly artifactsDir: string;
  readonly logsDir: string;
  private readonly startedAt = Date.now();
  private readonly startedIso = new Date().toISOString();
  private status: E2EStatus = "running";
  private phaseName = "INIT";
  private lastEvent = "run started";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(root: string, runId: string) {
    this.runDir = join(root, runId);
    this.artifactsDir = join(this.runDir, "artifacts");
    this.logsDir = join(this.runDir, "logs");
    mkdirSync(this.artifactsDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    this.persistState();
  }

  phase(phase: string, message = `${phase} started`): void {
    this.phaseName = phase;
    this.record("phase", message);
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.record("progress", message, "info", details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.record("progress", message, "warn", details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.record("error", message, "error", details);
  }

  command(message: string, details?: Record<string, unknown>): void {
    this.record("command", message, "info", details);
  }

  output(stream: "stdout" | "stderr", chunk: string): void {
    const text = chunk.replace(/\r\n/g, "\n");
    if (text.length === 0) return;
    this.record("output", text, stream === "stderr" ? "warn" : "info", { stream });
  }

  artifact(name: string, value: unknown): string {
    const path = join(this.artifactsDir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    this.record("artifact", `saved artifact ${name}`, "info", { path });
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
      this.record("heartbeat", `${this.phaseName} still running`, "info");
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  finish(status: Exclude<E2EStatus, "running">, message: string): void {
    this.stopHeartbeat();
    this.status = status;
    this.record("decision", message, status === "aborted" ? "error" : "info");
  }

  close(): void {
    this.stopHeartbeat();
  }

  private record(
    event: E2ELogEvent["event"],
    message: string,
    level: E2ELogEvent["level"] = "info",
    details?: Record<string, unknown>,
  ): void {
    const value: E2ELogEvent = {
      ts: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startedAt,
      phase: this.phaseName,
      event,
      level,
      message,
      ...(details === undefined ? {} : { details }),
    };
    appendFileSync(join(this.runDir, "run.jsonl"), `${JSON.stringify(value)}\n`, "utf8");
    this.lastEvent = message;
    this.persistState();
  }

  private persistState(): void {
    const state: E2EState = {
      kind: "e2e-state",
      version: 1,
      run_id: basename(this.runDir),
      status: this.status,
      phase: this.phaseName,
      started_at: this.startedIso,
      updated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startedAt,
      last_event: this.lastEvent,
    };
    writeFileSync(join(this.runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
