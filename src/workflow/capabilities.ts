import { createHash } from "node:crypto";
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { diffSnapshots, type Snapshot } from "../runtime/fs-snapshot.js";
import type { CapabilityRequest, CapabilityResponse } from "./capability-protocol.js";
import type {
  PlanStepDeclaration,
  ProcessHandle,
  ProcessResult,
  ProcessRunSpec,
  ProcessStartSpec,
  WorkflowCapabilityPolicy,
  WorkflowEvent,
  WorkflowFilesystem,
  WorkflowFsEffect,
  WorkflowFsSnapshot,
  WorkflowPlan,
  WorkflowPlanStep,
  WorkflowProcess,
  WorkflowReadyProbe,
  WorkflowTool,
  WorkflowTools,
} from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PROCESSES = 16;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const SYSTEM_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
]);

type ProcessExit = {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error: Error | null;
};

export interface CapabilityHost {
  readonly workspaceRoot: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  readonly policy?: WorkflowCapabilityPolicy;
}

export interface CapabilityBroker {
  handle(request: CapabilityRequest): Promise<CapabilityResponse>;
  close(): Promise<void>;
}

interface RunningProcess {
  readonly child: ChildProcess;
  readonly startedAt: number;
  readonly spec: ProcessStartSpec;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly exit: Promise<ProcessExit>;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  resultPromise: Promise<ProcessResult> | null;
  outputBytes: number;
  outputLimit: boolean;
  timedOut: boolean;
  stopRequested: boolean;
}

/**
 * Main-process capability broker. The worker can only reach this object through
 * validated JSON requests; all filesystem and process operations stay here.
 */
export class LocalCapabilityBroker implements CapabilityBroker {
  private readonly workspaceRoot: string;
  private readonly host: HostPreflight | undefined;
  private readonly policy: Required<WorkflowCapabilityPolicy>;
  private readonly running = new Map<string, RunningProcess>();
  private nextProcessId = 1;
  private closed = false;

  constructor(options: CapabilityHost) {
    const requestedRoot = resolve(options.workspaceRoot);
    this.workspaceRoot = realpathSync(requestedRoot);
    this.host = options.host;
    void options.project;
    this.policy = {
      readableGlobs: options.policy?.readableGlobs ?? ["**"],
      writableGlobs: options.policy?.writableGlobs ?? [],
      executableGlobs: options.policy?.executableGlobs ?? [],
      allowedTools: options.policy?.allowedTools ?? [],
      allowedEnv: options.policy?.allowedEnv ?? [],
      maxProcesses: options.policy?.maxProcesses ?? DEFAULT_MAX_PROCESSES,
      maxOutputBytes: options.policy?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxFileBytes: options.policy?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    };
  }

