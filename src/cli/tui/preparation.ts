import { createPatch } from "diff";
import { z } from "zod";
import type { PreparationView, TrialResult } from "../../testing/types.js";
import type { RunProgressEvent } from "../../runtime/progress.js";
import { CliInputCancelled } from "../input.js";
import { duration } from "../display.js";
import { Workbench, type Item, type Section } from "./workbench.js";
import { RunScreen, strategyItems } from "./run.js";

export interface PreparationReviewer {
  readonly directory: string;
  view(): PreparationView;
  subscribe(listener: (view: PreparationView) => void): () => void;
  cancel(): void;
  author(feedback?: string): Promise<void>;
  repair(): Promise<void>;
  trial(): Promise<void>;
  save(parent?: string): { directory: string };
}
export type ReviewOutcome = { kind: "exit"; directory: string | null; task: null } | { kind: "continue"; directory: string; task: string };
const Materials = z.object({ materials: z.array(z.object({ path: z.string(), content: z.string() })) });
export function reviewFiles(view: PreparationView): { path: string; content: string | null; previous: string | null }[] {
  const files = new Map<string, { path: string; content: string | null; previous: string | null }>();
  for (const file of view.files) {
    if (!file.path.endsWith(".materials.json")) { files.set(file.path, file); continue; }
    const current = new Map(file.content === null ? [] : Materials.parse(JSON.parse(file.content)).materials.map(material => [material.path, material.content]));
    const previous = new Map(file.previous === null ? [] : Materials.parse(JSON.parse(file.previous)).materials.map(material => [material.path, material.content]));
    for (const path of new Set([...current.keys(), ...previous.keys()])) files.set(path, { path, content: current.get(path) ?? null, previous: previous.get(path) ?? null });
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
const resultLabel = (trial: TrialResult): string => trial.status === "pass" ? "原版执行成功" : trial.status === "failed" ? "原版执行失败" : "尚未试跑";
export class PreparationScreen {
  private readonly activity: RunScreen;
  private readonly done = Promise.withResolvers<ReviewOutcome>();
  private view: PreparationView;
  private busy = false;
  private cancelled = false;
  private active: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly started = performance.now();
  private lastActivity = this.started;
  constructor(private readonly ui: Workbench, private readonly preparation: PreparationReviewer, private readonly options: { out?: string; verbosity: "detailed" | "summary" }) {
    this.view = preparation.view(); this.activity = new RunScreen(ui, options.verbosity);
  }
  receive = (event: RunProgressEvent): void => {
    if (!((event.type === "log" || event.type === "agent-activity") && event.heartbeat)) this.lastActivity = performance.now();
    this.activity.receive(event);
  };
  async run(initial?: () => Promise<void>): Promise<ReviewOutcome> {
    this.ui.setTitle(`测试准备与审阅 · ${this.view.session}`);
    this.ui.setSections(this.sections()); this.ui.onExit = () => { void this.exit(); }; this.ui.onCancel = this.interrupt;
    this.unsubscribe = this.preparation.subscribe(view => { this.view = view; this.update(); });
    this.timer = setInterval(() => this.status(), 1000); this.timer.unref(); this.update();
    if (initial) void this.perform(initial);
    try { return await this.done.promise; }
    finally { this.unsubscribe(); if (this.timer) clearInterval(this.timer); this.activity.stop(); }
  }
  private status(): void {
    const state = this.cancelled ? "正在取消与清理" : this.busy ? this.view.status === "running" ? "原版试跑中" : "AI 编写或修复中" : "审阅";
    this.ui.setStatus(`${state} · ${resultLabel(this.view.content.metadata.trial)} · 总 ${duration(performance.now() - this.started)} · 无新活动 ${duration(performance.now() - this.lastActivity)}`);
  }
  private update(): void {
    this.status(); this.ui.refresh();
    const ready = this.view.content.metadata.delivery === "complete" && this.view.content.metadata.trial.status === "pass";
    const inactive = this.busy ? "当前操作尚未结束" : undefined;
    this.ui.setActions([
      { id: "feedback", label: "修改意见", disabled: inactive, run: () => this.feedback() },
      { id: "repair", label: "修复执行错误", disabled: inactive ?? (this.view.content.metadata.trial.failure ? undefined : "当前没有执行错误"), run: async () => { await this.perform(() => this.preparation.repair()); } },
      { id: "trial", label: "重新试跑", disabled: inactive ?? (this.view.content.metadata.delivery !== "complete" ? "方案尚未完整交付" : undefined), run: async () => { await this.perform(() => this.preparation.trial()); } },
      { id: "save", label: "保存方案", disabled: inactive, run: () => this.save() },
      { id: "continue", label: "继续重构", disabled: inactive ?? (!ready ? "需要完整方案和成功的原版试跑" : undefined), tone: "success", run: () => this.continue() },
      { id: "exit", label: this.busy ? "取消运行" : "退出", tone: this.busy ? "warning" : "muted", run: () => this.exit() },
    ]);
  }
  private async perform(action: () => void | Promise<void>): Promise<boolean> {
    if (this.busy) throw new Error("已有操作正在运行");
    this.busy = true; this.update();
    const operation = Promise.resolve().then(() => { if (!this.cancelled) return action(); });
    this.active = operation.then(() => undefined, () => undefined);
    try { await operation; return !this.cancelled; }
    catch (error) { if (!this.cancelled) { this.ui.dismissDialog(); await this.ui.message("执行错误", error instanceof Error ? error.message : String(error)); } return false; }
    finally { this.busy = false; this.view = this.preparation.view(); this.update(); }
  }
  interrupt = (): void => {
    if (this.cancelled) return; this.cancelled = true; this.ui.dismissDialog(); this.preparation.cancel(); this.status();
    void this.active.then(() => this.done.reject(new CliInputCancelled(130, `已取消测试准备；已有材料和证据：${this.preparation.directory}`)));
  };
  private async exit(): Promise<void> {
    if (this.busy) { if (await this.ui.confirm("取消当前操作？", "将停止模型或试跑进程，已有材料与证据保留。")) this.interrupt(); return; }
    this.done.resolve({ kind: "exit", directory: this.view.saved, task: null });
  }
  private async feedback(): Promise<void> {
    const text = await this.ui.input({ title: "修改测试的意见", multiline: true, help: "说明需要增加、调整或解释的测试。Enter 换行；Tab 选择提交，Esc 取消。", validate: value => value ? null : "请填写修改意见" });
    if (text) await this.perform(() => this.preparation.author(text));
  }
  private async save(): Promise<void> {
    const saved = await this.perform(() => {
      this.preparation.save(this.options.out);
    });
    if (!saved) return;
    await this.ui.message("方案已保存", `${this.preparation.view().saved}\n\n复用命令：\nbun scripts/cli.ts run <repo> --task "<重构需求>" --tests "${this.preparation.view().saved}"`);
  }
  private async continue(): Promise<void> {
    const view = this.preparation.view();
    if (view.content.metadata.delivery !== "complete" || view.content.metadata.trial.status !== "pass") throw new Error("请先让完整方案在原版上执行成功");
    const task = await this.ui.input({ title: "接下来的重构需求", multiline: true, help: "将使用当前审阅的测试方案；下一步可确认完整运行设置。", validate: value => value ? null : "请填写重构需求" });
    if (task) { const saved = this.preparation.save(this.options.out); this.done.resolve({ kind: "continue", directory: saved.directory, task }); }
  }
  private sections(): Section[] {
    return [
      { id: "overview", title: "方案概览", items: () => [{ id: "summary", label: resultLabel(this.view.content.metadata.trial), description: this.view.content.metadata.delivery === "complete" ? "方案完整" : "草稿", detail: () => ({ title: "当前测试方案", paragraphs: [
        { text: this.view.content.metadata.scope }, { text: `${resultLabel(this.view.content.metadata.trial)}\n基准提交：${this.view.content.metadata.base_sha}\n保存目录：${this.view.saved ?? "尚未保存"}` },
        { text: this.view.trialOrigin === "saved" ? "当前显示保存时的试跑记录；重新试跑将使用当前项目提交。" : "当前项目的原版试跑记录。", tone: "muted" },
        ...(this.view.content.metadata.trial.failure ? [{ text: this.view.content.metadata.trial.failure.reason, tone: "error" as const }] : []),
      ] }) }, ...strategyItems(this.view.content.metadata.analysis)] },
      { id: "scenarios", title: "测试场景", items: () => this.scenarios() },
      { id: "trial", title: "原版试跑", items: () => this.trialItems() },
      { id: "files", title: "文件与修改", items: () => reviewFiles(this.view).map(file => ({ id: file.path, label: file.path, description: file.content === null ? "已删除" : file.previous === null ? "新文件" : file.content !== file.previous ? "已修改" : "内容相同",
        detail: () => ({ title: file.path, paragraphs: [{ text: file.content === null ? "本轮已删除此文件。" : file.previous !== null && file.content !== file.previous ? "显示本轮修改前后的行级差异。" : "交付文件内容；只读。", tone: "muted" }],
          ...(file.previous !== null && file.content !== file.previous ? { diff: createPatch(file.path, file.previous, file.content ?? "") } : { code: (file.content ?? file.previous ?? "").slice(0, 1024 * 1024) }) }) })) },
      ...this.activity.sections().filter(section => section.id === "agents" || section.id === "execution"),
      { id: "history", title: "历史与设置", items: () => [
        ...this.view.history.map((trial, index): Item => ({ id: `history-${index}`, label: `试跑记录 ${index + 1}`, description: `${resultLabel(trial)} · ${duration(trial.duration_ms)}`, detail: () => ({ title: `试跑记录 ${index + 1}`, paragraphs: [{ text: resultLabel(trial) }, { text: `完整证据：${trial.evidence_dir ?? "未执行"}` }, ...(trial.failure ? [{ text: trial.failure.reason, tone: "error" as const }] : [])], code: JSON.stringify(trial, null, 2) }) })),
        { id: "limits", label: "当前模型与限制", detail: () => ({ title: "模型与限制", paragraphs: [{ text: `会话：${this.view.session}\n工作版本：${this.view.revision}\n准备目录：${this.preparation.directory}` }], code: JSON.stringify(this.view.limits, null, 2) }) },
      ] },
    ];
  }
  private scenarios(): Item[] {
    const trial = this.view.content.metadata.trial;
    const result = (this.view.content.metadata.review?.scenarios ?? []).map((scenario): Item => {
      const observations = trial.observations.filter(observation => scenario.observations.includes(observation.name));
      return { id: scenario.id, label: scenario.title, description: this.busy && this.view.status === "running" ? "当前正在试跑" : observations.length ? `已观测 ${observations.length} 项` : "尚无观测值",
        detail: () => ({ title: scenario.title, paragraphs: [{ text: scenario.purpose }, { text: `输入与条件：\n${scenario.inputs.join("\n")}` },
          { text: `关联检查项：\n${scenario.observations.join("\n")}\n\n源码依据：\n${scenario.sourceReferences.join("\n")}` },
          ...(this.busy && this.view.status === "running" ? [{ text: "当前试跑尚未结束；以下为上一次记录。", tone: "warning" as const }] : []),
          ...observations.map(observation => ({ text: `${observation.name}\n${JSON.stringify(observation.value, null, 2)?.slice(0, 1024) ?? "undefined"}` })),
          { text: `完整观测值：${trial.evidence_dir ?? "尚未执行"}`, tone: "muted" },
        ] }) };
    });
    const declared = new Set(this.view.content.metadata.review?.scenarios.flatMap(scenario => scenario.observations) ?? []);
    for (const observation of trial.observations.filter(observation => !declared.has(observation.name))) result.push({ id: `unmatched/${observation.name}`, label: observation.name, description: "未关联到场景", detail: () => ({ title: observation.name, paragraphs: [{ text: "AI 的场景说明尚未关联这一实际检查项，可通过修改意见要求补全。", tone: "warning" }], code: JSON.stringify(observation.value, null, 2) }) });
    return result;
  }
  private trialItems(): Item[] {
    const trial = this.view.content.metadata.trial;
    return [{ id: "trial-summary", label: this.busy && this.view.status === "running" ? "当前正在试跑" : resultLabel(trial), description: `${trial.observations.length} 个已记录检查项`, detail: () => ({ title: "原版试跑", paragraphs: [
      { text: this.busy && this.view.status === "running" ? "当前执行状态请查看“构建与测试”；本页已完成记录将在试跑结束后更新。" : `${resultLabel(trial)} · ${duration(trial.duration_ms)}` },
      ...(trial.failure ? [{ text: trial.failure.reason, tone: "error" as const }] : []), { text: `证据：${trial.evidence_dir ?? "未执行"}` },
      ...(trial.ctest ? [{ text: `CTest：${trial.ctest.status}\n实际测试：${trial.ctest.top_level_tests.join("、")}` }] : []),
    ] }) }, ...trial.builds.map(build => ({ id: `build/${build.id}`, label: `构建 ${build.id}`, description: build.status, detail: () => ({ title: `构建 ${build.id}`, paragraphs: [{ text: `${build.status} · ${duration(build.duration_ms)}` }, ...(build.failure ? [{ text: build.failure, tone: "error" as const }] : [])] }) }))];
  }
}
