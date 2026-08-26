import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { WorkflowRunResult } from "./types.js";
import { checkWorkflowSource } from "./source-policy.js";

export interface RunWorkflowOptions {
  entry: string;
  cwd: string;
  input?: unknown;
  timeoutMs: number;
}

interface WorkerEnvelope {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Execute a source-checked workflow in an isolated Bun child process. */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const entry = resolveEntry(options.entry);
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) return rejected(checked.reason ?? "workflow source rejected");

  const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
  const cwd = resolve(options.cwd);
  const child = spawn(process.execPath, ["run", worker, entry, cwd], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(options.input ?? null));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child.pid);
  }, options.timeoutMs);

  const exitPromise = Promise.withResolvers<{ code: number | null; error: Error | null }>();
  child.once("error", (error) => exitPromise.resolve({ code: null, error }));
  child.once("close", (code) => exitPromise.resolve({ code, error: null }));
  const exit = await exitPromise.promise;

  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  if (timedOut) {
    return {
      status: "timeout",
      exitCode: null,
      result: null,
      stdout: out,
      stderr: err,
      failure: `workflow exceeded timeout ${options.timeoutMs}ms`,
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
    };
  }

  const envelope = parseEnvelope(out);
  if (exit.code !== 0 || envelope === null || !envelope.ok) {
    return {
      status: "failed",
      exitCode: exit.code,
      result: envelope?.result ?? null,
      stdout: out,
      stderr: err,
      failure: envelope?.error ?? `workflow exited with code ${String(exit.code)}`,
    };
  }

  return {
    status: "pass",
    exitCode: exit.code,
    result: envelope.result ?? null,
    stdout: out,
    stderr: err,
    failure: null,
  };
}

function resolveEntry(entry: string): string {
  return isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
}

function parseEnvelope(output: string): WorkerEnvelope | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isWorkerEnvelope(value) ? value : null;
  } catch {
    return null;
  }
}

function isWorkerEnvelope(value: unknown): value is WorkerEnvelope {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return false;
  if ("error" in record && record.error !== undefined && typeof record.error !== "string") return false;
  return true;
}

function rejected(reason: string): WorkflowRunResult {
  return {
    status: "rejected",
    exitCode: null,
    result: null,
    stdout: "",
    stderr: "",
    failure: reason,
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