  async handle(request: CapabilityRequest): Promise<CapabilityResponse> {
    const started = Date.now();
    let value: unknown;
    let error: string | null = null;
    try {
      if (this.closed) throw new Error("capability broker is closed");
      value = await this.dispatch(request);
    } catch (cause) {
      error = errorMessage(cause);
    }
    const ok = error === null;
    const event: WorkflowEvent = {
      id: request.id,
      capability: request.capability,
      method: request.method,
      ok,
      durationMs: Date.now() - started,
      error,
    };
    return {
      type: "capability-response",
      id: request.id,
      ok,
      ...(ok ? { value } : { error: error ?? "capability request failed" }),
      event,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.running.keys()]) await this.stopProcess({ id });
  }

  private async dispatch(request: CapabilityRequest): Promise<unknown> {
    if (request.capability === "fs") return this.dispatchFs(request.method, request.args);
    if (request.capability === "process") return this.dispatchProcess(request.method, request.args);
    if (request.capability === "plan") return this.dispatchPlan(request.method, request.args);
    return this.dispatchTools(request.method, request.args);
  }

  private readonly planSteps = new Map<string, {
    readonly title: string;
    readonly description: string | undefined;
    status: "pending" | "running" | "completed" | "failed";
    readonly parent: string | null;
    readonly children: string[];
  }>();
  private readonly planRoots: string[] = [];

  private async dispatchPlan(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "declare":
        return this.planDeclare(planDeclarationsArg(args, 0));
      case "begin":
        return this.planMark("begin", stringArg(args, 0, "id"));
      case "complete":
        return this.planMark("complete", stringArg(args, 0, "id"));
      case "fail":
        return this.planMark("fail", stringArg(args, 0, "id"), optionalErrorArg(args, 1));
      default:
        throw new Error(`unsupported plan capability method: ${method}`);
    }
  }

  private planNextAutoId = 1;

  private planDeclare(declarations: readonly PlanStepDeclaration[]): string[] {
    const roots: string[] = [];
    const assign = (items: readonly PlanStepDeclaration[], parentId: string | null): string[] => {
      const local: string[] = [];
      for (const item of items) {
        if (typeof item.title !== "string" || item.title.length === 0) {
          throw new Error("plan step title must be a non-empty string");
        }
        // Caller-supplied ids are used verbatim; missing ids get a host
        // fallback (pN / parentId.N) so a workflow that skips ids still runs.
        const id = typeof item.id === "string" && item.id.length > 0
          ? item.id
          : parentId === null
            ? `p${String(this.planNextAutoId++)}`
            : `${parentId}.${String(local.length + 1)}`;
        if (this.planSteps.has(id)) {
          throw new Error(`plan step id '${id}' is not unique; ids must be globally unique`);
        }
        const children = item.children === undefined ? [] : assign(item.children, id);
        this.planSteps.set(id, {
          title: item.title,
          description: item.description,
          status: "pending",
          parent: parentId,
          children,
        });
        if (parentId === null) this.planRoots.push(id);
        local.push(id);
      }
      return local;
    };
    return assign(declarations, null);
  }

  private planMark(method: "begin" | "complete" | "fail", id: string, error?: string): void {
    const step = this.planSteps.get(id);
    if (step === undefined) {
      throw new Error(`plan step '${id}' was not declared; use the exact ids passed to plan.declare`);
    }
    if (method === "begin") {
      if (step.status !== "pending") throw new Error(`plan step ${id} is already ${step.status}`);
      step.status = "running";
      return;
    }
    if (method === "complete") {
      if (step.status !== "running") throw new Error(`plan step ${id} cannot complete while ${step.status}`);
      step.status = "completed";
      return;
    }
    // fail
    if (step.status === "completed") throw new Error(`plan step ${id} is already completed`);
    if (error !== undefined && error.length === 0) throw new Error("plan fail error must be a non-empty string");
    step.status = "failed";
  }

  /** Assemble the declared plan tree with final statuses. */
  getPlan(): WorkflowPlan {
    const build = (ids: readonly string[]): WorkflowPlanStep[] => ids.map((id) => {
      const step = this.planSteps.get(id);
      if (step === undefined) throw new Error(`plan step ${id} missing during assembly`);
      return {
        id,
        title: step.title,
        ...(step.description === undefined ? {} : { description: step.description }),
        status: step.status,
        ...(step.children.length === 0 ? {} : { children: build(step.children) }),
      };
    });
    return { steps: build(this.planRoots) };
  }

  private async dispatchFs(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "readFile":
        return this.readFile(stringArg(args, 0, "path"), encodingArg(args, 1));
      case "writeFile":
        this.writeFile(
          stringArg(args, 0, "path"),
          stringArg(args, 1, "content"),
          encodingArg(args, 2),
        );
        return null;
      case "mkdir":
        this.mkdir(stringArg(args, 0, "path"));
        return null;
      case "exists":
        return this.exists(stringArg(args, 0, "path"));
      case "readdir":
        return this.readdir(stringArg(args, 0, "path"));
      case "snapshot":
        return this.snapshot(optionalStringArg(args, 0));
      case "diff":
        return this.diff(stringArg(args, 0, "path"), snapshotArg(args, 1));
      default:
        throw new Error(`unsupported fs capability method: ${method}`);
    }
  }

  private async dispatchProcess(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "run":
        return this.runProcess(processRunSpecArg(args, 0));
      case "start":
        return this.startProcess(processStartSpecArg(args, 0));
      case "wait":
        return this.waitProcess(handleArg(args, 0), optionalPositiveInt(args, 1, "timeoutMs"));
      case "stop":
        return this.stopProcess(handleArg(args, 0));
      default:
        throw new Error(`unsupported process capability method: ${method}`);
    }
  }

  private async dispatchTools(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "available":
        return this.toolAvailable(stringArg(args, 0, "name"));
      case "list":
        if (args.length !== 0) throw new Error("tools.list does not accept arguments");
        return this.toolList();
      default:
        throw new Error(`unsupported tools capability method: ${method}`);
    }
  }

  private readFile(path: string, encoding: "utf8" | "base64"): string {
    const absolute = this.resolveReadable(path);
    const stats = statSync(absolute);
    if (!stats.isFile()) throw new Error(`capability path is not a regular file: ${path}`);
    if (stats.size > this.policy.maxFileBytes) {
      throw new Error(`file exceeds capability limit ${this.policy.maxFileBytes} bytes: ${path}`);
    }
    const bytes = readFileSync(absolute);
    return encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
  }

  private writeFile(path: string, content: string, encoding: "utf8" | "base64"): void {
    const absolute = this.resolveWritable(path);
    const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    if (bytes.length > this.policy.maxFileBytes) {
      throw new Error(`file exceeds capability limit ${this.policy.maxFileBytes} bytes: ${path}`);
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
  }

  private mkdir(path: string): void {
    mkdirSync(this.resolveWritable(path), { recursive: true });
  }

  private exists(path: string): boolean {
    return existsSync(this.resolveReadable(path));
  }

  private readdir(path: string): string[] {
    const absolute = this.resolveReadable(path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`capability path is not a directory: ${path}`);
    }
    return readdirSync(absolute);
  }

  private snapshot(path: string | undefined): WorkflowFsSnapshot {
    const root = this.resolveReadable(path ?? ".");
    if (!existsSync(root)) throw new Error(`snapshot path does not exist: ${path ?? "."}`);
    const stats = statSync(root);
    if (stats.isFile()) {
      return { [this.relativeWorkspace(root)]: hashFile(root) };
    }
    const local = snapshotDirectory(root);
    const prefix = this.relativeWorkspace(root);
    return Object.fromEntries([...local.entries()].map(([entry, hash]) => [
      prefix === "." ? entry : `${prefix}/${entry}`,
      hash,
    ]));
  }

  private diff(path: string, before: WorkflowFsSnapshot): WorkflowFsEffect[] {
    const root = this.resolveReadable(path);
    const prefix = this.relativeWorkspace(root);
    const beforeLocal: Snapshot = new Map();
    for (const [entry, hash] of Object.entries(before)) {
      if (prefix === ".") beforeLocal.set(entry, hash);
      else if (entry.startsWith(`${prefix}/`)) beforeLocal.set(entry.slice(prefix.length + 1), hash);
      else throw new Error(`snapshot does not belong to diff path: ${entry}`);
    }
    const afterLocal = statSync(root).isFile()
      ? new Map([[".", hashFile(root)]])
      : snapshotDirectory(root);
    return diffSnapshots(beforeLocal, afterLocal).map((effect) => ({
      ...effect,
      path: prefix === "." ? effect.path : `${prefix}/${effect.path}`,
    }));
  }

  private async runProcess(spec: ProcessRunSpec): Promise<ProcessResult> {
    const handle = await this.startProcess({ ...spec, ready: { kind: "none" } });
    return this.waitProcess(handle);
  }

  private async startProcess(spec: ProcessStartSpec): Promise<ProcessHandle> {
    if (this.running.size >= this.policy.maxProcesses) {
      throw new Error(`process limit exceeded: ${this.policy.maxProcesses}`);
    }
    const normalized = normalizeProcessSpec(spec);
    const program = this.resolveProgram(normalized.program);
    const cwd = this.resolveReadable(normalized.cwd ?? ".");
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`process cwd is not a directory: ${normalized.cwd ?? "."}`);
    }
    const env = this.buildEnv(normalized.env);
    let child: ChildProcess;
    try {
      child = spawn(program, normalized.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (cause) {
      throw new Error(`failed to spawn '${normalized.program}': ${errorMessage(cause)}`);
    }

    const id = `p${String(this.nextProcessId++)}`;
    const running: RunningProcess = {
      child,
      startedAt: Date.now(),
      spec: normalized,
      stdout: [],
      stderr: [],
      exit: createExitPromise(child),
      timeoutTimer: null,
      resultPromise: null,
      outputBytes: 0,
      outputLimit: false,
      timedOut: false,
      stopRequested: false,
    };
    this.running.set(id, running);
    child.stdout?.on("data", (chunk: Buffer) => appendOutput(running, running.stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput(running, running.stderr, chunk));
    running.timeoutTimer = setTimeout(() => {
      running.timedOut = true;
      terminateTree(child.pid);
    }, normalized.timeoutMs);

    if (normalized.stdinBase64 !== undefined) {
      child.stdin?.end(Buffer.from(normalized.stdinBase64, "base64"));
    } else {
      child.stdin?.end();
    }
    try {
      await waitReady(normalized.ready, this.workspaceRoot, this.policy, child);
    } catch (cause) {
      await this.stopProcess({ id });
      throw cause;
    }
    return { id };
  }

  private waitProcess(handle: ProcessHandle, timeoutMs?: number): Promise<ProcessResult> {
    const running = this.running.get(handle.id);
    if (running === undefined) throw new Error(`unknown process handle: ${handle.id}`);
    if (running.resultPromise !== null) return running.resultPromise;
    running.resultPromise = this.collectProcess(handle.id, running, timeoutMs);
    return running.resultPromise;
  }

  private async collectProcess(
    id: string,
    running: RunningProcess,
    timeoutMs: number | undefined,
  ): Promise<ProcessResult> {
    let waitTimedOut = false;
    const waitTimer = timeoutMs === undefined
      ? null
      : setTimeout(() => {
          waitTimedOut = true;
          terminateTree(running.child.pid);
        }, timeoutMs);
    const exit = await running.exit;
    if (waitTimer !== null) clearTimeout(waitTimer);
    if (running.timeoutTimer !== null) clearTimeout(running.timeoutTimer);
    this.running.delete(id);

    const status: ProcessResult["status"] = running.outputLimit
      ? "output_limit"
      : running.timedOut || waitTimedOut
        ? "timeout"
        : exit.error !== null
          ? "spawn_error"
          : running.stopRequested
            ? "stopped"
            : "exited";
    return {
      status,
      exitCode: status === "exited" ? exit.code : null,
      signal: exit.signal,
      stdoutBase64: Buffer.concat(running.stdout).toString("base64"),
      stderrBase64: Buffer.concat(running.stderr).toString("base64"),
      durationMs: Date.now() - running.startedAt,
      error: running.outputLimit
        ? `process output exceeded ${running.spec.maxOutputBytes} bytes`
        : running.timedOut || waitTimedOut
          ? `process exceeded timeout ${timeoutMs ?? running.spec.timeoutMs}ms`
          : exit.error?.message ?? null,
    };
  }

  private async stopProcess(handle: ProcessHandle): Promise<ProcessResult> {
    const running = this.running.get(handle.id);
    if (running === undefined) {
      return {
        status: "stopped",
        exitCode: null,
        signal: null,
        stdoutBase64: "",
        stderrBase64: "",
        durationMs: 0,
        error: null,
      };
    }
    running.stopRequested = true;
    terminateTree(running.child.pid);
    return this.waitProcess(handle);
  }

  private toolAvailable(name: string): boolean {
    if (this.policy.allowedTools.length > 0 && !this.policy.allowedTools.includes(name)) return false;
    const tool = this.host?.tools[name];
    return tool?.available === true && tool.path !== null;
  }

  private toolList(): WorkflowTool[] {
    const tools = this.host?.tools ?? {};
    return Object.entries(tools)
      .filter(([name, probe]) => this.toolAvailable(name) && probe.path !== null)
      .map(([name, probe]) => ({ name, path: probe.path! }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private resolveProgram(program: string): string {
    const measured = this.resolveMeasuredTool(program);
    if (measured !== null) return measured;
    if (isAbsolute(program)) throw new Error(`absolute executable paths are not allowed: ${program}`);
    if (!program.includes("/") && !program.includes("\\")) {
      throw new Error(`measured tool is unavailable: ${program}`);
    }
    const absolute = this.resolveReadable(program);
    if (!matchesAnyGlob(this.relativeWorkspace(absolute), this.policy.executableGlobs)) {
      throw new Error(`executable is not allowed by executableGlobs: ${program}`);
    }
    if (!existsSync(absolute)) throw new Error(`executable does not exist: ${program}`);
    if (lstatSync(absolute).isSymbolicLink() || statSync(absolute).isDirectory()) {
      throw new Error(`executable is not a regular file: ${program}`);
    }
    return absolute;
  }

  private resolveMeasuredTool(name: string): string | null {
    if (name.includes("/") || name.includes("\\") || isAbsolute(name)) return null;
    if (this.policy.allowedTools.length > 0 && !this.policy.allowedTools.includes(name)) {
      return null;
    }
    const tool = this.host?.tools[name];
    return tool?.available === true && tool.path !== null ? tool.path : null;
  }

  private buildEnv(overrides: Readonly<Record<string, string>> | undefined): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of SYSTEM_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(overrides ?? {})) {
      if (!SYSTEM_ENV_KEYS.has(key) && !this.policy.allowedEnv.includes(key)) {
        throw new Error(`environment key is not allowed: ${key}`);
      }
      env[key] = value;
    }
    return env;
  }

  private resolveReadable(path: string): string {
    const absolute = resolveInside(this.workspaceRoot, path, "readable path");
    assertRealPathInside(this.workspaceRoot, absolute, "readable path");
    if (!matchesAnyGlob(this.relativeWorkspace(absolute), this.policy.readableGlobs)) {
      throw new Error(`path is not readable by capability policy: ${path}`);
    }
    return absolute;
  }

  private resolveWritable(path: string): string {
    const absolute = resolveInside(this.workspaceRoot, path, "writable path");
    assertRealPathInside(this.workspaceRoot, absolute, "writable path");
    if (!matchesAnyGlob(this.relativeWorkspace(absolute), this.policy.writableGlobs)) {
      throw new Error(`path is not writable by capability policy: ${path}`);
    }
    return absolute;
  }

  private relativeWorkspace(absolute: string): string {
    const rel = relative(this.workspaceRoot, absolute).split(sep).join("/");
    return rel.length === 0 ? "." : rel;
  }
}

function createExitPromise(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolveExit) => {
    let settled = false;
    const settle = (value: ProcessExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(value);
    };
    child.once("error", (error) => settle({ code: null, signal: null, error }));
    child.once("close", (code, signal) => settle({ code, signal, error: null }));
  });
}

