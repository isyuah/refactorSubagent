import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { SessionStore } from "../orchestrator/store.js";
import type { FailureReport } from "../artifacts/index.js";
import type { LayerOverrides } from "../config/layers.js";
import type { InjectionSpec } from "./inject.js";
import type { E2ELogger } from "./e2e-log.js";
import { hasBranch, resolveHead } from "./worktree.js";
import {
  loadStageCheckpoints,
  runStageFlow,
  type StageCheckpoint,
  type StageFlow,
  type StageFlowResult,
  type StageName,
} from "./stage-flow.js";
import {
  existingBranchPrepareStage,
  fixedRefactorStage,
  presetWorkflowsStage,
} from "./stage-presets.js";

/**
 * stage-resume — resume an aborted run from its stage checkpoints.
 *
 * A failed run must not force a full re-run: the expensive stages (test-writer
 * session, refactor session) persist host-measured checkpoints when they
 * complete, and a resume run reuses them INSTEAD OF re-executing the stage:
 *
 *   workflows checkpoint → presetWorkflowsStage over the persisted sources
 *                          (re-validated by the source policy on every load)
 *   refactor checkpoint  → existingBranchPrepareStage + fixedRefactorStage
 *                          (the candidate branch still carries the commit the
 *                          host already measured)
 *
 * Reuse is decided fail-closed, per stage, at resume time: a checkpoint is
 * reused only when every fact it references still verifies against the world
 * (files exist under the recorded entry root, branch exists, the branch tip
 * still equals the measured commit, repo HEAD unchanged, diff non-empty).
 * Anything else — missing file, replaced tip, moved HEAD, malformed
 * checkpoint — demotes that stage to a normal re-run; it never fails the
 * resume by itself.
 *
 * The resumed run is a NEW session (terminal states are immutable, R7): it
 * re-runs preflight (cheap, zero model), rebuilds its own artifacts, and
 * records `provenance.resume` so the record states which stages were reused
 * rather than re-executed. Verification is always re-run — it is the host's
 * authoritative measurement, never inherited.
 */

export interface StageResumeRequest {
  /** Git repository containing the base C project (same as the source run). */
  readonly repoPath: string;
  readonly task: string;
  /** Root under which both sessions live (<root>/.refactor/sessions/<id>). */
  readonly sessionRoot: string;
  /** Caller-owned worktree root, as in runStageFlow. */
  readonly worktreeRoot?: string;
  /** The aborted session to resume from. */
  readonly sourceSessionId: string;
  /** NEW session id for the resumed run (terminal states are immutable). */
  readonly sessionId: string;
  /** Judge material injected into both worktrees before verification, as in
   *  runStageFlow. Forwarded so a resumed run verifies the same environment. */
  readonly injections?: readonly InjectionSpec[];
  /** User-configured stage sources (pipeline config / --stage). Stages the
   *  checkpoints reuse are overlaid on top of this; every stage WITHOUT a
   *  reusable checkpoint still runs the user's configured source instead of
   *  falling back to the AI default. */
  readonly baseFlow?: StageFlow;
  readonly limitOverrides?: LayerOverrides;
  readonly knownEnvironmentPatterns?: readonly RegExp[];
  readonly logger?: E2ELogger;
}

export interface StageResumePlan {
  readonly sourceSessionId: string;
  /** State of the source session ("ABORTED" — anything else cannot resume). */
  readonly sourceState: string;
  /** Structured attribution persisted by the failed run (null for old runs). */
  readonly failure: FailureReport | null;
  readonly reuseWorkflows: boolean;
  readonly reuseRefactor: boolean;
  /** Parsed checkpoint payloads for the reusable stages. */
  readonly workflows: WorkflowsCheckpoint | null;
  readonly refactor: RefactorCheckpoint | null;
  /** Why each stage was or was not reused (diagnostics, not errors). */
  readonly notes: readonly string[];
}

export interface WorkflowsCheckpoint {
  /** Entry-root-relative test workflow source. */
  readonly testEntry: string;
  /** Root the entries are resolved against; absent in pre-entry_root
   *  checkpoints (they are repo-relative, resolved against the repository). */
  readonly entryRoot?: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly builds: readonly {
    readonly id: string;
    /** Entry-root-relative build workflow source. */
    readonly entry: string;
    readonly sourceHash: string;
    readonly runLocal: boolean;
  }[];
}

