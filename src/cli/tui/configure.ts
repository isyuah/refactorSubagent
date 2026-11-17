import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createPatch } from "diff";
import { Pipeline, DEFAULT_PIPELINE, buildStageFlow, resolvePipeline } from "../../config/pipeline.js";
import { Limits, resolveLimits } from "../../config/limits.js";
import type { LayerOverrides } from "../../config/layers.js";
import type { RunCommand, TestsCommand } from "../args.js";
import { CliInputCancelled } from "../input.js";
import { loadTestPlan } from "../../testing/bundle.js";
import { Workbench, type Item, type Section } from "./workbench.js";

export type LaunchCommand = RunCommand | TestsCommand;
export interface ConfiguredLaunch { command: LaunchCommand; limitOverrides: LayerOverrides; pipelineOverrides: LayerOverrides }
interface Field { id: string; label: string; value: () => string; help: string; edit: () => Promise<void> }
const lines = (value: string): string[] => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const limitNames: Record<string, string> = {
  testWriter: "测试编写", refactor: "重构", deadlineMs: "会话总时间（毫秒）", stallMs: "无活动超时（毫秒）", maxTurns: "会话轮数", model: "模型",
  buildMs: "构建超时（毫秒）", ctestMs: "CTest 超时（毫秒）", testWorkflowMs: "测试脚本超时（毫秒）", policyRepairs: "源码策略修复次数",
  processMs: "默认命令超时（毫秒）", readyMs: "就绪检查超时（毫秒）", maxProcesses: "最大进程数", maxOutputBytes: "最大输出字节数", maxFileBytes: "最大文件字节数",
  build: "构建", test: "测试", hostMs: "主机工具探测超时（毫秒）", sessions: "会话", stages: "阶段", commands: "命令", resources: "资源", probes: "探测",
};
function leafEntries(value: object, prefix = ""): { path: string; value: unknown }[] {
  return Object.entries(value).flatMap(([key, entry]) => key === "version" ? [] : entry !== null && typeof entry === "object"
    ? leafEntries(entry, `${prefix}${key}.`) : [{ path: `${prefix}${key}`, value: entry }]);
}
function setLeaf(value: object, path: string, next: unknown): void {
  const parts = path.split("."); let node: Record<string, unknown> = value as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
  node[parts.at(-1)!] = next;
}
function getLeaf(value: object, path: string): unknown { let node: unknown = value; for (const part of path.split(".")) node = (node as Record<string, unknown>)[part]; return node; }

