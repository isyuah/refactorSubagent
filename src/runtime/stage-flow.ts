import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { z } from "zod";
import type {
  FailureCategory,
  FailureReport,
  HostPreflight,
  ProjectDetection,
} from "../artifacts/index.js";
import { WorkflowPolicyError } from "../workflow/source-policy.js";
import { curateBuildWorkflow, loadAliases } from "../workflow/curator.js";
import { runRefactor } from "../agents/refactor.js";
import { asWorkflowSessionFailure, runWorkflowSession } from "../agents/workflow-session.js";
import { LocalDependencyRegistry } from "../agents/dep-registry.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import type { ResolvedDeclaredWorkflows } from "../workflow/resolve-declared.js";
import {
  resolveWithRepairs as resolveWithRepairSessions,
  type WorkflowRepairAttempt,
} from "../workflow/resolve-with-repairs.js";
import { runWorkflowRepairSession } from "../agents/workflow-repair.js";
import { E2ELogger } from "./e2e-log.js";
import { StageFailureError } from "./stage-failure.js";
import { FileSessionStore } from "./session-store.js";
import { detectCProject } from "./project-detector.js";
import { probeHost } from "./host-preflight.js";
import { runWorkflowVerification, type WorkflowVerificationOutcome } from "./workflow-pipeline.js";
import { applyInjections, type InjectionSpec } from "./inject.js";
import { TrackedRepositoryGuard, type IntegrityInput } from "./verification-integrity.js";
import {
  mergeVerificationMaterials,
  readVerificationMaterials,
  type VerificationMaterial,
} from "../workflow/verification-materials.js";
import {
  commitCandidateChanges,
  createWorktrees,
  releaseWorktree,
  resolveHead,
  type WorktreePair,
} from "./worktree.js";
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
  "workflows",
  "prepare",
  "refactor",
  "verify",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

/**
 * Structured attribution a stage may attach to a halt. The stage it belongs to
 * is the one that returned the halt, so it is not repeated here. Without it the
 * abort falls back to { category: "internal", component: "stage-flow" }.
 */
export interface StageFailureAttribution {
  readonly category: FailureCategory;
  readonly component: string;
  readonly retryable?: boolean;
  readonly detail?: Record<string, unknown>;
}

/** A stage may refuse to continue; the composer turns this into an abort. */
export interface StageHalt {
  readonly halt: true;
  readonly reason: string;
  /** Structured attribution persisted as artifacts/failure-report.json. */
  readonly attribution?: StageFailureAttribution;
}

export function halt(reason: string, attribution?: StageFailureAttribution): StageHalt {
  return attribution === undefined
    ? { halt: true, reason }
    : { halt: true, reason, attribution };
}

export type StageResult<T> = T | StageHalt;

export function isHalt<T>(value: StageResult<T>): value is StageHalt {
  const maybe = value as { halt?: unknown } | null;
  return typeof value === "object" && maybe !== null && maybe.halt === true;
}

export interface StageFlowRequest {
  /** Git repository containing the base C project. */
  readonly repoPath: string;
  /** Natural-language task given to workflow writers and the Refactor agent. */
  readonly task: string;
  /** Root under which the durable session is created. */
  readonly sessionRoot: string;
  /**
   * Caller-owned root for the baseline/candidate worktrees. When set, the pair
   * is reused across runs (reset in place, warm build outputs kept) and never
   * deleted by this run — the caller owns its lifetime. Omitted: the pair lives
   * under the session directory and is deleted when the run ends.
   */
  readonly worktreeRoot?: string;
  /**
   * Judgement material copied into both worktrees after the candidate commit
   * and before verification. The refactor session never sees it; the verdict
   * still comes from the host verification stage.
   */
  readonly injections?: readonly InjectionSpec[];
  readonly sessionId: string;
  /** CLI layers on top of the user/project config files (see config/limits). */
  readonly limitOverrides?: LayerOverrides;
  readonly knownEnvironmentPatterns?: readonly RegExp[];
  readonly logger?: E2ELogger;
  /** Stage implementations; omitted stages use the host defaults. */
  readonly flow?: StageFlow;
  /**
   * Set when this run resumes a previously aborted one (see stage-resume.ts).
   * Purely descriptive — written to stage-provenance.json so a resumed run's
   * record states which stages were reused instead of re-executed.
   */
  readonly resume?: {
    readonly sourceSessionId: string;
    readonly reusedStages: readonly StageName[];
  };
}

