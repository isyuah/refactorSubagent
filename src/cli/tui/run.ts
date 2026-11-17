import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunProgressEvent, RunReport, AgentUsage } from "../../runtime/progress.js";
import type { VerificationAnalysis as Analysis } from "../../agents/verification-analysis.js";
import type { CliVerbosity } from "../args.js";
import { duration, PHASES, ROLES, STAGES, STRATEGIES, FEEDBACK_STOPS, REPAIR_LABELS, type RunStartup } from "../display.js";
import { cleanText } from "../terminal.js";
import type { FeedbackLane } from "../../runtime/feedback/types.js";
import { toolPresentation } from "../tool-presentation.js";
import { Workbench, type Detail, type Item, type Section } from "./workbench.js";

const git = promisify(execFile);
const statusLabel = (status: string): string => ({ running: "进行中", pass: "成功", failed: "失败", "not-run": "未执行", reused: "已复用", completed: "完成", waiting: "等待", ok: "成功", timeout: "超时", spawn_error: "启动失败", stopped: "已停止", error: "失败", output_limit: "输出超出限制", pending: "等待", exited: "已退出" })[status] ?? status;
const sideLabel = (side: string): string => side === "baseline" ? "原版" : side === "candidate" ? "候选版" : side;
const preview = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "未提供").slice(0, 1024);
export class BoundedText {
  private value = "";
  clipped = false;
  append(text: string): void {
    let next = this.value + cleanText(text); const lines = next.split("\n");
    if (lines.length > 2000) { next = lines.slice(-2000).join("\n"); this.clipped = true; }
    const bytes = Buffer.from(next);
    if (bytes.length > 2 * 1024 * 1024) {
      let start = bytes.length - 2 * 1024 * 1024; while ((bytes[start]! & 0xc0) === 0x80) start++;
      next = bytes.subarray(start).toString("utf8"); this.clipped = true;
    }
    this.value = next;
  }
  text(): string { return (this.clipped ? "仅显示最近日志，完整内容见日志文件。\n\n" : "") + this.value; }
}
function usageText(usage: AgentUsage): string {
  const labels: Record<string, string> = { turns: "会话轮数", input_tokens: "输入 token", output_tokens: "输出 token", cache_read_tokens: "缓存读取 token", cache_write_tokens: "缓存写入 token", cost_usd: "费用（美元）", duration_ms: "SDK 会话耗时（毫秒）", session_id: "SDK 会话编号", parent_id: "父会话编号" };
  return Object.entries(labels).flatMap(([key, label]) => {
    const value = usage[key as keyof AgentUsage]; return value === undefined ? [] : [`${label}：${value}`];
  }).join("\n") || "SDK 未提供用量统计。";
}
interface Conversation { id: string; role: string; model?: string; text: BoundedText; tools: Map<string, Tool>; usage?: AgentUsage; activity?: string }
interface Tool { label: string; target: string; start?: number; end?: number; failed?: boolean }
interface Execution { key: string; round: number; kind: string; label: string; status: string; duration?: number; error?: string | null; path?: string; text: BoundedText; command?: string; cwd?: string; stream?: "stdout" | "stderr"; exitCode?: number | null }
const executionFailed = (status: string): boolean => ["failed", "error", "timeout", "spawn_error", "stopped", "output_limit"].includes(status);
interface Round { number: number; session: string; state: string; reason: string | null; logDir?: string; repair?: FeedbackLane | null; details?: string }
export function strategyItems(analysis: Analysis | null): Item[] {
  if (!analysis) return [];
  return [
    { id: "strategy", label: STRATEGIES[analysis.recommendation.strategy] ?? analysis.recommendation.strategy, description: "验证方式", detail: () => ({ title: "验证方案", paragraphs: [{ text: analysis.recommendation.rationale }, ...analysis.behaviors.map(text => ({ text: `覆盖行为：${text}` }))] }) },
    ...analysis.dependencies.map((dependency, index): Item => ({ id: `dependency-${index}`, label: dependency.name, description: dependency.treatment, detail: () => ({ title: dependency.name, paragraphs: [
      { text: dependency.rationale }, ...(dependency.treatment === "test-double" ? [
        { text: `替代位置：${dependency.seam}\n模拟行为：${dependency.simulate.join("；")}\n保留真实实现：${dependency.retainReal}` },
        ...dependency.lostCoverage.map(text => ({ text: `失去的覆盖：${text}`, tone: "warning" as const })),
      ] : []),
    ] }) })),
    ...[...analysis.limitations, ...analysis.openQuestions].map((text, index): Item => ({ id: `gap-${index}`, label: "覆盖缺口", description: text, detail: () => ({ title: "覆盖缺口", paragraphs: [{ text, tone: "warning" }] }) })),
  ];
}

