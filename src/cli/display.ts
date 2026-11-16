import { dirname, isAbsolute, join } from "node:path";
import type { CliFormat, CliProgress, CliVerbosity } from "./args.js";
import type { FeedbackLane, FeedbackStopReason, FeedbackUpdate } from "../runtime/feedback/types.js";
import type { Limits } from "../config/limits.js";
import type { ExecutionContext, RunProgressEvent, RunReport } from "../runtime/progress.js";
import type { Pipeline } from "../config/pipeline.js";
import { cleanText, styled, statusTone, TerminalStyle, type ColorOptions, type TextLine, type TextPart, type Tone } from "./terminal.js";
import { toolPresentation } from "./tool-presentation.js";

export { cleanText } from "./terminal.js";

interface TerminalOutput {
  write(text: string): unknown;
  readonly isTTY?: boolean;
  readonly columns?: number;
}
export interface DisplayOptions {
  readonly format: CliFormat;
  readonly verbosity: CliVerbosity;
  readonly progress: CliProgress;
  readonly color: boolean;
  readonly output?: TerminalOutput;
  readonly now?: () => number;
  readonly env?: Record<string, string | undefined>;
}
export interface RunStartup {
  readonly repo: string;
  readonly task: string;
  readonly session: string;
  readonly log_dir: string;
  readonly pipeline: string;
  readonly pipeline_sources: readonly string[];
  readonly pipeline_config?: Pipeline;
  readonly pipeline_overrides?: readonly string[];
  readonly limits: Limits;
  readonly limit_sources: readonly string[];
  readonly limit_overrides?: readonly string[];
  readonly auto_retry?: number;
}

const PHASES: Readonly<Record<string, string>> = {
  INIT: "初始化", PREFLIGHT: "检查环境与项目", WORKFLOW_SESSION: "设计验证方案并编写脚本",
  PREPARE: "创建原版与候选工作目录", REFACTOR: "重构候选代码", VERIFICATION: "验证",
  BASELINE_BUILD: "构建原版", CANDIDATE_BUILD: "构建候选版",
  BASELINE_TEST_WORKFLOW: "测试原版", CANDIDATE_TEST_WORKFLOW: "测试候选版",
  BASELINE_CTEST: "原版 CTest", CANDIDATE_CTEST: "候选版 CTest",
  BUILD_REPAIR: "修复构建方案", FEEDBACK_REFACTOR: "修复候选代码", FEEDBACK_TEST: "修复测试脚本",
  FEEDBACK_BUILD: "修复构建方案", FEEDBACK_DONE: "运行结束",
  COMPARISON: "比较两侧结果", CLEANUP: "清理工作目录与保存结果",
};
const STAGES: Readonly<Record<string, string>> = {
  preflight: "环境与项目检查", workflows: "验证方案与脚本", prepare: "准备工作目录",
  refactor: "重构", verify: "验证（含两侧构建、测试与比较）", cleanup: "清理与保存",
};
const STRATEGIES: Readonly<Record<string, string>> = {
  "reuse-existing": "复用现有产物或测试", "library-consumer": "编写库调用程序",
  "source-harness": "编写独立辅助程序", undetermined: "尚未确定",
};
const ROLES: Readonly<Record<string, string>> = { "test-writer": "测试编写", "build-writer": "构建编写", refactor: "代码重构", "source-repair": "脚本策略修复", "build-repair": "构建方案修复" };

const REPAIR_LABELS: Readonly<Record<FeedbackLane, string>> = { refactor: "候选代码修复", test: "测试脚本修复", build: "构建方案修复" };
const FEEDBACK_STOPS: Readonly<Record<FeedbackStopReason | "finalization-error", string>> = {
  accepted: "验证通过", "budget-exhausted": "已达到自动修复次数上限", "no-progress": "连续两轮的方案或代码及失败原因相同，停止重复修复",
  "routed-stop": "当前问题无法自动修复", "repair-failed": "未获得可用的修复方案",
  "missing-dialogue": "缺少原 AI 对话，无法继续修复", "missing-patch": "缺少可继续使用的候选代码或验证方案",
  "missing-input": "缺少修复所需的信息", "finalization-error": "结果保存或清理失败，已保留验证结论",
};

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
}
function commandText(program: string, args: readonly string[]): string {
  let redactNext = false;
  return [program, ...args].map((arg) => {
    if (redactNext) { redactNext = false; return "[redacted]"; }
    if (/^--?(?:token|password|api[-_]?key|secret|authorization)$/i.test(arg)) redactNext = true;
    const safe = arg.replace(/((?:token|password|api[-_]?key|secret|authorization)=)[^\s]+/gi, "$1[redacted]");
    return /\s/.test(safe) ? JSON.stringify(safe) : safe;
  }).join(" ");
}
function roleName(role: string): string { return ROLES[role] ?? role; }
function agentParts(role: string, id: string): TextPart[] {
  const [root, child] = id.split("/");
  return [styled(`AI [${roleName(role)}`, "agent"), " · ",
    styled(`${root!.slice(0, 8)}${child ? `/${child.slice(-8)}` : ""}`, "muted"), styled("]", "agent")];
}
function sidePart(side: "baseline" | "candidate"): TextPart {
  return styled(side === "baseline" ? "原版" : "候选版", side);
}
function contextParts(context: ExecutionContext | undefined, stream?: "stdout" | "stderr"): TextPart[] {
  return ["[", ...(context ? [sidePart(context.side), context.build_id ? `/${context.build_id}` : ""] : [styled("执行", "accent")]),
    ...(stream ? [" ", styled(stream, stream === "stderr" ? "warning" : "accent")] : []), "]"];
}
function field(label: string, value: string, tone: Tone = "accent"): TextPart[] {
  return [styled(`${label}: `, tone), value];
}
function comparisonParts(comparison: NonNullable<RunReport["comparison"]>): TextPart[] {
  return [styled("比较: ", "accent"), styled(comparison.overall, statusTone(comparison.overall)), ` · ${comparison.total} 项 · `,
    styled(`一致 ${comparison.matched}`, "success"), " · ", styled(`失配 ${comparison.mismatched}`, comparison.mismatched ? "error" : "muted"), " · ",
    styled(`比较错误 ${comparison.errors.length}`, comparison.errors.length ? "error" : "muted")];
}

