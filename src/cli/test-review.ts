import { emitKeypressEvents, type Key } from "node:readline";
import type { PreparationView } from "../testing/types.js";
import type { RunProgressEvent } from "../runtime/progress.js";
import { cleanText, styled, statusTone, TerminalStyle, type TextLine } from "./terminal.js";
import { toolPresentation } from "./tool-presentation.js";
import { CliInputCancelled } from "./input.js";

const pretty = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "未提供";
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const field = (name: string, value: string): TextLine => [styled(`${name}：`, "accent"), value];
export function preparationPages(view: PreparationView, activity: readonly string[] = []): { title: string; lines: TextLine[] }[] {
  const { metadata, builds } = view.content;
  const trial = metadata.trial;
  const analysis = metadata.analysis;
  const status = trial.status === "pass" ? "原版试跑通过" : trial.status === "failed" ? "原版试跑失败" : "等待试跑";
  const overview: TextLine[] = [[styled(status, trial.status === "pass" ? "success" : trial.status === "failed" ? "error" : "warning")],
    field("验证范围", metadata.scope), field("原版提交", metadata.base_sha), field("工作版本", String(view.revision)),
    field("保存位置", view.saved ?? "尚未保存"), field("交付状态", metadata.delivery === "complete" ? "完整" : "草稿"),
    field("试跑主机", `${metadata.host.platform} / ${metadata.host.arch}`),
    field("测试模型（当前配置）", view.limits.sessions.testWriter.model ?? "SDK 默认值"),
    field("会话限制（当前配置）", `轮数 ${view.limits.sessions.testWriter.maxTurns ?? "不限制"} / 总时间 ${view.limits.sessions.testWriter.deadlineMs === null ? "不限制" : seconds(view.limits.sessions.testWriter.deadlineMs)}`), [""], [styled("AI 的验证方案", "heading")]];
  if (analysis) {
    overview.push(field("验证方式", analysis.recommendation.strategy), field("选择理由", analysis.recommendation.rationale));
    for (const b of analysis.behaviors) overview.push(field("覆盖行为", b));
    for (const d of analysis.dependencies) overview.push(field(`${d.name} / ${d.treatment}`, d.rationale),
      ...(d.treatment === "test-double" ? [field("替代位置", d.seam), field("模拟行为", d.simulate.join("；")), field("保留真实实现", d.retainReal), field("失去的覆盖", d.lostCoverage.join("；"))] : []));
    for (const gap of [...analysis.limitations, ...analysis.openQuestions]) overview.push([styled("覆盖缺口：", "warning"), gap]);
  } else overview.push(["尚未交付验证方案。"]);
  overview.push([""], [styled("构建产物与使用方式", "heading")], ...builds.map(b => field(b.id, b.description || "描述未提供")));
  const scenarios: TextLine[] = [[styled("AI 交付的测试场景", "heading")]];
  for (const s of metadata.review?.scenarios ?? []) scenarios.push([""], field(`${s.id} / ${s.title}`, s.purpose),
    field("输入和条件", s.inputs.join("；")), field("观察点", s.observations.join("、")), field("源码依据", s.sourceReferences.join("、")));
  if (!metadata.review) scenarios.push(["场景说明尚未交付；可输入修改意见要求补全。"]);
  const names = new Set(metadata.review?.scenarios.flatMap(s => s.observations) ?? []);
  const actualNames = [...trial.observations.map(o => o.name), ...(trial.ctest?.top_level_tests ?? [])];
  const unmatched = actualNames.filter(name => !names.has(name));
  if (unmatched.length) scenarios.push([""], field("未关联到场景的实际检查项", unmatched.join("、")));
  const results: TextLine[] = [[styled("宿主实际执行结果", "heading")], field("状态", status), field("耗时", seconds(trial.duration_ms)),
    field("检查项数量", String(trial.observations.length)), field("场景数量", String(metadata.review?.scenarios.length ?? 0)),
    field("完整证据", trial.evidence_dir ?? "尚未执行")];
  if (view.trialOrigin === "saved") results.push([styled("当前为保存时的试跑记录；重新试跑将使用当前项目提交。", "warning")]);
  if (trial.failure) results.push([styled("失败原因：", "error"), trial.failure.reason]);
  for (const b of trial.builds) results.push([styled(`构建 ${b.id}：`, "accent"), styled(b.status === "not-run" ? "未执行" : b.status === "pass" ? "通过" : "失败", statusTone(b.status)),
    ` / ${seconds(b.duration_ms)}${b.failure ? ` / ${b.failure}` : ""}`]);
  for (const o of trial.observations) results.push([""], field(o.name, `${o.relation} / ${pretty(o.value).slice(0, 1024)}`));
  if (trial.ctest) {
    results.push(field("CTest", `${trial.ctest.status} / ${trial.ctest.summary.total} 项测试`), field("实际执行的 CTest 名称", trial.ctest.top_level_tests.join("、")));
    for (const failed of trial.ctest.failed_tests) results.push(field(`失败 ${failed.name}`, failed.output.slice(0, 1024)));
  }
  if (view.history.length) results.push([""], [styled("历史试跑", "heading")], ...view.history.map(t => field(t.status, `${seconds(t.duration_ms)} / ${t.evidence_dir ?? "无证据"}`)));
  results.push([""], [styled("运行活动与命令", "heading")], ...activity.map(text => [text]));
  const files: TextLine[] = [[styled("本轮交付文件", "heading")]];
  for (const f of view.files) {
    files.push([""], [styled(f.path, "accent")]);
    if (f.content === null) { files.push([styled("已删除", "warning")], [f.previous!]); continue; }
    if (f.previous !== null && f.previous !== f.content) files.push([styled("修改前", "warning")], [f.previous], [styled("修改后", "success")]);
    else files.push([styled(f.previous === null ? "新文件" : "内容相同", "muted")]);
    files.push([f.content]);
  }
  return [{ title: "方案概览", lines: overview }, { title: "测试场景", lines: scenarios }, { title: "试跑结果", lines: results }, { title: "文件与修改", lines: files }];
}