export interface DeclaredAgentResolution {
  /** DeclaredBuildSet artifact carrying the whole declaration. */
  readonly declaredSet: DeclaredBuildSetValue;
  readonly testResolution: TestWorkflowResolution;
  /** Resolved build workflows, in declaration order. */
  readonly buildResolutions: readonly BuildWorkflowResolution[];
  readonly materials: readonly VerificationMaterial[];
  readonly testSource: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
}

/** Which stages came from the caller instead of the host. */
export interface StageProvenance {
  readonly injected: readonly StageName[];
  /** False when the caller replaced the verification stage. */
  readonly verification_authoritative: boolean;
  /** Present when the run resumed a previously aborted session. */
  readonly resume?: {
    readonly source_session: string;
    readonly reused_stages: readonly StageName[];
  };
}

export interface StageFlowResult {
  readonly store: SessionStore;
  readonly state: string;
  readonly refactorSummary: string;
  readonly declared: DeclaredAgentResolution | null;
  readonly verification: WorkflowVerificationOutcome | null;
  readonly provenance: StageProvenance;
  /** Structured attribution of the abort; null unless the run aborted. */
  readonly failure: FailureReport | null;
  readonly logDir: string;
}

/** Everything a stage may read; run configuration plus host-owned accumulators. */
export interface StageContext {
  readonly repoPath: string;
  readonly task: string;
  readonly sessionRoot: string;
  /** Caller-owned worktree root, when the run must reuse a persistent pair. */
  readonly worktreeRoot?: string;
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

export interface WorkflowsOutcome {
  readonly declared: DeclaredAgentResolution;
  /** Root the declared entries were resolved against and must stay inside.
   *  Defaults to the repository when the stage does not say otherwise. */
  readonly entryRoot?: string;
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
  readonly workflows: WorkflowsOutcome;
  readonly candidate: CandidateWorkspace;
}

export interface VerifyStageInput {
  readonly preflight: PreflightOutcome;
  readonly workflows: WorkflowsOutcome;
  readonly candidate: CandidateWorkspace;
  readonly refactor: RefactorOutcome;
  readonly patch: PatchFacts;
  readonly injectedFiles: readonly IntegrityInput[];
}

export type PreflightStage = (ctx: StageContext) => Promise<StageResult<PreflightOutcome>>;
export type WorkflowsStage = (
  ctx: StageContext,
  input: { readonly preflight: PreflightOutcome },
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
    ...(req.resume !== undefined
      ? {
          resume: {
            source_session: req.resume.sourceSessionId,
            reused_stages: req.resume.reusedStages,
          },
        }
      : {}),
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
    ...(req.worktreeRoot !== undefined ? { worktreeRoot: req.worktreeRoot } : {}),
    sessionId: req.sessionId,
    store,
    logger,
    sessionStore,
    limits,
    ...(req.knownEnvironmentPatterns !== undefined
      ? { knownEnvironmentPatterns: req.knownEnvironmentPatterns }
      : {}),
  };
  let declared: DeclaredAgentResolution | null = null;
  let verification: WorkflowVerificationOutcome | null = null;
  let refactorSummary = "";
  let worktrees: WorktreePair | null = null;
  // The catch-all attributes a thrown error to the stage in progress; halts
  // carry their own stage at the call site.
  let currentStage: StageName = "preflight";
  // Stage-completion facts for resume; rewritten after each completed stage.
  const checkpoints: StageCheckpoint[] = [];
  const done = (): StageFlowResult =>
    result(store, logger, declared, verification, refactorSummary, provenance);