type ToolEvent = Extract<RunProgressEvent, { type: "agent-tool" }>;

/** Append-only history, with one disposable status line on interactive terminals. */
export class RunDisplay {
  private readonly output: TerminalOutput;
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly animated: boolean;
  private readonly style: TerminalStyle;
  private observedAt: number;
  private elapsed = 0;
  private phase = "INIT";
  private phaseStarted = 0;
  private lastActivity = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private hasStatus = false;
  private closed = false;
  private interrupted = false;
  private logDir = "";
  private logRoot = "";
  private round: number | null = null;
  private repair: FeedbackLane | null = null;
  private repairsUsed = 0;
  private repairBudget = 0;
  private readonly pending = new Map<string, string>();
  private readonly tails = new Map<string, string>();
  private readonly reusedStages = new Set<string>();
  private readonly activeTools = new Map<string, ToolEvent>();
  private readonly completedTools = new Set<string>();

  constructor(private readonly options: DisplayOptions) {
    this.output = options.output ?? process.stderr;
    this.now = options.now ?? (() => performance.now());
    this.observedAt = this.now();
    const env = options.env ?? process.env;
    this.enabled = options.progress !== "off" && (options.format !== "json" || options.progress === "plain");
    this.animated = options.progress === "auto" && Boolean(this.output.isTTY) && env.TERM !== "dumb";
    this.style = new TerminalStyle({ color: options.color, output: this.output, env });
  }

  start(input: RunStartup): void {
    this.logDir = input.log_dir;
    this.logRoot = dirname(input.log_dir);
    if (!this.enabled) return;
    this.line(styled("开始运行", "heading"));
    this.lines([field("任务", input.task), field("仓库", input.repo), field("会话", input.session),
      field("结果目录", input.log_dir), field("运行配置", input.pipeline), field("运行配置来源", input.pipeline_sources.join(", ") || "内置默认")]);
    if (input.pipeline_config) this.line(...field("阶段配置", JSON.stringify(input.pipeline_config.stages)));
    if (input.pipeline_overrides?.length) this.line(...field("命令行阶段覆盖", input.pipeline_overrides.join("; ")));
    this.line(...field("限制配置来源", input.limit_sources.join(", ") || "内置默认"));
    if (input.limit_overrides?.length) this.line(...field("命令行限制覆盖", input.limit_overrides.join("; ")));
    this.lines(limitLines(input.limits));
    if (input.auto_retry !== undefined) this.line(...field("自动修复上限", input.auto_retry === 0 ? "关闭（只执行，不自动修复）" : `${input.auto_retry} 次；首次执行不计入，恢复时继承已用次数`));
    this.timer = setInterval(() => this.tick(), this.animated ? 1000 : 10_000);
    this.timer.unref();
  }

