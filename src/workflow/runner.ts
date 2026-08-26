import { execFileSync, spawn } from "node:child_process";
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

export interface RunWorkflowOptions {
  entry: string;
  cwd: string;
  input?: unknown;
  facts?: WorkflowFacts;
  policy?: WorkflowCapabilityPolicy;
  timeoutMs: number;
}

/** Execute a source-checked workflow with brokered filesystem/process capabilities. */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const entry = resolveEntry(options.entry);
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) return rejected(checked.reason ?? "workflow source rejected");

  const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
  const cwd = resolve(options.cwd);
  const broker = new LocalCapabilityBroker({
    workspaceRoot: cwd,
    host: options.facts?.host,
    project: options.facts?.project,
    policy: options.policy,
  });
  const child = spawn(process.execPath, ["run", worker, entry, cwd], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  const protocolNoise: Buffer[] = [];
  const stderr: Buffer[] = [];
  let protocolBuffer = "";
  let finalEnvelope: WorkerEnvelope | null = null;
  let timedOut = false;
  let requestChain = Promise.resolve();

  child.stdout.on("data", (chunk: Buffer) => {
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
        requestChain = requestChain.then(async () => {
          const response = await broker.handle(value);
          if (child.stdin.writable) child.stdin.write(`${JSON.stringify(response)}\n`);
        });
      } else if (isWorkerEnvelope(value)) {
        finalEnvelope = value;
      } else {
        protocolNoise.push(Buffer.from(`${line}\n`, "utf8"));
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.write(`${JSON.stringify({
    input: options.input ?? null,
    facts: options.facts ?? {},
    policy: options.policy,
  } satisfies WorkerPayload)}\n`);

  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child.pid);
  }, options.timeoutMs);
  const exit = await new Promise<{ code: number | null; signal: string | null; error: Error | null }>((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolveExit({ code, signal, error: null }));
  });
  const completedEnvelope = finalEnvelope as WorkerEnvelope | null;
  const out = Buffer.concat(protocolNoise).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  const events = completedEnvelope?.events ?? [];
  if (timedOut) {
    return {
      status: "timeout",
      exitCode: null,
      result: null,
      stdout: out,
      stderr: err,
      failure: `workflow exceeded timeout ${options.timeoutMs}ms`,
      events,
    };
  }
  if (exit.error !== null) {
    return {
      status: "failed",
      exitCode: null,
      result: null,
      stdout: out,
      stderr: err,
      failure: exit.error.message,
      events,
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
  };
}

function terminateTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // The process may have exited between timeout and cleanup.
  }
}

export function readJsonInput(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}
