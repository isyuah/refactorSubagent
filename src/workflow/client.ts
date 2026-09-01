import type {
  CapabilityRequest,
  CapabilityResponse,
} from "./capability-protocol.js";
import type {
  CMakeAdapter,
  CompilerAdapter,
  CTestAdapter,
  NinjaAdapter,
  PlanStepDeclaration,
  ProcessHandle,
  ProcessResult,
  WorkflowAdapters,
  WorkflowCapabilities,
  WorkflowContext,
  WorkflowFacts,
  WorkflowFilesystem,
  WorkflowFsEffect,
  WorkflowFsSnapshot,
  WorkflowPlanApi,
  WorkflowProcess,
  WorkflowEvent,
  WorkflowTool,
  WorkflowTools,
} from "./types.js";

export interface CapabilityClientTransport {
  send(request: CapabilityRequest): void;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** Worker-side capability proxy. It has no host API other than the transport. */
export class WorkflowCapabilityClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: WorkflowEvent[] = [];
  private nextId = 1;

  constructor(private readonly transport: CapabilityClientTransport) {}

  accept(response: CapabilityResponse): void {
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    this.events.push(response.event);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error(response.error ?? "capability request failed"));
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  getEvents(): WorkflowEvent[] {
    return [...this.events];
  }

  createCapabilities(): WorkflowCapabilities {
    const fs: WorkflowFilesystem = {
      readFile: async (path, encoding = "utf8") => await this.call("fs", "readFile", [path, encoding]) as string,
      writeFile: async (path, content, encoding = "utf8") => { await this.call("fs", "writeFile", [path, content, encoding]); },
      mkdir: async (path) => { await this.call("fs", "mkdir", [path]); },
      exists: async (path) => await this.call("fs", "exists", [path]) as boolean,
      readdir: async (path) => await this.call("fs", "readdir", [path]) as string[],
      snapshot: async (path) => await this.call("fs", "snapshot", [path]) as WorkflowFsSnapshot,
      diff: async (path, before) => await this.call("fs", "diff", [path, before]) as WorkflowFsEffect[],
    };
    const processCapability: WorkflowProcess = {
      run: async (spec) => await this.call("process", "run", [spec]) as ProcessResult,
      start: async (spec) => await this.call("process", "start", [spec]) as ProcessHandle,
      wait: async (handle, timeoutMs) => await this.call(
        "process",
        "wait",
        timeoutMs === undefined ? [handle] : [handle, timeoutMs],
      ) as ProcessResult,
      stop: async (handle) => await this.call("process", "stop", [handle]) as ProcessResult,
    };
    const tools: WorkflowTools = {
      available: async (name) => await this.call("tools", "available", [name]) as boolean,
      list: async () => await this.call("tools", "list", []) as WorkflowTool[],
    };
    const plan: WorkflowPlanApi = {
      declare: async (steps: readonly PlanStepDeclaration[]) => await this.call("plan", "declare", [steps]) as string[],
      begin: async (id: string) => { await this.call("plan", "begin", [id]); },
      complete: async (id: string) => { await this.call("plan", "complete", [id]); },
      fail: async (id: string, error: string) => { await this.call("plan", "fail", [id, error]); },
    };
    return {
      fs,
      process: processCapability,
      tools,
      plan,
      adapters: createAdapters(processCapability),
    };
  }

  private call(capability: CapabilityRequest["capability"], method: string, args: unknown[]): Promise<unknown> {
    const id = `c${String(this.nextId++)}`;
    const request: CapabilityRequest = { type: "capability-request", id, capability, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.send(request);
      } catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
}

export function createWorkflowContext(options: {
  readonly workspaceRoot: string;
  readonly input: unknown;
  readonly facts: WorkflowFacts;
  readonly transport: CapabilityClientTransport;
}): { readonly context: WorkflowContext; readonly client: WorkflowCapabilityClient } {
  const client = new WorkflowCapabilityClient(options.transport);
  const capabilities = client.createCapabilities();
  return {
    client,
    context: {
      apiVersion: 1,
      workspaceRoot: options.workspaceRoot,
      input: options.input,
      facts: options.facts,
      capabilities,
      fs: capabilities.fs,
      process: capabilities.process,
      tools: capabilities.tools,
      adapters: capabilities.adapters,
      plan: capabilities.plan,
    },
  };
}

function createAdapters(processCapability: WorkflowProcess): WorkflowAdapters {
  const run = (program: string, args: readonly string[], cwd?: string, timeoutMs?: number): Promise<ProcessResult> =>
    processCapability.run({ program, args, cwd, timeoutMs });
  const cmake: CMakeAdapter = {
    configure: ({ sourceDir = ".", buildDir, generator, flags = [] }) => {
      const args = ["-S", sourceDir, "-B", buildDir];
      if (generator !== undefined) args.push("-G", generator);
      args.push(...flags);
      return run("cmake", args);
    },
    build: ({ buildDir, target, flags = [] }) => {
      const args = ["--build", buildDir];
      if (target !== undefined) args.push("--target", target);
      args.push(...flags);
      return run("cmake", args);
    },
  };
  const ninja: NinjaAdapter = {
    build: ({ buildDir = ".", target, flags = [] }) => {
      const args = ["-C", buildDir, ...flags];
      if (target !== undefined) args.push(target);
      return run("ninja", args);
    },
  };
  const ctest: CTestAdapter = {
    run: ({ buildDir, configuration = "Debug", args = [], timeoutMs }) =>
      run("ctest", ["--test-dir", buildDir, "-C", configuration, "--output-on-failure", ...args], ".", timeoutMs),
  };
  const compiler: CompilerAdapter = {
    compile: ({ compiler = "gcc", args, cwd, timeoutMs }) => run(compiler, args, cwd, timeoutMs),
  };
  return { cmake, ninja, ctest, compiler };
}