  receive = (event: RunProgressEvent): void => {
    if (!this.enabled || this.closed) return;
    this.observedAt = this.now();
    this.elapsed = event.elapsed_ms;
    if (!(event.type === "log" && (event.heartbeat || ["trace", "debug"].includes(event.level))) &&
        !(event.type === "agent-activity" && event.heartbeat)) this.lastActivity = event.elapsed_ms;
    const label = styled(`[${duration(event.elapsed_ms)}]`, "muted");
    switch (event.type) {
      case "feedback": this.feedbackEvent(event.feedback, event.elapsed_ms); break;
      case "resume":
        for (const stage of event.reused_stages) this.reusedStages.add(stage);
        this.line(label, " ", ...field("恢复自会话", event.source_session));
        this.line(...field("复用阶段", `${event.reused_stages.map((stage) => STAGES[stage] ?? stage).join("、") || "无"}；环境检查与验证重新执行，阶段耗时仅计入本次重新校验。`));
        break;
      case "phase":
        this.phase = event.name;
        this.phaseStarted = event.elapsed_ms;
        this.line(label, " ", styled(this.phaseLabel(event.name), "heading"), " ", styled(`(${event.name})`, "muted"));
        break;
      case "stage":
        if (event.action === "end") this.line(label, " ", styled(`${STAGES[event.name]}: `, "accent"),
          styled(event.failed ? "未完成" : this.reusedStages.has(event.name) ? "复用完成" : "完成", event.failed ? "error" : "success"));
        break;
      case "log":
        if (!event.heartbeat && !["trace", "debug"].includes(event.level)) {
          const details = event.details ?? {};
          const extra = ["attempt", "max_repairs", "entry", "rule", "detail", "reason", "duration_ms", "stage", "category", "component", "retryable"]
            .flatMap((key) => details[key] === undefined ? [] : [`${key}=${String(details[key])}`]);
          this.line(label, " ", styled(event.level === "error" ? "错误: " : event.level === "warn" ? "提示: " : "活动: ",
            event.level === "error" ? "error" : event.level === "warn" ? "warning" : "accent"),
            event.message, extra.length ? ` · ${extra.join(" · ")}` : "");
        }
        break;
      case "preflight":
        this.line(...field("平台", `${event.host.platform}/${event.host.arch}`), "; ", ...field("项目", event.project.status), "; ",
          ...field("构建系统", event.project.primary_build_system ?? "未识别"), `\n${event.project.reason}`);
        this.line(styled("工具: ", "accent"), ...Object.entries(event.host.tools).flatMap(([name, tool], index) =>
          [index ? "; " : "", styled(`${name}=`, "accent"), tool.available ? tool.path ?? "可用" : styled("不可用", "warning")]));
        break;
      case "strategy": this.lines(strategyLines(event.report, this.options.verbosity)); break;
      case "workspace": this.lines([field("基准提交", event.base_sha), field("候选分支", event.branch),
        field("原版目录", event.baseline_dir), field("候选目录", event.candidate_dir)]); break;
      case "candidate": this.lines([field("候选提交", event.candidate.commit_sha), field("改动文件", event.candidate.changed_files.join(", "))]); break;
      case "agent-start": this.line(label, " ", ...agentParts(event.role, event.agent_id), " ", styled("开始", "accent"),
        " · ", styled("模型=", "accent"), event.model ?? "SDK 默认/尚未报告"); break;
      case "agent-text":
        if (this.options.verbosity === "detailed") this.line(label, " ", ...agentParts(event.role, event.agent_id), `:\n${event.text}`);
        break;
      case "agent-activity":
        if (!event.heartbeat) this.line(label, " ", ...agentParts(event.role, event.agent_id), ` ${event.text}`);
        break;
      case "agent-tool": this.toolEvent(event); break;
      case "agent-usage": this.line(label, " ", ...agentParts(event.usage.role, event.usage.agent_id), " ", styled("结束", "accent"), ` · ${usageText(event.usage)}`); break;
      case "command-start": this.line(label, " ", ...contextParts(event.context), " ", styled("$ ", "accent"),
        commandText(event.program, event.args), "\n  ", ...field("cwd", event.cwd)); break;
      case "command-output": this.outputChunk(event); break;
      case "command-end": {
        this.flushCommand(event);
        const tone = event.status === "exited" && event.exit_code === 0 && !event.error ? "success" : statusTone(event.status) === "warning" ? "warning" : "error";
        this.line(label, " ", ...contextParts(event.context), " ", styled("命令结束: ", "accent"), styled(event.status, tone),
          `; exit=${event.exit_code ?? "无"}; 耗时=${duration(event.duration_ms)}${event.error ? `; ${event.error}` : ""}`);
        const tail = this.tails.get(commandKey(event)) ?? "";
        if (this.options.verbosity === "summary" && (event.status !== "exited" || (event.exit_code !== null && event.exit_code !== 0)) && tail) this.line(...field("输出末尾", `\n${tail}`, "warning"));
        if (event.context) this.line(...field("完整输出", event.context.log_path));
        this.tails.delete(commandKey(event));
        break;
      }
      case "step": this.line(label, " ", ...contextParts(event.context), " ", styled(event.title, "accent"), ` (${event.id}): `,
        styled(statusText(event.status), statusTone(event.status)), `${event.duration_ms === undefined ? "" : ` · ${duration(event.duration_ms)}`}${event.error ? ` · ${event.error}` : ""}`); break;
      case "build": this.line(label, " ", sidePart(event.side), styled(`构建 ${event.id}: `, "accent"), styled(statusText(event.status), statusTone(event.status)),
        `${event.duration_ms === undefined ? "" : ` · ${duration(event.duration_ms)}`}${event.failure ? ` · ${event.failure}` : ""}`); break;
      case "test": this.line(label, " ", sidePart(event.side), styled("测试: ", "accent"), styled(statusText(event.status), statusTone(event.status)),
        `${event.duration_ms === undefined ? "" : ` · ${duration(event.duration_ms)}`}${event.checks === undefined ? "" : ` · ${event.checks} 个检查项`}${event.ctest_tests === undefined ? "" : ` · ${event.ctest_tests} 个 CTest 测试`}${event.failure ? ` · ${event.failure}` : ""}`); break;
      case "comparison": this.line(...comparisonParts(event.comparison)); break;
    }
    if (this.animated) this.tick();
  };