export interface RefactorCheckpoint {
  readonly branch: string;
  readonly baseSha: string;
  readonly commitSha: string;
  readonly summary: string;
}

const WorkflowsCheckpointData = z.object({
  entry_root: z.string().min(1).optional(),
  test_entry: z.string().min(1),
  workflow_id: z.string().min(1),
  workflow_revision: z.number().int().positive(),
  builds: z.array(
    z.object({
      id: z.string().min(1),
      entry: z.string().min(1),
      source_hash: z.string(),
      run_local: z.boolean(),
    }),
  ),
});

const RefactorCheckpointData = z.object({
  branch: z.string().min(1),
  base_sha: z.string().min(1),
  commit_sha: z.string().min(1),
  summary: z.string(),
});

/**
 * Decide what the resume can reuse, WITHOUT executing anything. Throws only
 * when the source session cannot be a resume source at all (missing, or not
 * aborted — ACCEPTED/REJECTED already carry a verdict).
 */
export function planStageResume(req: StageResumeRequest): StageResumePlan {
  const source = SessionStore.open(req.sessionRoot, req.sourceSessionId);
  if (source.state !== "ABORTED") {
    throw new Error(
      `cannot resume session ${req.sourceSessionId}: state is ${source.state}, only ABORTED sessions can be resumed`,
    );
  }
  const notes: string[] = [];
  const { checkpoints, error } = loadStageCheckpoints(source.sessionDir);
  if (error !== null) notes.push(error);

  const failure = source.failureReport();

  // Workflows reuse: the checkpoint's sources must still exist on disk. The
  // declaration itself is re-validated by the source policy during resolution.
  const workflowsEntry = checkpointOf(checkpoints, "workflows");
  let workflows: WorkflowsCheckpoint | null = null;
  if (workflowsEntry === null) {
    notes.push("workflows: no checkpoint — the stage will re-run");
  } else {
    const parsed = WorkflowsCheckpointData.safeParse(workflowsEntry.data);
    if (!parsed.success) {
      notes.push("workflows: malformed checkpoint — the stage will re-run");
    } else {
      // Entries are relative to the entry root the source run resolved them
      // against (the repository when the checkpoint predates entry_root).
      const entryRoot = parsed.data.entry_root ?? req.repoPath;
      const missing = [parsed.data.test_entry, ...parsed.data.builds.map((b) => b.entry)].find(
        (entry) => !existsSync(join(entryRoot, entry)),
      );
      if (missing !== undefined) {
        notes.push(`workflows: source missing on disk (${missing}) — the stage will re-run`);
      } else {
        workflows = {
          testEntry: parsed.data.test_entry,
          workflowId: parsed.data.workflow_id,
          workflowRevision: parsed.data.workflow_revision,
          ...(parsed.data.entry_root !== undefined ? { entryRoot: parsed.data.entry_root } : {}),
          builds: parsed.data.builds.map((b) => ({
            id: b.id,
            entry: b.entry,
            sourceHash: b.source_hash,
            runLocal: b.run_local,
          })),
        };
      }
    }
  }

  // Refactor reuse: the candidate branch must still exist, its tip must be
  // the exact commit the host measured (a replaced tip would verify a
  // different candidate than the checkpoint recorded), the repo must not
  // have moved since the failed run (a stale base invalidates the measured
  // diff), and the branch must actually carry a change.
  const refactorEntry = checkpointOf(checkpoints, "refactor");
  let refactor: RefactorCheckpoint | null = null;
  if (refactorEntry === null) {
    notes.push("refactor: no checkpoint — the stage will re-run");
  } else {
    const parsed = RefactorCheckpointData.safeParse(refactorEntry.data);
    if (!parsed.success) {
      notes.push("refactor: malformed checkpoint — the stage will re-run");
    } else if (!hasBranch(req.repoPath, parsed.data.branch)) {
      notes.push(`refactor: branch ${parsed.data.branch} no longer exists — the stage will re-run`);
    } else if (resolveBranchTip(req.repoPath, parsed.data.branch) !== parsed.data.commit_sha) {
      notes.push(
        `refactor: branch ${parsed.data.branch} moved since the failed run (tip no longer matches the measured commit) — the stage will re-run`,
      );
    } else if (resolveHead(req.repoPath) !== parsed.data.base_sha) {
      notes.push("refactor: repo HEAD moved since the failed run; the candidate branch is stale — the stage will re-run");
    } else if (diffFileCount(req.repoPath, parsed.data.base_sha, parsed.data.branch) === 0) {
      notes.push(`refactor: branch ${parsed.data.branch} carries no changes vs base — the stage will re-run`);
    } else {
      refactor = {
        branch: parsed.data.branch,
        baseSha: parsed.data.base_sha,
        commitSha: parsed.data.commit_sha,
        summary: parsed.data.summary,
      };
    }
  }

  return {
    sourceSessionId: req.sourceSessionId,
    sourceState: source.state,
    failure,
    reuseWorkflows: workflows !== null,
    reuseRefactor: refactor !== null,
    workflows,
    refactor,
    notes,
  };
}

