import { join } from "node:path";
import { workflowContentHash } from "./effective-plan.js";
import type { StageFlowResult, WorkflowsStage } from "../stage-flow.js";
import type { ReusedExpectation } from "../workflow-pipeline.js";
import { classifyFailureOwner, routeFailure, type RouterInput } from "./router.js";
import { composeRefactorFeedback } from "./repair.js";
import type { FeedbackDecision, FeedbackUpdate, FeedbackStopReason, FeedbackLane, RepairEvidence } from "./types.js";
import { freshFeedbackState, loadFeedbackState, saveFeedbackState } from "./state.js";
import type { FeedbackState } from "./types.js";

/**
 * feedback/coordinator — the loop above the (immutable-verdict) state machine.
 *
 * Round 1 is a normal full run. A failed round is routed (router.ts); the
 * three repair lanes:
 *   refactor — CONTINUE the original refactor dialogue with the failure
 *              evidence, rebuild from the measured candidate branch, re-verify
 *              under the current pinned exam (baseline observations reusable).
 *   test     — CONTINUE the original authoring dialogue when the exam itself
 *              errored as a script; both sides re-run under the NEW exam.
 *   build    — a dedicated build-writer session repairs the failed build
 *              workflow (run-local revision); both sides rebuild under it,
 *              the candidate branch and exam stay.
 *
 * Budget: the initial round is free; every repair round consumes one unit,
 * success or failure. Stops: ACCEPTED, budget exhausted, no progress
 * (identical repair artifact AND identical failure twice), any stop /
 * needs-diagnosis decision, or a lane input the loop cannot honestly build.
 */

export interface FeedbackLoopConfig {
  readonly baseTask: string;
  /** Total repair attempts allowed (the initial round is not counted). */
  readonly budget: number;
  /** Optional structured activity, independent of terminal rendering. */
  readonly onFeedback?: (update: FeedbackUpdate) => void;
  /** Round 1: the normal full run (AI workflows, AI refactor, verify). */
  readonly runInitial: () => Promise<StageFlowResult>;
  /** Load the current pinned exam so refactor/build repair rounds run the
   *  identical test workflow (null when its checkpoint no longer verifies). */
  readonly loadPinnedWorkflows: () => WorkflowsStage | null;
  /** Absolute path of the current exam entry (test-repair lane writes the
   *  fixed exam to the SAME path). Null when the checkpoint is unavailable. */
  readonly locateExamEntry: () => string | null;
  /** Compose the build-repair brief (needs the failed build's specifics from
   *  the current checkpoint). Null = checkpoint unavailable, stop honestly. */
  readonly composeBuildBrief: (evidence: RepairEvidence, round: number) => string | null;
  /** Run the dedicated build-repair session; null = it produced nothing. */
  readonly runBuildRepair: (brief: string, round: number) => Promise<{ id: string; entry: string } | null>;
  /** Load a previous round's measured baseline observations (refactor lane
   *  reuse). Null = unavailable, the round re-measures the baseline side. */
  readonly loadBaselineObservations: (previousSessionId: string, baseSha: string) => readonly ReusedExpectation[] | null;
  /** Durable state location (feedback-state.json); optional. */
  readonly stateDir?: string;
  /** State already loaded and enriched by the caller when resuming a run. */
  readonly initialState?: FeedbackState;
  /** Persist the run lineage before execution, and the measured plan afterwards. */
  readonly onRoundStarted?: (sessionId: string) => void;
  readonly onRoundCompleted?: (sessionId: string, result: StageFlowResult) => void;
  /** Current builds available to the continued test-writer's MCP tools. */
  readonly loadCurrentBuilds?: () => readonly { readonly id: string; readonly entry: string }[];
  /** Run one repair round with the composed lane context. */
  readonly runRepairRound: (round: number, context: RepairRoundContext) => Promise<StageFlowResult>;
  /**
   * REAL session id for a round number (the CLI owns id layout: base id for
   * round 1, `<base>-fb<N>` for repairs). Records, reuse loaders and the
   * durable state must use these ids — internal "round-N" labels do not name
   * any on-disk directory.
   */
  readonly sessionIdFor: (round: number) => string;
}

