import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BuildWorkflowOutput as BuildWorkflowOutputValue,
  type BuildArtifact,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import type {
  CapabilityRequest,
  CapabilityResponse,
} from "./capability-protocol.js";
import { LocalCapabilityBroker } from "./capabilities.js";
import { runWorkflow } from "./runner.js";
import type {
  ProcessResult,
  WorkflowCapabilityPolicy,
  WorkflowEvent,
} from "./types.js";
export interface ExecuteBuildWorkflowOptions {
  readonly cwd: string;
  /** Workflow source entry; required for workflow-driven builds. */
  readonly entry?: string;
  /** Declarative plan. May be null for workflow-driven builds (the function
   *  produces the output during execution). */
  readonly output: BuildWorkflowOutputValue | null;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  readonly policy?: WorkflowCapabilityPolicy;
  readonly timeoutMs?: number;
}
export interface BuildWorkflowStepResult {
  readonly name: "configure" | "build";
  readonly status: ProcessResult["status"] | "error";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error: string | null;
}

export interface BuildWorkflowExecution {
  readonly status: "pass" | "failed";
  readonly artifact: BuildArtifact;
  readonly steps: BuildWorkflowStepResult[];
  readonly missingArtifacts: string[];
  readonly events: WorkflowEvent[];
  readonly failure: string | null;
}

/** Execute a validated BuildWorkflow through the brokered process boundary. */
export async function executeBuildWorkflow(
  options: ExecuteBuildWorkflowOptions,
): Promise<BuildWorkflowExecution> {
  const broker = new LocalCapabilityBroker({
    workspaceRoot: options.cwd,
    host: options.host,
    policy: options.policy,
  });
  const steps: BuildWorkflowStepResult[] = [];
  const events: WorkflowEvent[] = [];
  try {
    // workflow-driven: the function produces the output during execution.
    let artifact: BuildArtifact | null = null;
    let buildKind = "custom";
    if (options.output !== null) {
      artifact = options.output.artifact;
      const build = options.output.environment.build;
      buildKind = "kind" in build ? build.kind : "custom";
      if ("kind" in build && build.kind === "cmake") {
        const configureArgs = ["-S", build.source_dir, "-B", build.build_dir];
        if (build.generator !== null) configureArgs.push("-G", build.generator);
        configureArgs.push(...build.configure_flags);
        const configure = await runProcess(broker, "configure", {
          program: "cmake",
          args: configureArgs,
          cwd: ".",
          timeoutMs: options.timeoutMs,
        }, events);
        steps.push(configure.step);
        if (configure.result === null || !successful(configure.result)) {
          return failed(options.output.artifact, steps, [], events, configure.step.error ?? "CMake configure failed");
        }

        const buildArgs = ["--build", build.build_dir, ...build.build_flags];
        if (build.target !== null) buildArgs.push("--target", build.target);
        const built = await runProcess(broker, "build", {
          program: "cmake",
          args: buildArgs,
          cwd: ".",
          timeoutMs: options.timeoutMs,
        }, events);
        steps.push(built.step);
        if (built.result === null || !successful(built.result)) {
          return failed(options.output.artifact, steps, [], events, built.step.error ?? "CMake build failed");
        }
      } else if ("kind" in build && build.kind === "ninja") {
        const args = ["-C", build.build_dir, ...build.build_flags];
        if (build.target !== null) args.push(build.target);
        const built = await runProcess(broker, "build", {
          program: "ninja",
          args,
          cwd: ".",
          timeoutMs: options.timeoutMs,
        }, events);
        steps.push(built.step);
        if (built.result === null || !successful(built.result)) {
          return failed(options.output.artifact, steps, [], events, built.step.error ?? "Ninja build failed");
        }
      } else if ("kind" in build && build.kind === "direct-compiler") {
        const output = process.platform === "win32" && !build.output.toLowerCase().endsWith(".exe")
          ? `${build.output}.exe`
          : build.output;
        const args = [
          ...build.flags,
          ...Object.entries(build.defines).map(([key, value]) => `-D${key}=${value}`),
          ...build.sources,
          "-o",
          output,
        ];
        const built = await runProcess(broker, "build", {
          program: build.compiler,
          args,
          cwd: ".",
          timeoutMs: options.timeoutMs,
        }, events);
        steps.push(built.step);
        if (built.result === null || !successful(built.result)) {
          return failed(options.output.artifact, steps, [], events, built.step.error ?? "compiler build failed");
        }
      } else if ("kind" in build && build.kind === "workflow-driven") {
        const driven = await runDrivenWorkflow(options, broker, steps, events);
        if ("error" in driven) {
          return failed(
            { kind: "custom", version: 1, workflow_id: "", workflow_revision: 0, paths: {}, metadata: {} },
            steps,
            [],
            events,
            driven.error,
          );
        }
        artifact = driven.artifact;
        buildKind = "workflow-driven";
      } else {
        return failed(options.output.artifact, steps, [], events, "legacy shell-command BuildWorkflow execution is not supported");
      }
    } else {
      // options.output === null: workflow-driven with no declarative plan.
      const driven = await runDrivenWorkflow(options, broker, steps, events);
      if ("error" in driven) {
        return failed(
          { kind: "custom", version: 1, workflow_id: "", workflow_revision: 0, paths: {}, metadata: {} },
          steps,
          [],
          events,
          driven.error,
        );
      }
      artifact = driven.artifact;
      buildKind = "workflow-driven";
    }

    const output = artifact;
    const missingArtifacts: string[] = [];
    for (const [name, path] of Object.entries(output.paths)) {
      const candidates = artifactCandidates(path, buildKind);
      if (!candidates.some((candidate) => existsSync(join(options.cwd, candidate)))) {
        missingArtifacts.push(`${name}: ${path}`);
      }
    }
    if (missingArtifacts.length > 0) {
      return failed(
        output,
        steps,
        missingArtifacts,
        events,
        `build completed but artifacts are missing: ${missingArtifacts.join(", ")}`,
      );
    }
    return {
      status: "pass",
      artifact: output,
      steps,
      missingArtifacts,
      events,
      failure: null,
    };
  } finally {
    await broker.close();
  }
}

