import type {
  BehaviorContract,
  BuildWorkflowOutput,
  CTestBaseline,
  CTestCandidate,
  CTestComparisonResult,
  DeclaredBuildSet as DeclaredBuildSetValue,
  DependencyManifest,
  HostPreflight,
  PatchRecord,
  ProjectDetection,
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
import type { Limits } from "../config/limits.js";
import type { WorkflowEvent } from "../workflow/types.js";
import { VerificationIntegrity, type IntegrityInput } from "./verification-integrity.js";
import {
  mergeVerificationMaterials,
  readVerificationMaterials,
  type VerificationMaterial,
} from "../workflow/verification-materials.js";

export interface WorkflowVerificationRequest {
  readonly repoPath: string;
  readonly worktrees: WorktreePair;
  readonly store: SessionStore;
  readonly logger?: E2ELogger;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly contract: BehaviorContract;
  readonly deps: DependencyManifest;
  readonly tests: TestSpec;
  readonly buildResolution: WorkflowResolution;
  readonly testResolution: WorkflowResolution;
  readonly build: BuildWorkflowResolution;
  readonly test: TestWorkflowResolution;
  /** Declared-set mode artifact (carries the whole declaration set). */
  readonly declaredSet?: DeclaredBuildSetValue;
  /** Declared build resolutions, in declaration order (executed each side). */
  readonly declaredBuilds?: readonly BuildWorkflowResolution[];
  readonly materials?: readonly VerificationMaterial[];
  readonly injectedFiles?: readonly IntegrityInput[];
  readonly patch: Omit<PatchRecord, "kind" | "version" | "base_commit_sha">;
  /** Resolved host limits; every stage budget and resource cap comes from here. */
  readonly limits: Limits;
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
  /** Self-driven test path: the declared-expectation comparison that decided the run. */
  readonly expectationComparison: ExpectationComparisonResult | null;
}

/**
 * Execute one complete workflow-backed differential verification attempt.
 *
 * Writers supply the workflows and patch; this function owns every
 * execution decision after that point. Both worktrees receive the exact same
 * validated BuildWorkflow and materialized TestWorkflow.
 */
export async function runWorkflowVerification(
  request: WorkflowVerificationRequest,
): Promise<WorkflowVerificationOutcome> {
  const orch = new Orchestrator(request.store);
  const results: SubmitResult[] = [];
  try {
    const builds = request.declaredBuilds ?? [request.build];
    const materials = mergeVerificationMaterials(request.materials ??
      builds.flatMap((build) => [...readVerificationMaterials(build.entry)]));
    if (request.declaredSet !== undefined) {
      const pins = new Map(request.declaredSet.builds.flatMap((build) =>
        (build.materials ?? []).map((material) => [material.path, material.sha256] as const)));
      if (pins.size !== materials.length || materials.some((material) => pins.get(material.path) !== material.sha256)) {
        throw new Error("verification materials do not match the declared build set");
      }
    }
    const integrity = new VerificationIntegrity({
      originalRepo: request.repoPath,
      worktrees: [
        { root: request.worktrees.baselineDir, commit: request.worktrees.baseSha },
        { root: request.worktrees.candidateDir, commit: request.patch.commit_sha },
      ],
      workflows: [...builds, request.test],
      materials,
      injectedFiles: request.injectedFiles,
    });
    request.logger?.artifact("verification-materials.json", { version: 1, materials });
    return await verifyWorkflows({ ...request, integrity }, orch, results);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    request.logger?.error(`workflow verification aborted: ${reason}`);
    results.push(orch.abort(reason));
    return emptyOutcome(request.store.state, results);
  }
}

interface CheckedVerificationRequest extends WorkflowVerificationRequest {
  readonly integrity: VerificationIntegrity;
}

async function verifyWorkflows(
  request: CheckedVerificationRequest,
  orch: Orchestrator,
  results: SubmitResult[],
): Promise<WorkflowVerificationOutcome> {
  const submit = (artifact: unknown): boolean => {
    const kind = kindOf(artifact);
    if (kind === "expectation-comparison-result" || kind === "ctest-comparison-result") {
      request.integrity.check("before submitting the verification verdict");
    }
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
      !submit(request.deps) ||
      !submit(request.tests)) {
    return emptyOutcome(request.store.state, results);
  }
  if (request.declaredSet !== undefined) {
    // Declared mode: the single DeclaredBuildSet artifact carries the whole
    // declaration (N build resolutions are executed later); it transitions
    // TESTS_READY -> BUILD_WORKFLOW_READY, then the declared test resolution
    // -> TEST_WORKFLOW_READY. No per-build workflow-resolution artifact exists
    // in this mode (the set is the audit record).
    if (!submit(request.declaredSet)) return emptyOutcome(request.store.state, results);
    if (!submit(request.testResolution)) return emptyOutcome(request.store.state, results);
  } else {
    if (!submit(request.buildResolution)) return emptyOutcome(request.store.state, results);
    if (!submit(request.testResolution)) return emptyOutcome(request.store.state, results);
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
    if (request.declaredBuilds !== undefined && request.declaredBuilds.length > 0) {
      const declaration = request.declaredSet?.builds;
      if (declaration !== undefined && declaration.length !== request.declaredBuilds.length) {
        throw new Error("resolved build count does not match the declared build set");
      }
      const buildList = request.declaredBuilds.map((resolution, index) => ({
        id: declaration === undefined ? resolution.manifest.id : declaration[index]!.id,
        resolution,
      }));
      return runDeclaredWorkflowVerification(request, orch, results, submit, environment, buildList);
    }
    return runSelfDrivenVerification(request, orch, results, submit, environment);
  }

  const suite = materializeTestWorkflow(request.test, {
    timeout_ms: request.limits.stages.ctestMs,
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
    expectationComparison: null,
  };
}

/**
 * Self-driven TestWorkflow path: build both worktrees, run the test workflow
 * once per side (it declares expectations via ctx.expect), then compare the
 * two sides' declarations by position with the declared relations.
 */
interface BuildToExecute {
  readonly id: string;
  readonly resolution: BuildWorkflowResolution;
}

async function runSelfDrivenVerification(
  request: CheckedVerificationRequest,
  orch: Orchestrator,
  results: SubmitResult[],
  submit: (artifact: unknown) => boolean,
  environment: unknown,
): Promise<WorkflowVerificationOutcome> {
  return runSelfDrivenCore(
    request, orch, results, submit, environment,
    [{ id: request.build.manifest.id, resolution: request.build }],
  );
}

async function runSelfDrivenCore(
  request: CheckedVerificationRequest,
  orch: Orchestrator,
  results: SubmitResult[],
  submit: (artifact: unknown) => boolean,
  environment: unknown,
  buildList: readonly BuildToExecute[],
): Promise<WorkflowVerificationOutcome> {
  const empty = (extra: Record<string, unknown> = {}) => ({
    ...emptyOutcome(request.store.state, results),
    ...extra,
  });

  // Run every build in the (declaration) set on the baseline worktree.
  const baselineBuild = await executeBuildList(request, request.worktrees.baselineDir, "baseline", buildList);
  if (baselineBuild.status !== "pass") {
    results.push(orch.abort(`baseline BuildWorkflow failed: ${baselineBuild.failure ?? "unknown failure"}`));
    return empty({ baselineBuild });
  }

  const baselineRun = await runObservedTest(request, request.worktrees.baselineDir, "baseline");
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

  const candidateBuild = await executeBuildList(request, request.worktrees.candidateDir, "candidate", buildList);
  if (candidateBuild.status !== "pass") {
    results.push(orch.abort(`candidate BuildWorkflow failed: ${candidateBuild.failure ?? "unknown failure"}`));
    return empty({ baselineBuild, candidateBuild });
  }

  const candidateRun = await runObservedTest(request, request.worktrees.candidateDir, "candidate");
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
    expectationComparison: comparisonArtifact,
  };
}

async function runObservedTest(
  request: CheckedVerificationRequest,
  cwd: string,
  side: "baseline" | "candidate",
) {
  request.logger?.phase(`${side.toUpperCase()}_TEST_WORKFLOW`);
  request.integrity.check(`before ${side} test workflow`);
  const result = await runTestSide(request.test.entry, cwd, {
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
  return result;
}

function testWorkflowPolicy(request: WorkflowVerificationRequest) {
  const caps = request.limits.resources.test;
  return {
    readableGlobs: ["**"],
    writableGlobs: ["**"],
    // The self-driven test workflow runs the artifacts the declared builds
    // produced (assertFile first, then process.run). Allow executables under
    // the build tree only — never arbitrary programs.
    executableGlobs: ["build/**"],
    allowedTools: [],
    maxProcesses: caps.maxProcesses,
    maxOutputBytes: caps.maxOutputBytes,
    maxFileBytes: caps.maxFileBytes,
    processTimeoutMs: request.limits.commands.processMs,
    readyTimeoutMs: request.limits.commands.readyMs,
  };
}

/**
 * Run every build in a (declaration) set on one worktree, sequentially.
 * Stops at the first failure (fail-closed). Single-build callers pass one item.
 */
async function executeBuildList(
  request: CheckedVerificationRequest,
  cwd: string,
  side: "baseline" | "candidate",
  buildList: readonly BuildToExecute[],
): Promise<BuildWorkflowExecution> {
  let last: BuildWorkflowExecution | null = null;
  for (const [index, item] of buildList.entries()) {
    request.logger?.info(`executing ${side} build ${item.id}`, { cwd });
    const result = await executeBuildFor(
      request,
      item.resolution,
      cwd,
      side,
      `${side}-build-${index + 1}-${item.id.replace(/[^A-Za-z0-9._-]/g, "_")}`,
    );
    last = result;
    if (result.status !== "pass") {
      return {
        ...result,
        failure: `build ${item.id} failed: ${result.failure ?? result.status}`,
      };
    }
  }
  return last ?? {
    status: "pass",
    artifact: { kind: "custom", version: 1, workflow_id: "", workflow_revision: 0, paths: {}, metadata: {} },
    steps: [],
    missingArtifacts: [],
    events: [],
    failure: null,
  };
}

async function executeBuild(
  request: CheckedVerificationRequest,
  cwd: string,
  build: "baseline" | "candidate",
): Promise<BuildWorkflowExecution> {
  return executeBuildFor(request, request.build, cwd, build, `${build}-build`);
}

/** Execute one build workflow resolution in one worktree. */
async function executeBuildFor(
  request: CheckedVerificationRequest,
  resolution: BuildWorkflowResolution,
  cwd: string,
  side: "baseline" | "candidate",
  artifactName: string,
): Promise<BuildWorkflowExecution> {
  request.integrity.check(`before ${side} build ${resolution.manifest.id}`);
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
  return result;
}

function isWorkflowDriven(output: BuildWorkflowOutput): boolean {
  const build = output.environment.build;
  return "kind" in build && build.kind === "workflow-driven";
}

async function runSuite(
  request: CheckedVerificationRequest,
  repoDir: string,
  spec: Parameters<typeof runCTest>[0]["spec"],
  build: "baseline" | "candidate",
) {
  request.integrity.check(`before ${build} CTest`);
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
    request.integrity.check(`after ${build} CTest`);
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
    expectationComparison: null,
  };
}

function kindOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !("kind" in value)) return "unknown";
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "unknown";
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

/**
 * Declared-set workflow verification (subagent-driven flow). The test-writer
 * session declared N build workflows; the host executes every one on both
 * worktrees, then runs the self-driven test workflow once per side and compares
 * expectations. Mirrors runSelfDrivenVerification but over a build list.
 */
async function runDeclaredWorkflowVerification(
  request: CheckedVerificationRequest,
  orch: Orchestrator,
  results: SubmitResult[],
  submit: (artifact: unknown) => boolean,
  environment: unknown,
  builds: readonly BuildToExecute[],
): Promise<WorkflowVerificationOutcome> {
  return runSelfDrivenCore(request, orch, results, submit, environment, builds);
}
