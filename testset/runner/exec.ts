/** Process execution with per-job timeout and tree kill (Windows-safe). */
import { spawn, spawnSync } from "node:child_process";

export interface ExecResult {
  readonly status: "exited" | "timeout" | "error";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
  readonly elapsedMs: number;
}

export interface ExecOptions {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: Record<string, string>;
  /** fed to the child's stdin, then closed (the rubric scorer's prompt). */
  readonly stdin?: string;
  /** run through the shell: needed for .cmd/.bat shims on Windows. */
  readonly shell?: boolean;
  /** Called with every stdout/stderr chunk, for live progress details. */
  readonly onOutput?: (chunk: string) => void;
}

export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export async function exec(options: ExecOptions): Promise<ExecResult> {
  const startedAt = Date.now();
  const { promise, resolve } = Promise.withResolvers<ExecResult>();
  {
    const child = spawn(options.program, [...options.args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: options.shell === true,
      detached: process.platform !== "win32",
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, options.timeoutMs);

    const bump = (chunk: Buffer, sink: string[]): void => {
      const text = chunk.toString("utf8");
      sink.push(text);
      options.onOutput?.(text);
    };

    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.end(options.stdin);
    }

    // stdout/stderr are always piped (see stdio above), so they are non-null.
    const out = child.stdout!;
    const err = child.stderr!;
    out.on("data", (chunk: Buffer) => bump(chunk, stdout));
    err.on("data", (chunk: Buffer) => bump(chunk, stderr));

    const finish = (status: ExecResult["status"], exitCode: number | null, error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        exitCode,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        error,
        elapsedMs: Date.now() - startedAt,
      });
    };

    child.on("error", (error: Error) => finish("error", null, error.message));
    child.on("close", (code: number | null) => {
      if (timedOut) finish("timeout", code, `timed out after ${String(options.timeoutMs)} ms`);
      else finish("exited", code, null);
    });
  }
  return await promise;
}
