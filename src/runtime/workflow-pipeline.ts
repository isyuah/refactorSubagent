import type {
  BehaviorContract,
  BuildWorkflowOutput,
  CTestBaseline,
  CTestCandidate,
  CTestComparisonResult,
  DependencyManifest,
  HostPreflight,
  PatchRecord,
  ProjectDetection,
  ScopeManifest,
  TestSpec,
  WorkflowResolution,
} from "../artifacts/index.js";
import { EnvironmentSpec } from "../artifacts/index.js";
import { Orchestrator, type SubmitResult } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import { materializeTestWorkflow, type TestWorkflowResolution } from "../workflow/test-workflow.js";
import type { BuildWorkflowResolution } from "../workflow/build-workflow.js";
import { executeBuildWorkflow, type BuildWorkflowExecution } from "../workflow/build-executor.js";
import { classifyCTestBaseline, compareCTestSuites, createCTestCandidate } from "./ctest-comparator.js";
import { runCTest } from "./ctest-runner.js";
import type { WorktreePair } from "./worktree.js";
import type { E2ELogger } from "./e2e-log.js";

export interface WorkflowVerificationRequest {
  readonly repoPath: string;
  readonly worktrees: WorktreePair;
  readonly store: SessionStore;
  readonly logger?: E2ELogger;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly contract: BehaviorContract;
  readonly scope: ScopeManifest;
  readonly deps: DependencyManifest;
  readonly tests: TestSpec;
  readonly buildResolution: WorkflowResolution;
  readonly testResolution: WorkflowResolution;
  readonly build: BuildWorkflowResolution;
  readonly test: TestWorkflowResolution;
  readonly patch: Omit<PatchRecord, "kind" | "version" | "base_commit_sha">;
  readonly buildTimeoutMs?: number;
  readonly ctestTimeoutMs?: number;
  readonly knownEnvironmentPatterns?: readonly RegExp[];
}

export interface WorkflowVerificationOutcome {
  readonly state: string;
  readonly results: SubmitResult[];
  readonly baselineBuild: BuildWorkflowExecution | null;
  readonly candidateBuild: BuildWorkflowExecution | null;
  readonly baseline: CTestBaseline | null;
  readonly candidate: CTestCandidate | null;
  readonly comparison: CTestComparisonResult | null;
}

/**
 * Execute one complete Workflow-backed CTest verification attempt.
 *
 * Claude supplies the analysis artifacts and patch; this function owns every
 * execution decision after that point. Both worktrees receive the exact same
 * validated BuildWorkflow and materialized TestWorkflow.
 */
export async function runWorkflowVerification(
  request: WorkflowVerificationRequest,
): Promise<WorkflowVerificationOutcome> {
  const orch = new Orchestrator(request.store);
  const results: SubmitResult[] = [];
  const submit = (artifact: unknown): boolean => {
    const result = orch.submit(artifact);
    results.push(result);
    request.logger?.info(
      result.ok
        ? `state transition ${result.from} -> ${result.to}`
        : `artifact rejected: ${result.reason}`,
      result.ok
        ? { artifact: kindOf(artifact), to: result.to }
        : { artifact: kindOf(artifact), reason: result.reason },
    );
    if (!result.ok) {
      request.logger?.error(`workflow verification stopped: ${result.reason}`);
      results.push(orch.abort(`workflow verification rejected an artifact: ${result.reason}`));
      return false;
    }
    return true;
  };

  if (!submit(request.contract) ||
      !submit(request.scope) ||
      !submit(request.deps) ||
      !submit(request.tests) ||
      !submit(request.buildResolution) ||
      !submit(request.testResolution)) {
    return emptyOutcome(request.store.state, results);
  }

  // workflow-driven builds have no static plan at resolution time; the host
  // supplies the fixed environment shape and execution fills in the output.
  const environment = request.build.output === null
    ? EnvironmentSpec.parse({
        kind: "environment-spec",
        version: 1,
        build: { kind: "workflow-driven" },
        sanitizers: [],
        determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },
        sandbox: { run_cwd_strategy: "fresh_temp_dir" },
      })
    : EnvironmentSpec.parse(request.build.output.environment);
  if (!submit(environment)) return emptyOutcome(request.store.state, results);

  const suite = materializeTestWorkflow(request.test, {
    timeout_ms: request.ctestTimeoutMs ?? 1_200_000,
    parallelism: 1,
  });
  if (suite === null) {
    results.push(orch.abort("TestWorkflow is not a CTest workflow; this executor requires CTest"));
    return emptyOutcome(request.store.state, results);
  }

  const baselineBuild = await executeBuild(
    request,
    request.worktrees.baselineDir,
    "baseline",
  );
  if (baselineBuild.status !== "pass") {
    results.push(orch.abort(`baseline BuildWorkflow failed: ${baselineBuild.failure ?? "unknown failure"}`));
    return { ...emptyOutcome(request.store.state, results), baselineBuild };
  }

  const baselineResult = await runSuite(request, request.worktrees.baselineDir, suite, "baseline");
  const baseline = classifyCTestBaseline(baselineResult, {
    scopeFiles: request.scope.editable_files.map((target) => target.file),
    scopeSymbols: request.scope.editable_files.flatMap((target) => target.symbols),
    knownEnvironmentPatterns: request.knownEnvironmentPatterns,
  });
  request.store.saveArtifact(baseline);
  request.logger?.artifact("ctest-baseline.json", baseline);
  if (!submit(baseline)) {
    return { ...emptyOutcome(request.store.state, results), baselineBuild, baseline };
  }

  const patch: PatchRecord = {
    kind: "patch-record",
    version: 1,
    ...request.patch,
    base_commit_sha: request.worktrees.baseSha,
  };
  if (!submit(patch)) {
    return { ...emptyOutcome(request.store.state, results), baselineBuild, baseline };
  }

  const candidateBuild = await executeBuild(
    request,
    request.worktrees.candidateDir,
    "candidate",
  );
  if (candidateBuild.status !== "pass") {
    results.push(orch.abort(`candidate BuildWorkflow failed: ${candidateBuild.failure ?? "unknown failure"}`));
    return { ...emptyOutcome(request.store.state, results), baselineBuild, baseline, candidateBuild };
  }

  const candidateResult = await runSuite(request, request.worktrees.candidateDir, suite, "candidate");
  const candidate = createCTestCandidate(candidateResult);
  request.store.saveArtifact(candidate);
  request.logger?.artifact("ctest-candidate.json", candidate);
  if (!submit(candidate)) {
    return {
      ...emptyOutcome(request.store.state, results),
      baselineBuild,
      candidateBuild,
      baseline,
      candidate,
    };
  }

  const comparison = compareCTestSuites(baseline, candidate);
  request.store.saveArtifact(comparison);
  request.logger?.artifact("ctest-comparison-result.json", comparison);
  submit(comparison);
  return {
    state: request.store.state,
    results,
    baselineBuild,
    candidateBuild,
    baseline,
    candidate,
    comparison,
  };
}

