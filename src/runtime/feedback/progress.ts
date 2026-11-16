import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2ELogger } from "../log.js";
import type { AgentUsage, ProgressObserver, RunProgressEvent, StageTiming } from "../progress.js";
import type { StageFlowResult } from "../stage-flow.js";
import type { FeedbackLane, FeedbackStopReason, FeedbackUpdate } from "./types.js";

export interface FeedbackRoundSummary {
  readonly round: number;
  readonly session: string;
  readonly repair: FeedbackLane | null;
  readonly state: string;
  readonly reason: string | null;
  readonly elapsed_ms: number;
  readonly stage_timings: readonly StageTiming[];
  readonly log_dir: string;
  readonly report_path: string;
}
export interface FeedbackReport {
  readonly owner_session: string;
  readonly resumed_from: string | null;
  readonly budget_total: number;
  readonly budget_used_before: number;
  readonly budget_used: number;
  readonly stopped_because: FeedbackStopReason | "finalization-error";
  readonly stop_detail: string | null;
  readonly state_dir: string;
  readonly dialogue_dir: string;
  /** Rounds executed by this invocation; earlier history stays in feedback-state.json. */
  readonly rounds: readonly FeedbackRoundSummary[];
  /** Build authoring happens before its verification round. */
  readonly build_repairs: readonly { round: number; elapsed_ms: number; delivered: boolean; log_dir: string }[];
}

/** One monotonic timeline across rounds and the separate build-repair session. */
export class FeedbackRunProgress {
  private readonly logger: E2ELogger;
  private readonly rounds = new Map<string, { round: number; repair: FeedbackLane | null; result?: StageFlowResult }>();
  private readonly agents = new Map<string, AgentUsage>();
  private budgetUsed: number;
  private readonly buildRepairs: Array<{ round: number; start: number; end?: number; delivered: boolean; log_dir: string }> = [];

  constructor(private readonly input: {
    session: string; owner: string; resumeFrom: string | null; stateDir: string;
    e2eRoot: string; budget: number; budgetUsed: number; onProgress?: ProgressObserver;
  }) {
    this.budgetUsed = input.budgetUsed;
    this.logger = new E2ELogger(join(input.stateDir, "executions"), input.session);
    if (input.onProgress) this.logger.subscribe(input.onProgress);
    this.onFeedback({ action: "start", owner_session: input.owner, resumed_from: input.resumeFrom,
      budget_total: input.budget, budget_used: input.budgetUsed, state_dir: input.stateDir });
  }

  forward = (event: RunProgressEvent): void => {
    if (event.type === "agent-usage") this.agents.set(event.usage.agent_id, event.usage);
    if (event.type === "phase") this.logger.phase(event.name);
    else this.logger.progress(event);
  };

  onFeedback = (update: FeedbackUpdate): void => {
    if (update.action === "repair-start" && update.lane === "build") {
      this.buildRepairs.push({ round: update.round, start: this.logger.elapsedMs(), delivered: false,
        log_dir: join(this.input.e2eRoot, `${update.session}-bw`) });
    }
    if (update.action === "build-repaired") {
      const repair = this.buildRepairs.at(-1)!;
      repair.end = this.logger.elapsedMs();
      repair.delivered = true;
    }
    if (update.action === "stop") {
      const repair = this.buildRepairs.at(-1);
      if (repair && repair.end === undefined) repair.end = this.logger.elapsedMs();
    }
    if (update.action === "round-start") this.rounds.set(update.session, { round: update.round, repair: update.repair });
    if (update.action === "repair-start" || update.action === "stop") this.budgetUsed = update.budget_used;
    // Save only typed metadata here. AI text and tool data stay in their session logs.
    appendFileSync(join(this.logger.runDir, "feedback-events.jsonl"), JSON.stringify({ ...update, elapsed_ms: this.logger.elapsedMs() }) + "\n");
    this.logger.progress({ type: "feedback", feedback: update });
  };

  remember(session: string, result: StageFlowResult): void {
    const entry = this.rounds.get(session)!;
    entry.result = result;
    // Preserve each round before the invocation-level report replaces run-summary.json.
    const roundPath = join(result.logDir, "artifacts", "round-summary.json");
    writeFileSync(roundPath, JSON.stringify({ ...result.report, report_path: roundPath }, null, 2) + "\n");
    for (const usage of result.report.agents) this.agents.set(usage.agent_id, usage);
  }

  finish(result: StageFlowResult, reason: FeedbackReport["stopped_because"], detail: string | null): StageFlowResult {
    const rounds: FeedbackRoundSummary[] = [];
    for (const [session, entry] of this.rounds) {
      if (!entry.result) continue; // Interrupted executions have no completed round report.
      const report = entry.result.report;
      rounds.push({ round: entry.round, session, repair: entry.repair, state: report.state,
        reason: report.abort_reason ?? report.decision_reason, elapsed_ms: report.elapsed_ms,
        stage_timings: report.stage_timings, log_dir: report.log_dir,
        report_path: join(report.log_dir, "artifacts", "round-summary.json") });
    }
    const feedback: FeedbackReport = {
      owner_session: this.input.owner, resumed_from: this.input.resumeFrom,
      budget_total: this.input.budget, budget_used_before: this.input.budgetUsed,
      budget_used: this.budgetUsed, stopped_because: reason, stop_detail: detail,
      state_dir: this.input.stateDir, dialogue_dir: join(this.input.e2eRoot, this.input.owner, "sessions"), rounds,
      build_repairs: this.buildRepairs.map((repair) => ({ round: repair.round,
        elapsed_ms: (repair.end ?? this.logger.elapsedMs()) - repair.start, delivered: repair.delivered, log_dir: repair.log_dir })),
    };
    this.logger.finish(reason === "finalization-error" ? "error" : result.state.toLowerCase(), "运行结束，正在保存汇总报告");
    const agents = [...this.agents.values()];
    const roots = agents.filter((usage) => usage.parent_id === undefined && usage.cost_usd !== undefined);
    const report = { ...result.report, session: this.input.session, elapsed_ms: this.logger.elapsedMs(),
      report_path: join(this.input.e2eRoot, this.input.session, "artifacts", "run-summary.json"),
      agents, cost_usd: roots.length ? roots.reduce((sum, usage) => sum + usage.cost_usd!, 0) : null, feedback };
    writeFileSync(report.report_path, JSON.stringify(report, null, 2) + "\n");
    return { ...result, report };
  }

  close(): void { this.logger.close(); }
}