function appendOutput(running: RunningProcess, target: Buffer[], chunk: Buffer): void {
  if (running.outputLimit) return;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const max = running.spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const remaining = max - running.outputBytes;
  if (remaining > 0) target.push(bytes.subarray(0, remaining));
  running.outputBytes += bytes.length;
  if (running.outputBytes > max) {
    running.outputLimit = true;
    terminateTree(running.child.pid);
  }
}

function waitReady(
  probe: WorkflowReadyProbe | undefined,
  workspaceRoot: string,
  policy: Required<WorkflowCapabilityPolicy>,
  child: ChildProcess,
): Promise<void> {
  if (probe === undefined || probe.kind === "none") return Promise.resolve();
  const timeoutMs = probe.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const started = Date.now();
  if (probe.kind === "file") {
    const path = resolveInside(workspaceRoot, probe.path, "ready probe path");
    assertRealPathInside(workspaceRoot, path, "ready probe path");
    if (!matchesAnyGlob(relativeWorkspacePath(workspaceRoot, path), policy.readableGlobs)) {
      return Promise.reject(new Error(`ready probe path is not readable: ${probe.path}`));
    }
    return poll(
      async () => existsSync(path),
      () => `file ready probe timed out after ${timeoutMs}ms: ${probe.path}`,
      timeoutMs,
      started,
    );
  }
  return poll(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`process exited before TCP ready probe on ${probe.host}:${String(probe.port)}`);
      }
      return canConnect(probe.host, probe.port);
    },
    () => `TCP ready probe timed out after ${timeoutMs}ms: ${probe.host}:${String(probe.port)}`,
    timeoutMs,
    started,
  );
}