/**
 * Run the pipeline again, reusing every checkpoint that still verifies. The
 * resumed session re-runs preflight/analyze (cheap), rebuilds artifacts under
 * its own session id, and always re-runs verification.
 */
export async function runStageFlowResume(req: StageResumeRequest): Promise<StageFlowResult> {
  const plan = planStageResume(req);
  // The user's configured stage sources are the base: stages WITHOUT a
  // reusable checkpoint keep running whatever the caller configured (a patch
  // preset, an injected stage, …) instead of silently falling back to the AI
  // defaults. Reused checkpoints are then overlaid on top of that base.
  // (Mutable shape first, StageFlow readonly surface at the call — same
  // pattern as config/pipeline.ts buildStageFlow.)
  const flow: {
    preflight?: StageFlow["preflight"];
    workflows?: StageFlow["workflows"];
    prepare?: StageFlow["prepare"];
    refactor?: StageFlow["refactor"];
    verify?: StageFlow["verify"];
  } = { ...(req.baseFlow ?? {}) };
  const reusedStages: StageName[] = [];
  if (plan.workflows !== null) {
    flow.workflows = presetWorkflowsStage({
      builds: plan.workflows.builds.map((b) => ({
        id: b.id,
        entry: b.entry,
        runLocal: b.runLocal,
      })),
      testEntry: plan.workflows.testEntry,
      workflowId: plan.workflows.workflowId,
      revision: plan.workflows.workflowRevision,
      ...(plan.workflows.entryRoot !== undefined ? { entryRoot: plan.workflows.entryRoot } : {}),
    });
    reusedStages.push("workflows");
  }
  if (plan.refactor !== null) {
    flow.prepare = existingBranchPrepareStage({
      branch: plan.refactor.branch,
      baseSha: plan.refactor.baseSha,
    });
    flow.refactor = fixedRefactorStage(
      `resume: candidate branch ${plan.refactor.branch} already carries the measured change`,
    );
    reusedStages.push("refactor");
  }
  const result = await runStageFlow({
    repoPath: req.repoPath,
    task: req.task,
    sessionRoot: req.sessionRoot,
    sessionId: req.sessionId,
    ...(req.worktreeRoot !== undefined ? { worktreeRoot: req.worktreeRoot } : {}),
    ...(req.injections !== undefined && req.injections.length > 0
      ? { injections: req.injections }
      : {}),
    ...(req.limitOverrides !== undefined ? { limitOverrides: req.limitOverrides } : {}),
    ...(req.knownEnvironmentPatterns !== undefined
      ? { knownEnvironmentPatterns: req.knownEnvironmentPatterns }
      : {}),
    ...(req.logger !== undefined ? { logger: req.logger } : {}),
    flow,
    resume: { sourceSessionId: req.sourceSessionId, reusedStages },
  });
  return result;
}

function checkpointOf(
  checkpoints: readonly StageCheckpoint[],
  stage: "workflows" | "refactor",
): StageCheckpoint | null {
  return checkpoints.find((c) => c.stage === stage) ?? null;
}

/** Number of files changed between two refs (0 when git fails — treated as "no change"). */
function diffFileCount(repo: string, from: string, to: string): number {
  const result = spawnSync("git", ["diff", "--name-only", `${from}..${to}`], {
    cwd: repo,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) return 0;
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

/** Current commit of a branch (null when git fails — treated as "moved"). */
function resolveBranchTip(repo: string, branch: string): string | null {
  const result = spawnSync("git", ["rev-parse", branch], {
    cwd: repo,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
}
