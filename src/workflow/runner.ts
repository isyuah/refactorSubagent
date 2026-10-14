import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { WorkflowCapabilityPolicy, WorkflowFacts, WorkflowRunResult } from "./types.js";
import {
  isCapabilityRequest,
  isWorkerEnvelope,
  type WorkerEnvelope,
  type WorkerPayload,
} from "./capability-protocol.js";
import { checkWorkflowSource } from "./source-policy.js";
import { LocalCapabilityBroker } from "./capabilities.js";
import { spawnOwnedProcess } from "../../shared/owned-process.js";

export interface RunWorkflowOptions {
  entry: string;
  cwd: string;
  input?: unknown;
  facts?: WorkflowFacts;
  policy?: WorkflowCapabilityPolicy;
  /** Host deadline for the whole workflow run. undefined = no deadline. */
  timeoutMs?: number;
  /** Caller cancellation also closes broker-owned tools and readiness probes. */
  signal?: AbortSignal;
}

/** Execute a source-checked workflow with brokered filesystem/process capabilities. */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const entry = resolveEntry(options.entry);
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) return rejected(checked.reason ?? "workflow source rejected");
  if (options.signal?.aborted) return { ...rejected("workflow cancelled"), status: "failed" };

  const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
  const cwd = resolve(options.cwd);
  const broker = new LocalCapabilityBroker({
    workspaceRoot: cwd,
    host: options.facts?.host,
    project: options.facts?.project,
    policy: options.policy,
  });
  const owned = spawnOwnedProcess({
    program: process.execPath,
    args: ["run", worker, entry, cwd],
    cwd,
    env: process.env,
  });
  const child = owned.child;

  const protocolNoise: Buffer[] = [];
  const stderr: Buffer[] = [];
  let protocolBuffer = "";
  let finalEnvelope: WorkerEnvelope | null = null;
  let stopped: "timeout" | "cancelled" | "transport" | null = null;
  let transportError: string | null = null;
  let cleanupError: string | null = null;
  const requests = new Set<Promise<void>>();
  const stop = (reason: typeof stopped): void => {
    stopped ??= reason;
    void broker.close().catch((error) => { cleanupError = errorMessage(error); });
    void owned.stop();
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    protocolBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = protocolBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = protocolBuffer.slice(0, newline).trim();
      protocolBuffer = protocolBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        protocolNoise.push(Buffer.from(`${line}\n`, "utf8"));
        continue;
      }
      if (isCapabilityRequest(value)) {
        // Requests are correlated by id. A long wait/run must not block a stop
        // for the same process; synchronous mutations still run in arrival order.
        const task = (async () => {
          const response = await broker.handle(value);
          if (child.stdin?.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(response)}\n`);
        })().catch((error) => {
          transportError = errorMessage(error);
          stop("transport");
        });
        requests.add(task);
        void task.then(() => requests.delete(task));
      } else if (isWorkerEnvelope(value)) {
        finalEnvelope = value;
      } else {
        protocolNoise.push(Buffer.from(`${line}\n`, "utf8"));
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
  try {
    child.stdin!.write(`${JSON.stringify({
      input: options.input ?? null,
      facts: options.facts ?? {},
      policy: options.policy,
    } satisfies WorkerPayload)}\n`);
  } catch (error) {
    transportError = errorMessage(error);
    stop("transport");
  }

  const timer = options.timeoutMs === undefined
    ? null
    : setTimeout(() => {
        stop("timeout");
      }, options.timeoutMs);
  const cancelled = () => stop("cancelled");
  options.signal?.addEventListener("abort", cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const exit = await owned.exited;
  if (timer !== null) clearTimeout(timer);
  options.signal?.removeEventListener("abort", cancelled);
  try { await broker.close(); } catch (error) { cleanupError = errorMessage(error); }
  await Promise.all(requests);
  const completedEnvelope = finalEnvelope as WorkerEnvelope | null;
  const out = Buffer.concat(protocolNoise).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  const events = broker.getEvents();
  const expectations = completedEnvelope?.expectations ?? [];
  if (stopped === "timeout") {
    return {
      status: "timeout",
      exitCode: null,
      result: null,
      stdout: out,
      stderr: err,
      failure: [`workflow exceeded timeout ${options.timeoutMs}ms`, cleanupError, exit.error?.message]
        .filter((message) => message != null).join("; "),
      events,
      plan: broker.getPlan(),
      expectations,
    };
  }
  if (stopped === "cancelled" || transportError !== null || cleanupError !== null || exit.error !== null) {
    return {
      status: "failed",
      exitCode: null,
      result: null,
      stdout: out,
      stderr: err,
      failure: stopped === "cancelled"
        ? ["workflow cancelled", cleanupError, transportError, exit.error?.message]
          .filter((message) => message != null).join("; ")
        : [cleanupError, transportError, exit.error?.message]
          .filter((message) => message != null).join("; "),
      events,
      plan: broker.getPlan(),
      expectations,
    };
  }
  if (exit.code !== 0 || completedEnvelope === null || !completedEnvelope.ok) {
    return {
      status: "failed",
      exitCode: exit.code,
      result: completedEnvelope?.ok === true ? completedEnvelope.result : null,
      stdout: out,
      stderr: err,
      failure: completedEnvelope?.ok === false
        ? completedEnvelope.error
        : `workflow exited with code ${String(exit.code)}${exit.signal === null ? "" : ` (${exit.signal})`}`,
      events,
      plan: broker.getPlan(),
      expectations,
    };
  }

  return {
    status: "pass",
    exitCode: exit.code,
    result: completedEnvelope.result,
    stdout: out,
    stderr: err,
    failure: null,
    events,
    plan: broker.getPlan(),
    expectations,
  };
}

function resolveEntry(entry: string): string {
  return isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
}

function rejected(reason: string): WorkflowRunResult {
  return {
    status: "rejected",
    exitCode: null,
    result: null,
    stdout: "",
    stderr: "",
    failure: reason,
    events: [],
    plan: null,
    expectations: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readJsonInput(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}
