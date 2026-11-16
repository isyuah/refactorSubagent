import type { VerificationAnalysis } from "../agents/verification-analysis.js";
import type { FailureReport, HostPreflight, ProjectDetection } from "../artifacts/index.js";
import type { Limits } from "../config/limits.js";
import type { FeedbackUpdate } from "./feedback/types.js";
import type { FeedbackReport } from "./feedback/progress.js";
import type { Pipeline } from "../config/pipeline.js";

export interface RunConfiguration {
  readonly pipeline: Pipeline;
  readonly sources: readonly string[];
  readonly overrides: readonly string[];
}
export interface WorkspaceSummary {
  readonly branch: string;
  readonly base_sha: string;
  readonly baseline_dir: string;
  readonly candidate_dir: string;
}

export type Side = "baseline" | "candidate";
export type RunStage = "preflight" | "workflows" | "prepare" | "refactor" | "verify" | "cleanup";
export type ExecutionStatus = "running" | "pass" | "failed" | "not-run" | "reused";
export interface ExecutionContext {
  readonly side: Side;
  readonly build_id?: string;
  readonly log_path: string;
}
export interface AgentUsage {
  readonly agent_id: string;
  readonly role: string;
  readonly session_id?: string;
  readonly parent_id?: string;
  readonly model?: string;
  readonly turns?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly cost_usd?: number;
  readonly duration_ms?: number;
}
export interface CheckResult {
  readonly name: string;
  readonly matched: boolean;
  readonly reason: string;
  readonly baseline?: unknown;
  readonly candidate?: unknown;
}
export interface ComparisonSummary {
  readonly overall: string;
  readonly total: number;
  readonly matched: number;
  readonly mismatched: number;
  readonly checks: readonly CheckResult[];
  readonly errors: readonly string[];
  readonly warnings?: readonly string[];
  readonly reason: string;
  readonly evidence_paths: readonly string[];
}
export interface CandidateSummary {
  readonly branch: string;
  readonly base_sha: string;
  readonly commit_sha: string;
  readonly changed_files: readonly string[];
}
export type ProgressUpdate = (
  | { readonly type: "feedback"; readonly feedback: FeedbackUpdate }
  | { readonly type: "phase"; readonly name: string }
  | { readonly type: "resume"; readonly source_session: string; readonly reused_stages: readonly RunStage[] }
  | { readonly type: "stage"; readonly name: RunStage; readonly action: "start" | "end"; readonly failed?: boolean }
  | { readonly type: "log"; readonly level: string; readonly message: string; readonly heartbeat?: boolean; readonly details?: Record<string, unknown> }
  | { readonly type: "preflight"; readonly host: HostPreflight; readonly project: ProjectDetection }
  | { readonly type: "strategy"; readonly report: VerificationAnalysis; readonly path: string }
  | ({ readonly type: "workspace" } & WorkspaceSummary)
  | { readonly type: "candidate"; readonly candidate: CandidateSummary }
  | { readonly type: "agent-start"; readonly agent_id: string; readonly role: string; readonly model?: string }
  | { readonly type: "agent-text"; readonly agent_id: string; readonly role: string; readonly text: string }
  | { readonly type: "agent-activity"; readonly agent_id: string; readonly role: string; readonly text: string; readonly heartbeat?: boolean }
  | { readonly type: "agent-tool"; readonly agent_id: string; readonly role: string; readonly id: string; readonly name: string; readonly target: string; readonly action: "start" | "end"; readonly failed?: boolean }
  | { readonly type: "agent-usage"; readonly usage: AgentUsage }
  | { readonly type: "command-start"; readonly id: string; readonly program: string; readonly args: readonly string[]; readonly cwd: string }
  | { readonly type: "command-output"; readonly id: string; readonly stream: "stdout" | "stderr"; readonly text: string }
  | { readonly type: "command-end"; readonly id: string; readonly status: string; readonly exit_code: number | null; readonly duration_ms: number; readonly error: string | null }
  | { readonly type: "step"; readonly id: string; readonly title: string; readonly status: string; readonly duration_ms?: number; readonly error?: string }
  | { readonly type: "build"; readonly side: Side; readonly id: string; readonly status: ExecutionStatus; readonly duration_ms?: number; readonly failure?: string | null; readonly evidence_path?: string }
  | { readonly type: "test"; readonly side: Side; readonly status: ExecutionStatus; readonly duration_ms?: number; readonly failure?: string | null; readonly checks?: number; readonly ctest_tests?: number; readonly evidence_path?: string }
  | { readonly type: "comparison"; readonly comparison: ComparisonSummary }
) & { readonly context?: ExecutionContext };