  tick(): void {
    if (!this.enabled || this.closed) return;
    const elapsed = this.currentElapsed();
    const phase = this.animated ? fitTerminal(this.phaseLabel(this.phase), 14) : this.phaseLabel(this.phase);
    const tool = [...this.activeTools.values()].at(-1);
    const activity: TextPart[] = tool ? [" | ", styled(`当前: ${toolPresentation(tool.name).label}`, "accent"),
      this.activeTools.size > 1 ? `（另 ${this.activeTools.size - 1} 项）` : ""] : [];
    const round = this.round === null ? "" : `第 ${this.round} 轮 · 修复 ${this.repairsUsed}/${this.repairBudget} · `;
    const parts = [styled(`状态: ${round}${phase}`, "heading"), ...activity, ` | 总耗时 ${duration(elapsed)} | 阶段 ${duration(elapsed - this.phaseStarted)} | 无活动 ${duration(elapsed - this.lastActivity)}`];
    if (!this.animated) { this.line(...parts); return; }
    this.clearStatus();
    // Unicode grapheme boundaries and display cells keep long CJK labels from wrapping.
    const cells = Math.max(1, (this.output.columns ?? 80) - 1);
    const compact = [styled(`${this.round === null ? "" : `第${this.round}轮 ${this.repairsUsed}/${this.repairBudget} `}${fitTerminal(phase, 10)}`, "heading"),
      ...(tool ? [" | ", styled(fitTerminal(toolPresentation(tool.name).label, 12), "accent"), this.activeTools.size > 1 ? ` +${this.activeTools.size - 1}` : ""] : []),
      ` | 总 ${duration(elapsed)} | 阶段 ${duration(elapsed - this.phaseStarted)} | 无活动 ${duration(elapsed - this.lastActivity)}`];
    const plain = new TerminalStyle().render(parts);
    this.write(this.style.render(fitLine(fitTerminal(plain, cells) === plain ? parts : compact, cells)));
    this.hasStatus = true;
  }

  stop(): void {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearStatus();
    if (this.pending.size && this.options.verbosity === "detailed") {
      for (const text of this.pending.values()) if (text) this.line(text);
    }
    this.pending.clear();
    const elapsed = this.currentElapsed();
    this.finishTools(elapsed);
    this.completedTools.clear();
    this.tails.clear();
    this.closed = true;
  }

  interrupt(signal: string): void {
    this.interrupted = true;
    if (this.enabled && !this.closed) this.line(styled(`收到 ${signal}，正在回收进程。`, "warning"),
      "已有证据: ", this.logDir, "；本次最终报告可能尚未生成。");
    this.stop();
  }