export type RepairRoundContext =
  | {
      lane: "refactor";
      dialogueId: string;
      candidateBranch: string;
      baseSha: string;
      pinnedWorkflows: WorkflowsStage;
      feedback: string;
      /** Previous round's baseline observations — reuse instead of
       *  re-measuring (guards verified by construction of this lane). */
      reusedBaseline: readonly ReusedExpectation[] | null;
      sessionId: string;
    }
  | {
      lane: "test";
      adoptBuilds: readonly { readonly id: string; readonly entry: string }[];
      dialogueId: string;
      testEntry: string;
      feedback: string;
      /** The measured candidate branch keeps carrying the unchanged code. */
      candidateBranch: string;
      baseSha: string;
      sessionId: string;
    }
  | {
      lane: "build";
      fixedBuild: { id: string; entry: string };
      /** Declared id of the build that failed (from the attribution; null
       *  when the round predated build-id attribution). */
      failedBuildId: string | null;
      candidateBranch: string;
      baseSha: string;
      pinnedWorkflows: WorkflowsStage;
      sessionId: string;
    };

export interface FeedbackRoundOutcome {
  readonly round: number;
  readonly sessionId: string;
  readonly state: string;
  readonly decision: FeedbackDecision["kind"] | null;
  /** Identity of what this round produced (no-progress detection). */
  readonly artifactHash: string | null;
  readonly failureSignature: string | null;
}

export interface FeedbackLoopOutcome {
  readonly result: StageFlowResult;
  readonly rounds: readonly FeedbackRoundOutcome[];
  readonly stoppedBecause: FeedbackStopReason;
  /** The router's stop decision, when stoppedBecause is "routed-stop". */
  readonly stopDetail: string | null;
}

/** Extract the router input from a finished round (host-measured facts only). */
export function routerInputOf(result: StageFlowResult): RouterInput {
  const failure = result.failure;
  const component = failure?.component ?? "";
  const side: RouterInput["side"] = component.endsWith(":baseline")
    ? "baseline"
    : component.endsWith(":candidate")
      ? "candidate"
      : null;
  const rawBuildId = failure?.detail["build_id"];
  const buildId: RouterInput["buildId"] = typeof rawBuildId === "string" && rawBuildId.length > 0
    ? rawBuildId
    : null;
  const comparison = result.verification?.expectationComparison ?? null;
  const mismatches = comparison === null
    ? []
    : comparison.declarations
        .filter((declaration) => !declaration.matched)
        .map((declaration) => ({ name: declaration.name, reason: declaration.reason }));
  return {
    state: result.state,
    failure: failure === null
      ? null
      : {
          stage: failure.stage,
          category: failure.category,
          component: failure.component,
          retryable: failure.retryable,
          reason: failure.reason,
          detail: failure.detail,
        },
    side,
    buildId,
    mismatches,
    failureOwner: failure === null ? null : classifyFailureOwner(failure.reason),
    evidencePaths: [
      join(result.logDir, "artifacts", "expectation-comparison-result.json"),
      join(result.logDir, "artifacts", "patch-candidate.json"),
    ],
  };
}

/** Content identity stays stable when a repair re-registers identical sources. */
function artifactHashOf(result: StageFlowResult): string | null {
  if (result.declared === null) return result.patch?.commit_sha ?? null;
  const hash = workflowContentHash({
    testSourceHash: result.declared.testResolution.sourceHash,
    builds: result.declared.declaredSet.builds.map((build) => ({
      ...build, sourceHash: build.source_hash, runLocal: build.run_local, materials: build.materials ?? [],
    })),
  });
  return `${result.patch?.commit_sha ?? "no-commit"}:${hash}`;
}