export interface ReviewTerminalInput extends NodeJS.ReadableStream { isTTY?: boolean; setRawMode(mode: boolean): unknown; isRaw?: boolean }
export interface ReviewTerminalOutput extends NodeJS.WritableStream { isTTY?: boolean; columns?: number; rows?: number }
export interface PreparationReviewer {
  readonly directory: string;
  view(): PreparationView;
  cancel(): void;
  author(feedback?: string): Promise<void>;
  repair(): Promise<void>;
  trial(): Promise<void>;
  save(parent?: string): { directory: string };
}
export type ReviewOutcome =
  | { kind: "exit"; directory: string | null; task: null }
  | { kind: "continue"; directory: string; task: string };

/** Terminal owns keyboard/rendering only; authoring and execution stay in the controller. */
export class TestReviewTerminal {
  private page = 0;
  private offset = 0;
  private busy = false;
  private active: Promise<void> = Promise.resolve();
  private message = "";
  private readonly started = performance.now();
  private lastActivity = this.started;
  private editor: { label: string; value: string; done: (text: string | null) => void } | null = null;
  private readonly activity: string[] = [];
  private readonly style: TerminalStyle;
  private readonly completion = Promise.withResolvers<ReviewOutcome>();
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wasRaw = false;
  private rawSet = false;
  private screenEntered = false;
  constructor(private readonly preparation: PreparationReviewer, private readonly options: {
    color: boolean; env?: Record<string, string | undefined>; verbosity?: "detailed" | "summary"; out?: string; input?: ReviewTerminalInput; output?: ReviewTerminalOutput;
  }) { this.style = new TerminalStyle({ color: options.color, output: this.output, env: options.env }); }
  private get input(): ReviewTerminalInput { return this.options.input ?? process.stdin; }
  private get output(): ReviewTerminalOutput { return this.options.output ?? process.stderr; }
  receive = (event: RunProgressEvent): void => {
    if (!(event.type === "log" && event.heartbeat) && !(event.type === "agent-activity" && event.heartbeat)) this.lastActivity = performance.now();
    let text: string | null = null;
    if (event.type === "command-start") text = `${event.program} ${event.args.join(" ")} / ${event.cwd}`;
    else if (event.type === "command-output" && this.options.verbosity !== "summary") text = `[${event.stream}] ${event.text}`;
    else if (event.type === "agent-text" && this.options.verbosity !== "summary") text = `AI ${event.role}：${event.text}`;
    else if (event.type === "agent-tool" && event.action === "end") text = `${toolPresentation(event.name).label} ${event.target} / ${event.failed ? "失败" : "完成"}`;
    else if (event.type === "command-end") text = `命令${event.status} / ${seconds(event.duration_ms)}${event.error ? ` / ${event.error}` : ""}`;
    else if (event.type === "build") text = `构建 ${event.id}：${event.status} ${event.failure ?? ""}`;
    else if (event.type === "test") text = `试跑：${event.status} ${event.failure ?? ""}`;
    else if (event.type === "phase") text = event.name;
    if (text !== null) { this.activity.push(cleanText(text)); if (this.activity.length > 2000) this.activity.shift(); }
  };
  start(): void {
    if (!this.input.isTTY || !this.output.isTTY) throw new Error("TUI requires interactive stdin and stderr");
    this.wasRaw = this.input.isRaw === true;
    emitKeypressEvents(this.input); this.input.setRawMode(true); this.rawSet = true; this.input.resume();
    this.input.on("keypress", this.keypress);
    this.input.once("end", this.ended);
    this.output.on("resize", this.render);
    process.once("exit", this.close);
    process.once("SIGTERM", this.terminated);
    process.once("SIGINT", this.terminated);
    this.screenEntered = true;
    this.output.write("\x1b[?1049h\x1b[?25l");
    this.timer = setInterval(this.render, 1000); this.timer.unref(); this.render();
  }
  async run(initial?: () => Promise<void>): Promise<ReviewOutcome> {
    try {
      this.start();
      if (initial) void this.perform(initial);
      return await this.completion.promise;
    } finally { this.close(); }
  }
  private interrupt = (): void => {
    this.preparation.cancel();
    if (this.editor) { const done = this.editor.done; this.editor = null; done(null); }
    this.close();
    void this.active.then(() => this.completion.reject(new CliInputCancelled(130, `已取消测试准备；已有材料和证据：${this.preparation.directory}`)));
  };
  private ended = this.interrupt;
  private terminated = this.interrupt;
  close = (): void => {
    if (this.closed) return; this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.input.off("keypress", this.keypress); this.input.off("end", this.ended); this.output.off("resize", this.render);
    process.off("exit", this.close); process.off("SIGTERM", this.terminated); process.off("SIGINT", this.terminated);
    if (this.rawSet) { this.input.setRawMode(this.wasRaw); this.input.pause(); }
    if (this.screenEntered) this.output.write("\x1b[?25h\x1b[?1049l");
  };
  private async perform(action: () => Promise<void> | void): Promise<void> {
    this.busy = true; this.message = "正在处理；可以切换页面查看活动。"; this.render();
    const pending = Promise.resolve().then(() => { if (!this.closed) return action(); });
    this.active = pending.then(() => undefined, () => undefined);
    try { await pending; this.message = "操作完成。"; }
    catch (error) { this.message = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.render(); }
  }
  private ask(label: string): Promise<string | null> {
    return new Promise(resolve => { this.editor = { label, value: "", done: resolve }; this.render(); });
  }
  private keypress = (text: string, key: Key): void => {
    if (key.ctrl && key.name === "c") { this.interrupt(); return; }
    if (this.editor) {
      if (key.name === "escape") { const done = this.editor.done; this.editor = null; done(null); }
      else if (key.name === "return") { const { value, done } = this.editor; this.editor = null; done(value.trim()); }
      else if (key.name === "backspace") this.editor.value = Array.from(this.editor.value).slice(0, -1).join("");
      else if (text && !key.ctrl && !key.meta) this.editor.value += cleanText(text).replaceAll("\n", " ");
      this.render(); return;
    }
    const action = text?.toLowerCase();
    if (["1", "2", "3", "4"].includes(text)) { this.page = Number(text) - 1; this.offset = 0; }
    else if (key.name === "tab") { this.page = (this.page + 1) % 4; this.offset = 0; }
    else if (key.name === "down" || text === "j") this.offset++;
    else if (key.name === "up" || text === "k") this.offset = Math.max(0, this.offset - 1);
    else if (key.name === "pagedown") this.offset += Math.max(1, (this.output.rows ?? 24) - 9);
    else if (key.name === "pageup") this.offset = Math.max(0, this.offset - Math.max(1, (this.output.rows ?? 24) - 9));
    else if (!this.busy) {
      if (action === "q" || key.name === "escape") { this.completion.resolve({ kind: "exit", directory: this.preparation.view().saved, task: null }); }
      else if (action === "r") void this.perform(() => this.preparation.trial());
      else if (action === "f") void this.perform(() => this.preparation.repair());
      else if (action === "s") void this.perform(() => { this.preparation.save(this.options.out); });
      else if (action === "m") void this.perform(async () => {
        const feedback = await this.ask("修改意见（Enter 提交，Esc 取消）");
        if (feedback) await this.preparation.author(feedback);
      });
      else if (action === "c") void this.perform(async () => {
        if (this.preparation.view().content.metadata.delivery !== "complete" || this.preparation.view().content.metadata.trial.status !== "pass") throw new Error("请先让当前测试在原版上试跑通过。");
        const task = await this.ask("确认测试完成；输入接下来的重构需求（Enter 继续，Esc 取消）");
        if (!task) return;
        const saved = this.preparation.save(this.options.out);
        this.completion.resolve({ kind: "continue", directory: saved.directory, task });
      });
    }
    this.render();
  };
  render = (): void => {
    if (this.closed) return;
    const width = Math.max(2, (this.output.columns ?? 80) - 1);
    const rows = Math.max(4, this.output.rows ?? 24);
    const pages = preparationPages(this.preparation.view(), this.activity);
    const heading = wrap([styled("测试准备与审阅", "heading"), ` / ${this.preparation.view().session}`], width).slice(0, 1);
    const tabs: TextLine = width < 65
      ? [styled(`[${this.page + 1}/4] ${pages[this.page]!.title} [Tab]切页`, "accent")]
      : pages.flatMap((p, i) => [styled(`[${i + 1}] ${p.title}`, i === this.page ? "accent" : "muted"), "  "]);
    const tabLines = wrap(tabs, width).slice(0, 2);
    const state = { idle: "等待开始", authoring: "编写测试", running: "原版试跑", review: "审阅", closed: "已退出" }[this.preparation.view().status];
    const footer: TextLine = this.editor ? [`${this.editor.label}\n${this.editor.value}`]
      : [`${state} · 总 ${seconds(performance.now() - this.started)} · 无新活动 ${seconds(performance.now() - this.lastActivity)} / ${this.message}\nM修改 F修复 R试跑 S保存 C继续重构 Q退出`];
    const footerLines = wrap(footer, width).slice(-Math.min(3, Math.max(1, Math.floor(rows / 3))));
    const height = Math.max(0, rows - 1 - heading.length - tabLines.length - footerLines.length);
    const lines = pages[this.page]!.lines.flatMap(line => wrap(line, width));
    this.offset = Math.min(this.offset, Math.max(0, lines.length - height));
    const body = lines.slice(this.offset, this.offset + height);
    while (body.length < height) body.push([]);
    const screen = [...heading, ...tabLines, ...body, ...footerLines].map(line => this.style.render(line));
    this.output.write(`${this.editor ? "\x1b[?25h" : "\x1b[?25l"}\x1b[H\x1b[2J` + screen.join("\n"));
  };
}

function wrap(parts: TextLine, width: number): TextLine[] {
  const lines: Array<Array<TextLine[number]>> = [[]]; let cells = 0;
  for (const part of parts) {
    const text = cleanText(typeof part === "string" ? part : part.text);
    let fragment = "";
    const flush = (): void => { if (fragment) lines[lines.length - 1]!.push(typeof part === "string" ? fragment : { ...part, text: fragment }); fragment = ""; };
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      if (segment === "\n") { flush(); lines.push([]); cells = 0; continue; }
      const size = Bun.stringWidth(segment);
      if (cells + size > width) { flush(); lines.push([]); cells = 0; }
      fragment += segment; cells += size;
    }
    flush();
  }
  return lines;
}