/** One observable presentation model for a run, including every feedback round. */
export class RunScreen {
  private startup: RunStartup | null = null;
  private report: RunReport | null = null;
  private round = 1;
  private phase = "INIT";
  private phaseStarted = performance.now();
  private readonly stages = new Map<string, { round: number; name: keyof typeof STAGES; state: string; start: number; duration?: number }>();
  private readonly diffs = new Map<string, Promise<Detail>>();
  private readonly executions = new Map<string, Execution>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly rounds = new Map<number, Round>();
  private readonly strategies = new Map<number, Analysis>();
  private readonly comparisons = new Map<number, Extract<RunProgressEvent, { type: "comparison" }>["comparison"]>();
  private preflight: Extract<RunProgressEvent, { type: "preflight" }> | null = null;
  private workspace: Extract<RunProgressEvent, { type: "workspace" }> | null = null;
  private candidate: RunReport["candidate"] = null;
  private lastActivity = performance.now();
  private readonly started = performance.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private readonly done = Promise.withResolvers<void>();
  private finished = false;
  private feedback = "";
  private readonly events = new BoundedText();
  private interruption = "";
  constructor(private readonly ui: Workbench, private readonly verbosity: CliVerbosity) { this.initializeStages(1); }
  private initializeStages(round: number): void {
    for (const name of Object.keys(STAGES) as (keyof typeof STAGES)[]) this.stages.set(`${round}/${name}`, { round, name, state: "waiting", start: 0 });
  }
  start(startup: RunStartup): void {
    this.startup = startup; this.ui.setTitle(`全流程重构 · ${startup.session}`);
    this.rounds.set(1, { number: 1, session: startup.session, state: "进行中", reason: null });
    this.ui.setSections(this.sections()); this.ui.onExit = () => { void this.requestExit(); };
    this.ui.onCancel = () => { process.emit("SIGINT"); };
    this.ui.onFollow = () => this.ui.follow();
    this.actions(); this.timer = setInterval(() => this.updateStatus(), 1000); this.timer.unref(); this.updateStatus();
  }
  private agent(id: string, role: string): Conversation {
    let conversation = this.conversations.get(id);
    if (!conversation) { conversation = { id, role, text: new BoundedText(), tools: new Map() }; this.conversations.set(id, conversation); }
    return conversation;
  }
  receive = (event: RunProgressEvent): void => {
    const heartbeat = (event.type === "log" || event.type === "agent-activity") && event.heartbeat;
    if (!heartbeat) this.lastActivity = performance.now();
    const key = (kind: string, id: string): string => `${this.round}/${kind}/${event.context?.side ?? ""}/${event.context?.build_id ?? ""}/${id}`;
    switch (event.type) {
      case "phase": this.phase = event.name; this.phaseStarted = performance.now(); break;
      case "stage": {
        const id = `${this.round}/${event.name}`;
        if (event.action === "start") this.stages.set(id, { round: this.round, name: event.name, state: "running", start: event.elapsed_ms });
        else { const stage = this.stages.get(id); if (stage) { stage.state = event.failed ? "failed" : "completed"; stage.duration = event.elapsed_ms - stage.start; } }
        break;
      }
      case "resume": this.events.append(`恢复自 ${event.source_session}；复用阶段：${event.reused_stages.map(stage => STAGES[stage]).join("、")}\n`); break;
      case "log": if (!event.heartbeat) this.events.append(`[${event.level}] ${event.message}\n`); break;
      case "agent-activity": if (!event.heartbeat) this.agent(event.agent_id, event.role).activity = event.text; break;
      case "agent-start": this.agent(event.agent_id, event.role).model = event.model; break;
      case "agent-text": if (this.verbosity === "detailed") this.agent(event.agent_id, event.role).text.append(event.text + "\n\n"); break;
      case "agent-usage": this.agent(event.usage.agent_id, event.usage.role).usage = event.usage; break;
      case "agent-tool": {
        const tools = this.agent(event.agent_id, event.role).tools;
        const tool = tools.get(event.id) ?? { label: toolPresentation(event.name).label, target: event.target };
        if (event.action === "start") tool.start = event.elapsed_ms; else { tool.end = event.elapsed_ms; tool.failed = event.failed; }
        tools.set(event.id, tool); break;
      }
      case "strategy": this.strategies.set(this.round, event.report); break;
      case "preflight": this.preflight = event; break;
      case "workspace": this.workspace = event; break;
      case "candidate": this.candidate = event.candidate; break;
      case "command-start": this.executions.set(key("command", event.id), { key: key("command", event.id), round: this.round, kind: "command",
        label: `${sideLabel(event.context?.side ?? "")} ${event.context?.build_id ?? ""} ${event.program}`, status: "running", text: new BoundedText(), command: [event.program, ...event.args].join(" "), cwd: event.cwd, path: event.context?.log_path }); break;
      case "command-output": {
        const entry = this.executions.get(key("command", event.id));
        if (entry) { entry.text.append(`${entry.stream === event.stream ? "" : (entry.stream ? "\n" : "") + `[${event.stream}] `}${event.text}`); entry.stream = event.stream; }
        break;
      }
      case "command-end": {
        const entry = this.executions.get(key("command", event.id));
        if (entry) { entry.status = event.status === "exited" ? event.exit_code === 0 ? "pass" : "failed" : event.status; entry.exitCode = event.exit_code; entry.duration = event.duration_ms; entry.error = event.error; }
        break;
      }
      case "build": case "test": {
        const id = `${this.round}/${event.type}/${event.side}/${event.type === "build" ? event.id : "tests"}`;
        const previous = this.executions.get(id);
        this.executions.set(id, { key: id, round: this.round, kind: event.type, label: `${sideLabel(event.side)} · ${event.type === "build" ? `构建 ${event.id}` : "测试"}`,
          status: event.status, duration: event.duration_ms, error: event.failure, path: event.evidence_path, text: previous?.text ?? new BoundedText() }); break;
      }
      case "step": {
        const id = key("step", event.id); this.executions.set(id, { key: id, round: this.round, kind: "step", label: `${sideLabel(event.context?.side ?? "")} ${event.title}`,
          status: event.status, duration: event.duration_ms, error: event.error, path: event.context?.log_path, text: new BoundedText() }); break;
      }
      case "comparison": this.comparisons.set(this.round, event.comparison); break;
      case "feedback": {
        const update = event.feedback;
        if (update.action === "round-start") { this.round = update.round; if (!this.rounds.has(this.round)) this.initializeStages(this.round); this.rounds.set(this.round, { ...this.rounds.get(this.round), number: this.round, session: update.session, state: "进行中", reason: null, repair: update.repair }); }
        if (update.action === "round-end") {
          this.rounds.set(update.round, { ...this.rounds.get(update.round), number: update.round, session: update.session, state: update.state, reason: update.reason, logDir: update.log_dir });
          for (const stage of this.stages.values()) if (stage.round === update.round && stage.state === "waiting") { stage.state = "not-run"; stage.duration = 0; }
        }
        if (update.action === "repair-start") {
          this.round = update.round;
          if (!this.rounds.has(this.round)) this.initializeStages(this.round);
          this.rounds.set(this.round, { number: this.round, session: update.session, state: "修复中", reason: update.evidence.summary, repair: update.lane });
          this.feedback = `修复第 ${update.round} 轮 · ${update.lane === "build" ? "构建方案" : update.lane === "test" ? "测试脚本" : "候选代码"} · ${update.evidence.summary} · 已用 ${update.budget_used}/${update.budget_total} · ${update.reuse_baseline ? "复用原版" : "重新验证两侧"}`; const round = this.rounds.get(update.round); if (round) round.details = this.feedback; }
        if (update.action === "stop") this.feedback = `${FEEDBACK_STOPS[update.reason]}${update.detail ? "：" + update.detail : ""}`;
        break;
      }
    }
    if (!this.scheduled) this.scheduled = setTimeout(() => { this.scheduled = null; this.ui.refresh(); this.updateStatus(); }, 75);
  };
  private updateStatus(): void {
    if (!this.startup) return;
    this.ui.setStatus(`${this.finished ? this.report?.state ?? "已结束" : PHASES[this.phase] ?? this.phase} · 第 ${this.round} 轮 · 总 ${duration(this.report?.elapsed_ms ?? performance.now() - this.started)}${this.finished ? "" : " · 当前阶段 " + duration(performance.now() - this.phaseStarted)} · 无新活动 ${duration(performance.now() - this.lastActivity)}${this.interruption ? " · " + this.interruption : ""}`);
    if (this.feedback) this.ui.setNotice(this.feedback);
  }
  sections(): Section[] {
    return [
      { id: "overview", title: "运行概览", items: () => this.overview() },
      { id: "agents", title: "AI 会话", items: () => [...this.conversations.values()].map(agent => ({ id: agent.id, label: `${ROLES[agent.role] ?? agent.role} · ${agent.id.slice(0, 8)}`, description: agent.model ?? "SDK 默认模型",
        detail: () => ({ title: ROLES[agent.role] ?? agent.role, paragraphs: [{ text: `${agent.id}\n模型：${agent.model ?? "SDK 默认值"}`, tone: "agent" },
          ...(agent.activity ? [{ text: agent.activity, tone: "muted" as const }] : []),
          { text: this.verbosity === "summary" ? "摘要模式省略 AI 正文；完整内容见会话记录。" : agent.text.text() || "等待 AI 回复。" },
          ...[...agent.tools.values()].map(tool => ({ text: `${tool.label} ${tool.target}\n${tool.end === undefined ? this.interruption ? "已中断；未收到完成结果" : this.finished ? "未收到完成结果" : "进行中" : tool.failed ? "失败" : "完成"}${tool.start !== undefined && tool.end !== undefined ? " · " + duration(tool.end - tool.start) : ""}`, tone: tool.failed ? "error" as const : "accent" as const })),
          ...(agent.usage ? [{ text: usageText(agent.usage), tone: "muted" as const }] : []),
        ], follow: true }) })) },
      { id: "strategy", title: "验证方案", items: () => [...this.strategies].flatMap(([round, analysis]) => strategyItems(analysis).map(item => ({ ...item, id: `${round}/${item.id}`, description: `第 ${round} 轮 · ${item.description ?? ""}` }))) },
      { id: "execution", title: "构建与测试", items: () => [...this.executions.values()].map(entry => ({ id: entry.key, label: entry.label, description: `第 ${entry.round} 轮 · ${statusLabel(entry.status)}${entry.duration === undefined ? "" : " · " + duration(entry.duration)}`,
        detail: () => ({ title: entry.label, paragraphs: [
          { text: `第 ${entry.round} 轮 · ${statusLabel(entry.status)}${entry.duration === undefined ? "" : " · " + duration(entry.duration)}`, tone: executionFailed(entry.status) ? "error" : ["pass", "ok"].includes(entry.status) ? "success" : "accent" },
          ...(entry.command ? [{ text: `命令：${entry.command}\n工作目录：${entry.cwd}${entry.exitCode === undefined ? "" : "\n退出码：" + (entry.exitCode ?? "无")}` }] : []), ...(entry.error ? [{ text: entry.error, tone: "error" as const }] : []),
          ...(entry.path ? [{ text: `完整证据：${entry.path}`, tone: "muted" as const }] : []), { text: this.verbosity === "summary" && !executionFailed(entry.status) ? "摘要模式省略成功命令的输出；完整内容见证据文件。" : entry.text.text() || "此项没有单独输出；可选择相关执行命令查看日志。" },
        ], follow: true }) })) },
      { id: "comparison", title: "行为对比", items: () => this.comparisonItems() },
      { id: "files", title: "文件差异", items: () => (this.candidate?.changed_files ?? []).map(path => ({ id: path, label: path, detail: () => this.fileDiff(path) })) },
      { id: "feedback", title: "反馈历史", items: () => [...this.rounds.values()].map(round => ({ id: String(round.number), label: `第 ${round.number} 轮 · ${round.state}`, description: round.reason ?? (round.repair ? `修复 ${round.repair}` : "初次执行"),
        detail: () => ({ title: `第 ${round.number} 轮`, paragraphs: [{ text: `${round.state}\n会话：${round.session}` }, { text: round.reason ?? "当前尚无失败原因。" }, ...(round.details ? [{ text: round.details }] : []), { text: `修复角色：${round.repair ? REPAIR_LABELS[round.repair] : "初次执行"}\n完整证据：${round.logDir ?? "运行中"}` },
          ...(this.report?.feedback ? [{ text: `已用修复次数：${this.report.feedback.budget_used}/${this.report.feedback.budget_total}\n停止原因：${this.report.feedback.stop_detail ?? this.report.feedback.stopped_because}` }] : []),
        ] }) })) },
      { id: "settings", title: "运行设置", items: () => this.settings() },
    ];
  }
  private overview(): Item[] {
    const result: Item[] = [{ id: "current", label: this.report?.state ?? (PHASES[this.phase] ?? this.phase), description: this.report?.decision_reason ?? "当前运行", detail: () => ({ title: "运行结果与进度", paragraphs: [
      { text: this.report?.state ?? (PHASES[this.phase] ?? this.phase), tone: this.report?.state === "ACCEPTED" ? "success" : this.report?.state === "REJECTED" ? "error" : "heading" },
      { text: this.report?.abort_reason ?? this.report?.decision_reason ?? (this.feedback || "正在执行。") },
      ...(this.report?.finalization_error ? [{ text: `结束处理失败：${this.report.finalization_error}`, tone: "error" as const }] : []),
      { text: `仓库：${this.startup?.repo}\n任务：${this.startup?.task}\n结果目录：${this.report?.log_dir ?? this.startup?.log_dir}` },
      ...(this.candidate ? [{ text: `候选分支：${this.candidate.branch}\n基准：${this.candidate.base_sha}\n候选：${this.candidate.commit_sha}\n结果尚未合并回原分支。` }] : []),
      ...(this.report?.refactor_summary ? [{ text: this.report.refactor_summary }] : []),
      ...(this.report ? [{ text: `完整报告：${this.report.report_path}\n总耗时：${duration(this.report.elapsed_ms)}\n费用：${this.report.cost_usd === null ? "SDK 未提供" : "$" + this.report.cost_usd.toFixed(4)}` }] : []),
    ] }) }];
    for (const stage of this.stages.values()) result.push({ id: `stage/${stage.round}/${stage.name}`, label: STAGES[stage.name] ?? stage.name, description: `第 ${stage.round} 轮 · ${statusLabel(stage.state)}`,
      detail: () => ({ title: STAGES[stage.name] ?? stage.name, paragraphs: [{ text: `${statusLabel(stage.state)} · 第 ${stage.round} 轮\n阶段耗时：${stage.duration === undefined ? stage.state === "waiting" ? "等待执行" : "运行中" : duration(stage.duration)}` }] }) });
    result.push({ id: "events", label: "运行记录", detail: () => ({ title: "运行记录", paragraphs: [{ text: this.events.text() || "尚无记录。" }], follow: true }) });
    return result;
  }
  private comparisonItems(): Item[] {
    return [...this.comparisons].flatMap(([round, comparison]) => [
      { id: `${round}/summary`, label: `第 ${round} 轮 · ${comparison.overall}`, description: `${comparison.total} 项 · 一致 ${comparison.matched} · 失配 ${comparison.mismatched}`, detail: () => ({ title: "比较结果", paragraphs: [{ text: comparison.reason }, ...comparison.errors.map(text => ({ text, tone: "error" as const })), { text: comparison.evidence_paths.join("\n"), tone: "muted" as const }] }) },
      ...comparison.checks.map((check, index): Item => ({ id: `${round}/${index}`, label: check.name, description: check.matched ? "一致" : "失配", detail: () => ({ title: check.name, paragraphs: [
        { text: check.reason, tone: check.matched ? "success" : "error" }, { text: `原版\n${preview(check.baseline)}` }, { text: `候选版\n${preview(check.candidate)}` }, { text: `完整观测值与证据：\n${comparison.evidence_paths.join("\n")}`, tone: "muted" },
      ] }) })),
    ]);
  }
  private fileDiff(path: string): Promise<Detail> {
    const candidate = this.candidate!; const key = `${candidate.base_sha}/${candidate.commit_sha}/${path}`;
    let detail = this.diffs.get(key);
    if (!detail) { detail = this.loadDiff(path, candidate); this.diffs.set(key, detail); }
    return detail;
  }
  private async loadDiff(path: string, candidate: NonNullable<RunReport["candidate"]>): Promise<Detail> {
    const result = await git("git", ["diff", "--no-ext-diff", "--no-textconv", candidate.base_sha, candidate.commit_sha, "--", path], { cwd: this.startup!.repo, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { title: path, paragraphs: [{ text: `${candidate.base_sha} → ${candidate.commit_sha}` }, { text: `完整差异：git -C "${this.startup!.repo}" diff ${candidate.base_sha} ${candidate.commit_sha}` }, ...(result.stdout.length > 1024 * 1024 ? [{ text: "差异过大，仅预览前 1 MiB。", tone: "warning" as const }] : [])], diff: result.stdout.slice(0, 1024 * 1024) };
  }
  private settings(): Item[] {
    const startup = this.startup!;
    return [
      { id: "config", label: "执行配置", detail: () => ({ title: "生效的执行配置", paragraphs: [{ text: `配置来源：${startup.pipeline_sources.join("、") || "内置默认"}` }], code: JSON.stringify(startup.pipeline_config, null, 2) }) },
      { id: "limits", label: "模型与限制", detail: () => ({ title: "生效的模型与限制", paragraphs: [{ text: `配置来源：${startup.limit_sources.join("、") || "内置默认"}` }, { text: "模型为空时使用 SDK 默认值；可选限制为 null 时不设置上限。", tone: "muted" }], code: JSON.stringify(startup.limits, null, 2) }) },
      ...(this.preflight ? [{ id: "host", label: "主机与项目", detail: () => ({ title: "环境识别结果", paragraphs: [], code: JSON.stringify({ host: this.preflight!.host, project: this.preflight!.project }, null, 2) }) }] : []),
      ...(this.workspace ? [{ id: "workspace", label: "工作目录", detail: () => ({ title: "原版与候选版", paragraphs: [{ text: `基准：${this.workspace!.base_sha}\n候选分支：${this.workspace!.branch}\n原版目录：${this.workspace!.baseline_dir}\n候选目录：${this.workspace!.candidate_dir}` }] }) }] : []),
    ];
  }
  private actions(): void {
    this.ui.setActions([{ id: "follow", label: "跟随最新", run: () => this.ui.follow() }, { id: "exit", label: this.finished ? "退出" : "取消运行", tone: this.finished ? "accent" : "warning", run: () => this.requestExit() }]);
  }
  private async requestExit(): Promise<void> {
    if (this.finished) { this.done.resolve(); return; }
    if (await this.ui.confirm("取消本次运行？", "将停止正在运行的模型和进程，已有证据保留。")) this.ui.onCancel();
  }
  interrupt(signal: string): void { this.interruption = `已收到 ${signal}，正在回收进程`; this.updateStatus(); }
  stop(): void { if (this.timer) clearInterval(this.timer); if (this.scheduled) clearTimeout(this.scheduled); this.timer = null; this.scheduled = null; }
  async finish(report: RunReport): Promise<void> {
    this.stop(); this.ui.dismissDialog(); this.finished = true; this.report = report; this.candidate = report.candidate;
    if (report.feedback) {
      this.round = report.feedback.rounds.at(-1)?.round ?? this.round;
      for (const round of report.feedback.rounds) {
        this.rounds.set(round.round, { ...this.rounds.get(round.round), number: round.round, session: round.session, state: round.state, reason: round.reason, repair: round.repair, logDir: round.log_dir });
        for (const stage of round.stage_timings) this.stages.set(`${round.round}/${stage.name}`, { round: round.round, name: stage.name, state: stage.status, start: 0, duration: stage.elapsed_ms });
      }
    }
    if (report.resume) this.events.append(`恢复自 ${report.resume.source_session}；复用阶段：${report.resume.reused_stages.map(stage => STAGES[stage]).join("、")}\n`);
    if (report.comparison) this.comparisons.set(this.round, report.comparison);
    if (report.strategy) this.strategies.set(this.round, report.strategy.report);
    for (const summary of report.builds) {
      const id = `${this.round}/build/${summary.side}/${summary.id}`; const previous = this.executions.get(id);
      this.executions.set(id, { key: id, round: this.round, kind: "build", label: `${sideLabel(summary.side)} · 构建 ${summary.id}`, status: summary.status, duration: summary.duration_ms ?? undefined, error: summary.failure, path: summary.evidence_path, text: previous?.text ?? new BoundedText() });
    }
    for (const summary of report.tests) {
      const id = `${this.round}/test/${summary.side}/tests`; const previous = this.executions.get(id);
      this.executions.set(id, { key: id, round: this.round, kind: "test", label: `${sideLabel(summary.side)} · 测试`, status: summary.status, duration: summary.duration_ms ?? undefined, error: summary.failure, path: summary.evidence_path, text: previous?.text ?? new BoundedText() });
    }
    for (const stage of report.stage_timings) this.stages.set(`${this.round}/${stage.name}`, { round: this.round, name: stage.name, state: stage.status, start: 0, duration: stage.elapsed_ms });
    for (const usage of report.agents) this.agent(usage.agent_id, usage.role).usage = usage;
    this.ui.onCancel = () => this.done.resolve(); this.ui.selectSection(0); this.actions(); this.ui.refresh(); this.updateStatus();
    await this.done.promise;
  }
}