/** Unbiased digest of the raw failure text so "build A broke" and "build B
 *  broke" never share a signature even when the routed decision matches. */
function reasonDigest(reason: string): string {
  let hash = 5381;
  for (let index = 0; index < reason.length; index++) {
    hash = ((hash << 5) + hash + reason.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Identity of how a round failed: the routed decision, the failing side and
 *  build (from the structured attribution), the raw error digest, and the
 *  behavior-diff names. Without the build id and error digest, "build A
 *  repaired, now build B fails" reads as two identical rounds. */
function failureSignatureOf(result: StageFlowResult): string | null {
  const input = routerInputOf(result);
  const decision = routeFailure(input);
  const names = input.mismatches.map((mismatch) => mismatch.name).sort().join("|");
  let reason = input.failure?.reason ?? "";
  let buildSlot = input.buildId ?? "none";
  for (const [index, build] of (result.declared?.declaredSet.builds ?? []).entries()) {
    // A new run-local id must not turn the same error into a new failure.
    reason = reason.replaceAll(build.id, `<build-${String(index)}>`);
    if (input.buildId === build.id) buildSlot = String(index);
  }
  return `${decision.kind}:${input.side ?? "none"}:${buildSlot}:${reasonDigest(reason)}:${names}`;
}

export async function runFeedbackLoop(config: FeedbackLoopConfig): Promise<FeedbackLoopOutcome> {
  const rounds: FeedbackRoundOutcome[] = [];
  // Durable budget: a re-launched loop for the same run keeps what it spent.
  let persisted = config.initialState
    ?? (config.stateDir !== undefined ? loadFeedbackState(config.stateDir) : null)
    ?? freshFeedbackState(config.budget);
  // Changing the total never erases attempts already spent.
  persisted = { ...persisted, budgetTotal: config.budget };
  let budgetUsed = persisted.budgetUsed;
  const firstRound = (persisted.rounds.at(-1)?.round ?? 0) + 1;
  /** Budget snapshot written IMMEDIATELY when a unit is consumed — an
   *  interrupted repair (crash, kill, model-session halt mid-round) must not
   *  look like unspent budget on the next launch. */
  const persistBudget = (): void => {
    const base = persisted;
    base.budgetUsed = budgetUsed;
    persisted = base;
    if (config.stateDir !== undefined) saveFeedbackState(config.stateDir, base);
  };
  const persist = (record: FeedbackRoundOutcome, result: StageFlowResult, lane: RepairRoundContext["lane"] | null): void => {
    const base = persisted;
    base.budgetUsed = budgetUsed;
    if (result.refactorDialogueId !== null) base.dialogues.refactor = result.refactorDialogueId;
    if (result.workflowsDialogueId !== null) base.dialogues.testWriter = result.workflowsDialogueId;
    // The audit trail: append the round (history is never rewritten).
    base.rounds = [
      ...base.rounds,
      {
        round: record.round,
        sessionId: record.sessionId,
        outcome: record.state === "ACCEPTED" || record.state === "REJECTED" ? record.state : "ABORTED",
        decision: record.decision,
        repair: lane,
        budgeted: lane !== null,
        artifactHash: record.artifactHash,
        failureSignature: record.failureSignature,
      },
    ];
    persisted = base;
    if (config.stateDir !== undefined) saveFeedbackState(config.stateDir, base);
  };

  const evaluate = (round: number, sessionId: string, result: StageFlowResult): FeedbackRoundOutcome => ({
    round,
    sessionId,
    state: result.state,
    decision: result.state === "ACCEPTED" ? null : routeFailure(routerInputOf(result)).kind,
    artifactHash: artifactHashOf(result),
    failureSignature: result.state === "ACCEPTED" ? null : failureSignatureOf(result),
  });

  const startRound = (round: number, session: string, repair: FeedbackLane | null): void => {
    config.onFeedback?.({ action: "round-start", round, session, repair });
    config.onRoundStarted?.(session);
  };
  const endRound = (round: number, session: string, measured: StageFlowResult): void => {
    config.onRoundCompleted?.(session, measured);
    config.onFeedback?.({ action: "round-end", round, session, state: measured.state,
      reason: measured.failure?.reason ?? measured.verification?.expectationComparison?.reason ?? null,
      log_dir: measured.logDir });
  };
  const finish = (reason: FeedbackStopReason, detail: string | null = null): FeedbackLoopOutcome => {
    config.onFeedback?.({ action: "stop", reason, detail, budget_total: config.budget, budget_used: budgetUsed });
    return { result, rounds, stoppedBecause: reason, stopDetail: detail };
  };
  const beginRepair = (round: number, session: string, lane: FeedbackLane, evidence: RepairEvidence,
    dialogueId: string | null = null, reuseBaseline = false): void => {
    config.onFeedback?.({ action: "repair-start", round, session, lane, evidence,
      dialogue_id: dialogueId, reuse_baseline: reuseBaseline, budget_total: config.budget, budget_used: budgetUsed });
  };

  startRound(firstRound, config.sessionIdFor(firstRound), null);
  let result = await config.runInitial();
  endRound(firstRound, config.sessionIdFor(firstRound), result);
  let record = evaluate(firstRound, config.sessionIdFor(firstRound), result);
  rounds.push(record);
  persist(record, result, null);

  while (true) {
    if (result.state === "ACCEPTED") return finish("accepted");

    const decision = routeFailure(routerInputOf(result));

    if (decision.kind === "stop" || decision.kind === "needs-diagnosis") {
      return finish("routed-stop", decision.detail);
    }
    if (budgetUsed >= config.budget) return finish("budget-exhausted");

    // No-progress brake: identical artifact AND identical failure twice.
    const previous = rounds.at(-2);
    const current = rounds.at(-1);
    if (
      previous !== undefined && current !== undefined &&
      previous.artifactHash !== null && current.artifactHash !== null &&
      previous.failureSignature !== null && current.failureSignature !== null &&
      previous.artifactHash === current.artifactHash &&
      previous.failureSignature === current.failureSignature
    ) {
      return finish("no-progress");
    }

    const round = firstRound + rounds.length;
    const sessionId = config.sessionIdFor(round);
    let context: RepairRoundContext;

    if (decision.kind === "repair-refactor") {
      // Durable dialogue handles: a lane that did not run the refactor AI
      // (e.g. the previous round was a build repair) keeps the id from the
      // last round that did, so lane SWITCHES continue the original chat.
      const dialogueId = result.refactorDialogueId ?? persisted.dialogues.refactor ?? null;
      const patch = result.patch;
      if (dialogueId === null) {
        return finish("missing-dialogue", "没有可继续的原重构对话编号。");
      }
      if (patch === null) {
        return finish("missing-patch", "尚未记录候选提交，无法确定从哪里继续修复。");
      }
      const pinnedWorkflows = config.loadPinnedWorkflows();
      if (pinnedWorkflows === null) {
        return finish("missing-patch", "当前验证方案不可用，无法用相同方案重新验证。");
      }
      // Baseline reuse: every refactor-lane trigger (candidate build/crash,
      // behavior mismatch) implies the baseline side PASSED under this exact
      // pinned exam in the previous round, and repair rounds never move the
      // repo HEAD — so the previous baseline observations remain valid.
      // The loader receives the previous round's REAL session id.
      const reusedBaseline = config.loadBaselineObservations(rounds.at(-1)!.sessionId, patch.base_sha);
      const feedback = composeRefactorFeedback(decision.trigger, decision.evidence, {
        candidateBranch: patch.branch,
        round,
      });
      context = {
        lane: "refactor",
        dialogueId,
        candidateBranch: patch.branch,
        baseSha: patch.base_sha,
        pinnedWorkflows,
        feedback,
        reusedBaseline,
        sessionId,
      };
      budgetUsed += 1;
      persistBudget();
      beginRepair(round, sessionId, "refactor", decision.evidence, dialogueId, reusedBaseline !== null);
    } else if (decision.kind === "repair-test") {
      const dialogueId = result.workflowsDialogueId ?? persisted.dialogues.testWriter ?? null;
      const testEntry = config.locateExamEntry();
      const patch = result.patch;
      if (dialogueId === null || testEntry === null) {
        return finish("missing-input", "原测试编写对话编号或测试脚本路径不可用。");
      }
      if (patch === null) {
        return finish("missing-patch", "尚未记录候选提交，无法保留已完成的改动。");
      }
      const feedback = composeTestFeedback(decision.evidence, { round, testEntry });
      context = {
        lane: "test",
        adoptBuilds: config.loadCurrentBuilds?.() ?? [],
        dialogueId,
        testEntry,
        feedback,
        candidateBranch: patch.branch,
        baseSha: patch.base_sha,
        sessionId,
      };
      budgetUsed += 1;
      persistBudget();
      beginRepair(round, sessionId, "test", decision.evidence, dialogueId);
    } else {
      // decision.kind === "repair-build"
      const patch = result.patch;
      if (patch === null) {
        return finish("missing-patch", "尚未记录候选提交，无法保留已完成的改动。");
      }
      const brief = config.composeBuildBrief(decision.evidence, round);
      if (brief === null) {
        return finish("missing-input", "缺少已保存的构建方案，无法提供修复所需信息。");
      }
      // Consume the budget unit BEFORE dispatching the repair session: a
      // session that tries and fails (or a run interrupted mid-repair) has
      // still spent the attempt, and the durable state must say so.
      budgetUsed += 1;
      persistBudget();
      beginRepair(round, sessionId, "build", decision.evidence);
      const fixed = await config.runBuildRepair(brief, round);
      if (fixed === null) {
        return finish("repair-failed", "构建修复会话没有交付可用的修复方案；已保留证据。");
      }
      config.onFeedback?.({ action: "build-repaired", round, build_id: fixed.id });
      const pinnedWorkflows = config.loadPinnedWorkflows();
      if (pinnedWorkflows === null) {
        return finish("missing-patch", "构建方案已修复，但当前测试方案不可用，无法重新验证。");
      }
      context = {
        lane: "build",
        fixedBuild: fixed,
        failedBuildId: decision.evidence.buildId ?? null,
        candidateBranch: patch.branch,
        baseSha: patch.base_sha,
        pinnedWorkflows,
        sessionId,
      };
    }

    startRound(round, sessionId, context.lane);
    result = await config.runRepairRound(round, context);
    endRound(round, sessionId, result);
    record = evaluate(round, sessionId, result);
    rounds.push(record);
    persist(record, result, context.lane);
  }
}

/** Feedback message for the continued authoring dialogue (script-error lane). */
function composeTestFeedback(evidence: RepairEvidence, context: { round: number; testEntry: string }): string {
  const lines: string[] = [];
  lines.push(`[第 ${String(context.round)} 轮反馈 — 系统自动追加]`);
  lines.push("你编写的 TestWorkflow 在执行时自身出错了（脚本错误，不是被测程序的行为问题）。");
  lines.push(`错误证据：${evidence.summary}`);
  if (evidence.side !== undefined) {
    lines.push(`出错的一侧：${evidence.side === "baseline" ? "基线（原代码）" : "候选（新代码）"}。`);
  }
  if (evidence.evidencePaths !== undefined && evidence.evidencePaths.length > 0) {
    lines.push(`日志与证据路径（可读取）：${evidence.evidencePaths.join("、")}`);
  }
  lines.push("请修复脚本的执行错误（路径、API 用法、语法等），并保持考卷的覆盖面不缩水。");
  return lines.join("\n");
}
