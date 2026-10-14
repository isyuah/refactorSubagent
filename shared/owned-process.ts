import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const TERM_GRACE_MS = 200;
const OWNER_GRACE_MS = 4000;
const EXIT_WAIT_MS = 2000;
const DRAIN_WAIT_MS = 1000;

const active = new Set<OwnedProcess>();
let exiting = false;
let exitHookInstalled = false;
let signalHooksInstalled = false;

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error: Error | null;
}

export interface OwnedProcessOptions {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: "pipe" | "ignore";
  readonly shell?: boolean;
  /** This target handles TERM by closing its own independently owned groups. */
  readonly cooperativeShutdown?: boolean;
}

export interface OwnedProcess {
  readonly child: ChildProcess;
  /** Resolves after the root exits, descendants are stopped and output drains. */
  readonly exited: Promise<ProcessExit>;
  /** Idempotent; shares the same bounded cleanup as natural exit. */
  stop(): Promise<ProcessExit>;
}

/** Own a process group (POSIX) or Job Object (Windows) for one operation. */
export function spawnOwnedProcess(options: OwnedProcessOptions): OwnedProcess {
  if (exiting) throw new Error("process owner is shutting down");
  const windows = process.platform === "win32";
  const child = windows
    ? spawn(process.execPath, [fileURLToPath(new URL("./windows-process-host.ts", import.meta.url))], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: [options.stdin ?? "pipe", "pipe", "pipe", "ipc"],
        windowsHide: true,
      })
      : spawn(options.program, [...options.args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: [options.stdin ?? "pipe", "pipe", "pipe"],
        detached: true,
        shell: options.shell === true,
      });

  const root = Promise.withResolvers<ProcessExit>();
  const closed = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<ProcessExit>();
  let stopping = false;
  let cleanup: Promise<void> | null = null;
  let streamError: Error | null = null;
  let reported = false;

  const finalize = (): void => {
    if (cleanup !== null) return;
    cleanup = Promise.resolve().then(async () => {
      let cleanupError: Error | null = null;
      try {
        await terminateOwnedTree(child, windows, options.cooperativeShutdown === true);
      } catch (error) {
        cleanupError = asError(error);
      }
      const exit = await bounded(root.promise, EXIT_WAIT_MS);
      if (exit === null) {
        cleanupError ??= new Error("process did not exit after forced termination");
        child.unref();
        if (child.connected) child.disconnect();
      }
      if (await bounded(closed.promise.then(() => true), DRAIN_WAIT_MS) === null) {
        cleanupError ??= new Error("process output pipes did not close after tree cleanup");
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finished.resolve({
        code: exit?.code ?? null,
        signal: exit?.signal ?? null,
        error: cleanupError ?? streamError ?? exit?.error ?? null,
      });
    }).catch((error) => {
      // Unexpected adapter failures must resolve the owner, rather than leak a
      // rejection from an event callback and leave callers waiting indefinitely.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finished.resolve({ code: null, signal: null, error: asError(error) });
    });
  };

  child.once("error", (error) => {
    root.resolve({ code: null, signal: null, error });
    finalize();
  });
  child.once("exit", (code, signal) => {
    if (windows && !stopping && !reported) {
      // Process exit and IPC delivery are separate events. Allow buffered
      // reports to arrive before diagnosing a missing helper result.
      child.once("close", () => root.resolve({
        code, signal,
        error: new Error(`Windows process host exited without a result (code ${String(code)})`),
      }));
    } else {
      root.resolve({ code, signal, error: null });
    }
    finalize();
  });
  child.once("close", () => closed.resolve());
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    // A tool may deliberately close stdin before its caller finishes writing.
    // EPIPE is then expected; the root's exit still decides the operation result.
    if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
    streamError = error;
    stopping = true;
    finalize();
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("error", (error) => {
      streamError = error;
      stopping = true;
      finalize();
    });
  }

  if (windows) {
    child.on("message", (report: unknown) => {
      if (!isExitReport(report)) return;
      reported = true;
      root.resolve({ code: report.code, signal: report.signal, error: report.error === null ? null : new Error(report.error) });
      finalize();
    });
    child.once("spawn", () => {
      child.send({ ...options, env: options.env ?? process.env }, (error: Error | null) => {
        if (error === null) return;
        root.resolve({ code: null, signal: null, error });
        stopping = true;
        finalize();
      });
    });
  }

  const owned: OwnedProcess = {
    child,
    exited: finished.promise,
    stop: () => {
      stopping = true;
      finalize();
      return finished.promise;
    },
  };
  active.add(owned);
  void owned.exited.then(() => active.delete(owned));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // `exit` cannot await. This also covers explicit process.exit() calls.
    process.once("exit", () => {
      exiting = true;
      for (const owned of active) {
        try { terminateImmediately(owned.child, windows); } catch (error) {
          console.error(`process cleanup on host exit failed: ${asError(error).message}`);
        }
      }
    });
  }
  return owned;
}

/** Opt-in CLI interruption handling; importing the library does not own signals. */
export function installOwnedProcessSignalHandlers(): void {
  if (signalHooksInstalled) return;
  signalHooksInstalled = true;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(signal, () => {
      if (exiting) return;
      exiting = true;
      process.exitCode = code;
      void Promise.all([...active].map((owned) => owned.stop())).then((results) => {
        for (const result of results) {
          if (result.error !== null) console.error(`process cleanup on ${signal} failed: ${result.error.message}`);
        }
        process.exit(code);
      });
    });
  }
}

function terminateImmediately(child: ChildProcess, windows: boolean): void {
  if (child.pid === undefined) return;
  if (windows) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  } else {
    signalGroup(child.pid, "SIGKILL");
  }
}

async function terminateOwnedTree(child: ChildProcess, windows: boolean, cooperative: boolean): Promise<void> {
  if (child.pid === undefined) return;
  if (windows) {
    // The helper enters its Job before spawning the target. Killing the helper
    // closes the last Job handle, including when the target has already exited.
    terminateImmediately(child, true);
    return;
  }
  if (!groupExists(child.pid)) return;
  signalGroup(child.pid, "SIGTERM");
  // A CLI owns groups outside its own group. Give its signal handler enough
  // time to stop them before killing the CLI; equal parent/child grace periods
  // otherwise race and can leave a TERM-resistant grandchild alive.
  const grace = cooperative && child.exitCode === null && child.signalCode === null
    ? OWNER_GRACE_MS
    : TERM_GRACE_MS;
  const until = Date.now() + grace;
  while (Date.now() < until && groupExists(child.pid)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (groupExists(child.pid)) signalGroup(child.pid, "SIGKILL");
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function bounded<T>(task: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([task, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally { clearTimeout(timer!); }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isExitReport(value: unknown): value is { code: number | null; signal: string | null; error: string | null } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record.code === null || typeof record.code === "number") &&
    (record.signal === null || typeof record.signal === "string") &&
    (record.error === null || typeof record.error === "string");
}
