import type { BuildWorkflowOutput, HostPreflight, ProjectDetection } from "../artifacts/index.js";
import type { Limits } from "../config/limits.js";
import { executeBuildWorkflow, type BuildWorkflowExecution } from "../workflow/build-executor.js";
import type { BuildWorkflowResolution } from "../workflow/build-workflow.js";
import type { TestWorkflowResolution } from "../workflow/test-workflow.js";
import { runTestSide } from "../workflow/test-executor.js";
import type { WorkflowEvent } from "../workflow/types.js";
import { runCTest } from "./ctest-runner.js";
import { workflowProgress, nativeLogPath } from "./workflow-progress.js";
import type { E2ELogger } from "./e2e-log.js";

export interface SideExecutionRequest {
  readonly signal?: AbortSignal;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly test: TestWorkflowResolution;
  readonly limits: Limits;
  readonly logger?: E2ELogger;
  readonly integrity: { check(label: string): void };
}

export async function runObservedTest(
  request: SideExecutionRequest,
  cwd: string,
  side: "baseline" | "candidate",
) {
  request.logger?.phase(`${side.toUpperCase()}_TEST_WORKFLOW`);
  request.integrity.check(`before ${side} test workflow`);
  const started = performance.now();
  const logPath = nativeLogPath(request.logger, `${side}-test-workflow.log`);
  request.logger?.progress({ type: "test", side, status: "running" });
  try {
    const result = await runTestSide(request.test.entry, cwd, {
      signal: request.signal,
      onProgress: workflowProgress(request.logger, { side, log_path: logPath }),
      host: request.host,
      project: request.project,
      policy: testWorkflowPolicy(request),
      input: { kind: "test-workflow-input", version: 1 },
      timeoutMs: request.limits.stages.testWorkflowMs ?? undefined,
    });
    request.logger?.artifact(`${side}-test-workflow-run.json`, result);
    request.integrity.check(`after ${side} test workflow`);
    const executionFailure = invalidExecution(result.events);
    if (executionFailure !== null) throw new Error(`${side} test workflow has an invalid process execution: ${executionFailure}`);
    if (result.status === "pass" && !result.events.some((event) => event.ok &&
        ((event.capability === "process" && (event.method === "run" || event.method === "wait")) ||
         (event.capability === "fs" && ["readFile", "snapshot", "diff"].includes(event.method))))) {
      throw new Error(`${side} test workflow did not run or read any implementation artifact`);
    }
    request.logger?.progress({ type: "test", side, status: result.status === "pass" ? "pass" : "failed",
      duration_ms: Math.round(performance.now() - started), failure: result.failure,
      checks: result.expectations.length, evidence_path: `${side}-test-workflow-run.json` });
    return result;
  } catch (error) {
    request.logger?.progress({ type: "test", side, status: "failed", duration_ms: Math.round(performance.now() - started),
      failure: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function testWorkflowPolicy(request: SideExecutionRequest) {
  const caps = request.limits.resources.test;
  return {
    readableGlobs: ["**"],
    writableGlobs: ["**"],
    // Projects may produce executables outside build/ (e.g. src/redis-server).
    // The broker still checks workspace containment and rejects symlink escapes.
    executableGlobs: ["**"],
    allowedTools: [],
    maxProcesses: caps.maxProcesses,
    maxOutputBytes: caps.maxOutputBytes,
    maxFileBytes: caps.maxFileBytes,
    processTimeoutMs: request.limits.commands.processMs,
    readyTimeoutMs: request.limits.commands.readyMs,
  };
}

/** Execute one build workflow resolution in one worktree. */
export async function executeBuildFor(
  request: SideExecutionRequest,
  resolution: BuildWorkflowResolution,
  cwd: string,
  side: "baseline" | "candidate",
  artifactName: string,
  buildId: string,
): Promise<BuildWorkflowExecution> {
  request.integrity.check(`before ${side} build ${resolution.manifest.id}`);
  request.logger?.phase(`${side.toUpperCase()}_BUILD`);
  request.logger?.info(`executing ${side} BuildWorkflow`, {
    workflow_id: resolution.manifest.id,
    workflow_revision: resolution.manifest.revision,
    cwd,
  });
  const started = performance.now();
  const logPath = nativeLogPath(request.logger, `${artifactName}.log`);
  request.logger?.progress({ type: "build", side, id: buildId, status: "running" });
  try {
    const result = await executeBuildWorkflow({
      signal: request.signal,
      onProgress: workflowProgress(request.logger, { side, build_id: buildId, log_path: logPath }),
      cwd,
      output: resolution.output,
      host: request.host,
      project: request.project,
      entry: resolution.entry,
      policy: {
        readableGlobs: ["**"],
        writableGlobs: resolution.output !== null && isWorkflowDriven(resolution.output)
          ? ["**"]
          : resolution.output === null
            ? ["**"]
            : ["build/**"],
        // Build scripts may run this worktree's artifacts for smoke checks.
        executableGlobs: ["**"],
        allowedTools: resolution.output === null
          ? []
          : requiredBuildTools(resolution.output),
        maxProcesses: request.limits.resources.build.maxProcesses,
        maxOutputBytes: request.limits.resources.build.maxOutputBytes,
        maxFileBytes: request.limits.resources.build.maxFileBytes,
        processTimeoutMs: request.limits.commands.processMs,
        readyTimeoutMs: request.limits.commands.readyMs,
      },
      timeoutMs: request.limits.stages.buildMs ?? undefined,
    });
    request.logger?.artifact(`${artifactName}.json`, result);
    request.integrity.check(`after ${side} build ${resolution.manifest.id}`);
    const executionFailure = invalidExecution(result.events);
    if (executionFailure !== null) throw new Error(`${side} build has an invalid process execution: ${executionFailure}`);
    for (const step of result.steps) {
      request.logger?.info(`${side} build step ${step.name}: ${step.status}`, {
        exit_code: step.exitCode,
        duration_ms: step.durationMs,
        error: step.error,
      });
    }
    request.logger?.progress({ type: "build", side, id: buildId, status: result.status === "pass" ? "pass" : "failed",
      duration_ms: Math.round(performance.now() - started), failure: result.failure, evidence_path: `${artifactName}.json` });
    return result;
  } catch (error) {
    request.logger?.progress({ type: "build", side, id: buildId, status: "failed", duration_ms: Math.round(performance.now() - started),
      failure: error instanceof Error ? error.message : String(error), evidence_path: `${artifactName}.json` });
    throw error;
  }
}

function isWorkflowDriven(output: BuildWorkflowOutput): boolean {
  const build = output.environment.build;
  return "kind" in build && build.kind === "workflow-driven";
}

export async function runSuite(
  request: SideExecutionRequest,
  repoDir: string,
  spec: Parameters<typeof runCTest>[0]["spec"],
  build: "baseline" | "candidate",
) {
  request.integrity.check(`before ${build} CTest`);
  request.logger?.phase(`${build.toUpperCase()}_CTEST`);
  const logName = `${build}-ctest.log`;
  const logPath = nativeLogPath(request.logger, logName);
  const onProgress = workflowProgress(request.logger, { side: build, log_path: logPath });
  request.logger?.progress({ type: "test", side: build, status: "running" });
  request.logger?.startHeartbeat(10_000);
  try {
    const result = await runCTest({
      signal: request.signal,
      repoDir,
      spec,
      host: request.host,
      onProgress,
      requiredTopLevelTests: requiredTopLevelTests(request.test),
    });
    request.logger?.artifact(`${build}-ctest-result.json`, result);
    request.integrity.check(`after ${build} CTest`);
    request.logger?.info(`${build} CTest finished`, {
      status: result.status,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      failed_tests: result.failed_tests.map((failure) => failure.name),
    });
    request.logger?.progress({ type: "test", side: build, status: result.status === "pass" ? "pass" : "failed",
      duration_ms: result.duration_ms, failure: result.failure?.explanation ?? null,
      ctest_tests: result.summary.total, evidence_path: `${build}-ctest-result.json` });
    return result;
  } finally {
    request.logger?.stopHeartbeat();
  }
}

function requiredBuildTools(output: BuildWorkflowOutput): string[] {
  const build = output.environment.build;
  if ("kind" in build && build.kind === "cmake") return ["cmake"];
  if ("kind" in build && build.kind === "ninja") return ["ninja"];
  if ("kind" in build && build.kind === "direct-compiler") return [build.compiler];
  return [];
}

function requiredTopLevelTests(test: TestWorkflowResolution): readonly string[] {
  return test.workflow !== null && test.workflow.runner === "ctest"
    ? test.workflow.required_top_level_tests
    : [];
}

/** Negative test exit codes are allowed; infrastructure failures never prove behavior. */
function invalidExecution(events: readonly WorkflowEvent[]): string | null {
  for (const event of events) {
    if (event.execution !== undefined &&
        ["timeout", "output_limit", "spawn_error"].includes(event.execution.status)) {
      return event.execution.status;
    }
    if (!event.ok && event.capability === "process") return event.error ?? "process capability failed";
  }
  return null;
}
