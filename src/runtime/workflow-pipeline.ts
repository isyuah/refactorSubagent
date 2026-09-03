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
import { runTestSide } from "../workflow/test-executor.js";
import { compareExpectations } from "../workflow/expectation-compare.js";
import {
  ExpectationBaseline,
  ExpectationCandidate,
  ExpectationComparisonResult,
} from "../artifacts/index.js";
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

  // Self-driven test workflows (workflow === null) execute their own test
  // logic once per worktree and declare expectations; the host compares.
  if (request.test.workflow === null) {
    return runSelfDrivenVerification(request, orch, results, submit, environment);
  }

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

/**
 * Self-driven TestWorkflow path: build both worktrees, run the test workflow
 * once per side (it declares expectations via ctx.expect), then compare the
 * two sides' declarations by position with the declared relations.
 */
async function runSelfDrivenVerification(
  request: WorkflowVerificationRequest,
  orch: Orchestrator,
  results: SubmitResult[],
  submit: (artifact: unknown) => boolean,
  environment: unknown,
): Promise<WorkflowVerificationOutcome> {
  const empty = (extra: Record<string, unknown> = {}) => ({
    ...emptyOutcome(request.store.state, results),
    ...extra,
  });

  const baselineBuild = await executeBuild(request, request.worktrees.baselineDir, "baseline");
  if (baselineBuild.status !== "pass") {
    results.push(orch.abort(`baseline BuildWorkflow failed: ${baselineBuild.failure ?? "unknown failure"}`));
    return empty({ baselineBuild });
  }

  request.logger?.phase("BASELINE_TEST_WORKFLOW");
  const baselineRun = await runTestSide(request.test.entry, request.worktrees.baselineDir, {
    host: request.host,
    project: request.project,
    policy: testWorkflowPolicy(request),
    input: {
      kind: "test-workflow-input",
      version: 1,
      build_workflow_id: request.build.manifest.id,
      build_workflow_revision: request.build.manifest.revision,
    },
    timeoutMs: request.ctestTimeoutMs ?? 1_200_000,
  });
  if (baselineRun.status !== "pass") {
    results.push(orch.abort(`baseline test workflow failed: ${baselineRun.failure ?? baselineRun.status}`));
    return empty({ baselineBuild });
  }
  const baselineArtifact = ExpectationBaseline.parse({
    kind: "expectation-baseline",
    version: 1,
    workflow_passed: true,
    expectations: baselineRun.expectations,
  });
  request.store.saveArtifact(baselineArtifact);
  request.logger?.artifact("expectation-baseline.json", baselineArtifact);
  if (!submit(baselineArtifact)) return empty({ baselineBuild });

  const patch: PatchRecord = {
    kind: "patch-record",
    version: 1,
    ...request.patch,
    base_commit_sha: request.worktrees.baseSha,
  };
  if (!submit(patch)) return empty({ baselineBuild });

  const candidateBuild = await executeBuild(request, request.worktrees.candidateDir, "candidate");
  if (candidateBuild.status !== "pass") {
    results.push(orch.abort(`candidate BuildWorkflow failed: ${candidateBuild.failure ?? "unknown failure"}`));
    return empty({ baselineBuild, candidateBuild });
  }

  request.logger?.phase("CANDIDATE_TEST_WORKFLOW");
  const candidateRun = await runTestSide(request.test.entry, request.worktrees.candidateDir, {
    host: request.host,
    project: request.project,
    policy: testWorkflowPolicy(request),
    input: {
      kind: "test-workflow-input",
      version: 1,
      build_workflow_id: request.build.manifest.id,
      build_workflow_revision: request.build.manifest.revision,
    },
    timeoutMs: request.ctestTimeoutMs ?? 1_200_000,
  });
  if (candidateRun.status !== "pass") {
    results.push(orch.abort(`candidate test workflow failed: ${candidateRun.failure ?? candidateRun.status}`));
    return empty({ baselineBuild, candidateBuild });
  }
  const candidateArtifact = ExpectationCandidate.parse({
    kind: "expectation-candidate",
    version: 1,
    workflow_passed: true,
    expectations: candidateRun.expectations,
  });
  request.store.saveArtifact(candidateArtifact);
  request.logger?.artifact("expectation-candidate.json", candidateArtifact);
  if (!submit(candidateArtifact)) {
    return empty({ baselineBuild, candidateBuild });
  }

  const comparison = compareExpectations(baselineRun.expectations, candidateRun.expectations);
  const consistent = comparison.overall === "consistent";
  const reason = consistent
    ? `all ${String(comparison.matched.length)} expectation(s) consistent`
    : [
        ...comparison.errors,
        ...comparison.mismatched.map((m) => `'${m.declaration.name}': ${m.reason}`),
      ].join("; ") || "expectations inconsistent";
  const comparisonArtifact = ExpectationComparisonResult.parse({
    kind: "expectation-comparison-result",
    version: 1,
    overall: consistent ? "consistent" : "inconsistent",
    declarations: [
      ...comparison.matched.map((m) => ({
        name: m.declaration.name,
        relation: m.declaration.relation,
        matched: true,
        reason: "",
      })),
      ...comparison.mismatched.map((m) => ({
        name: m.declaration.name,
        relation: m.declaration.relation,
        matched: false,
        reason: m.reason,
      })),
    ],
    errors: comparison.errors,
    reason,
  });
  request.store.saveArtifact(comparisonArtifact);
  request.logger?.artifact("expectation-comparison-result.json", comparisonArtifact);
  submit(comparisonArtifact);
  return {
    state: request.store.state,
    results,
    baselineBuild,
    candidateBuild,
    baseline: null,
    candidate: null,
    comparison: null,
  };
}

function testWorkflowPolicy(request: WorkflowVerificationRequest) {
  return {
    readableGlobs: ["**"],
    writableGlobs: ["**"],
    allowedTools: [],
    maxProcesses: 4,
    maxOutputBytes: 32 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
  };
}

async function executeBuild(
  request: WorkflowVerificationRequest,
  cwd: string,
  build: "baseline" | "candidate",
): Promise<BuildWorkflowExecution> {
  return executeBuildFor(request, request.build, cwd, build, `${build}-build`);
}

/** Execute one build workflow resolution in one worktree. */
async function executeBuildFor(
  request: WorkflowVerificationRequest,
  resolution: BuildWorkflowResolution,
  cwd: string,
  side: "baseline" | "candidate",
  artifactName: string,
): Promise<BuildWorkflowExecution> {
  request.logger?.phase(`${side.toUpperCase()}_BUILD`);
  request.logger?.info(`executing ${side} BuildWorkflow`, {
    workflow_id: resolution.manifest.id,
    workflow_revision: resolution.manifest.revision,
    cwd,
  });
  const result = await executeBuildWorkflow({
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
      allowedTools: resolution.output === null
        ? []
        : requiredBuildTools(resolution.output),
      maxProcesses: 4,
      maxOutputBytes: 16 * 1024 * 1024,
      maxFileBytes: 64 * 1024 * 1024,
    },
    timeoutMs: request.buildTimeoutMs ?? 1_200_000,
  });
  request.logger?.artifact(`${artifactName}.json`, result);
  for (const step of result.steps) {
    request.logger?.info(`${side} build step ${step.name}: ${step.status}`, {
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
  return test.workflow !== null && test.workflow.runner === "ctest"
    ? test.workflow.required_top_level_tests
    : [];
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
