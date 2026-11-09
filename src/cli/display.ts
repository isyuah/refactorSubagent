import { isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { CliFormat, CliProgress, CliVerbosity } from "./args.js";
import type { Limits } from "../config/limits.js";
import type { ExecutionContext, RunProgressEvent, RunReport } from "../runtime/progress.js";
import type { Pipeline } from "../config/pipeline.js";

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
}

const PHASES: Readonly<Record<string, string>> = {
  INIT: "初始化", PREFLIGHT: "检查环境与项目", WORKFLOW_SESSION: "设计验证方案并编写脚本",
  PREPARE: "创建原版与候选工作目录", REFACTOR: "重构候选代码", VERIFICATION: "验证",
  BASELINE_BUILD: "构建原版", CANDIDATE_BUILD: "构建候选版",
  BASELINE_TEST_WORKFLOW: "测试原版", CANDIDATE_TEST_WORKFLOW: "测试候选版",
  BASELINE_CTEST: "原版 CTest", CANDIDATE_CTEST: "候选版 CTest",
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
const ROLES: Readonly<Record<string, string>> = { "test-writer": "测试编写", "build-writer": "构建编写", refactor: "代码重构", "source-repair": "脚本策略修复" };

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
}
export function cleanText(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
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
function contextLabel(context: ExecutionContext | undefined): string {
  return context ? `${context.side === "baseline" ? "原版" : "候选版"}${context.build_id ? `/${context.build_id}` : ""}` : "执行";
}
function roleName(role: string): string { return ROLES[role] ?? role; }
function agentLabel(role: string, id: string): string {
  const [root, child] = id.split("/");
  return `${roleName(role)} · ${root!.slice(0, 8)}${child ? `/${child.slice(-8)}` : ""}`;
}

/** Append-only history, with one disposable status line on interactive terminals. */
export class RunDisplay {
  private readonly output: TerminalOutput;
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly animated: boolean;
  private readonly color: boolean;
  private observedAt: number;
  private elapsed = 0;
  private phase = "INIT";
  private phaseStarted = 0;
  private lastActivity = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private hasStatus = false;
  private closed = false;
  private logDir = "";
  private readonly pending = new Map<string, string>();
  private readonly tails = new Map<string, string>();

  constructor(private readonly options: DisplayOptions) {
    this.output = options.output ?? process.stderr;
    this.now = options.now ?? (() => performance.now());
    this.observedAt = this.now();
    const env = options.env ?? process.env;
    this.enabled = options.progress !== "off" && (options.format !== "json" || options.progress === "plain");
    this.animated = options.progress === "auto" && Boolean(this.output.isTTY) && env.TERM !== "dumb";
    this.color = options.color && Boolean(this.output.isTTY) && env.NO_COLOR === undefined && env.TERM !== "dumb";
  }

  start(input: RunStartup): void {
    this.logDir = input.log_dir;
    if (!this.enabled) return;
    this.line(`任务: ${input.task}\n仓库: ${input.repo}\n会话: ${input.session}\n结果目录: ${input.log_dir}\n运行配置: ${input.pipeline}`);
    this.line(`运行配置来源: ${input.pipeline_sources.join(", ") || "内置默认"}`);
    if (input.pipeline_config) this.line(`阶段配置: ${JSON.stringify(input.pipeline_config.stages)}`);
    if (input.pipeline_overrides?.length) this.line(`命令行阶段覆盖: ${input.pipeline_overrides.join("; ")}`);
    this.line(`限制配置来源: ${input.limit_sources.join(", ") || "内置默认"}`);
    if (input.limit_overrides?.length) this.line(`命令行限制覆盖: ${input.limit_overrides.join("; ")}`);
    this.line(limitLines(input.limits).join("\n"));
    this.timer = setInterval(() => this.tick(), this.animated ? 1000 : 10_000);
    this.timer.unref();
  }

  receive = (event: RunProgressEvent): void => {
    if (!this.enabled || this.closed) return;
    this.observedAt = this.now();
    this.elapsed = event.elapsed_ms;
    if (!(event.type === "log" && (event.heartbeat || ["trace", "debug"].includes(event.level))) &&
        !(event.type === "agent-activity" && event.heartbeat)) this.lastActivity = event.elapsed_ms;
    const label = `[${duration(event.elapsed_ms)}]`;
    switch (event.type) {
      case "phase":
        this.phase = event.name;
        this.phaseStarted = event.elapsed_ms;
        this.line(`${label} ${PHASES[event.name] ?? event.name} (${event.name})`);
        break;
      case "stage":
        if (event.action === "end") this.line(`${label} ${STAGES[event.name]}: ${event.failed ? "未完成" : "完成"}`);
        break;
      case "log":
        if (!event.heartbeat && !["trace", "debug"].includes(event.level)) {
          const details = event.details ?? {};
          const extra = ["attempt", "max_repairs", "entry", "rule", "detail", "reason", "duration_ms"]
            .flatMap((key) => details[key] === undefined ? [] : [`${key}=${String(details[key])}`]);
          this.line(`${label} ${event.level === "error" ? "错误: " : event.level === "warn" ? "提示: " : ""}${event.message}${extra.length ? ` · ${extra.join(" · ")}` : ""}`);
        }
        break;
      case "preflight":
        this.line(`平台: ${event.host.platform}/${event.host.arch}; 项目: ${event.project.status}; 构建系统: ${event.project.primary_build_system ?? "未识别"}\n${event.project.reason}`);
        this.line(`工具: ${Object.entries(event.host.tools).map(([name, tool]) => `${name}=${tool.available ? tool.path : "不可用"}`).join("; ")}`);
        break;
      case "strategy": this.line(strategyText(event.report, this.options.verbosity)); break;
      case "workspace": this.line(`基准提交: ${event.base_sha}\n候选分支: ${event.branch}\n原版目录: ${event.baseline_dir}\n候选目录: ${event.candidate_dir}`); break;
      case "candidate": this.line(`候选提交: ${event.candidate.commit_sha}\n改动文件: ${event.candidate.changed_files.join(", ")}`); break;
      case "agent-start": this.line(`${label} AI [${agentLabel(event.role, event.agent_id)}] 开始 · 模型=${event.model ?? "SDK 默认/尚未报告"}`); break;
      case "agent-text":
        if (this.options.verbosity === "detailed") this.line(`${label} AI [${agentLabel(event.role, event.agent_id)}]:\n${event.text}`);
        break;
      case "agent-activity":
        if (!event.heartbeat) this.line(`${label} AI [${agentLabel(event.role, event.agent_id)}] ${event.text}`);
        break;
      case "agent-tool": this.line(`${label} AI [${agentLabel(event.role, event.agent_id)}] ${event.name}${event.target ? ` ${preview(event.target, 256)}` : ""} · ${event.action === "start" ? "开始" : event.failed ? "失败" : "完成"}`); break;
      case "agent-usage": this.line(`${label} AI [${agentLabel(event.usage.role, event.usage.agent_id)}] 结束 · ${usageText(event.usage)}`); break;
      case "command-start": this.line(`${label} [${contextLabel(event.context)}] $ ${commandText(event.program, event.args)}\n  cwd: ${event.cwd}`); break;
      case "command-output": this.outputChunk(event); break;
      case "command-end": {
        this.flushCommand(event);
        this.line(`${label} [${contextLabel(event.context)}] 命令结束: ${event.status}; exit=${event.exit_code ?? "无"}; 耗时=${duration(event.duration_ms)}${event.error ? `; ${event.error}` : ""}`);
        const tail = this.tails.get(commandKey(event)) ?? "";
        if (this.options.verbosity === "summary" && (event.status !== "exited" || (event.exit_code !== null && event.exit_code !== 0)) && tail) this.line(`输出末尾:\n${tail}`);
        if (event.context) this.line(`完整输出: ${event.context.log_path}`);
        this.tails.delete(commandKey(event));
        break;
      }
      case "step": this.line(`${label} [${contextLabel(event.context)}] ${event.title} (${event.id}): ${statusText(event.status)}${event.duration_ms === undefined ? "" : ` · ${duration(event.duration_ms)}`}${event.error ? ` · ${event.error}` : ""}`); break;
      case "build": this.line(`${label} ${event.side === "baseline" ? "原版" : "候选版"}构建 ${event.id}: ${statusText(event.status)}${event.duration_ms === undefined ? "" : ` · ${duration(event.duration_ms)}`}${event.failure ? ` · ${event.failure}` : ""}`); break;
      case "test": this.line(`${label} ${event.side === "baseline" ? "原版" : "候选版"}测试: ${statusText(event.status)}${event.duration_ms === undefined ? "" : ` · ${duration(event.duration_ms)}`}${event.checks === undefined ? "" : ` · ${event.checks} 个检查项`}${event.ctest_tests === undefined ? "" : ` · ${event.ctest_tests} 个 CTest 测试`}${event.failure ? ` · ${event.failure}` : ""}`); break;
      case "comparison": this.line(`比较: ${event.comparison.overall} · ${event.comparison.total} 项 · 一致 ${event.comparison.matched} · 失配 ${event.comparison.mismatched} · 比较错误 ${event.comparison.errors.length}`); break;
    }
    if (this.animated) this.tick();
  };

  tick(): void {
    if (!this.enabled || this.closed) return;
    const elapsed = this.elapsed + this.now() - this.observedAt;
    const phase = this.animated ? fitTerminal(PHASES[this.phase] ?? this.phase, 14) : PHASES[this.phase] ?? this.phase;
    const text = `状态: ${phase} | 总耗时 ${duration(elapsed)} | 阶段 ${duration(elapsed - this.phaseStarted)} | 无活动 ${duration(elapsed - this.lastActivity)}`;
    if (!this.animated) { this.line(text); return; }
    this.clearStatus();
    // Unicode grapheme boundaries and display cells keep long CJK labels from wrapping.
    const cells = Math.max(1, (this.output.columns ?? 80) - 1);
    const compact = `${phase} | 总 ${duration(elapsed)} | 阶段 ${duration(elapsed - this.phaseStarted)} | 无活动 ${duration(elapsed - this.lastActivity)}`;
    const clipped = fitTerminal(text, cells) === text ? text : fitTerminal(compact, cells);
    this.write(this.color ? `\u001b[36m${clipped}\u001b[0m` : clipped);
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
    this.closed = true;
  }

  interrupt(signal: string): void {
    if (this.enabled && !this.closed) this.line(`收到 ${signal}，正在回收进程。已有证据: ${this.logDir}；本次最终报告可能尚未生成。`);
    this.stop();
  }

  private clearStatus(): void {
    if (this.hasStatus) { this.write("\r\u001b[2K"); this.hasStatus = false; }
  }
  private line(text: string): void { this.clearStatus(); this.write(`${cleanText(text)}\n`); }
  private write(text: string): void { this.output.write(text); }
  private outputChunk(event: Extract<RunProgressEvent, { type: "command-output" }>): void {
    const key = commandKey(event);
    const text = cleanText(event.text);
    this.tails.set(key, ((this.tails.get(key) ?? "") + text).slice(-4096));
    if (this.options.verbosity !== "detailed") return;
    const streamKey = `${key}/${event.stream}`;
    const lines = ((this.pending.get(streamKey) ?? "") + text).split("\n");
    let last = lines.pop() ?? "";
    for (const line of lines) this.line(`[${contextLabel(event.context)} ${event.stream}] ${line}`);
    while (last.length > 4096) { this.line(`[${contextLabel(event.context)} ${event.stream}] ${last.slice(0, 4096)}`); last = last.slice(4096); }
    this.pending.set(streamKey, last);
  }
  private flushCommand(event: RunProgressEvent & { id: string }): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const key = `${commandKey(event)}/${stream}`;
      const pending = this.pending.get(key);
      if (pending) this.line(`[${contextLabel(event.context)} ${stream}] ${pending}`);
      this.pending.delete(key);
    }
  }
}