  try {
    const originalRepository = new TrackedRepositoryGuard(req.repoPath);
    logger.phase("PREFLIGHT");
    logger.artifact("stage-provenance.json", provenance);
    if (provenance.injected.length > 0) {
      logger.info("stage flow overrides active", {
        injected: provenance.injected.join(", "),
        verification_authoritative: provenance.verification_authoritative,
        ...(provenance.resume !== undefined ? { resume: provenance.resume } : {}),
      });
    }
    const preflight = await (flow.preflight ?? defaultPreflightStage)(ctx);
    if (isHalt(preflight)) {
      abort(orch, ctx, "preflight", preflight.reason, preflight.attribution);
      return done();
    }
    if (preflight.project.status === "no-c-sources") {
      abort(orch, ctx, "preflight", `project detection blocked: ${preflight.project.reason}`, {
        category: "project",
        component: "project-detection",
        retryable: false,
        detail: {
          status: preflight.project.status,
          reason: preflight.project.reason,
          primary_build_system: preflight.project.primary_build_system ?? null,
        },
      });
      return done();
    }
    currentStage = "workflows";

    logger.phase("WORKFLOW_SESSION");
    const workflows = await (flow.workflows ?? defaultWorkflowsStage)(ctx, {
      preflight,
    });
    originalRepository.assertUnchanged("after workflow authoring");
    if (isHalt(workflows)) {
      abort(orch, ctx, "workflows", workflows.reason, workflows.attribution);
      return done();
    }
    declared = workflows.declared;
    checkpoints.push({ stage: "workflows", at: now(), data: workflowsCheckpointData(req.repoPath, workflows) });
    saveStageCheckpoints(store, checkpoints);

    currentStage = "prepare";
    const prepared = await (flow.prepare ?? defaultPrepareStage)(ctx, { preflight, workflows });
    if (isHalt(prepared)) {
      abort(orch, ctx, "prepare", prepared.reason, prepared.attribution);
      return done();
    }
    worktrees = prepared.worktrees;
    const baselineRepository = new TrackedRepositoryGuard(worktrees.baselineDir);

    currentStage = "refactor";
    logger.phase("REFACTOR");
    const refactored = await (flow.refactor ?? defaultRefactorStage)(ctx, {
      preflight,
      workflows,
      candidate: prepared,
    });
    originalRepository.assertUnchanged("after candidate refactoring");
    baselineRepository.assertUnchanged("after candidate refactoring");
    if (isHalt(refactored)) {
      abort(orch, ctx, "refactor", refactored.reason, refactored.attribution);
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
      abort(orch, ctx, "refactor", "refactor agent made no changes", {
        category: "gate",
        component: "change-set-measurement",
        retryable: false,
        detail: { branch: prepared.branch, base_sha: prepared.baseSha },
      });
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
    // Refactor checkpoint: written only after the host measured the commit,
    // so a resume never replays an unmeasured half-state.
    checkpoints.push({
      stage: "refactor",
      at: now(),
      data: {
        branch: patch.branch,
        base_sha: patch.base_sha,
        commit_sha: patch.commit_sha,
        summary: patch.summary,
      },
    });
    saveStageCheckpoints(store, checkpoints);

    // Judge material comes back only now: the candidate is committed (so the
    // injection cannot appear in the measured change set) and the refactor
    // session is over (so it never saw what it is judged by). The verification
    // stage itself is untouched and stays authoritative.
    const injectedFiles = new Map<string, IntegrityInput>();
    if (req.injections !== undefined && req.injections.length > 0) {
      const reports = applyInjections(
        [prepared.worktrees.baselineDir, prepared.worktrees.candidateDir],
        req.injections,
      );
      logger.artifact("injections.json", { injections: reports });
      for (const report of reports) {
        for (const file of report.files) injectedFiles.set(file.path, { path: file.path, sha256: file.sha256 });
        logger.info("judge material injected", {
          source: report.source,
          dest: report.dest,
          worktree: report.worktree,
          files: report.files.length,
          pre_existing: report.preExisting.length,
        });
      }
    }

    currentStage = "verify";
    logger.phase("VERIFICATION");
    if (declared === null || declared.buildResolutions.length === 0) {
      abort(orch, ctx, "verify", "declared workflow resolution missing or empty build set", {
        category: "resolution",
        component: "declared-build-set",
        retryable: false,
        detail: { build_resolutions: declared?.buildResolutions.length ?? null },
      });
      return done();
    }
    logger.info("workflow verification started", { phase_detail: "all declared builds + observations on both sides" });
    const verificationStarted = performance.now();
    const verified = await (flow.verify ?? defaultVerifyStage)(ctx, {
      preflight,
      workflows,
      candidate: prepared,
      refactor: refactored,
      patch,
      injectedFiles: [...injectedFiles.values()],
    });
    if (isHalt(verified)) {
      abort(orch, ctx, "verify", verified.reason, verified.attribution);
      return done();
    }
    verification = verified;
    logger.info("workflow verification completed", {
      duration_ms: Math.round(performance.now() - verificationStarted),
    });
    if (store.state === "ABORTED") {
      // The verification pipeline aborted the session itself (build or test
      // execution failure) with a plain reason on the store; attribute it here
      // from the measured outcome. orch.abort must NOT run again: ABORTED is
      // terminal (R7), so this persists the report only.
      const reason = abortReason(store) ?? "workflow verification aborted";
      persistFailureReport(ctx, "verify", reason, verificationAbortAttribution(verification));
    }
    return done();
  } catch (error) {
    const reason = errorMessage(error);
    const info = error instanceof StageFailureError ? error.info : undefined;
    abort(orch, ctx, currentStage, reason, {
      category: info?.category ?? "internal",
      component: info?.component ?? "stage-flow",
      retryable: info?.retryable ?? false,
      detail: info?.detail ?? {},
    });
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
    else if (store.state === "ABORTED") {
      // Every abort path records its reason on the session store, including the
      // direct Orchestrator.abort calls that never touch the logger: read it
      // back so the run journal states WHY the run stopped.
      const reason = abortReason(store) ?? "workflow verification aborted";
      logger.abort(reason);
      logger.finish("aborted", reason);
    }
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
    const detected = detectCProject(ctx.repoPath);
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
      policyRepairs: ctx.limits.stages.policyRepairs,
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
  const root = ctx.worktreeRoot ?? ctx.store.sessionDir;
  const reuse = ctx.worktreeRoot !== undefined;
  const worktrees = timed(ctx.logger, "branch + worktree creation", () => {
    if (reuse) {
      // A persistent root may still have the candidate worktree attached to a
      // branch from an earlier run; free it before (re)creating this one.
      releaseWorktree(join(root, "worktrees", "candidate"));
    }
    // `-f`: a rerun in a reused root recreates the same branch name.
    gitIn(ctx.repoPath, ["branch", "-f", branch, baseSha]);
    return createWorktrees(ctx.repoPath, root, branch, baseSha, { reuse, keep: reuse });
  });
  ctx.logger.info("isolated baseline and candidate worktrees created", {
    base_sha: baseSha,
    branch,
    baseline_dir: worktrees.baselineDir,
    candidate_dir: worktrees.candidateDir,
    reused: reuse,
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
    materials: declared.materials,
    injectedFiles: input.injectedFiles,
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

/**
 * The reason recorded for the ABORTED transition. The orchestrator stores it in
 * the session history; the run journal is written from it in the finally block,
 * so an abort that never goes through a logger call still explains itself.
 */
function abortReason(store: SessionStore): string | null {
  for (let index = store.history.length - 1; index >= 0; index -= 1) {
    const entry = store.history[index];
    if (entry?.to === "ABORTED") {
      return entry.note.trim().length > 0 ? entry.note.trim() : null;
    }
  }
  return null;
}

/**
 * Abort the run and persist its structured attribution. The reason is journaled
 * once, from the store, in the finally block; the typed fields land in
 * artifacts/failure-report.json and the run dir's failure-report.json.
 */
function abort(
  orch: Orchestrator,
  ctx: StageContext,
  stage: StageName,
  reason: string,
  attribution?: StageFailureAttribution,
): void {
  orch.abort(reason);
  persistFailureReport(ctx, stage, reason, {
    category: attribution?.category ?? "internal",
    component: attribution?.component ?? "stage-flow",
    retryable: attribution?.retryable ?? false,
    detail: attribution?.detail ?? {},
  });
}

/** Validate + durably store one failure attribution (session + run dir). */
function persistFailureReport(
  ctx: StageContext,
  stage: StageName,
  reason: string,
  attribution: StageFailureAttribution,
): FailureReport {
  const report = ctx.store.saveFailureReport({
    kind: "failure-report",
    version: 1,
    stage,
    category: attribution.category,
    component: attribution.component,
    reason,
    retryable: attribution.retryable ?? false,
    detail: attribution.detail ?? {},
    at: now(),
  });
  ctx.logger.error("stage failure attributed", {
    stage: report.stage,
    category: report.category,
    component: report.component,
    retryable: report.retryable,
    reason: report.reason,
  });
  ctx.logger.artifact("failure-report.json", report);
  return report;
}

/**
 * Derive the attribution of an abort that the verification pipeline performed
 * directly on the store: prefer the attribution recorded at the exact abort
 * site; the legacy nullness heuristic only covers outcomes that predate it.
 */
function verificationAbortAttribution(
  v: WorkflowVerificationOutcome,
): StageFailureAttribution {
  if (v.abortAttribution !== undefined) {
    return v.abortAttribution;
  }
  if (v.baselineBuild !== null && v.baselineBuild.status !== "pass") {
    return {
      category: "build",
      component: "build-workflow:baseline",
      retryable: true,
      detail: { status: v.baselineBuild.status, failure: v.baselineBuild.failure },
    };
  }
  if (v.candidateBuild !== null && v.candidateBuild.status !== "pass") {
    return {
      category: "build",
      component: "build-workflow:candidate",
      retryable: true,
      detail: { status: v.candidateBuild.status, failure: v.candidateBuild.failure },
    };
  }
  if (v.baseline === null) {
    return { category: "test", component: "test-workflow:baseline", retryable: true, detail: {} };
  }
  if (v.candidate === null) {
    return { category: "test", component: "test-workflow:candidate", retryable: true, detail: {} };
  }
  return {
    category: "internal",
    component: "workflow-verification",
    retryable: false,
    detail: { state: v.state },
  };
}

function result(
  store: SessionStore,
  logger: E2ELogger,
  declared: DeclaredAgentResolution | null,
  verification: WorkflowVerificationOutcome | null,
  refactorSummary: string,
  provenance: StageProvenance,
): StageFlowResult {
  // Read the attribution back from the store instead of threading it through
  // locals: abort() persists synchronously, and this stays correct even for
  // aborts performed inside the verification pipeline.
  const failure = store.state === "ABORTED" ? store.failureReport() : null;
  return {
    store,
    state: store.state,
    refactorSummary,
    declared,
    verification,
    provenance,
    failure,
    logDir: logger.runDir,
  };
}

/** First non-empty line of a stage summary, used as the commit subject. */
function firstSummaryLine(summary: string): string | null {
  return summary.split(/\r?\n/).find((line) => line.trim().length > 0) ?? null;
}

/**
 * Stage checkpoints — the resume bookkeeping.
 *
 * After the workflows and refactor stages complete, their host-measured facts
 * are written to <sessionDir>/stage-checkpoints.json. A resume run
 * (stage-resume.ts) reuses a checkpoint only when every fact it references is
 * still verifiable on disk (workflow sources exist, branch exists, repo HEAD
 * unchanged); otherwise the stage simply re-runs. Fail-closed: an unreadable
 * or malformed checkpoint file is treated as absent, never as reusable.
 */

export interface StageCheckpoint {
  readonly stage: "workflows" | "refactor";
  readonly at: string;
  readonly data: Record<string, unknown>;
}

const CheckpointEntry = z.object({
  stage: z.enum(["workflows", "refactor"]),
  at: z.string(),
  data: z.record(z.unknown()),
});
const CheckpointFile = z.object({
  version: z.literal(1),
  session_id: z.string().min(1),
  checkpoints: z.array(CheckpointEntry),
});

/** Persist (rewrite) the checkpoint file for a session. */
export function saveStageCheckpoints(store: SessionStore, checkpoints: readonly StageCheckpoint[]): void {
  const file = {
    version: 1,
    session_id: store.id,
    checkpoints: checkpoints.map((c) => ({ stage: c.stage, at: c.at, data: c.data })),
  };
  CheckpointFile.parse(file);
  writeFileSync(join(store.sessionDir, "stage-checkpoints.json"), JSON.stringify(file, null, 2) + "\n");
}

/**
 * Load a session's checkpoints. Returns them with a diagnostic; a missing file
 * yields an empty list, a malformed one yields an empty list PLUS an error —
 * the caller decides (resume must not reuse, but may still report why).
 */
export function loadStageCheckpoints(
  sessionDir: string,
): { checkpoints: StageCheckpoint[]; error: string | null } {
  const path = join(sessionDir, "stage-checkpoints.json");
  if (!existsSync(path)) return { checkpoints: [], error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { checkpoints: [], error: `unreadable stage-checkpoints.json: ${errorMessage(error)}` };
  }
  const parsed = CheckpointFile.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { checkpoints: [], error: `malformed stage-checkpoints.json: ${issue?.message ?? "schema mismatch"}` };
  }
  return {
    checkpoints: parsed.data.checkpoints.map((c) => ({ stage: c.stage, at: c.at, data: c.data })),
    error: null,
  };
}

/**
 * Checkpoint payload of a completed workflows stage. Paths are relative to
 * `entry_root` (the root the stage resolved its sources against — usually the
 * repository, but a caller may point it elsewhere), so a resume can re-resolve
 * them without mistaking an external source for a boundary escape.
 */
function workflowsCheckpointData(
  repoPath: string,
  outcome: WorkflowsOutcome,
): Record<string, unknown> {
  const declared = outcome.declared;
  const entryRoot = outcome.entryRoot ?? repoPath;
  return {
    entry_root: entryRoot.split("\\").join("/"),
    test_entry: relative(entryRoot, declared.testResolution.entry).split("\\").join("/"),
    workflow_id: declared.workflowId,
    workflow_revision: declared.workflowRevision,
    builds: declared.declaredSet.builds.map((b) => ({
      id: b.id,
      entry: relative(entryRoot, join(repoPath, b.entry)).split("\\").join("/"),
      source_hash: b.source_hash,
      run_local: b.run_local,
    })),
  };
}

function now(): string {
  return new Date().toISOString();
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

/** Hash the actual pinned declaration rather than only its source locations. */
function declaredSetHash(builds: DeclaredBuildSetValue["builds"]): string {
  return createHash("sha256").update(JSON.stringify(builds), "utf8").digest("hex");
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
  /** Rewrite sessions allowed per rejected workflow source. */
  readonly policyRepairs: number;
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
    const f = asWorkflowSessionFailure(session.failure);
    throw new StageFailureError(
      `test-writer session failed: ${f?.reason ?? "unknown"}${session.summary.length > 0 ? ` — ${session.summary.slice(0, 400)}` : ""}`,
      {
        category: f?.category ?? "model-session",
        component: "test-writer-session",
        retryable: f?.retryable ?? true,
        detail: { ...(f?.detail ?? {}), summary_excerpt: session.summary.slice(0, 400) },
      },
    );
  }
  options.logger.info("test-writer session completed", {
    declared_builds: session.declaredBuilds.join(", "),
    verification_analysis: session.verificationAnalysisPath,
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
      throw new StageFailureError(
        `declared build workflow '${id}' cannot be resolved to a source`,
        {
          category: "resolution",
          component: "dep-registry",
          retryable: false,
          detail: { build_id: id, declared_builds: [...session.declaredBuilds] },
        },
      );
    }
    buildSources.push({ id, entry: resolved.entry, runLocal: resolved.runLocal });
  }

  let resolved: ResolvedDeclaredWorkflows;
  try {
    resolved = await resolveWithRepairs({
      repoDir: options.repoDir,
      testEntry,
      testWorkflowId: `test-${options.sessionId}`,
      buildSources,
      host: options.host,
      project: options.project,
      logger: options.logger,
      sessionStore: options.sessionStore,
      limits: options.limits,
      policyRepairs: options.policyRepairs,
    });
  } catch (error) {
    if (error instanceof StageFailureError) throw error;
    if (error instanceof WorkflowPolicyError) {
      throw new StageFailureError(errorMessage(error), {
        category: "policy",
        component: "source-policy",
        retryable: false,
        detail: {
          entry: relative(options.repoDir, error.entry).split("\\").join("/"),
          rule: error.violation.rule,
          detail: error.violation.detail,
          line: error.violation.line,
          column: error.violation.column,
          snippet: error.violation.snippet,
        },
      });
    }
    throw new StageFailureError(errorMessage(error), {
      category: "resolution",
      component: "workflow-resolution",
      retryable: false,
      detail: {},
    });
  }

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
 * Resolve every declared workflow, handing a source-policy violation back to a
 * bounded repair session instead of aborting the run. Any other failure (hash
 * mismatch, missing file, session error) still propagates.
 */
async function resolveWithRepairs(options: {
  readonly repoDir: string;
  readonly testEntry: string;
  readonly testWorkflowId: string;
  readonly buildSources: readonly { id: string; entry: string; runLocal: boolean }[];
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly logger: E2ELogger;
  readonly sessionStore: FileSessionStore;
  readonly limits: SessionLimits;
  readonly policyRepairs: number;
}): Promise<ResolvedDeclaredWorkflows> {
  const attempts: WorkflowRepairAttempt[] = [];
  const record = (attempt: WorkflowRepairAttempt): void => {
    attempts.push(attempt);
  };
  try {
    const resolved = await resolveWithRepairSessions({
      workspaceRoot: options.repoDir,
      entryRoot: options.repoDir,
      host: options.host,
      project: options.project,
      testEntry: options.testEntry,
      testWorkflowId: options.testWorkflowId,
      testRevision: 1,
      builds: options.buildSources.map((b) => ({ id: b.id, entry: b.entry, runLocal: b.runLocal })),
      policyRepairs: options.policyRepairs,
      onRepairAttempt: record,
      repair: async (request) => {
        options.logger.warn("workflow source rejected by the source policy; requesting a repair", {
          attempt: request.attempt,
          max_repairs: request.attempts,
          entry: relative(options.repoDir, request.entry).split("\\").join("/"),
          rule: request.violation.rule,
          line: request.violation.line,
          column: request.violation.column,
          detail: request.violation.detail,
          snippet: request.violation.snippet,
        });
        const repair = await runWorkflowRepairSession({
          repoDir: options.repoDir,
          entry: request.entry,
          kind: request.kind,
          violation: request.violation,
          attempt: request.attempt,
          attempts: request.attempts,
          logger: options.logger,
          sessionStore: options.sessionStore,
          limits: options.limits,
        });
        options.logger.info("workflow source repair session completed", {
          attempt: request.attempt,
          entry: relative(options.repoDir, request.entry).split("\\").join("/"),
          ok: repair.ok,
          timed_out: repair.timedOut,
          summary: repair.summary.slice(0, 200),
        });
        return { ok: repair.ok, timedOut: repair.timedOut, summary: repair.summary };
      },
    });
    if (attempts.length > 0) {
      options.logger.info("workflow source repair accepted", {
        repairs: attempts.length,
        entries: attempts.map((a) => relative(options.repoDir, a.entry).split("\\").join("/")).join(", "),
      });
      options.logger.artifact("workflow-source-repairs.json", {
        outcome: "accepted",
        repairs: repairRecords(options.repoDir, attempts),
      });
    }
    return resolved;
  } catch (error) {
    if (attempts.length > 0) {
      options.logger.artifact("workflow-source-repairs.json", {
        outcome: "rejected",
        repairs: repairRecords(options.repoDir, attempts),
        final_reason: errorMessage(error),
      });
    }
    throw error;
  }
}

/** Journal-friendly view: repo-relative entries, no full session text. */
function repairRecords(
  repoDir: string,
  attempts: readonly WorkflowRepairAttempt[],
): Record<string, unknown>[] {
  return attempts.map((attempt) => ({
    attempt: attempt.attempt,
    entry: relative(repoDir, attempt.entry).split("\\").join("/"),
    kind: attempt.kind,
    rule: attempt.violation.rule,
    detail: attempt.violation.detail,
    line: attempt.violation.line,
    column: attempt.violation.column,
    snippet: attempt.violation.snippet,
    session_ok: attempt.outcome.ok,
    timed_out: attempt.outcome.timedOut,
    summary: attempt.outcome.summary.slice(0, 400),
  }));
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
  const inputs = options.builds.map((build) => ({ build, materials: readVerificationMaterials(build.entry) }));
  const materials = mergeVerificationMaterials(inputs.flatMap((input) => [...input.materials]));
  const builds = inputs.map(({ build: b, materials: buildMaterials }) => ({
    id: b.id,
    entry: relative(options.repoDir, b.entry).split("\\").join("/"),
    source_hash: options.resolved.builds.find((r) => r.id === b.id)?.resolution.sourceHash ?? "",
    run_local: b.runLocal,
    materials: buildMaterials.map(({ path, sha256 }) => ({ path, sha256 })),
  }));
  const declaredSet: DeclaredBuildSetValue = {
    kind: "declared-build-set",
    version: 1,
    test_workflow_id: options.workflowId,
    test_workflow_revision: options.revision,
    builds,
    source_hash: declaredSetHash(builds),
  };

  return {
    declaredSet,
    testResolution: options.resolved.test,
    buildResolutions: options.resolved.builds.map((b) => b.resolution),
    materials,
    testSource,
    workflowId: options.workflowId,
    workflowRevision: options.revision,
  };
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
    if ((build.materials?.length ?? 0) > 0) {
      logger.info(`keeping build '${build.id}' run-local: task-specific verification materials are not promoted`);
      continue;
    }
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