async function executeBuild(
  request: WorkflowVerificationRequest,
  cwd: string,
  build: "baseline" | "candidate",
): Promise<BuildWorkflowExecution> {
  request.logger?.phase(`${build.toUpperCase()}_BUILD`);
  request.logger?.info(`executing ${build} BuildWorkflow`, {
    workflow_id: request.build.manifest.id,
    workflow_revision: request.build.manifest.revision,
    cwd,
  });
  const result = await executeBuildWorkflow({
    cwd,
    output: request.build.output,
    host: request.host,
    project: request.project,
    entry: request.build.entry,
    policy: {
      readableGlobs: ["**"],
      writableGlobs: request.build.output !== null && isWorkflowDriven(request.build.output)
        ? ["**"]
        : request.build.output === null
          ? ["**"]
          : ["build/**"],
      allowedTools: request.build.output === null
        ? []
        : requiredBuildTools(request.build.output),
      maxProcesses: 4,
      maxOutputBytes: 16 * 1024 * 1024,
      maxFileBytes: 64 * 1024 * 1024,
    },
    timeoutMs: request.buildTimeoutMs ?? 1_200_000,
  });
  request.logger?.artifact(`${build}-build.json`, result);
  for (const step of result.steps) {
    request.logger?.info(`${build} build step ${step.name}: ${step.status}`, {
      exit_code: step.exitCode,
      duration_ms: step.durationMs,
      error: step.error,
    });
  }
  return result;
}

function isWorkflowDriven(output: BuildWorkflowOutput): boolean {
  const build = output.environment.build;
  return "kind" in build && build.kind === "workflow-driven";
}

async function runSuite(
  request: WorkflowVerificationRequest,
  repoDir: string,
  spec: Parameters<typeof runCTest>[0]["spec"],
  build: "baseline" | "candidate",
) {
  request.logger?.phase(`${build.toUpperCase()}_CTEST`);
  const logName = `${build}-ctest.log`;
  request.logger?.logFile(logName, "");
  request.logger?.startHeartbeat(10_000);
  try {
    const result = await runCTest({
      repoDir,
      spec,
      host: request.host,
      requiredTopLevelTests: requiredTopLevelTests(request.test),
      onOutput: (stream, chunk) => {
        request.logger?.appendLogFile(logName, `[${stream}] ${chunk}`);
      },
    });
    request.logger?.artifact(`${build}-ctest-result.json`, result);
    request.logger?.info(`${build} CTest finished`, {
      status: result.status,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      failed_tests: result.failed_tests.map((failure) => failure.name),
    });
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
  return test.workflow.runner === "ctest" ? test.workflow.required_top_level_tests : [];
}

function emptyOutcome(
  state: string,
  results: SubmitResult[],
): WorkflowVerificationOutcome {
  return {
    state,
    results,
    baselineBuild: null,
    candidateBuild: null,
    baseline: null,
    candidate: null,
    comparison: null,
  };
}

function kindOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !("kind" in value)) return "unknown";
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "unknown";
}
