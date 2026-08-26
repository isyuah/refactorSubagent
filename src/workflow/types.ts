import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";

export interface WorkflowFacts {
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
}

export type WorkflowFileEncoding = "utf8" | "base64";

export interface WorkflowFsSnapshot {
  readonly [path: string]: string;
}

export interface WorkflowFsEffect {
  readonly path: string;
  readonly op: "create" | "modify" | "delete";
  readonly sha256: string | null;
}

export interface WorkflowFilesystem {
  readFile(path: string, encoding?: WorkflowFileEncoding): Promise<string>;
  writeFile(path: string, content: string, encoding?: WorkflowFileEncoding): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  snapshot(path?: string): Promise<WorkflowFsSnapshot>;
  diff(path: string, before: WorkflowFsSnapshot): Promise<WorkflowFsEffect[]>;
}

export interface ProcessRunSpec {
  /** A measured tool name (e.g. `cmake`) or a workspace-relative executable path. */
  readonly program: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly stdinBase64?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ProcessStartSpec extends ProcessRunSpec {
  readonly ready?: WorkflowReadyProbe;
}

export type WorkflowReadyProbe =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "tcp";
      readonly host: string;
      readonly port: number;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly timeoutMs?: number;
    };

export interface ProcessResult {
  readonly status: "exited" | "timeout" | "output_limit" | "spawn_error" | "stopped";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly durationMs: number;
  readonly error: string | null;
}

export interface ProcessHandle {
  readonly id: string;
}

export interface WorkflowProcess {
  run(spec: ProcessRunSpec): Promise<ProcessResult>;
  start(spec: ProcessStartSpec): Promise<ProcessHandle>;
  wait(handle: ProcessHandle, timeoutMs?: number): Promise<ProcessResult>;
  stop(handle: ProcessHandle): Promise<ProcessResult>;
}

export interface WorkflowTool {
  readonly name: string;
  readonly path: string;
}

export interface WorkflowTools {
  available(name: string): Promise<boolean>;
  list(): Promise<WorkflowTool[]>;
}

export interface CMakeAdapter {
  configure(options: {
    readonly sourceDir?: string;
    readonly buildDir: string;
    readonly generator?: string;
    readonly flags?: readonly string[];
  }): Promise<ProcessResult>;
  build(options: {
    readonly buildDir: string;
    readonly target?: string;
    readonly flags?: readonly string[];
  }): Promise<ProcessResult>;
}

export interface NinjaAdapter {
  build(options: {
    readonly buildDir?: string;
    readonly target?: string;
    readonly flags?: readonly string[];
  }): Promise<ProcessResult>;
}

export interface CTestAdapter {
  run(options: {
    readonly buildDir: string;
    readonly configuration?: string;
    readonly args?: readonly string[];
    readonly timeoutMs?: number;
  }): Promise<ProcessResult>;
}

export interface CompilerAdapter {
  compile(options: {
    readonly compiler?: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly timeoutMs?: number;
  }): Promise<ProcessResult>;
}

export interface WorkflowAdapters {
  readonly cmake: CMakeAdapter;
  readonly ninja: NinjaAdapter;
  readonly ctest: CTestAdapter;
  readonly compiler: CompilerAdapter;
}

export interface WorkflowCapabilityPolicy {
  /** Workspace-relative globs readable by the Workflow. */
  readonly readableGlobs?: readonly string[];
  /** Workspace-relative globs writable by the Workflow. */
  readonly writableGlobs?: readonly string[];
  /** Workspace-relative executable globs. Measured tools do not use this list. */
  readonly executableGlobs?: readonly string[];
  /** Empty means every measured host tool may be used. */
  readonly allowedTools?: readonly string[];
  /** Environment override keys allowed for child processes. */
  readonly allowedEnv?: readonly string[];
  readonly maxProcesses?: number;
  readonly maxOutputBytes?: number;
  readonly maxFileBytes?: number;
}

export interface WorkflowCapabilities {
  readonly fs: WorkflowFilesystem;
  readonly process: WorkflowProcess;
  readonly tools: WorkflowTools;
  readonly adapters: WorkflowAdapters;
}

export interface WorkflowContext {
  readonly apiVersion: 1;
  readonly workspaceRoot: string;
  readonly input: unknown;
  readonly facts: WorkflowFacts;
  readonly capabilities: WorkflowCapabilities;
  /** Convenience aliases; both forms refer to the same injected objects. */
  readonly fs: WorkflowFilesystem;
  readonly process: WorkflowProcess;
  readonly tools: WorkflowTools;
  readonly adapters: WorkflowAdapters;
}

export type WorkflowFunction = (
  context: WorkflowContext,
) => unknown | Promise<unknown>;

export interface WorkflowEvent {
  readonly id: string;
  readonly capability: "fs" | "process" | "tools";
  readonly method: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error: string | null;
}

export interface WorkflowRunResult {
  status: "pass" | "failed" | "timeout" | "rejected";
  exitCode: number | null;
  result: unknown;
  stdout: string;
  stderr: string;
  failure: string | null;
  events: WorkflowEvent[];
}
