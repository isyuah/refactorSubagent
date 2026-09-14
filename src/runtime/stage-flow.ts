import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { curateBuildWorkflow, loadAliases } from "../workflow/curator.js";
import { analyzeRepo, type AnalysisResult } from "../agents/analyze.js";
import { runRefactor } from "../agents/refactor.js";
import { runWorkflowSession } from "../agents/workflow-session.js";
import { LocalDependencyRegistry } from "../agents/dep-registry.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import {
  resolveDeclaredWorkflows,
  type ResolvedDeclaredWorkflows,
} from "../workflow/resolve-declared.js";
import { E2ELogger } from "./e2e-log.js";
import { FileSessionStore } from "./session-store.js";
import { detectCProject } from "./project-detector.js";
import { probeHost } from "./host-preflight.js";
import { runWorkflowVerification, type WorkflowVerificationOutcome } from "./workflow-pipeline.js";
import { commitCandidateChanges, createWorktrees, resolveHead, type WorktreePair } from "./worktree.js";
import type {
  BehaviorContract,
  DeclaredBuildSet as DeclaredBuildSetValue,
  DependencyManifest,
  TestSpec,
  WorkflowResolution,
} from "../artifacts/index.js";
import type { TestWorkflowResolution } from "../workflow/test-workflow.js";
import type { BuildWorkflowResolution } from "../workflow/build-workflow.js";
import {
  describeLimits,
  resolveLimits,
  type Limits,
  type SessionLimits,
} from "../config/limits.js";
import type { LayerOverrides } from "../config/layers.js";

/**
 * stage-flow — the pipeline as a flow of typed stages.
 *
 * The state machine (Orchestrator) and every execution decision belong to the
 * host; a stage only produces the next input of the flow. Stages can be
 * replaced per run (`flow`), which is how one capability at a time gets tested
 * through the REAL pipeline instead of a unit test that re-implements it:
 *
 *   runStageFlow({ ...req, flow: { workflows: presetWorkflowsStage(spec) } })
 *   runStageFlow({ ...req, flow: { refactor: patchRefactorStage("fix.patch") } })
 *
 * Host-owned invariants, never replaceable by a stage:
 *   - artifact submission and state transitions (Orchestrator);
 *   - the candidate commit and the diff measurement against the base commit;
 *   - the gate sequence: project detection, non-empty change set, non-empty
 *     declared build set;
 *   - worktree cleanup and run-local build promotion.
 *
 * The verification stage CAN be replaced, but a run that replaced it is
 * recorded as non-authoritative (`stage-provenance.json` and
 * `result.provenance.verification_authoritative`): a verdict must never be
 * mistaken for a host-measured one.
 */