  private clearStatus(): void {
    if (this.hasStatus) { this.write("\r\u001b[2K"); this.hasStatus = false; }
  }
  private phaseLabel(name: string): string {
    if (name === "WORKFLOW_SESSION" && this.repair === "test") return "修复测试脚本并重新校验";
    if (name === "REFACTOR" && this.repair === "refactor") return "修复候选代码";
    if (name === "PREPARE" && this.repair !== null) return "从已有候选分支准备工作目录";
    if (name === "WORKFLOW_SESSION" && this.reusedStages.has("workflows")) return "复用验证脚本并重新校验";
    if (name === "REFACTOR" && this.reusedStages.has("refactor")) return "复用已保存的候选改动";
    return PHASES[name] ?? name;
  }
  private currentElapsed(): number { return this.elapsed + this.now() - this.observedAt; }
  private lines(lines: readonly TextLine[]): void { for (const line of lines) this.line(...line); }
  private line(...parts: TextPart[]): void { this.clearStatus(); this.write(`${this.style.render(parts)}\n`); }
  private write(text: string): void { this.output.write(text); }
  private finishTools(elapsed: number): void {
    for (const tool of this.activeTools.values()) this.toolLine(tool, this.interrupted ? "已中断；未收到完成结果" : "未收到完成结果",
      "warning", elapsed, ` · 已等待 ${duration(elapsed - tool.elapsed_ms)}`);
    this.activeTools.clear();
  }
  private feedbackEvent(update: FeedbackUpdate, elapsed: number): void {
    const label = styled(`[${duration(elapsed)}]`, "muted");
    switch (update.action) {
      case "start":
        this.repairsUsed = update.budget_used;
        this.repairBudget = update.budget_total;
        this.line(label, " ", ...field("自动修复", `${update.budget_used}/${update.budget_total} 次已用${update.budget_total === 0 ? "（已关闭）" : ""}`));
        if (update.resumed_from) this.line(...field("恢复运行", `从 ${update.resumed_from} 继续，已用修复次数 ${update.budget_used} 次；原运行 ${update.owner_session}`));
        this.line(...field("反馈记录", update.state_dir));
        break;
      case "round-start":
        this.finishTools(elapsed);
        this.round = update.round;
        this.repair = update.repair;
        this.logDir = join(this.logRoot, update.session);
        this.reusedStages.clear();
        if (update.repair === "refactor" || update.repair === "build") this.reusedStages.add("workflows");
        if (update.repair === "test" || update.repair === "build") this.reusedStages.add("refactor");
        this.phase = "INIT";
        this.phaseStarted = elapsed;
        this.line(label, " ", styled(`第 ${update.round} 轮${update.repair ? "重新执行" : "执行"}`, "heading"),
          " · ", styled(update.session, "muted"));
        this.line(...field("本轮结果目录", this.logDir));
        break;
      case "round-end":
        this.finishTools(elapsed);
        this.line(label, " ", styled(`第 ${update.round} 轮结果: `, "accent"), styled(update.state, statusTone(update.state)));
        if (update.reason) this.line(...field("原因", update.reason, update.state === "ACCEPTED" ? "success" : "warning"));
        break;
      case "repair-start": {
        this.round = update.round;
        this.repair = update.lane;
        this.repairsUsed = update.budget_used;
        this.repairBudget = update.budget_total;
        this.phase = `FEEDBACK_${update.lane.toUpperCase()}`;
        this.phaseStarted = elapsed;
        if (update.lane === "build") this.logDir = join(this.logRoot, `${update.session}-bw`);
        this.line(label, " ", styled(`自动修复 ${update.budget_used}/${update.budget_total}`, "heading"), " · ", styled(REPAIR_LABELS[update.lane], "agent"));
        this.line(...field("失败原因", update.evidence.summary === "REJECTED" ? "候选版与原版的行为不一致" : update.evidence.summary, "warning"));
        if (update.evidence.side) this.line(...field("发生位置", update.evidence.side === "baseline" ? "原版" : "候选版"), update.evidence.buildId ? ` · 构建 ${update.evidence.buildId}` : "");
        if (update.evidence.mismatches?.length) this.line(...field("失配检查项", String(update.evidence.mismatches.length), "error"));
        if (update.dialogue_id) this.line(styled("AI 对话: ", "agent"), "继续原", update.lane === "refactor" ? "重构" : "测试编写", "对话 · ", styled(update.dialogue_id.slice(0, 12), "muted"));
        else this.line(styled("AI 对话: ", "agent"), "新建构建方案修复会话");
        const plan = update.lane === "refactor"
          ? `保留构建与测试方案；修复候选代码后重新构建、测试候选版并比较；${update.reuse_baseline ? "原版构建与测试观测复用" : "原版构建与测试重新执行"}`
          : update.lane === "test"
            ? "保留候选代码；修复测试脚本后重新校验方案，按当前流程重新构建、测试两侧并比较"
            : "保留候选代码与测试脚本；修复构建方案后重新构建、测试两侧并比较";
        this.line(...field("后续执行", plan));
        this.line(...field("剩余修复次数", String(Math.max(0, update.budget_total - update.budget_used))));
        for (const path of update.evidence.evidencePaths ?? []) this.line(...field("失败证据", path));
        break;
      }
      case "build-repaired":
        this.line(label, " ", styled("构建方案已保存", "success"), " · ", ...field("新方案", update.build_id));
        break;
      case "stop":
        this.phase = "FEEDBACK_DONE";
        this.phaseStarted = elapsed;
        this.repairsUsed = update.budget_used;
        this.line(label, " ", styled("自动修复结束: ", "heading"), styled(FEEDBACK_STOPS[update.reason], update.reason === "accepted" ? "success" : "warning"),
          ` · 已用 ${update.budget_used}/${update.budget_total} 次`);
        if (update.detail) this.line(...field("停止说明", update.detail, "warning"));
        break;
    }
  }

  private toolEvent(event: ToolEvent): void {
    const key = `${event.agent_id}\u0000${event.id}`;
    if (this.completedTools.has(key)) return;
    if (event.action === "start") {
      if (this.activeTools.has(key)) return;
      this.activeTools.set(key, event);
      if (!toolPresentation(event.name).completionOnly) this.toolLine(event, "开始", "accent", event.elapsed_ms);
    } else {
      const start = this.activeTools.get(key);
      this.activeTools.delete(key);
      this.completedTools.add(key);
      this.toolLine(event, event.failed ? "失败" : "完成", event.failed ? "error" : "success", event.elapsed_ms,
        start ? ` · ${duration(event.elapsed_ms - start.elapsed_ms)}` : "");
    }
  }
  private toolLine(event: ToolEvent, status: string, tone: Tone, elapsed: number, suffix = ""): void {
    const target = event.name === "Task" || event.name === "Agent"
      ? event.target.split(" · ").map((part, index) => index === 0 ? roleName(part) : part).join(" · ") : event.target;
    this.line(styled(`[${duration(elapsed)}]`, "muted"), " ", ...agentParts(event.role, event.agent_id), " ",
      styled(toolPresentation(event.name).label, "accent"), target ? ` ${preview(target, 256)}` : "", " · ", styled(status, tone), suffix);
  }
  private outputChunk(event: Extract<RunProgressEvent, { type: "command-output" }>): void {
    const key = commandKey(event);
    const text = cleanText(event.text);
    this.tails.set(key, ((this.tails.get(key) ?? "") + text).slice(-4096));
    if (this.options.verbosity !== "detailed") return;
    const streamKey = `${key}/${event.stream}`;
    const lines = ((this.pending.get(streamKey) ?? "") + text).split("\n");
    let last = lines.pop() ?? "";
    for (const line of lines) this.line(...contextParts(event.context, event.stream), ` ${line}`);
    while (last.length > 4096) { this.line(...contextParts(event.context, event.stream), ` ${last.slice(0, 4096)}`); last = last.slice(4096); }
    this.pending.set(streamKey, last);
  }
  private flushCommand(event: RunProgressEvent & { id: string }): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const key = `${commandKey(event)}/${stream}`;
      const pending = this.pending.get(key);
      if (pending) this.line(...contextParts(event.context, stream), ` ${pending}`);
      this.pending.delete(key);
    }
  }
}