function commandKey(event: { id: string; context?: ExecutionContext }): string {
  return `${event.context?.side ?? ""}/${event.context?.build_id ?? "test"}/${event.id}`;
}
function budget(value: number | null): string { return value === null ? "不限" : duration(value); }
function limitLines(limits: Limits): string[] {
  return [
    ...Object.entries(limits.sessions).map(([name, limit]) =>
      `${name === "testWriter" ? "测试编写" : "代码重构"}: 模型=${limit.model ?? "SDK 默认"}; 总时限=${budget(limit.deadlineMs)}; 无消息时限=${budget(limit.stallMs)}; 轮数=${limit.maxTurns ?? "不限"}`),
    `执行时限: 构建=${budget(limits.stages.buildMs)}; 测试=${budget(limits.stages.testWorkflowMs)}; CTest=${budget(limits.stages.ctestMs)}; 单命令=${budget(limits.commands.processMs)}; 脚本策略修复上限=${limits.stages.policyRepairs}`,
    `资源限制: 构建并发=${limits.resources.build.maxProcesses}; 测试并发=${limits.resources.test.maxProcesses}; 构建/测试输出上限=${limits.resources.build.maxOutputBytes}/${limits.resources.test.maxOutputBytes} 字节`,
    `探测时限: 就绪=${budget(limits.commands.readyMs)}; 工具=${budget(limits.probes.hostMs)}; 构建/测试单文件上限=${limits.resources.build.maxFileBytes}/${limits.resources.test.maxFileBytes} 字节`,
  ];
}
function statusText(status: string): string {
  return ({ running: "运行中", pass: "通过", failed: "失败", "not-run": "未执行", completed: "完成",
    declare: "已声明", begin: "开始", complete: "完成", fail: "失败" } as Record<string, string>)[status] ?? status;
}