async function poll(
  check: () => Promise<boolean>,
  timeoutMessage: () => string,
  timeoutMs: number,
  started: number,
): Promise<void> {
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(timeoutMessage());
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(100, () => done(false));
  });
}

function snapshotDirectory(root: string): Snapshot {
  const result: Snapshot = new Map();
  walkDirectory(root, root, result);
  return result;
}

function walkDirectory(root: string, directory: string, result: Snapshot): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`filesystem snapshot refuses symbolic link: ${relative(root, absolute)}`);
    if (entry.isDirectory()) {
      walkDirectory(root, absolute, result);
    } else if (entry.isFile()) {
      result.set(relative(root, absolute).split(sep).join("/"), hashFile(absolute));
    } else {
      throw new Error(`filesystem snapshot refuses special file: ${relative(root, absolute)}`);
    }
  }
}

function resolveInside(root: string, path: string, label: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes workspace: ${path}`);
  }
  return absolute;
}

function assertRealPathInside(root: string, absolute: string, label: string): void {
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  const real = realpathSync(current);
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} resolves outside workspace: ${absolute}`);
  }
}

function relativeWorkspacePath(root: string, absolute: string): string {
  const rel = relative(root, absolute).split(sep).join("/");
  return rel.length === 0 ? "." : rel;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => {
    if (glob.endsWith("/**") && path === glob.slice(0, -3)) return true;
    return globToRegExp(glob).test(path);
  });
}