function commandKey(event: { id: string; context?: ExecutionContext }): string {
  return `${event.context?.side ?? ""}/${event.context?.build_id ?? "test"}/${event.id}`;
}
function budget(value: number | null): string { return value === null ? "不限" : duration(value); }
function limitLines(limits: Limits): TextLine[] {
  return [
    ...Object.entries(limits.sessions).map(([name, limit]) =>
      field(name === "testWriter" ? "测试编写" : "代码重构", `模型=${limit.model ?? "SDK 默认"}; 总时限=${budget(limit.deadlineMs)}; 无消息时限=${budget(limit.stallMs)}; 轮数=${limit.maxTurns ?? "不限"}`)),
    field("执行时限", `构建=${budget(limits.stages.buildMs)}; 测试=${budget(limits.stages.testWorkflowMs)}; CTest=${budget(limits.stages.ctestMs)}; 单命令=${budget(limits.commands.processMs)}; 脚本策略修复上限=${limits.stages.policyRepairs}`),
    field("资源限制", `构建并发=${limits.resources.build.maxProcesses}; 测试并发=${limits.resources.test.maxProcesses}; 构建/测试输出上限=${limits.resources.build.maxOutputBytes}/${limits.resources.test.maxOutputBytes} 字节`),
    field("探测时限", `就绪=${budget(limits.commands.readyMs)}; 工具=${budget(limits.probes.hostMs)}; 构建/测试单文件上限=${limits.resources.build.maxFileBytes}/${limits.resources.test.maxFileBytes} 字节`),
  ];
}
function statusText(status: string): string {
  return ({ running: "运行中", pass: "通过", failed: "失败", "not-run": "未执行", completed: "完成", reused: "复用（重新校验）",
    declare: "已声明", begin: "开始", complete: "完成", fail: "失败" } as Record<string, string>)[status] ?? status;
}

function strategyLines(report: NonNullable<RunReport["strategy"]>["report"], verbosity: CliVerbosity): TextLine[] {
  const lines: TextLine[] = [[styled("验证方式: ", "accent"),
    styled(STRATEGIES[report.recommendation.strategy]!, report.recommendation.strategy === "undetermined" ? "warning" : "accent"), ` · ${report.subject}`],
    field("选择理由", report.recommendation.rationale), ...report.behaviors.map((behavior) => field("  覆盖", behavior))];
  for (const dep of report.dependencies) {
    lines.push(field("  依赖", `${dep.name} · ${dep.treatment} · ${dep.rationale}`));
    if (dep.treatment === "test-double") lines.push([...field("    模拟入口", dep.seam), "; ", ...field("模拟行为", dep.simulate.join("; ")), "; ", ...field("保留真实实现", dep.retainReal)],
      ...dep.lostCoverage.map((gap) => field("    缺少的集成覆盖", gap, "warning")));
  }
  lines.push(...report.limitations.map((gap) => field("  覆盖限制", gap, "warning")), ...report.openQuestions.map((question) => field("  待确认", question, "warning")));
  if (verbosity === "detailed") lines.push(...report.evidence.map((item) => [styled(`  依据 [${item.basis}] `, "accent"), `${item.reference}: ${item.finding}`]));
  return lines;
}

function usageText(usage: RunReport["agents"][number]): string {
  return [`模型=${usage.model ?? "未报告"}`, `轮数=${usage.turns ?? "未报告"}`,
    `输入/输出 token=${usage.input_tokens ?? "未报告"}/${usage.output_tokens ?? "未报告"}`,
    `缓存读取/写入 token=${usage.cache_read_tokens ?? "未报告"}/${usage.cache_write_tokens ?? "未报告"}`,
    `费用=${usage.cost_usd === undefined ? "未报告" : `$${usage.cost_usd.toFixed(6)}`}`].join("; ");
}