function strategyText(report: NonNullable<RunReport["strategy"]>["report"], verbosity: CliVerbosity): string {
  const lines = [`验证方式: ${STRATEGIES[report.recommendation.strategy]} · ${report.subject}`, `选择理由: ${report.recommendation.rationale}`,
    ...report.behaviors.map((behavior) => `  覆盖: ${behavior}`)];
  for (const dep of report.dependencies) {
    lines.push(`  依赖: ${dep.name} · ${dep.treatment} · ${dep.rationale}`);
    if (dep.treatment === "test-double") lines.push(`    模拟入口: ${dep.seam}; 模拟行为: ${dep.simulate.join("; ")}; 保留真实实现: ${dep.retainReal}`,
      ...dep.lostCoverage.map((gap) => `    缺少的集成覆盖: ${gap}`));
  }
  lines.push(...report.limitations.map((gap) => `  覆盖限制: ${gap}`), ...report.openQuestions.map((question) => `  待确认: ${question}`));
  if (verbosity === "detailed") lines.push(...report.evidence.map((item) => `  依据 [${item.basis}] ${item.reference}: ${item.finding}`));
  return lines.join("\n");
}

function usageText(usage: RunReport["agents"][number]): string {
  return [`模型=${usage.model ?? "未报告"}`, `轮数=${usage.turns ?? "未报告"}`,
    `输入/输出 token=${usage.input_tokens ?? "未报告"}/${usage.output_tokens ?? "未报告"}`,
    `缓存读取/写入 token=${usage.cache_read_tokens ?? "未报告"}/${usage.cache_write_tokens ?? "未报告"}`,
    `费用=${usage.cost_usd === undefined ? "未报告" : `$${usage.cost_usd.toFixed(6)}`}`].join("; ");
}