export type RunProgressEvent = ProgressUpdate & {
  readonly time: string;
  readonly elapsed_ms: number;
  readonly phase: string;
};
export type ProgressObserver = (event: RunProgressEvent) => void;
export type WorkflowProgressObserver = (update: ProgressUpdate) => void;

export interface StageTiming {
  readonly name: RunStage;
  readonly status: "completed" | "reused" | "failed" | "not-run";
  readonly elapsed_ms: number;
}
export interface ExecutionSummary {
  readonly side: Side;
  readonly id: string;
  readonly status: ExecutionStatus;
  readonly duration_ms: number | null;
  readonly failure: string | null;
  readonly checks?: number;
  readonly ctest_tests?: number;
  readonly evidence_path?: string;
}
export interface RunReport {
  readonly version: 1;
  readonly session: string;
  readonly repo: string;
  readonly task: string;
  readonly state: string;
  readonly abort_reason: string | null;
  readonly failure: FailureReport | null;
  readonly resume: { readonly source_session: string; readonly reused_stages: readonly RunStage[] } | null;
  readonly decision_reason: string | null;
  readonly finalization_error: string | null;
  readonly elapsed_ms: number;
  readonly stage_timings: readonly StageTiming[];
  readonly phases: readonly { name: string; elapsed_ms: number }[];
  readonly limits: Limits;
  readonly limit_sources: readonly string[];
  readonly limit_overrides: readonly string[];
  readonly configuration: RunConfiguration | null;
  readonly preflight: { host: HostPreflight; project: ProjectDetection } | null;
  readonly strategy: { report: VerificationAnalysis; path: string } | null;
  readonly candidate: CandidateSummary | null;
  readonly workspace: WorkspaceSummary | null;
  readonly builds: readonly ExecutionSummary[];
  readonly tests: readonly ExecutionSummary[];
  readonly comparison: ComparisonSummary | null;
  readonly refactor_summary: string;
  readonly agents: readonly AgentUsage[];
  /** Only root session totals: SDK root usage can already include its children. */
  readonly cost_usd: number | null;
  readonly log_dir: string;
  readonly report_path: string;
  readonly feedback?: FeedbackReport;
}

/** One consumer for both the live terminal and the durable final report. */
export class RunReportCollector {
  private readonly stages = new Map<RunStage, { start: number; end?: number; failed: boolean }>();
  private readonly phases: Array<{ name: string; start: number; end?: number }> = [];
  private readonly builds = new Map<string, ExecutionSummary>();
  private readonly tests = new Map<Side, ExecutionSummary>();
  private readonly agents = new Map<string, AgentUsage>();
  private preflight: RunReport["preflight"] = null;
  private strategy: RunReport["strategy"] = null;
  private candidate: CandidateSummary | null = null;
  private workspace: WorkspaceSummary | null = null;
  private comparison: ComparisonSummary | null = null;