/** A picker never interprets a selected filename as shell text. */
export async function pickPath(ui: Workbench, current: string, kind: "file" | "directory"): Promise<string | null> {
  let directory = resolve(current || ".");
  if (existsSync(directory) && !statSync(directory).isDirectory()) directory = dirname(directory);
  while (!existsSync(directory)) { const parent = dirname(directory); if (parent === directory) { directory = process.cwd(); break; } directory = parent; }
  for (;;) {
    const entries = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() || (kind === "file" && entry.isFile()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const selected = await ui.choose(`选择${kind === "file" ? "文件" : "目录"} · ${directory}`, [
      { label: "输入路径", value: "input", description: "可切换盘符，也可输入尚未创建的输出目录" },
      ...(kind === "directory" ? [{ label: "使用当前目录", value: "use" }] : []),
      ...(dirname(directory) !== directory ? [{ label: "上级目录", value: "parent" }] : []),
      ...entries.map(entry => ({ label: entry.name, value: `entry:${entry.name}`, description: entry.isDirectory() ? "目录" : "文件" })),
    ]);
    if (selected === null) return null;
    if (selected === "use") return directory;
    if (selected === "parent") { directory = dirname(directory); continue; }
    if (selected === "input") return ui.input({ title: "输入路径", value: current, help: "相对路径基于当前启动目录；Esc 取消。" });
    const path = join(directory, selected.slice(6));
    if (statSync(path).isDirectory()) directory = path; else return path;
  }
}

export class LaunchWizard {
  private command: LaunchCommand;
  private limits: Limits;
  private pipeline: Pipeline;
  private limitFiles: readonly string[];
  private pipelineFiles: readonly string[];
  private limitSources: readonly string[] = [];
  private pipelineSources: readonly string[] = [];
  private readonly done = Promise.withResolvers<ConfiguredLaunch>();
  private notice = "设置仅对本次运行生效；也可主动保存执行方案、模型和限制到项目。";
  private readonly originalLimits: LayerOverrides;
  private readonly originalPipeline: LayerOverrides;
  constructor(private readonly ui: Workbench, command: LaunchCommand, limitOverrides: LayerOverrides, pipelineOverrides: LayerOverrides) {
    this.command = structuredClone(command); this.originalLimits = limitOverrides; this.originalPipeline = pipelineOverrides;
    this.limitFiles = limitOverrides.files ?? []; this.pipelineFiles = pipelineOverrides.files ?? [];
    const effective = this.resolveConfiguration(); this.limits = effective.limits; this.pipeline = effective.pipeline;
    if (this.command.kind === "run" && this.command.tests) this.pipeline.stages.workflows = { mode: "test-plan", directory: this.command.tests };
  }
  private resolveConfiguration(): { limits: Limits; pipeline: Pipeline } {
    const limits = resolveLimits({ repoRoot: resolve(this.command.repo), overrides: { ...this.originalLimits, files: this.limitFiles } });
    const pipeline = this.command.kind === "run" ? resolvePipeline({ repoRoot: resolve(this.command.repo), overrides: { ...this.originalPipeline, files: this.pipelineFiles } }) : { pipeline: structuredClone(DEFAULT_PIPELINE), sources: [] };
    this.limitSources = limits.sources; this.pipelineSources = pipeline.sources;
    return { limits: limits.limits, pipeline: pipeline.pipeline };
  }
  run(): Promise<ConfiguredLaunch> {
    this.ui.onExit = () => this.done.reject(new CliInputCancelled()); this.ui.onCancel = this.ui.onExit;
    this.ui.setTitle("启动配置 · " + (this.command.kind === "run" ? "全流程重构" : this.command.action === "prepare" ? "准备测试" : "打开测试方案"));
    this.build(); return this.done.promise;
  }
  private text(id: string, label: string, value: () => string, apply: (text: string) => void, help: string, multiline = false, initial: () => string = value): Field {
    return { id, label, value, help, edit: async () => {
      const result = await this.ui.input({ title: label, value: initial(), help, multiline, validate: text => { try { apply(text); return null; } catch (error) { return errorText(error); } } });
      if (result !== null) this.build();
    } };
  }
  private path(id: string, label: string, value: () => string, apply: (text: string) => void, kind: "file" | "directory", help: string): Field {
    return { id, label, value, help, edit: async () => { const path = await pickPath(this.ui, value(), kind); if (path !== null) { apply(path); this.build(); } } };
  }
  private choice(id: string, label: string, value: () => string, choices: readonly { label: string; value: string; description?: string }[], apply: (value: string) => void, help: string): Field {
    return { id, label, value: () => choices.find(choice => choice.value === value())?.label ?? value(), help, edit: async () => {
      const choice = await this.ui.choose(label, choices); if (choice !== null) { apply(choice); this.build(); }
    } };
  }
  private build(): void {
    const command = this.command;
    const basic: Field[] = [this.path("repo", "目标仓库", () => command.repo, text => {
      if (!existsSync(text) || !statSync(text).isDirectory()) throw new Error("请选择存在的仓库目录");
      const previous = command.repo; command.repo = resolve(text);
      try { const next = this.resolveConfiguration(); this.limits = next.limits; this.pipeline = next.pipeline; }
      catch (error) { command.repo = previous; throw error; }
    }, "directory", "选择 Git 仓库；更换仓库后重新加载该项目的配置。")];
    if (command.kind === "run") basic.push(this.text("task", "重构需求", () => command.task, text => { command.task = text; }, "描述希望进行的重构；启动前必须填写。", true));
    else if (command.action === "prepare") basic.push(this.text("scope", "测试保护范围", () => command.scope ?? "", text => { command.scope = text; }, "描述需要保护的模块、行为和边界条件。", true));
    else basic.push(this.path("from", "已保存测试方案", () => command.from ?? "", text => { command.from = text; }, "directory", "选择包含 plan.json 的方案版本目录。"));
    basic.push(this.choice("verbosity", "显示内容", () => command.verbosity, [{ label: "详细", value: "detailed" }, { label: "摘要", value: "summary" }], value => { command.verbosity = value as "detailed" | "summary"; }, "详细模式包含 AI 正常回复和命令输出。"));
    const flow: Field[] = [];
    if (command.kind === "run" && command.resume === null) {
      const stages = this.pipeline.stages;
      flow.push(this.choice("workflow-mode", "验证方案来源", () => stages.workflows.mode,
        [{ label: "AI 设计并编写", value: "ai" }, { label: "指定构建与测试脚本", value: "preset" }, { label: "已保存测试方案", value: "test-plan" }], value => {
          stages.workflows = value === "ai" ? { mode: "ai" } : value === "preset" ? { mode: "preset", builds: [{ id: "build", entry: "" }], testEntry: "" } : { mode: "test-plan", directory: "" };
          command.tests = null;
        }, "决定验证方案的来源，不改变验证判据。"));
      const workflows = stages.workflows;
      if (workflows.mode === "test-plan") flow.push(this.path("test-plan", "测试方案目录", () => workflows.directory, value => { workflows.directory = value; }, "directory", "保存方案的一个具体版本目录。"));
      if (workflows.mode === "preset") {
        flow.push(this.path("test-entry", "测试脚本", () => workflows.testEntry, value => { workflows.testEntry = value; }, "file", "TestWorkflow 的 TypeScript 入口。"));
        flow.push(this.path("entry-root", "脚本允许根目录", () => workflows.entryRoot ?? command.repo, value => { workflows.entryRoot = value; }, "directory", "脚本必须位于这个目录内；默认是目标仓库。"));
        for (const [index, build] of workflows.builds.entries()) {
          flow.push(this.text(`build-id-${index}`, `构建 ${index + 1} · 编号`, () => build.id, value => { build.id = value; }, "每个构建使用不同的编号。"));
          flow.push(this.path(`build-entry-${index}`, `构建 ${index + 1} · 脚本`, () => build.entry, value => { build.entry = value; }, "file", "BuildWorkflow 的 TypeScript 入口。"));
          flow.push(this.text(`build-workflow-${index}`, `构建 ${index + 1} · 登记名称（可选）`, () => build.workflowId ?? "", value => { build.workflowId = value || undefined; }, "留空由脚本定义或自动生成。"));
          flow.push(this.text(`build-revision-${index}`, `构建 ${index + 1} · 版本（可选）`, () => build.revision === undefined ? "" : String(build.revision), value => {
            if (value && (!/^\d+$/.test(value) || Number(value) < 1)) throw new Error("版本号必须是正整数"); build.revision = value ? Number(value) : undefined;
          }, "留空使用现有默认版本。"));
          flow.push(this.choice(`build-local-${index}`, `构建 ${index + 1} · 脚本来源`, () => String(build.runLocal ?? false), [{ label: "项目中已有的脚本", value: "false" }, { label: "本次生成的脚本", value: "true" }], value => { build.runLocal = value === "true"; }, "项目中已有的脚本通常选择第一项。"));
        }
        flow.push({ id: "add-build", label: "添加构建", value: () => `${workflows.builds.length} 个构建`, help: "一个方案可以声明多个构建。", edit: async () => { workflows.builds.push({ id: `build-${workflows.builds.length + 1}`, entry: "" }); this.build(); } });
        flow.push({ id: "remove-build", label: "移除构建", value: () => "选择要移除的构建", help: "至少保留一个构建。", edit: async () => {
          if (workflows.builds.length <= 1) { await this.ui.message("无法移除", "至少需要一个构建"); return; } const selected = await this.ui.choose("移除构建", workflows.builds.map((build, index) => ({ label: build.id, value: String(index), description: build.entry })));
          if (selected !== null) { workflows.builds.splice(Number(selected), 1); this.build(); }
        } });
        flow.push(this.text("test-workflow", "测试登记名称（可选）", () => workflows.workflowId ?? "", value => { workflows.workflowId = value || undefined; }, "留空由脚本定义或自动生成。"));
        flow.push(this.text("test-revision", "测试版本（可选）", () => workflows.revision === undefined ? "" : String(workflows.revision), value => {
          if (value && (!/^\d+$/.test(value) || Number(value) < 1)) throw new Error("版本号必须是正整数"); workflows.revision = value ? Number(value) : undefined;
        }, "留空使用现有默认版本。"));
      }
      flow.push(this.choice("prepare-mode", "候选工作目录", () => stages.prepare.mode, [{ label: "新建候选分支", value: "create" }, { label: "复用已有候选分支", value: "reuse" }], value => { stages.prepare = value === "create" ? { mode: "create" } : { mode: "reuse", branch: "", baseSha: "" }; }, "复用时需提供候选分支和原版提交。"));
      if (stages.prepare.mode === "reuse") { const prepare = stages.prepare;
        flow.push(this.text("branch", "候选分支", () => prepare.branch, value => { prepare.branch = value; }, "已有且包含候选修改的分支。"), this.text("base-sha", "原版提交", () => prepare.baseSha, value => { prepare.baseSha = value; }, "作为比较基准的 Git 提交。"));
      }
      flow.push(this.choice("refactor-mode", "重构来源", () => stages.refactor.mode, [{ label: "AI 重构", value: "ai" }, { label: "应用现成补丁", value: "patch" }, { label: "使用已有候选改动", value: "none" }], value => { stages.refactor = value === "patch" ? { mode: "patch", patchFile: "" } : value === "none" ? { mode: "none" } : { mode: "ai" }; }, "使用已有候选改动需要复用候选分支。"));
      if (stages.refactor.mode === "patch") { const refactor = stages.refactor; flow.push(this.path("patch", "补丁文件", () => refactor.patchFile, value => { refactor.patchFile = value; }, "file", "提供给候选实现的 Git 补丁。")); }
    }
    if (command.kind === "run") {
      flow.push(this.text("retry", "自动反馈修复次数", () => String(command.autoRetry), value => { const number = Number(value); if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) throw new Error("请输入非负整数，0 表示关闭"); command.autoRetry = number; }, "默认 3；恢复运行会沿用已消耗次数。"));
      flow.push(this.text("resume", "恢复会话", () => command.resume ?? "", value => { command.resume = value || null; }, "填写已有 ABORTED 会话编号；留空为新运行。恢复时不能替换验证方案。"));
    }
    const limits: Field[] = leafEntries(this.limits).map(({ path }) => this.text(`limit:${path}`, path.split(".").map(part => limitNames[part] ?? part).join(" / "), () => {
      const value = getLeaf(this.limits, path); return value === null ? path.endsWith(".model") ? "SDK 默认值" : "不限制" : String(value);
    }, text => {
      const value = ["null", "不限制", "SDK 默认值", ""].includes(text) ? null : path.endsWith(".model") ? text : Number(text);
      const candidate = structuredClone(this.limits); setLeaf(candidate, path, value); this.limits = Limits.parse(candidate);
    }, "模型留空使用 SDK 默认值；可选限制填写 null 表示不限制。时间单位是毫秒，资源数量必须为正整数。", false, () => { const value = getLeaf(this.limits, path); return value === null ? "" : String(value); }));
    const paths: Field[] = [this.text("session", "会话名称", () => command.session ?? "", value => { if (value && !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("仅使用字母、数字、下划线和连字符"); command.session = value || null; }, "留空自动生成唯一编号；自定义名称不能覆盖已有会话。"),
      this.path("session-root", "结果目录根位置", () => command.sessionRoot ?? command.repo, value => { command.sessionRoot = value; }, "directory", "结果保存在此目录的 .refactor 中。")];
    if (command.kind === "run") paths.push(this.path("worktree-root", "复用工作目录根位置", () => command.worktreeRoot ?? "", value => { command.worktreeRoot = value || null; }, "directory", "可选；复用目录由调用方保管，不会自动删除。"),
      this.text("injections", "注入文件", () => command.injections.map(item => `${item.source}=${item.dest}`).join("\n"), value => {
        command.injections = lines(value).map(line => { const at = line.indexOf("="); if (at <= 0 || at === line.length - 1) throw new Error("每行使用 source=dest 格式"); const dest = line.slice(at + 1); if (isAbsolute(dest) || dest.split(/[\\/]/).includes("..")) throw new Error("目标必须是工作目录内的相对路径"); return { source: line.slice(0, at), dest }; });
      }, "每行 source=dest；在候选提交之后、验证之前注入到两侧。", true));
    else paths.push(this.path("out", "方案保存父目录", () => command.out ?? "", value => { command.out = value || null; }, "directory", "留空使用默认位置；每次保存创建新版本。"));
    const sources: Field[] = [this.text("limit-files", "额外限制配置文件", () => this.limitFiles.join("\n"), value => { const previous = this.limitFiles; this.limitFiles = lines(value); try { this.limits = this.resolveConfiguration().limits; } catch (error) { this.limitFiles = previous; throw error; } }, "每行一个文件，后面的覆盖前面的。重新加载会重置本页对限制的修改。", true)];
    if (command.kind === "run") sources.push(this.text("pipeline-files", "额外流程配置文件", () => this.pipelineFiles.join("\n"), value => { const previous = this.pipelineFiles; this.pipelineFiles = lines(value); try { this.pipeline = this.resolveConfiguration().pipeline; } catch (error) { this.pipelineFiles = previous; throw error; } }, "每行一个文件，后面的覆盖前面的。重新加载会重置本页对流程的修改。", true));
    const section = (id: string, title: string, fields: Field[]): Section => ({ id, title, items: () => fields.map(field => {
      return { id: field.id, label: field.label, description: field.value().replaceAll("\n", "；") || "未填写", activate: field.edit,
        detail: () => ({ title: field.label, paragraphs: [{ text: field.value() || "未填写", tone: "accent" }, { text: field.help }, { text: "Enter 编辑此项；Tab 切换区域。", tone: "muted" }] }) };
    }) });
    const failure = this.validate();
    const selected = this.ui.currentItem()?.id;
    const sections = [section("basic", "基本任务", basic), ...(flow.length ? [section("flow", "执行方案", flow)] : []), section("limits", "模型与限制", limits), section("paths", "目录与注入", paths), section("sources", "配置来源", sources), {
      id: "confirm", title: "确认启动", items: () => [{ id: "review", label: "本次运行", description: failure ?? "配置有效", detail: () => ({ title: "确认启动", paragraphs: [
        { text: `仓库：${resolve(command.repo)}\n${command.kind === "run" ? "重构需求：" + command.task : "保护范围：" + (command.scope ?? "保存方案中的范围")}` },
        { text: (command.kind === "run" ? `流程配置来源：\n${this.pipelineSources.join("\n") || "内置默认值"}\n\n` : "") + `限制配置来源：\n${this.limitSources.join("\n") || "内置默认值"}` },
        { text: failure ?? "必填项和配置校验通过。", tone: failure ? "error" : "success" },
        { text: this.notice, tone: "muted" }, { text: "可导出本次完整配置及启动命令，之后从终端直接复用。", tone: "muted" },
      ], code: JSON.stringify(command.kind === "run" ? { pipeline: this.pipeline, limits: this.limits } : { limits: this.limits }, null, 2) }) }],
    } satisfies Section];
    this.ui.setSections(sections);
    // Keep the selected field after edits, including fields revealed by a mode switch.
    if (selected) { const sectionIndex = sections.findIndex(entry => entry.items().some(item => item.id === selected)); if (sectionIndex >= 0) { this.ui.selectSection(sectionIndex); this.ui.selectItem(sections[sectionIndex]!.items().findIndex(item => item.id === selected)); } }
    this.ui.setStatus("尚未创建运行会话，也未调用 AI。");
    this.ui.setActions([{ id: "edit", label: "编辑选中项", run: () => this.ui.currentItem()?.activate?.() },
      { id: "save", label: "保存项目默认", run: () => this.saveProject() }, { id: "export", label: "导出启动命令", run: () => this.exportLaunch() }, { id: "start", label: "开始", tone: "success", run: () => this.start() },
      { id: "cancel", label: "取消", tone: "muted", run: () => this.done.reject(new CliInputCancelled()) }]);
    this.ui.setNotice("Enter 编辑 · Tab 切换区域 · 1–6 切换分组");
  }
  validate(requireTask = true): string | null {
    try {
      const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(this.command.repo), encoding: "utf8", windowsHide: true });
      if (git.error || git.status !== 0) throw new Error("目标目录不是可用的 Git 仓库");
      Limits.parse(this.limits);
      const command = this.command;
      if (command.kind === "run") {
        if (requireTask && !command.task.trim()) throw new Error("请填写重构需求");
        if (command.resume === null) {
          const pipeline = Pipeline.parse(this.pipeline); buildStageFlow(pipeline);
          const workflows = pipeline.stages.workflows;
          if (workflows.mode === "test-plan") loadTestPlan(resolve(workflows.directory));
          if (workflows.mode === "preset") {
            const root = resolve(workflows.entryRoot ?? command.repo);
            for (const entry of [workflows.testEntry, ...workflows.builds.map(build => build.entry)]) if (!existsSync(resolve(root, entry))) throw new Error(`脚本不存在：${entry}`);
            if (new Set(workflows.builds.map(build => build.id)).size !== workflows.builds.length) throw new Error("构建编号不能重复");
          }
          if (pipeline.stages.refactor.mode === "patch" && !existsSync(resolve(command.repo, pipeline.stages.refactor.patchFile))) throw new Error("补丁文件不存在");
        } else if (command.tests !== null) throw new Error("恢复运行不能同时替换已保存的测试方案");
      } else if (command.action === "prepare" && requireTask && !command.scope?.trim()) throw new Error("请填写测试保护范围");
      else if (command.action === "review") { if (!command.from) throw new Error("请选择测试方案目录"); loadTestPlan(resolve(command.from)); }
      return null;
    } catch (error) { return errorText(error); }
  }
  private result(): ConfiguredLaunch {
    const command = { ...this.command, configure: false };
    if (command.kind === "run") command.tests = null;
    return { command, limitOverrides: { ...this.originalLimits, files: this.limitFiles, inline: this.limits },
      pipelineOverrides: command.kind === "run" ? { ...this.originalPipeline, files: this.pipelineFiles, inline: { stages: this.pipeline.stages } } : this.originalPipeline };
  }
  private async start(): Promise<void> {
    const failure = this.validate(); if (failure) { this.ui.setNotice(failure); await this.ui.message("无法启动", failure); return; }
    this.done.resolve(this.result());
  }
  private async exportLaunch(): Promise<void> {
    const failure = this.validate();
    if (failure) { await this.ui.message("无法导出", failure); return; }
    const selected = await pickPath(this.ui, resolve(this.command.repo, ".refactor", "launches"), "directory");
    if (!selected) return;
    const directory = join(resolve(selected), crypto.randomUUID());
    mkdirSync(directory, { recursive: true });
    const limitsFile = join(directory, "limits.json");
    const pipelineFile = join(directory, "pipeline.json");
    writeFileSync(limitsFile, JSON.stringify(this.limits, null, 2) + "\n");
    const pipeline = structuredClone(this.pipeline);
    const workflows = pipeline.stages.workflows;
    if (workflows.mode === "test-plan") workflows.directory = resolve(workflows.directory);
    if (workflows.mode === "preset") workflows.entryRoot = resolve(workflows.entryRoot ?? this.command.repo);
    writeFileSync(pipelineFile, JSON.stringify(pipeline, null, 2) + "\n");
    const command = launchCommandLine(this.command, limitsFile, pipelineFile);
    writeFileSync(join(directory, "command.txt"), command + "\n");
    await this.ui.message("启动命令已导出", command + "\n\n配置快照及命令：" + directory);
  }
  async saveProject(): Promise<void> {
    const failure = this.validate(false); if (failure) { await this.ui.message("暂时无法保存", failure); return; }
    const directory = join(resolve(this.command.repo), ".refactor");
    const files = [{ path: join(directory, "limits.json"), value: this.limits }, ...(this.command.kind === "run" && this.command.resume === null ? [{ path: join(directory, "pipeline.json"), value: Pipeline.parse(this.pipeline) }] : [])];
    const changes = files.map(file => ({ ...file, text: JSON.stringify(file.value, null, 2) + "\n", previous: existsSync(file.path) ? readFileSync(file.path, "utf8") : "" }));
    this.ui.setSections([{ id: "save-preview", title: "保存预览", items: () => changes.map(file => ({ id: file.path, label: parse(file.path).base, description: file.path,
      detail: () => ({ title: file.path, paragraphs: [{ text: "仅保存执行方案、模型与限制；本次任务、会话和目录不写入项目默认。" }], diff: createPatch(file.path, file.previous, file.text) }) })) }]);
    const decision = Promise.withResolvers<boolean>();
    this.ui.setTitle("保存项目默认 · 预览修改");
    this.ui.setActions([{ id: "apply-config", label: "确认写入", tone: "success", run: () => decision.resolve(true) }, { id: "back-config", label: "返回设置", run: () => decision.resolve(false) }]);
    this.ui.setNotice("选择文件查看真实差异；确认后写入项目默认。");
    this.ui.onExit = () => decision.resolve(false); this.ui.onCancel = () => { decision.resolve(false); this.done.reject(new CliInputCancelled()); };
    try {
      if (await decision.promise) {
        mkdirSync(directory, { recursive: true });
        for (const file of changes) { const temporary = `${file.path}.${crypto.randomUUID()}.tmp`; writeFileSync(temporary, file.text, { flag: "wx" }); renameSync(temporary, file.path); }
        this.notice = "项目默认已保存；本次运行仍以确认页显示的设置为准。";
      }
    } finally {
      this.ui.onExit = () => this.done.reject(new CliInputCancelled()); this.ui.onCancel = this.ui.onExit;
      this.ui.setTitle("启动配置 · " + (this.command.kind === "run" ? "全流程重构" : "测试准备与审阅"));
    }
    this.build();
  }
}

