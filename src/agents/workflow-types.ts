/**
 * Host-provided workflow types. Generated next to every workflow source;
 * import these instead of declaring your own interfaces.
 *
 * IMPORTANT: type-only imports are erased at runtime; the worker injects the
 * real objects. Never import values from this file.
 */

export const WORKFLOW_TYPES = `
export interface WorkflowFacts {
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
}

export interface HostPreflight {
  readonly platform: "win32" | "linux" | "darwin";
  readonly arch: string;
  readonly executable_suffix: string;
  readonly shell: string;
  readonly tools: Record<string, {
    readonly available: boolean;
    readonly path: string | null;
    readonly version: string | null;
  }>;
  readonly cmake: {
    readonly version: string | null;
    readonly generators: string[];
    readonly default_generator: string | null;
    readonly c_compiler: string | null;
    readonly configure_probe: "pass" | "fail" | "not-run";
    readonly build_probe: "pass" | "fail" | "not-run";
  };
}

export interface ProjectDetection {
  readonly kind: "project-detection";
  readonly version: 1;
  readonly repo_root: string;
  readonly language: string;
  readonly build_systems: string[];
  readonly primary_build_system: string | null;
  readonly markers: string[];
  readonly source_files: string[];
  readonly adapter: "direct-compiler" | "cmake" | "ninja" | null;
  readonly status: "ready" | "needs-adapter" | "unsupported";
  readonly reason: string;
}

export type WorkflowFileEncoding = "utf8" | "base64";

export interface ProcessRunSpec {
  readonly program: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly stdinBase64?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ProcessStartSpec extends ProcessRunSpec {
  readonly ready?: {
    readonly kind: "none" | "tcp" | "file";
    readonly host?: string;
    readonly port?: number;
    readonly path?: string;
    readonly timeoutMs?: number;
  };
}

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

export interface WorkflowFilesystem {
  readFile(path: string, encoding?: WorkflowFileEncoding): Promise<string>;
  writeFile(path: string, content: string, encoding?: WorkflowFileEncoding): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
  snapshot(path?: string): Promise<Record<string, string>>;
  diff(path: string, before: Record<string, string>): Promise<Array<{
    readonly path: string;
    readonly op: "create" | "modify" | "delete";
    readonly sha256: string | null;
  }>>;
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

export interface WorkflowAdapters {
  readonly cmake: {
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
  };
  readonly ninja: {
    build(options: {
      readonly buildDir?: string;
      readonly target?: string;
      readonly flags?: readonly string[];
    }): Promise<ProcessResult>;
  };
  readonly ctest: {
    run(options: {
      readonly buildDir: string;
      readonly configuration?: string;
      readonly args?: readonly string[];
      readonly timeoutMs?: number;
    }): Promise<ProcessResult>;
  };
  readonly compiler: {
    compile(options: {
      readonly compiler?: string;
      readonly args: readonly string[];
      readonly cwd?: string;
      readonly timeoutMs?: number;
    }): Promise<ProcessResult>;
  };
}

/** Result-validation capability. Assertions throw on failure (fail-closed). */
export interface WorkflowValidator {
  assertFile(path: string, description?: string): Promise<void>;
  assertDir(path: string, description?: string): Promise<void>;
  assertAbsent(path: string, description?: string): Promise<void>;
}

export interface PlanStepDeclaration {
  readonly id?: string;
  readonly title: string;
  readonly description?: string;
  readonly children?: readonly PlanStepDeclaration[];
}

export interface WorkflowPlanApi {
  declare(steps: readonly PlanStepDeclaration[]): Promise<readonly string[]>;
  begin(id: string): Promise<void>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}

export interface WorkflowContext {
  readonly apiVersion: 1;
  readonly workspaceRoot: string;
  readonly input: unknown;
  readonly facts: WorkflowFacts;
  readonly capabilities: {
    readonly fs: WorkflowFilesystem;
    readonly process: WorkflowProcess;
    readonly tools: WorkflowTools;
    readonly adapters: WorkflowAdapters;
    readonly validator: WorkflowValidator;
    readonly plan: WorkflowPlanApi;
  };
  /** Convenience aliases; both forms refer to the same injected objects. */
  readonly fs: WorkflowFilesystem;
  readonly process: WorkflowProcess;
  readonly tools: WorkflowTools;
  readonly adapters: WorkflowAdapters;
  readonly validator: WorkflowValidator;
  readonly plan: WorkflowPlanApi;
}
`;