/**
 * Re-run a workflow-driven workflow function: it drives the build through
 * injected capabilities (process/fs/validator) and returns void. Artifact
 * existence is asserted by the workflow itself via ctx.validator; no static
 * artifact manifest is needed (the old BuildWorkflowOutput return is gone).
 */
async function runDrivenWorkflow(
  options: ExecuteBuildWorkflowOptions,
  broker: LocalCapabilityBroker,
  steps: BuildWorkflowStepResult[],
  events: WorkflowEvent[],
): Promise<{ readonly artifact: BuildArtifact } | { readonly error: string }> {
  if (options.entry === undefined) return { error: "workflow-driven build requires the workflow entry" };
  const driven = await runWorkflow({
    entry: options.entry,
    cwd: options.cwd,
    facts: { host: options.host, project: options.project },
    policy: options.policy,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  events.push(...driven.events);
  if (driven.status !== "pass") {
    return { error: driven.failure ?? "workflow-driven build failed" };
  }
  // workflow-driven: no BuildWorkflowOutput return is required anymore.
  // Artifact existence was asserted in-band by ctx.validator; a successful
  // run means the workflow's assertions (if any) passed.
  steps.push({
    name: "build",
    status: "exited",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
    error: null,
  });
  return { artifact: { kind: "custom", version: 1, workflow_id: "", workflow_revision: 0, paths: {}, metadata: {} } };
}

async function runProcess(
  broker: LocalCapabilityBroker,
  name: "configure" | "build",
  spec: { readonly program: string; readonly args: readonly string[]; readonly cwd: string; readonly timeoutMs?: number },
  events: WorkflowEvent[],
): Promise<{ readonly result: ProcessResult | null; readonly step: BuildWorkflowStepResult }> {
  const request: CapabilityRequest = {
    type: "capability-request",
    id: `build:${name}:${String(events.length + 1)}`,
    capability: "process",
    method: "run",
    args: [spec],
  };
  const response: CapabilityResponse = await broker.handle(request);
  events.push(response.event);
  if (!response.ok || !isProcessResult(response.value)) {
    const error = response.error ?? `invalid process result for ${name}`;
    return {
      result: null,
      step: {
        name,
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: response.event.durationMs,
        error,
      },
    };
  }
  const result = response.value;
  return {
    result,
    step: {
      name,
      status: result.status,
      exitCode: result.exitCode,
      stdout: decode(result.stdoutBase64),
      stderr: decode(result.stderrBase64),
      durationMs: result.durationMs,
      error: result.error,
    },
  };
}

function successful(result: ProcessResult): boolean {
  return result.status === "exited" && result.exitCode === 0;
}

function failed(
  artifact: BuildArtifact,
  steps: BuildWorkflowStepResult[],
  missingArtifacts: string[],
  events: WorkflowEvent[],
  failure: string,
): BuildWorkflowExecution {
  return {
    status: "failed",
    artifact,
    steps,
    missingArtifacts,
    events,
    failure,
  };
}

function artifactCandidates(path: string, buildKind: string): string[] {
  const candidates = new Set([path]);
  if (process.platform === "win32" && !path.toLowerCase().endsWith(".exe")) candidates.add(`${path}.exe`);
  if (buildKind === "cmake") {
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "." : path.slice(0, slash);
    const file = slash < 0 ? path : path.slice(slash + 1);
    for (const configuration of ["Debug", "Release", "RelWithDebInfo", "MinSizeRel"]) {
      const candidate = parent === "." ? `${configuration}/${file}` : `${parent}/${configuration}/${file}`;
      candidates.add(candidate);
      if (process.platform === "win32") candidates.add(`${candidate}.exe`);
    }
  }
  return [...candidates];
}

function isProcessResult(value: unknown): value is ProcessResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record.status === "exited" || record.status === "timeout" || record.status === "output_limit" || record.status === "spawn_error" || record.status === "stopped") &&
    (record.exitCode === null || typeof record.exitCode === "number") &&
    (record.signal === null || typeof record.signal === "string") &&
    typeof record.stdoutBase64 === "string" &&
    typeof record.stderrBase64 === "string" &&
    typeof record.durationMs === "number" &&
    (record.error === null || typeof record.error === "string");
}

function decode(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}
