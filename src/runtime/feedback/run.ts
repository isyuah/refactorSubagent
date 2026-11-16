import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExpectationBaseline, HostPreflight, ProjectDetection } from "../../artifacts/index.js";
import { resolveLimits } from "../../config/limits.js";
import {
  continuedWorkflowsStage, halt, runStageFlow, verifyStageWithReuse,
  StageFlowFinalizationError, type StageFlowRequest, type StageFlowResult,
} from "../stage-flow.js";
import { existingBranchPrepareStage, fixedRefactorStage } from "../stage-presets.js";
import {
  loadCheckpointDialogues, loadReusableWorkflowsStageFromView,
  loadWorkflowsCheckpointView, runStageFlowResume,
} from "../stage-resume.js";
import { E2ELogger } from "../log.js";
import { FeedbackRunProgress } from "./progress.js";
import { runFeedbackLoop, type FeedbackLoopOutcome } from "./coordinator.js";
import {
  loadEffectivePlan, planFromCheckpointView, replaceBuild, saveEffectivePlan,
  workflowContentHash,
} from "./effective-plan.js";
import { composeBuildRepairBrief, continuedRefactorStage, runBuildWriterRepairSession } from "./repair.js";
import { freshFeedbackState, loadFeedbackOwner, loadFeedbackState, saveFeedbackOwner } from "./state.js";