export function formatRunReport(report: RunReport, verbosity: CliVerbosity, options: ColorOptions = {}): string {
  const style = new TerminalStyle({ ...options, output: options.output ?? process.stdout });
  const lines: TextLine[] = [[styled("state: ", "accent"), styled(report.state, statusTone(report.state))], field("session", report.session),
    field("任务", report.task), field("仓库", report.repo), field("总耗时", duration(report.elapsed_ms))];
  const comparison = report.comparison;
  const compactReason = comparison ? `行为比较${comparison.overall === "consistent" ? "一致" : "未通过"}：${comparison.mismatched} 个检查项失配，${comparison.errors.length} 个比较错误。` : "";
  if (report.abort_reason) lines.push(field("中止原因", preview(report.abort_reason), "warning"));
  else if (report.decision_reason) lines.push(field("判定原因", verbosity === "summary" && comparison ? compactReason : preview(report.decision_reason)));
  if (report.failure) lines.push(field("失败归因", `[${report.failure.category}] ${report.failure.stage}/${report.failure.component} · 可重试=${report.failure.retryable ? "是" : "否"}`, "error"),
    field("失败证据", join(report.log_dir, "artifacts", "failure-report.json")));
  if (report.resume) lines.push(field("恢复自会话", report.resume.source_session),
    field("复用阶段", `${report.resume.reused_stages.map((stage) => STAGES[stage] ?? stage).join("、") || "无"}；耗时仅包含本次执行与重新校验。`));
  if (report.finalization_error) lines.push(field("收尾失败", `${report.finalization_error}（验证结论已保留，进程以失败退出）`, "error"));
  if (report.configuration) lines.push(field("阶段配置", JSON.stringify(report.configuration.pipeline.stages)),
    field("运行配置来源", report.configuration.sources.join(", ") || "内置默认"),
    ...report.configuration.overrides.map((value) => field("命令行阶段覆盖", value)));
  lines.push(field("限制配置来源", report.limit_sources.join(", ") || "内置默认"),
    ...report.limit_overrides.map((value) => field("命令行限制覆盖", value)), ...limitLines(report.limits));
  if (report.feedback) {
    const feedback = report.feedback;
    lines.push([styled("自动修复与重新执行:", "heading")], field("已用修复次数", `${feedback.budget_used}/${feedback.budget_total}；本次新增 ${feedback.budget_used - feedback.budget_used_before} 次`),
      field("结束原因", FEEDBACK_STOPS[feedback.stopped_because], feedback.stopped_because === "accepted" ? "success" : "warning"));
    if (feedback.resumed_from) lines.push(field("恢复自", `${feedback.resumed_from}；继承已用次数 ${feedback.budget_used_before}`));
    if (feedback.stop_detail) lines.push(field("停止说明", feedback.stop_detail, "warning"));
    for (const round of feedback.rounds) {
      lines.push([styled(`  第 ${round.round} 轮`, "accent"), ` · ${round.repair ? REPAIR_LABELS[round.repair] : feedback.resumed_from ? "恢复执行" : "首次执行"} · `,
        styled(round.state, statusTone(round.state)), ` · ${duration(round.elapsed_ms)} · `, styled(round.session, "muted")]);
      if (round.reason && round.state !== "ACCEPTED") lines.push(field("    原因", preview(round.reason), "warning"));
      const buildRepair = feedback.build_repairs.find((repair) => repair.round === round.round);
      if (buildRepair) lines.push(field("    构建方案修复", `${duration(buildRepair.elapsed_ms)}（在本轮执行前单独进行） · ${buildRepair.delivered ? "已保存方案" : "未交付方案"}`));
      if (verbosity === "detailed") lines.push(...round.stage_timings.filter((timing) => timing.status !== "not-run")
        .map((timing) => field(`    ${STAGES[timing.name]}`, `${statusText(timing.status)} · ${duration(timing.elapsed_ms)}`)));
      lines.push(field("    本轮报告", round.report_path));
    }
    for (const repair of feedback.build_repairs) {
      if (!feedback.rounds.some((round) => round.round === repair.round)) lines.push(field(`  第 ${repair.round} 轮构建方案修复`, `${duration(repair.elapsed_ms)} · 未进入重新验证`, "warning"));
      lines.push(field(`  第 ${repair.round} 轮构建修复日志`, repair.log_dir));
    }
    lines.push(field("反馈状态与历史", feedback.state_dir));
  }
  lines.push([styled(report.feedback ? "最后一轮阶段耗时:" : "阶段耗时:", "heading")], ...report.stage_timings.map((stage) => ["  ", styled(`${STAGES[stage.name]}: `, "accent"),
    styled(statusText(stage.status), statusTone(stage.status)), ` · ${duration(stage.elapsed_ms)}`]));
  if (verbosity === "detailed") lines.push([styled("验证子阶段（已包含在验证总耗时内）:", "heading")], ...report.phases
    .filter((phase) => /^(BASELINE_|CANDIDATE_|COMPARISON)/.test(phase.name))
    .map((phase) => field(`  ${PHASES[phase.name] ?? phase.name}`, duration(phase.elapsed_ms))));
  if (report.preflight) lines.push([...field("平台", `${report.preflight.host.platform}/${report.preflight.host.arch}`), "; ", ...field("项目识别", report.preflight.project.status)]);
  if (report.strategy) lines.push(...strategyLines(report.strategy.report, verbosity));
  lines.push([styled("构建结果:", "heading")]);
  if (!report.builds.length) lines.push([styled("  尚未声明构建", "warning")]);
  for (const build of report.builds) {
    lines.push(["  ", sidePart(build.side), `/${build.id}: `, styled(statusText(build.status), statusTone(build.status)),
      `${build.duration_ms === null ? "" : ` · ${duration(build.duration_ms)}`}${build.failure ? ` · ${preview(build.failure)}` : ""}`]);
    if (build.evidence_path) lines.push(field("    证据", evidencePath(report, build.evidence_path)));
  }
  lines.push([styled("测试结果:", "heading")]);
  for (const test of report.tests) {
    lines.push(["  ", sidePart(test.side), ": ", styled(statusText(test.status), statusTone(test.status)),
      `${test.duration_ms === null ? "" : ` · ${duration(test.duration_ms)}`}${test.checks === undefined ? "" : ` · ${test.checks} 个检查项`}${test.ctest_tests === undefined ? "" : ` · ${test.ctest_tests} 个 CTest 测试`}${test.failure ? ` · ${preview(test.failure)}` : ""}`]);
    if (test.evidence_path) lines.push(field("    证据", evidencePath(report, test.evidence_path)));
  }
  if (comparison) {
    lines.push(comparisonParts(comparison), field("判定说明", verbosity === "summary" ? compactReason : preview(comparison.reason)));
    const bad = comparison.checks.filter((check) => !check.matched);
    for (const check of verbosity === "summary" ? bad.slice(0, 10) : bad) {
      lines.push(field("  失配", `${check.name} · ${preview(check.reason)}`, "error"));
      if (verbosity === "detailed") lines.push(["    ", sidePart("baseline"), `: ${preview(check.baseline)}`], ["    ", sidePart("candidate"), `: ${preview(check.candidate)}`]);
    }
    if (verbosity === "summary" && bad.length > 10) lines.push([styled(`  另有 ${bad.length - 10} 项失配，详见完整报告。`, "warning")]);
    lines.push(...comparison.errors.map((error) => field("  比较错误", error, "error")));
    lines.push(...(comparison.warnings ?? []).map((warning) => field("  比较提示", warning, "warning")));
    lines.push(...comparison.evidence_paths.map((path) => field("比较证据", evidencePath(report, path))));
  } else lines.push([styled("比较: ", "accent"), styled("未执行或未完成", "warning")]);
  if (report.refactor_summary) lines.push([styled("重构说明:", "heading"), `\n${report.refactor_summary}`]);
  if (report.candidate) {
    const candidate = report.candidate;
    lines.push(field("候选分支", candidate.branch), field("基准提交", candidate.base_sha), field("候选提交", candidate.commit_sha),
      [styled("改动文件:", "heading")], ...candidate.changed_files.map((path) => [`  ${path}`]),
      field("查看差异", `git -C ${shellQuote(report.repo)} diff ${candidate.base_sha} ${candidate.commit_sha}`),
      [styled("候选改动尚未合并回原分支", "warning"), "；ACCEPTED 仅表示本次验证范围内通过。"]);
  } else {
    if (report.workspace) lines.push(field("候选分支", report.workspace.branch), field("基准提交", report.workspace.base_sha));
    lines.push([styled("候选提交: ", "accent"), styled("尚未生成", "warning")], [styled("结果尚未合并回原分支。", "warning")]);
  }
  for (const agent of report.agents) lines.push([...agentParts(agent.role, agent.agent_id),
    `${agent.session_id ? ` · 会话 ${agent.session_id}` : ""}${agent.parent_id ? "（子会话，用量不重复累计）" : ""}: ${usageText(agent)}`]);
  if (report.cost_usd !== null) lines.push(field("已报告的根会话费用合计", `$${report.cost_usd.toFixed(6)}`));
  lines.push(field("log", report.log_dir), field("完整报告", report.report_path),
    field("当前状态与中止原因", join(report.log_dir, "state.json")), field("AI 会话记录", report.feedback?.dialogue_dir ?? join(report.log_dir, "sessions")));
  return lines.map((line) => style.render(line)).join("\n");
}