/** Quote for the host's documented interactive shell; never execute this text. */
export function launchCommandLine(command: LaunchCommand, limitsFile: string, pipelineFile: string): string {
  const args = [resolve(import.meta.dir, "../../../scripts/cli.ts"), ...(command.kind === "run" ? ["run"] : ["tests", command.action]), resolve(command.repo)];
  const option = (flag: string, value: string | null): void => { if (value !== null) args.push(flag, value); };
  option("--limits-file", limitsFile);
  if (command.kind === "run") {
    option("--pipeline-file", pipelineFile); option("--task", command.task); option("--auto-retry", String(command.autoRetry));
    option("--worktree-root", command.worktreeRoot === null ? null : resolve(command.worktreeRoot)); option("--resume", command.resume);
    for (const injection of command.injections) option("--inject", `${resolve(injection.source)}=${injection.dest}`);
  } else {
    option("--scope", command.scope); option("--from", command.from === null ? null : resolve(command.from)); option("--out", command.out === null ? null : resolve(command.out));
  }
  option("--session", command.session); option("--session-root", command.sessionRoot === null ? null : resolve(command.sessionRoot));
  option("--ui", "tui"); option("--verbosity", command.verbosity);
  if (!command.color) args.push("--no-color");
  const quote = (value: string): string => process.platform === "win32" ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return "bun " + args.map(quote).join(" ");
}