function globToRegExp(glob: string): RegExp {
  let expression = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        expression += ".*";
        index++;
        if (glob[index + 1] === "/") index++;
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`);
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

function normalizeProcessSpec(spec: ProcessStartSpec): ProcessStartSpec {
  return {
    ...spec,
    args: [...(spec.args ?? [])],
    timeoutMs: positiveInt(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
    maxOutputBytes: positiveInt(spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes"),
  };
}

function processRunSpecArg(args: unknown[], index: number): ProcessRunSpec {
  return processSpecArg(args, index);
}

function processStartSpecArg(args: unknown[], index: number): ProcessStartSpec {
  const spec = processSpecArg(args, index) as ProcessStartSpec;
  if (spec.ready !== undefined && !isReadyProbe(spec.ready)) throw new Error("invalid process ready probe");
  return spec;
}

function processSpecArg(args: unknown[], index: number): ProcessRunSpec {
  const value = args[index];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("process spec must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.program !== "string" || record.program.length === 0) {
    throw new Error("process spec requires program");
  }
  if (
    record.args !== undefined &&
    (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string"))
  ) throw new Error("process args must be strings");
  if (record.cwd !== undefined && typeof record.cwd !== "string") throw new Error("process cwd must be a string");
  if (record.stdinBase64 !== undefined && typeof record.stdinBase64 !== "string") {
    throw new Error("process stdinBase64 must be a string");
  }
  if (record.env !== undefined && !isStringRecord(record.env)) throw new Error("process env must be a string record");
  return record as unknown as ProcessRunSpec;
}

function handleArg(args: unknown[], index: number): ProcessHandle {
  const value = args[index];
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).id !== "string"
  ) throw new Error("process handle must have an id");
  return value as ProcessHandle;
}

function snapshotArg(args: unknown[], index: number): WorkflowFsSnapshot {
  const value = args[index];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some((hash) => typeof hash !== "string")
  ) throw new Error("snapshot must be a path-to-hash object");
  return value as WorkflowFsSnapshot;
}

function stringArg(args: unknown[], index: number, label: string): string {
  const value = args[index];
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

/** Accept any fail payload; errors are stringified for the plan record. */
function optionalErrorArg(args: unknown[], index: number): string | undefined {
  const value = args[index];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return String(value);
}

 function optionalStringArg(args: unknown[], index: number): string | undefined {
   const value = args[index];
   if (value === undefined) return undefined;
   return stringArg(args, index, "path");
 }

function planDeclarationsArg(args: unknown[], index: number): PlanStepDeclaration[] {
  const value = args[index];
  if (!Array.isArray(value)) throw new Error("plan declarations must be an array");
  const validate = (items: unknown[]): PlanStepDeclaration[] => items.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("plan step must be an object");
    }
    const record = item as Record<string, unknown>;
    if (record.id !== undefined && (typeof record.id !== "string" || record.id.length === 0)) {
      throw new Error("plan step id must be a non-empty string when provided");
    }
    if (typeof record.title !== "string" || record.title.length === 0) {
      throw new Error("plan step title must be a non-empty string");
    }
    if (record.description !== undefined && typeof record.description !== "string") {
      throw new Error("plan step description must be a string");
    }
    if (record.children !== undefined && !Array.isArray(record.children)) {
      throw new Error("plan step children must be an array");
    }
    return {
      ...(record.id === undefined ? {} : { id: record.id }),
      title: record.title,
      ...(record.description === undefined ? {} : { description: record.description }),
      ...(record.children === undefined ? {} : { children: validate(record.children as unknown[]) }),
    };
  });
  return validate(value);
}

function encodingArg(args: unknown[], index: number): "utf8" | "base64" {
  const value = args[index] ?? "utf8";
  if (value !== "utf8" && value !== "base64") throw new Error("encoding must be utf8 or base64");
  return value;
}

function optionalPositiveInt(args: unknown[], index: number, label: string): number | undefined {
  const value = args[index];
  if (value === undefined) return undefined;
  return positiveInt(value, label);
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

function isReadyProbe(value: unknown): value is WorkflowReadyProbe {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).kind !== "string"
  ) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "none") return true;
  if (record.kind === "file") {
    return typeof record.path === "string" &&
      (record.timeoutMs === undefined || typeof record.timeoutMs === "number");
  }
  return record.kind === "tcp" &&
    typeof record.host === "string" &&
    typeof record.port === "number" &&
    (record.timeoutMs === undefined || typeof record.timeoutMs === "number");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