function evidencePath(report: RunReport, path: string): string {
  return isAbsolute(path) ? path : join(report.log_dir, "artifacts", path);
}
function shellQuote(text: string): string {
  return process.platform === "win32" ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
}
function preview(value: unknown, max = 1024): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "未提供";
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…（已截断，完整值见证据）` : text;
}
function fitTerminal(text: string, cells: number): string {
  let result = "";
  let width = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const code = segment.codePointAt(0) ?? 0;
    const size = /\p{Extended_Pictographic}/u.test(segment) || code >= 0x1100 &&
      (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 || code >= 0x20000) ? 2 : 1;
    if (width + size > cells) break;
    width += size;
    result += segment;
  }
  return result;
}

function fitLine(parts: TextLine, cells: number): TextPart[] {
  const safe = parts.map((part) => {
    const text = cleanText(typeof part === "string" ? part : part.text).replace(/[\n\t]/g, " ");
    return typeof part === "string" ? text : styled(text, part.tone);
  });
  let remaining = fitTerminal(new TerminalStyle().render(safe), cells).length;
  return safe.map((part) => {
    const text = typeof part === "string" ? part : part.text;
    const clipped = text.slice(0, remaining);
    remaining -= clipped.length;
    return typeof part === "string" ? clipped : styled(clipped, part.tone);
  });
}
