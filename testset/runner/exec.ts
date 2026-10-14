/** Bounded process execution shared by prepare, harness and rubric commands. */
import { spawnOwnedProcess } from "../../shared/owned-process.js";

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
  /** Fed to the child's stdin, then closed (the rubric scorer's prompt). */
  readonly stdin?: string;
  /** Run through the shell: needed for .cmd/.bat shims on Windows. */
  readonly shell?: boolean;
  readonly signal?: AbortSignal;
  /** Target CLI closes its own process groups when interrupted. */
  readonly cooperativeShutdown?: boolean;
  /** Called with every stdout/stderr chunk, for live progress details. */
  readonly onOutput?: (chunk: string) => void;
}

export async function exec(options: ExecOptions): Promise<ExecResult> {
  const startedAt = Date.now();
  if (options.signal?.aborted) {
    return { status: "error", exitCode: null, stdout: "", stderr: "", error: "process cancelled", elapsedMs: 0 };
  }
  const owned = spawnOwnedProcess({
    program: options.program, args: options.args, cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : "pipe", shell: options.shell,
    cooperativeShutdown: options.cooperativeShutdown,
  });
  const child = owned.child;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const bump = (chunk: Buffer, sink: string[]): void => {
    const text = chunk.toString("utf8");
    sink.push(text);
    options.onOutput?.(text);
  };
  child.stdout!.on("data", (chunk: Buffer) => bump(chunk, stdout));
  child.stderr!.on("data", (chunk: Buffer) => bump(chunk, stderr));
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);

  let stopped: "timeout" | "cancelled" | null = null;
  const timer = setTimeout(() => { stopped ??= "timeout"; void owned.stop(); }, options.timeoutMs);
  const cancelled = () => { stopped ??= "cancelled"; void owned.stop(); };
  options.signal?.addEventListener("abort", cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const exit = await owned.exited;
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", cancelled);
  return {
    status: stopped === "timeout" ? "timeout" : stopped === "cancelled" || exit.error !== null ? "error" : "exited",
    exitCode: stopped === null ? exit.code : null,
    stdout: stdout.join(""), stderr: stderr.join(""),
    error: stopped === "timeout"
      ? `timed out after ${options.timeoutMs} ms${exit.error === null ? "" : `; ${exit.error.message}`}`
      : stopped === "cancelled"
        ? ["process cancelled", exit.error?.message].filter((message) => message != null).join("; ")
        : exit.error?.message ?? null,
    elapsedMs: Date.now() - startedAt,
  };
}