/** Fresh runs and checkpoint restarts share one feedback coordinator. */
export async function runFeedbackStageFlow(
  request: StageFlowRequest,
  options: {
    readonly budget: number;
    readonly resumeFrom: string | null;
  },
): Promise<FeedbackLoopOutcome> {
  const { repoPath: repo, sessionRoot, sessionId } = request;
  if (existsSync(join(sessionRoot, ".refactor", "sessions", sessionId))) throw new Error(`session exists: ${sessionId}`);
  const owner = options.resumeFrom === null ? sessionId : loadFeedbackOwner(sessionRoot, options.resumeFrom);
  const stateDir = join(sessionRoot, ".refactor", "feedback", owner);
  const state = loadFeedbackState(stateDir) ?? freshFeedbackState(options.budget);
  if (options.resumeFrom !== null) {
    // Current run-level handles take precedence when resuming an older round.
    Object.assign(state.dialogues, {
      ...loadCheckpointDialogues(sessionRoot, options.resumeFrom), ...state.dialogues,
    });
  }
  const firstRound = (state.rounds.at(-1)?.round ?? 0) + 1;
  const e2eDir = (sid: string): string => join(sessionRoot, ".refactor", "e2e", sid);
  const progress = new FeedbackRunProgress({ session: sessionId, owner, resumeFrom: options.resumeFrom,
    stateDir, e2eRoot: join(sessionRoot, ".refactor", "e2e"), budget: options.budget,
    budgetUsed: state.budgetUsed, onProgress: request.onProgress });
  const sharedRequest = { ...request, dialogueRoot: e2eDir(owner), onProgress: progress.forward };
  const readArtifact = (sid: string, name: string): unknown => {
    const path = join(e2eDir(sid), "artifacts", name);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  };
  let plan = loadEffectivePlan(stateDir);
  let lastSession = options.resumeFrom ?? sessionId;

  const rememberRound = (sid: string, result: StageFlowResult): void => {
    lastSession = sid;
    progress.remember(sid, result);
    const view = loadWorkflowsCheckpointView(repo, sessionRoot, sid);
    if (view === null) return;
    const next = planFromCheckpointView(view, repo);
    const baseline = ExpectationBaseline.safeParse(readArtifact(sid, "expectation-baseline.json"));
    if (baseline.success && baseline.data.workflow_passed && result.patch !== null) {
      plan = { ...next, baseline: { sessionId: sid, baseSha: result.patch.base_sha, planHash: workflowContentHash(next) } };
    } else {
      // A round without a new baseline may retain only an identical prior measurement.
      plan = { ...next, baseline: plan !== null && workflowContentHash(plan) === workflowContentHash(next) ? plan.baseline : null };
    }
    saveEffectivePlan(stateDir, plan);
  };

  try {
    const outcome = await runFeedbackLoop({
      baseTask: request.task,
      budget: options.budget,
      onFeedback: progress.onFeedback,
      stateDir,
      initialState: state,
      sessionIdFor: (round) => round === firstRound ? sessionId : `${sessionId}-fb${String(round)}`,
      onRoundStarted: (sid) => saveFeedbackOwner(sessionRoot, sid, owner),
      onRoundCompleted: rememberRound,
      runInitial: () => options.resumeFrom === null
        ? runStageFlow(sharedRequest)
        : runStageFlowResume({
            ...sharedRequest, sourceSessionId: options.resumeFrom, baseFlow: request.flow,
            ...(plan !== null ? { workflowsView: plan } : {}),
          }),
      loadPinnedWorkflows: () => plan === null ? null : loadReusableWorkflowsStageFromView(repo, plan),
      locateExamEntry: () => plan?.testEntry ?? null,
      loadCurrentBuilds: () => plan?.builds ?? [],
      composeBuildBrief: (evidence, round) => {
        if (plan === null) return null;
        const failed = evidence.buildId === undefined
          ? plan.builds.length === 1 ? plan.builds[0] : undefined
          : plan.builds.find((build) => build.id === evidence.buildId);
        if (failed === undefined) return null;
        return composeBuildRepairBrief(evidence, {
          round, failedBuildId: failed.id, failedBuildEntry: failed.entry,
          failedBuildSource: readFileSync(failed.entry, "utf8"),
          otherSideOutcome: evidence.side === "candidate" ? "原版使用同一方案构建成功。" : "构建在原版失败，候选版尚未执行。",
        });
      },
      runBuildRepair: async (brief, round) => {
        const host = HostPreflight.safeParse(readArtifact(lastSession, "host-preflight.json"));
        const project = ProjectDetection.safeParse(readArtifact(lastSession, "project-detection.json"));
        if (!host.success || !project.success) return Promise.resolve(null);
        const limits = resolveLimits({ repoRoot: repo, overrides: request.limitOverrides }).limits.sessions.testWriter;
        const repairSession = `${sessionId}-fb${String(round)}-bw`;
        const logger = new E2ELogger(join(sessionRoot, ".refactor", "e2e"), repairSession);
        const unsubscribe = logger.subscribe(progress.forward);
        try {
          logger.phase("BUILD_REPAIR");
          return await runBuildWriterRepairSession({
            repoDir: repo, sessionRoot, sessionId: repairSession,
            task: request.task, host: host.data, project: project.data, brief, limits,
            logger, dialogueRoot: e2eDir(owner),
          });
        } finally {
          unsubscribe();
          logger.close();
        }
      },
      loadBaselineObservations: (_previousSessionId, baseSha) => {
        if (plan === null || plan.baseline === null) return null;
        if (plan.baseline.baseSha !== baseSha || plan.baseline.planHash !== workflowContentHash(plan)) return null;
        const baseline = ExpectationBaseline.safeParse(readArtifact(plan.baseline.sessionId, "expectation-baseline.json"));
        return baseline.success && baseline.data.workflow_passed ? baseline.data.expectations : null;
      },
      runRepairRound: (_round, context) => {
        const base = { ...sharedRequest, sessionId: context.sessionId };
        const prepare = existingBranchPrepareStage({ branch: context.candidateBranch, baseSha: context.baseSha });
        if (context.lane === "refactor") {
          return runStageFlow({
            ...base,
            flow: {
              ...request.flow,
              workflows: context.pinnedWorkflows, prepare,
              refactor: continuedRefactorStage({ dialogueId: context.dialogueId, feedback: context.feedback, dialogueRoot: e2eDir(owner) }),
              verify: verifyStageWithReuse(context.reusedBaseline === null ? {} : { reusedBaseline: { expectations: context.reusedBaseline } }),
            },
          });
        }
        if (context.lane === "test") {
          return runStageFlow({
            ...base,
            flow: {
              ...request.flow,
              workflows: continuedWorkflowsStage({
                dialogueId: context.dialogueId, feedback: context.feedback, testEntry: context.testEntry,
                dialogueRoot: e2eDir(owner), adoptBuilds: context.adoptBuilds,
              }),
              prepare,
              refactor: fixedRefactorStage(`feedback: candidate branch ${context.candidateBranch} carries the measured change`),
            },
          });
        }
        const repaired = plan === null ? null : replaceBuild(plan, context.fixedBuild, context.failedBuildId, repo);
        if (repaired === null) {
          return runStageFlow({ ...base, flow: { workflows: async () => halt("repaired build does not map into the current build set", { category: "resolution", component: "feedback-build-lane", retryable: false }) } });
        }
        plan = repaired;
        saveEffectivePlan(stateDir, plan);
        const workflows = loadReusableWorkflowsStageFromView(repo, plan);
        if (workflows === null) throw new Error("delivered build repair no longer matches its recorded sources");
        return runStageFlow({
          ...base,
          flow: {
            ...request.flow, workflows, prepare,
            refactor: fixedRefactorStage(`feedback: candidate branch ${context.candidateBranch} carries the measured change`),
          },
        });
      },
    });
    return { ...outcome, result: progress.finish(outcome.result, outcome.stoppedBecause, outcome.stopDetail) };
  } catch (error) {
    if (error instanceof StageFlowFinalizationError) {
      progress.remember(error.result.report.session, error.result);
      progress.onFeedback({ action: "stop", reason: "finalization-error", detail: error.result.report.finalization_error,
        budget_total: options.budget, budget_used: loadFeedbackState(stateDir)?.budgetUsed ?? state.budgetUsed });
      throw new StageFlowFinalizationError(progress.finish(error.result, "finalization-error", error.result.report.finalization_error), error);
    }
    throw error;
  } finally {
    progress.close();
  }
}