/** Stages in execution order. */
export const STAGE_NAMES = [
  "preflight",
  "analyze",
  "workflows",
  "prepare",
  "refactor",
  "verify",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

/** A stage may refuse to continue; the composer turns this into an abort. */
export interface StageHalt {
  readonly halt: true;
  readonly reason: string;
}

export function halt(reason: string): StageHalt {
  return { halt: true, reason };
}

export type StageResult<T> = T | StageHalt;

export function isHalt<T>(value: StageResult<T>): value is StageHalt {
  const maybe = value as { halt?: unknown } | null;
  return typeof value === "object" && maybe !== null && maybe.halt === true;
}

export interface StageFlowRequest {
  /** Git repository containing the base C project. */
  readonly repoPath: string;
  /** Natural-language refactoring task given to Analyze and Refactor agents. */
  readonly task: string;
  /** Root under which the durable session is created. */
  readonly sessionRoot: string;
  readonly sessionId: string;
  /** CLI layers on top of the user/project config files (see config/limits). */
  readonly limitOverrides?: LayerOverrides;
  readonly knownEnvironmentPatterns?: readonly RegExp[];
  readonly logger?: E2ELogger;
  /** Stage implementations; omitted stages use the host defaults. */
  readonly flow?: StageFlow;
}

export interface DeclaredAgentResolution {
  /** DeclaredBuildSet artifact carrying the whole declaration. */
  readonly declaredSet: DeclaredBuildSetValue;
  readonly testResolution: TestWorkflowResolution;
  /** Resolved build workflows, in declaration order. */
  readonly buildResolutions: readonly BuildWorkflowResolution[];
  readonly testSource: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
}

/** Which stages came from the caller instead of the host. */
export interface StageProvenance {
  readonly injected: readonly StageName[];
  /** False when the caller replaced the verification stage. */
  readonly verification_authoritative: boolean;
}

export interface StageFlowResult {
  readonly store: SessionStore;
  readonly state: string;
  readonly refactorSummary: string;
  readonly analysis: AnalysisResult | null;
  readonly declared: DeclaredAgentResolution | null;
  readonly verification: WorkflowVerificationOutcome | null;
  readonly provenance: StageProvenance;
  readonly logDir: string;
}

/** Everything a stage may read; run configuration plus host-owned accumulators. */
export interface StageContext {
  readonly repoPath: string;
  readonly task: string;
  readonly sessionRoot: string;
  readonly sessionId: string;
  /** Durable session: artifact submission and state transitions. */
  readonly store: SessionStore;
  readonly logger: E2ELogger;
  readonly sessionStore: FileSessionStore;
  readonly limits: Limits;
  readonly knownEnvironmentPatterns?: readonly RegExp[];
}

export interface PreflightOutcome {
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
}

export interface AnalysisOutcome {
  readonly analysis: AnalysisResult;
}

export interface WorkflowsOutcome {
  readonly declared: DeclaredAgentResolution;
}

/** Branch + worktree pair the refactor stage edits and verification measures. */
export interface CandidateWorkspace {
  readonly branch: string;
  readonly baseSha: string;
  readonly worktrees: WorktreePair;
}

export interface RefactorOutcome {
  readonly summary: string;
}

/** Host-measured candidate facts handed to the verification stage. */
export interface PatchFacts {
  readonly branch: string;
  readonly base_sha: string;
  readonly commit_sha: string;
  readonly changed_files: readonly string[];
  readonly summary: string;
}

export interface RefactorStageInput {
  readonly preflight: PreflightOutcome;
  readonly analysis: AnalysisOutcome | null;
  readonly workflows: WorkflowsOutcome;
  readonly candidate: CandidateWorkspace;
}

export interface VerifyStageInput {
  readonly preflight: PreflightOutcome;
  readonly analysis: AnalysisOutcome | null;
  readonly workflows: WorkflowsOutcome;
  readonly candidate: CandidateWorkspace;
  readonly refactor: RefactorOutcome;
  readonly patch: PatchFacts;
}

export type PreflightStage = (ctx: StageContext) => Promise<StageResult<PreflightOutcome>>;
export type AnalyzeStage = (
  ctx: StageContext,
  input: { readonly preflight: PreflightOutcome },
) => Promise<StageResult<AnalysisOutcome>>;
export type WorkflowsStage = (
  ctx: StageContext,
  input: { readonly preflight: PreflightOutcome; readonly analysis: AnalysisOutcome | null },
) => Promise<StageResult<WorkflowsOutcome>>;
export type PrepareStage = (
  ctx: StageContext,
  input: { readonly preflight: PreflightOutcome; readonly workflows: WorkflowsOutcome },
) => Promise<StageResult<CandidateWorkspace>>;
export type RefactorStage = (
  ctx: StageContext,
  input: RefactorStageInput,
) => Promise<StageResult<RefactorOutcome>>;
export type VerifyStage = (
  ctx: StageContext,
  input: VerifyStageInput,
) => Promise<StageResult<WorkflowVerificationOutcome>>;

/** Replaceable stages. Every omission falls back to the host default (AI-backed). */
export interface StageFlow {
  readonly preflight?: PreflightStage;
  readonly analyze?: AnalyzeStage;
  readonly workflows?: WorkflowsStage;
  readonly prepare?: PrepareStage;
  readonly refactor?: RefactorStage;
  readonly verify?: VerifyStage;
}

/**
 * Run one complete pipeline: the host composes the stages, owns the state
 * machine, and measures everything that a verdict depends on.
 */
export async function runStageFlow(req: StageFlowRequest): Promise<StageFlowResult> {
  const flow = req.flow ?? {};
  const provenance: StageProvenance = {
    injected: STAGE_NAMES.filter((name) => flow[name] !== undefined),
    verification_authoritative: flow.verify === undefined,
  };
  const store = SessionStore.create(req.sessionRoot, req.sessionId);
  const orch = new Orchestrator(store);
  const { limits, sources: limitSources, missing: missingLimitFiles } = resolveLimits({
    repoRoot: req.repoPath,
    overrides: req.limitOverrides,
  });
  writeFileSync(
    join(store.sessionDir, "limits.json"),
    JSON.stringify({ resolved: limits, sources: limitSources, missing: missingLimitFiles }, null, 2) + "\n",
  );
  const logger = req.logger ?? new E2ELogger(
    join(req.sessionRoot, ".refactor", "e2e"),
    req.sessionId,
  );
  logger.info(`limits resolved: ${describeLimits(limits)}`, {
    sources: limitSources,
    missing: missingLimitFiles,
  });
  // Mirror every AI session transcript (tool calls, subagent text, results)
  // under the run dir so slow runs can be analyzed at full fidelity without
  // raising the run.jsonl log level. One adapter per run; the SDK key is
  // {projectKey, sessionId} so each session lands in its own file.
  const sessionStore = new FileSessionStore(logger.runDir);
  const ctx: StageContext = {
    repoPath: req.repoPath,
    task: req.task,
    sessionRoot: req.sessionRoot,
    sessionId: req.sessionId,
    store,
    logger,
    sessionStore,
    limits,
    ...(req.knownEnvironmentPatterns !== undefined
      ? { knownEnvironmentPatterns: req.knownEnvironmentPatterns }
      : {}),
  };
  let analysis: AnalysisResult | null = null;
  let declared: DeclaredAgentResolution | null = null;
  let verification: WorkflowVerificationOutcome | null = null;
  let refactorSummary = "";
  let worktrees: WorktreePair | null = null;
  const done = (): StageFlowResult =>
    result(store, logger, analysis, declared, verification, refactorSummary, provenance);

  try {
    logger.phase("PREFLIGHT");
    logger.artifact("stage-provenance.json", provenance);
    if (provenance.injected.length > 0) {
      logger.info("stage flow overrides active", {
        injected: provenance.injected.join(", "),
        verification_authoritative: provenance.verification_authoritative,
      });
    }
    const preflight = await (flow.preflight ?? defaultPreflightStage)(ctx);
    if (isHalt(preflight)) {
      abort(orch, logger, preflight.reason);
      return done();
    }
    if (preflight.project.status !== "ready") {
      abort(orch, logger, `project build detection blocked: ${preflight.project.reason}`);
      return done();
    }

    logger.phase("ANALYSIS");
    const analyzed = await (flow.analyze ?? defaultAnalyzeStage)(ctx, { preflight });
    if (isHalt(analyzed)) {
      abort(orch, logger, analyzed.reason);
      return done();
    }
    analysis = analyzed.analysis;

    logger.phase("WORKFLOW_SESSION");
    const workflows = await (flow.workflows ?? defaultWorkflowsStage)(ctx, {
      preflight,
      analysis: analyzed,
    });
    if (isHalt(workflows)) {
      abort(orch, logger, workflows.reason);
      return done();
    }
    declared = workflows.declared;

    const prepared = await (flow.prepare ?? defaultPrepareStage)(ctx, { preflight, workflows });
    if (isHalt(prepared)) {
      abort(orch, logger, prepared.reason);
      return done();
    }
    worktrees = prepared.worktrees;

    logger.phase("REFACTOR");
    const refactored = await (flow.refactor ?? defaultRefactorStage)(ctx, {
      preflight,
      analysis: analyzed,
      workflows,
      candidate: prepared,
    });
    if (isHalt(refactored)) {
      abort(orch, logger, refactored.reason);
      return done();
    }
    refactorSummary = refactored.summary;
    logger.artifact("refactor-summary.json", { summary: refactored.summary });
    logger.info("refactor stage completed", { stage_source: flow.refactor === undefined ? "agent" : "injected" });

    // The host measures the candidate itself: a stage reports a summary, never
    // the change set, and a stage that changed nothing cannot reach verification.
    const summaryLine = firstSummaryLine(refactored.summary) ?? req.task;
    const changedFiles = commitCandidateChanges(prepared.worktrees.candidateDir, prepared.baseSha, summaryLine);
    if (changedFiles.length === 0) {
      abort(orch, logger, "refactor agent made no changes");
      return done();
    }
    const patch: PatchFacts = {
      branch: prepared.branch,
      base_sha: prepared.baseSha,
      commit_sha: gitIn(prepared.worktrees.candidateDir, ["rev-parse", "HEAD"]),
      changed_files: changedFiles,
      summary: summaryLine.slice(0, 500),
    };
    logger.artifact("patch-candidate.json", patch);

    logger.phase("VERIFICATION");
    if (declared === null || declared.buildResolutions.length === 0) {
      abort(orch, logger, "declared workflow resolution missing or empty build set");
      return done();
    }
    logger.info("workflow verification started", { phase_detail: "all builds + ctest both sides" });
    const verificationStarted = performance.now();
    const verified = await (flow.verify ?? defaultVerifyStage)(ctx, {
      preflight,
      analysis: analyzed,
      workflows,
      candidate: prepared,
      refactor: refactored,
      patch,
    });
    if (isHalt(verified)) {
      abort(orch, logger, verified.reason);
      return done();
    }
    verification = verified;
    logger.info("workflow verification completed", {
      duration_ms: Math.round(performance.now() - verificationStarted),
    });
    return done();
  } catch (error) {
    const reason = errorMessage(error);
    abort(orch, logger, reason);
    return done();
  } finally {
    timed(logger, "worktree cleanup", () => {
      worktrees?.cleanup();
    });
    if (store.state === "ACCEPTED") {
      await promoteRunLocalBuilds(declared, req.repoPath, logger);
      logger.finish("accepted", "workflow verification accepted candidate");
    }
    else if (store.state === "REJECTED") logger.finish("rejected", "workflow verification rejected candidate");
    else if (store.state === "ABORTED") logger.finish("aborted", "workflow verification aborted");
    logger.close();
  }
}

/** Host default: measure the host and detect the project. */
export const defaultPreflightStage: PreflightStage = async (ctx) => {
  const host = timed(ctx.logger, "host probe", () => {
    const probed = probeHost(ctx.repoPath, { toolTimeoutMs: ctx.limits.probes.hostMs });
    ctx.store.saveHostPreflight(probed);
    ctx.logger.artifact("host-preflight.json", probed);
    return probed;
  });
  const project = timed(ctx.logger, "project detection", () => {
    const detected = detectCProject(ctx.repoPath, host);
    ctx.store.saveProjectDetection(detected);
    ctx.logger.artifact("project-detection.json", detected);
    return detected;
  });
  ctx.logger.info("C project preflight completed", {
    status: project.status,
    primary_build_system: project.primary_build_system,
    adapter: project.adapter,
    source_file_count: project.source_files.length,
  });
  return { host, project };
};

/** Host default: the host-side probe report (no model call). */
export const defaultAnalyzeStage: AnalyzeStage = async (ctx, input) => {
  const analysis = timed(ctx.logger, "host-side analysis probe", () =>
    analyzeRepo({
      repoDir: ctx.repoPath,
      taskContext: ctx.task,
      host: input.preflight.host,
      project: input.preflight.project,
    }),
  );
  ctx.logger.artifact("analysis-report.txt", { report: analysis.report });
  ctx.logger.info("project probed; host-side report prepared");
  return { analysis };
};

/** Host default: the AI test-writer declares the build set and the test workflow. */
export const defaultWorkflowsStage: WorkflowsStage = async (ctx, input) => {
  ctx.logger.info("running test-writer session (declare build deps, author TestWorkflow)");
  ctx.logger.startHeartbeat(5_000);
  const sessionStarted = performance.now();
  let declared: DeclaredAgentResolution;
  try {
    declared = await runDeclaredResolution({
      repoDir: ctx.repoPath,
      sessionRoot: ctx.store.sessionDir,
      sessionId: ctx.sessionId,
      task: ctx.task,
      host: input.preflight.host,
      project: input.preflight.project,
      logger: ctx.logger,
      sessionStore: ctx.sessionStore,
      limits: ctx.limits.sessions.testWriter,
    });
  } finally {
    ctx.logger.stopHeartbeat();
  }
  ctx.logger.info("test-writer session wall time", {
    duration_ms: Math.round(performance.now() - sessionStarted),
  });
  ctx.logger.artifact("declared-build-set.json", declared.declaredSet);
  ctx.logger.artifact("workflow-resolution-test.json", declared.testResolution);
  // testSource is TypeScript source, not JSON — store it as text for audit.
  ctx.logger.artifact("test-workflow.json", { kind: "test-workflow-source", source: declared.testSource });
  ctx.logger.info("declared build set resolved", {
    build_count: declared.declaredSet.builds.length,
    test_entry: declared.testResolution.entry,
    test_id: declared.workflowId,
  });
  return { declared };
};

/** Host default: create the candidate branch and both worktrees. */
export const defaultPrepareStage: PrepareStage = async (ctx) => {
  const baseSha = resolveHead(ctx.repoPath);
  const branch = `refactor/agent-${ctx.sessionId}`;
  const worktrees = timed(ctx.logger, "branch + worktree creation", () => {
    gitIn(ctx.repoPath, ["branch", branch, baseSha]);
    return createWorktrees(ctx.repoPath, ctx.store.sessionDir, branch, baseSha);
  });
  ctx.logger.info("isolated baseline and candidate worktrees created", {
    base_sha: baseSha,
    branch,
    baseline_dir: worktrees.baselineDir,
    candidate_dir: worktrees.candidateDir,
  });
  return { branch, baseSha, worktrees };
};

/** Host default: the Claude refactor session edits the candidate worktree. */
export const defaultRefactorStage: RefactorStage = async (ctx, input) => {
  const refactor = await timedAsync(ctx.logger, "refactor agent session", () =>
    runRefactor(input.candidate.worktrees.candidateDir, ctx.task, {
      logger: ctx.logger,
      sessionStore: ctx.sessionStore,
      limits: ctx.limits.sessions.refactor,
    }),
  );
  ctx.logger.info("Claude refactor agent completed", {});
  return { summary: refactor.summary };
};

/** Host default: differential build + test execution and the verdict. */
export const defaultVerifyStage: VerifyStage = async (ctx, input) => {
  const { declared } = input.workflows;
  const firstBuild = declared.buildResolutions[0]!;
  return runWorkflowVerification({
    repoPath: ctx.repoPath,
    worktrees: input.candidate.worktrees,
    store: ctx.store,
    logger: ctx.logger,
    host: input.preflight.host,
    project: input.preflight.project,
    contract: defaultContract(),
    deps: defaultDeps(),
    tests: defaultTests(),
    // Declared mode: DeclaredBuildSet artifact + declared test resolution
    // replace the legacy single build resolution in the state machine.
    buildResolution: {
      kind: "workflow-resolution",
      version: 1,
      workflow_kind: "build",
      mode: "declared",
      workflow_id: "declared-set",
      workflow_revision: 1,
      build_workflow: null,
      entry_root: "workspace",
      root_path: ctx.repoPath,
      entry: "declared-build-set",
      source_hash: declared.declaredSet.source_hash,
      candidate_entries: [],
      reason: "declared build set",
    },
    testResolution: declaredResolutionArtifact(declared),
    build: firstBuild,
    test: declared.testResolution,
    declaredSet: declared.declaredSet,
    declaredBuilds: declared.buildResolutions,
    patch: {
      branch: input.patch.branch,
      commit_sha: input.patch.commit_sha,
      changed_files: [...input.patch.changed_files],
      summary: input.patch.summary,
    },
    limits: ctx.limits,
    ...(ctx.knownEnvironmentPatterns !== undefined
      ? { knownEnvironmentPatterns: ctx.knownEnvironmentPatterns }
      : {}),
  });
};

function abort(orch: Orchestrator, logger: E2ELogger, reason: string): void {
  logger.error(reason);
  orch.abort(reason);
}

function result(
  store: SessionStore,
  logger: E2ELogger,
  analysis: AnalysisResult | null,
  declared: DeclaredAgentResolution | null,
  verification: WorkflowVerificationOutcome | null,
  refactorSummary: string,
  provenance: StageProvenance,
): StageFlowResult {
  return {
    store,
    state: store.state,
    refactorSummary,
    analysis,
    declared,
    verification,
    provenance,
    logDir: logger.runDir,
  };
}

/** First non-empty line of a stage summary, used as the commit subject. */
function firstSummaryLine(summary: string): string | null {
  return summary.split(/\r?\n/).find((line) => line.trim().length > 0) ?? null;
}

/** Time one host-side stage; logs completion at info with duration_ms. */
function timed<R>(logger: E2ELogger, what: string, fn: () => R): R {
  const started = performance.now();
  const value = fn();
  logger.info(`${what} completed`, { duration_ms: Math.round(performance.now() - started) });
  return value;
}

async function timedAsync<T>(logger: E2ELogger, what: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await fn();
  logger.info(`${what} completed`, { duration_ms: Math.round(performance.now() - started) });
  return value;
}

function gitIn(dir: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hash the ordered declaration (id:entry) for the artifact audit field. */
function declaredSetHash(builds: readonly { id: string; entry: string }[]): string {
  const h = createHash("sha256");
  for (const b of builds) h.update(`${b.id}:${b.entry}\n`);
  return h.digest("hex");
}

/**
 * Run the test-writer session, resolve every declared build, and assemble the
 * DeclaredAgentResolution consumed by the verification stage.
 */
async function runDeclaredResolution(options: {
  readonly repoDir: string;
  readonly sessionRoot: string;
  readonly sessionId: string;
  readonly task: string;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly logger: E2ELogger;
  readonly sessionStore: FileSessionStore;
  readonly limits: SessionLimits;
}): Promise<DeclaredAgentResolution> {
  const testRelDir = join(".refactor", "runs", options.sessionId, "workflows", "test");
  const testEntry = join(options.repoDir, testRelDir, "test-workflow.ts");
  const session = await runWorkflowSession({
    repoDir: options.repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    task: options.task,
    testEntry,
    host: options.host,
    project: options.project,
    logger: options.logger,
    sessionStore: options.sessionStore,
    limits: options.limits,
  });
  if (!session.ok) {
    throw new Error(
      `test-writer session failed: ${session.failure ?? "unknown"}${session.summary.length > 0 ? ` — ${session.summary.slice(0, 400)}` : ""}`,
    );
  }
  options.logger.info("test-writer session completed", {
    declared_builds: session.declaredBuilds.join(", "),
    summary: session.summary.slice(0, 200),
  });

  // Rebuild the registry (run-local files restored from disk) to resolve
  // declared build ids to their workflow entries.
  const registry = new LocalDependencyRegistry({
    workspaceRoot: options.repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    host: options.host,
    project: options.project,
  });
  const buildSources: { id: string; entry: string; runLocal: boolean }[] = [];
  for (const id of session.declaredBuilds) {
    const resolved = await registry.resolveBuildEntry(id);
    if (resolved === null) {
      throw new Error(`declared build workflow '${id}' cannot be resolved to a source`);
    }
    buildSources.push({ id, entry: resolved.entry, runLocal: resolved.runLocal });
  }

  const resolved = await resolveDeclaredWorkflows({
    workspaceRoot: options.repoDir,
    entryRoot: options.repoDir,
    host: options.host,
    project: options.project,
    testEntry,
    testWorkflowId: `test-${options.sessionId}`,
    testRevision: 1,
    builds: buildSources.map((b) => ({ id: b.id, entry: b.entry, runLocal: b.runLocal })),
  });

  return buildDeclaredResolution({
    repoDir: options.repoDir,
    testEntry,
    workflowId: `test-${options.sessionId}`,
    revision: 1,
    builds: buildSources,
    resolved,
  });
}

/**
 * Assemble the declared resolution from resolved workflows. Shared by the AI
 * and preset workflow stages so both produce the exact same artifact shape.
 */
export function buildDeclaredResolution(options: {
  readonly repoDir: string;
  readonly testEntry: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly builds: readonly { id: string; entry: string; runLocal: boolean }[];
  readonly resolved: ResolvedDeclaredWorkflows;
}): DeclaredAgentResolution {
  const testSource = existsSync(options.testEntry) ? readFileSync(options.testEntry, "utf8") : "";
  const declaredSet: DeclaredBuildSetValue = {
    kind: "declared-build-set",
    version: 1,
    test_workflow_id: options.workflowId,
    test_workflow_revision: options.revision,
    builds: options.builds.map((b) => ({
      id: b.id,
      entry: relative(options.repoDir, b.entry).split("\\").join("/"),
      source_hash: b.runLocal
        ? sha256File(b.entry)
        : options.resolved.builds.find((r) => r.id === b.id)?.resolution.sourceHash ?? "",
      run_local: b.runLocal,
    })),
    source_hash: declaredSetHash(options.builds),
  };

  return {
    declaredSet,
    testResolution: options.resolved.test,
    buildResolutions: options.resolved.builds.map((b) => b.resolution),
    testSource,
    workflowId: options.workflowId,
    workflowRevision: options.revision,
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex");
}

/** Test workflow-resolution artifact (declared mode, no single build ref). */
function declaredResolutionArtifact(declared: DeclaredAgentResolution): WorkflowResolution {
  return {
    kind: "workflow-resolution",
    version: 1,
    workflow_kind: "test",
    mode: "declared",
    workflow_id: declared.workflowId,
    workflow_revision: declared.workflowRevision,
    build_workflow: null,
    entry_root: "workspace",
    root_path: declared.testResolution.entry,
    entry: relative(declared.testResolution.entry, declared.testResolution.entry).length === 0
      ? "test-workflow"
      : declared.testResolution.entry,
    source_hash: declared.testResolution.sourceHash,
    candidate_entries: [],
    reason: "declared test workflow",
  };
}

/** Promote run-local build workflows to the library after an accepted run. */
async function promoteRunLocalBuilds(
  declared: DeclaredAgentResolution | null,
  repoRoot: string,
  logger: E2ELogger,
): Promise<void> {
  if (declared === null) return;
  const existingAliases = loadAliases(repoRoot).aliases;
  for (const build of declared.declaredSet.builds) {
    if (!build.run_local) continue;
    if (existingAliases[build.id] !== undefined) continue; // already promoted
    const entry = join(repoRoot, build.entry);
    if (!existsSync(entry)) {
      logger.warn(`run-local build source missing, skip promotion: ${build.entry}`);
      continue;
    }
    try {
      const description = readDescriptionSidecar(entry);
      const result = await curateBuildWorkflow({
        repoRoot,
        entry,
        runLocalId: build.id,
        description,
      });
      logger.info(`promoted run-local build '${build.id}' -> '${result.libraryId}'`, {
        library_id: result.libraryId,
        revision: result.revision,
      });
    } catch (error) {
      logger.warn(`promotion failed for '${build.id}': ${errorMessage(error)}`);
    }
  }
}

function readDescriptionSidecar(entry: string): string {
  try {
    const parsed = JSON.parse(readFileSync(`${entry}.description.json`, "utf8")) as {
      description?: string;
    };
    return parsed.description ?? "";
  } catch {
    return "";
  }
}

/**
 * Host-constructed default proposal artifacts. In the declared-mode flow the
 * behavior contract, dependency list and test spec are decided inside the AI
 * sessions (test workflow declares expectations; the build/test workflows
 * self-drive). The state machine still requires these artifacts to advance
 * INIT → CONTRACT_READY → DEPENDENCY_READY → TESTS_READY, so the
 * host submits minimal, semantically-neutral placeholders that carry no
 * verification meaning — the real gate is the DeclaredBuildSet + expectation
 * diff that follows.
 */
function defaultContract(): BehaviorContract {
  const ignore = { mode: "ignore" as const };
  return {
    kind: "behavior-contract",
    version: 1,
    channels: {
      exit_code: ignore,
      signals: ignore,
      stdout: ignore,
      stderr: ignore,
      filesystem: ignore,
    },
    allowed_change: { internal_structure: true, execution_time: true },
    notes: ["host-derived placeholder: expectations are declared by the test workflow"],
  };
}

function defaultDeps(): DependencyManifest {
  return {
    kind: "dependency-manifest",
    version: 1,
    dependencies: [
      {
        name: "none-declared",
        kind: "time",
        strategy: "reject",
        evidence: [],
        notes: "host-derived placeholder: no static dependency analysis in declared mode",
      },
    ],
  };
}

function defaultTests(): TestSpec {
  return {
    kind: "test-spec",
    version: 1,
    cases: [
      {
        id: "self-driven",
        kind: "differential",
        argv: [],
        stdin: "",
        fixtures: [],
      },
    ],
  };
}