export function formatRunReport(report: RunReport, verbosity: CliVerbosity): string {
  const lines = [`state: ${report.state}`, `session: ${report.session}`, `任务: ${report.task}`, `仓库: ${report.repo}`, `总耗时: ${duration(report.elapsed_ms)}`];
  const comparison = report.comparison;
  const compactReason = comparison ? `行为比较${comparison.overall === "consistent" ? "一致" : "未通过"}：${comparison.mismatched} 个检查项失配，${comparison.errors.length} 个比较错误。` : "";
  if (report.abort_reason) lines.push(`中止原因: ${preview(report.abort_reason)}`);
  else if (report.decision_reason) lines.push(`判定原因: ${verbosity === "summary" && comparison ? compactReason : preview(report.decision_reason)}`);
  if (report.finalization_error) lines.push(`收尾失败: ${report.finalization_error}（验证结论已保留，进程以失败退出）`);
  if (report.configuration) lines.push(`阶段配置: ${JSON.stringify(report.configuration.pipeline.stages)}`,
    `运行配置来源: ${report.configuration.sources.join(", ") || "内置默认"}`,
    ...report.configuration.overrides.map((value) => `命令行阶段覆盖: ${value}`));
  lines.push(`限制配置来源: ${report.limit_sources.join(", ") || "内置默认"}`,
    ...report.limit_overrides.map((value) => `命令行限制覆盖: ${value}`), ...limitLines(report.limits));
  lines.push("阶段耗时:", ...report.stage_timings.map((stage) => `  ${STAGES[stage.name]}: ${statusText(stage.status)} · ${duration(stage.elapsed_ms)}`));
  if (verbosity === "detailed") lines.push("验证子阶段（已包含在验证总耗时内）:", ...report.phases
    .filter((phase) => /^(BASELINE_|CANDIDATE_|COMPARISON)/.test(phase.name))
    .map((phase) => `  ${PHASES[phase.name] ?? phase.name}: ${duration(phase.elapsed_ms)}`));
  if (report.preflight) lines.push(`平台: ${report.preflight.host.platform}/${report.preflight.host.arch}; 项目识别: ${report.preflight.project.status}`);
  if (report.strategy) lines.push(strategyText(report.strategy.report, verbosity));
  lines.push("构建结果:", ...(report.builds.length ? report.builds.map((build) =>
    `  ${build.side === "baseline" ? "原版" : "候选版"}/${build.id}: ${statusText(build.status)}${build.duration_ms === null ? "" : ` · ${duration(build.duration_ms)}`}${build.failure ? ` · ${preview(build.failure)}` : ""}${build.evidence_path ? `\n    证据: ${evidencePath(report, build.evidence_path)}` : ""}`) : ["  尚未声明构建"]));
  lines.push("测试结果:", ...report.tests.map((test) => `  ${test.side === "baseline" ? "原版" : "候选版"}: ${statusText(test.status)}${test.duration_ms === null ? "" : ` · ${duration(test.duration_ms)}`}${test.checks === undefined ? "" : ` · ${test.checks} 个检查项`}${test.ctest_tests === undefined ? "" : ` · ${test.ctest_tests} 个 CTest 测试`}${test.failure ? ` · ${preview(test.failure)}` : ""}${test.evidence_path ? `\n    证据: ${evidencePath(report, test.evidence_path)}` : ""}`));
  if (comparison) {
    lines.push(`比较: ${comparison.overall} · ${comparison.total} 项 · 一致 ${comparison.matched} · 失配 ${comparison.mismatched} · 比较错误 ${comparison.errors.length}`, `判定说明: ${verbosity === "summary" ? compactReason : preview(comparison.reason)}`);
    const bad = comparison.checks.filter((check) => !check.matched);
    for (const check of verbosity === "summary" ? bad.slice(0, 10) : bad) {
      lines.push(`  失配: ${check.name} · ${preview(check.reason)}`);
      if (verbosity === "detailed") lines.push(`    原版: ${preview(check.baseline)}`, `    候选版: ${preview(check.candidate)}`);
    }
    if (verbosity === "summary" && bad.length > 10) lines.push(`  另有 ${bad.length - 10} 项失配，详见完整报告。`);
    lines.push(...comparison.errors.map((error) => `  比较错误: ${error}`));
    lines.push(...(comparison.warnings ?? []).map((warning) => `  比较提示: ${warning}`));
    lines.push(...comparison.evidence_paths.map((path) => `比较证据: ${evidencePath(report, path)}`));
  } else lines.push("比较: 未执行或未完成");
  if (report.refactor_summary) lines.push(`重构说明:\n${report.refactor_summary}`);
  if (report.candidate) {
    const candidate = report.candidate;
    lines.push(`候选分支: ${candidate.branch}`, `基准提交: ${candidate.base_sha}`, `候选提交: ${candidate.commit_sha}`,
      "改动文件:", ...candidate.changed_files.map((path) => `  ${path}`),
      `查看差异: git -C ${shellQuote(report.repo)} diff ${candidate.base_sha} ${candidate.commit_sha}`,
      "候选改动尚未合并回原分支；ACCEPTED 仅表示本次验证范围内通过。");
  } else {
    if (report.workspace) lines.push(`候选分支: ${report.workspace.branch}`, `基准提交: ${report.workspace.base_sha}`);
    lines.push("候选提交: 尚未生成", "结果尚未合并回原分支。");
  }
  for (const agent of report.agents) lines.push(`AI [${agentLabel(agent.role, agent.agent_id)}]${agent.session_id ? ` · 会话 ${agent.session_id}` : ""}${agent.parent_id ? "（子会话，用量不重复累计）" : ""}: ${usageText(agent)}`);
  if (report.cost_usd !== null) lines.push(`已报告的根会话费用合计: $${report.cost_usd.toFixed(6)}`);
  lines.push(`log: ${report.log_dir}`, `完整报告: ${report.report_path}`,
    `当前状态与中止原因: ${join(report.log_dir, "state.json")}`, `AI 会话记录: ${join(report.log_dir, "sessions")}`);
  return cleanText(lines.join("\n"));
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