  accept(event: RunProgressEvent): void {
    switch (event.type) {
      case "stage":
        if (event.action === "start") this.stages.set(event.name, { start: event.elapsed_ms, failed: false });
        else {
          const stage = this.stages.get(event.name);
          if (stage) { stage.end = event.elapsed_ms; stage.failed = event.failed === true; }
        }
        break;
      case "phase": {
        const last = this.phases.at(-1);
        if (last) last.end = event.elapsed_ms;
        this.phases.push({ name: event.name, start: event.elapsed_ms });
        break;
      }
      case "preflight": this.preflight = { host: event.host, project: event.project }; break;
      case "strategy": this.strategy = { report: event.report, path: event.path }; break;
      case "candidate": this.candidate = event.candidate; break;
      case "workspace": this.workspace = { branch: event.branch, base_sha: event.base_sha,
        baseline_dir: event.baseline_dir, candidate_dir: event.candidate_dir }; break;
      case "build": this.builds.set(`${event.side}/${event.id}`, execution(event, event.id)); break;
      case "test": this.tests.set(event.side, execution(event, "tests")); break;
      case "comparison": this.comparison = event.comparison; break;
      case "agent-usage": this.agents.set(event.usage.agent_id, event.usage); break;
    }
  }

  finish(input: Pick<RunReport, "session" | "repo" | "task" | "state" | "abort_reason" | "failure" | "resume" | "decision_reason" | "finalization_error" | "elapsed_ms" | "limits" | "limit_sources" | "limit_overrides" | "configuration" | "refactor_summary" | "log_dir" | "report_path">,
    buildIds: readonly string[]): RunReport {
    const agents = [...this.agents.values()];
    const rootCosts = agents.filter((agent) => !agent.parent_id && agent.cost_usd !== undefined);
    const builds: ExecutionSummary[] = [];
    const tests: ExecutionSummary[] = [];
    for (const side of ["baseline", "candidate"] as const) {
      for (const id of buildIds) builds.push(finalExecution(this.builds.get(`${side}/${id}`) ?? notRun(side, id), input.abort_reason));
      tests.push(finalExecution(this.tests.get(side) ?? notRun(side, "tests"), input.abort_reason));
    }
    return {
      version: 1, ...input,
      // Successful artifact transitions may carry an empty history note; use
      // the measured comparison as the verdict's explanation in that case.
      decision_reason: input.decision_reason?.trim() || input.abort_reason || this.comparison?.reason || null,
      stage_timings: (["preflight", "workflows", "prepare", "refactor", "verify", "cleanup"] as const).map((name) => {
        const timing = this.stages.get(name);
        return { name, status: timing ? timing.failed || timing.end === undefined ? "failed" : input.resume?.reused_stages.includes(name) ? "reused" : "completed" : "not-run",
          elapsed_ms: timing ? Math.max(0, (timing.end ?? input.elapsed_ms) - timing.start) : 0 };
      }),
      phases: this.phases.map((phase) => ({ name: phase.name, elapsed_ms: Math.max(0, (phase.end ?? input.elapsed_ms) - phase.start) })),
      preflight: this.preflight, strategy: this.strategy, candidate: this.candidate, workspace: this.workspace,
      builds, tests, comparison: this.comparison, refactor_summary: input.refactor_summary, agents,
      cost_usd: rootCosts.length ? rootCosts.reduce((sum, agent) => sum + agent.cost_usd!, 0) : null,
    };
  }
}

function execution(event: Extract<RunProgressEvent, { type: "build" | "test" }>, id: string): ExecutionSummary {
  return { side: event.side, id, status: event.status, duration_ms: event.duration_ms ?? null,
    failure: event.failure ?? null, ...(event.type === "test" && event.checks !== undefined ? { checks: event.checks } : {}),
    ...(event.type === "test" && event.ctest_tests !== undefined ? { ctest_tests: event.ctest_tests } : {}),
    ...(event.evidence_path ? { evidence_path: event.evidence_path } : {}) };
}
function notRun(side: Side, id: string): ExecutionSummary {
  return { side, id, status: "not-run", duration_ms: null, failure: null };
}
function finalExecution(run: ExecutionSummary, abortReason: string | null): ExecutionSummary {
  return run.status === "running" ? { ...run, status: "failed", failure: abortReason ?? "执行中断，未获得完成结果" } : run;
}
