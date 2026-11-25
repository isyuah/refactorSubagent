import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../src/cli/args.js";
import { LaunchWizard } from "../src/cli/tui/configure.js";
import { resolveLimits } from "../src/config/limits.js";
import { resolvePipeline } from "../src/config/pipeline.js";
import { CliInputCancelled } from "../src/cli/input.js";
import { terminal } from "./tui-helpers.js";

function repository(): string {
  const repo = mkdtempSync(join(tmpdir(), "rfr-tui-wizard-"));
  execFileSync("git", ["init", "-q", repo], { windowsHide: true }); return repo;
}
function command(repo: string, args: string[] = []) {
  const command = parseCliArgs(["run", repo, ...args], true); if (command.kind !== "run") throw new Error("run required"); return command;
}
async function field(t: Awaited<ReturnType<typeof terminal>>, id: string): Promise<void> {
  const index = t.ui.list.options.findIndex(option => option.value === id); expect(index).toBeGreaterThanOrEqual(0);
  t.ui.selectItem(index); t.mockInput.pressEnter(); await t.frame();
}

describe("OpenTUI launch configuration", () => {
  test("repo 字段接受相对路径：失败时展示解析基准，空值显式报错，修正后通过", async () => {
    const repo = repository(); const t = await terminal(120, 38);
    const wizard = new LaunchWizard(t.ui, command(repo), {}, {}); const running = wizard.run();
    const editRepo = async (text: string): Promise<void> => {
      await field(t, "repo");                                  // 目录浏览器
      await t.mockInput.pressEnter(); await t.frame();          // 默认「输入路径」→ 输入框
      await t.mockInput.pressKey("a", { ctrl: true }); await t.mockInput.pressKey("k", { ctrl: true });
      await t.mockInput.pasteBracketedText(text);
      await t.activate("dialog:submit"); await t.frame();       // 提交 → apply 校验
    };
    try {
      // ① 相对路径：按启动目录解析；失败时把解析结果与当前目录一起说明。
      await editRepo("missing-relative-dir");
      const frame = await t.frame();
      expect(frame).toContain("仓库目录不存在：missing-relative-dir");
      expect(frame).toContain("相对路径按启动目录解析为");
      expect(frame).toContain(process.cwd());
      await t.activate("dialog:close"); await t.frame();        // 关掉「操作失败」弹窗
      // ② 空值不能被当成当前目录（resolve("") === cwd）。
      await editRepo("");
      expect(await t.frame()).toContain("请填写仓库目录");
      await t.activate("dialog:close"); await t.frame();
      // ③ 改填真实仓库：校验通过，向导回到表单。
      await editRepo(repo);
      expect(wizard.validate()).not.toBeNull();
    } finally { await t.close(); void running.catch(() => {}); }
  });  test("edit missing task, choose workflow input and start with ephemeral typed settings", async () => {
    const repo = repository(); const t = await terminal(120, 38); const wizard = new LaunchWizard(t.ui, command(repo), {}, {}); const running = wizard.run();
    try {
      await field(t, "task"); await t.mockInput.pasteBracketedText("提取重复函数\n保留行为"); await t.activate("dialog:submit");
      t.ui.selectSection(1); await field(t, "workflow-mode");
      t.mockInput.pressArrow("down"); t.mockInput.pressEnter(); await t.frame();
      expect(wizard.validate()).not.toBeNull();
      // Switching back must remove the incomplete preset fields, rather than leave stale entries.
      await field(t, "workflow-mode"); t.mockInput.pressEnter(); await t.frame();
      t.ui.selectSection(2); const modelId = t.ui.list.options.find(option => String(option.value).endsWith("testWriter.model"))!.value as string;
      await field(t, modelId); t.mockInput.pressKey("a", { ctrl: true }); t.mockInput.pressKey("k", { ctrl: true }); await t.mockInput.pasteBracketedText("test-model"); await t.activate("dialog:submit");
      await t.activate("action:start"); const result = await running;
      expect(result.command.kind === "run" && result.command.task).toBe("提取重复函数\n保留行为");
      expect(resolvePipeline({ repoRoot: repo, overrides: result.pipelineOverrides }).pipeline.stages.workflows).toEqual({ mode: "ai" });
      expect(resolveLimits({ repoRoot: repo, overrides: result.limitOverrides }).limits.sessions.testWriter.model).toBe("test-model");
      expect(existsSync(join(repo, ".refactor"))).toBeFalse();
    } finally { await t.close(); }
  });
  test("saving project defaults previews real diff, requires confirmation, and excludes this run's task", async () => {
    const repo = repository(); const t = await terminal(120, 38); const wizard = new LaunchWizard(t.ui, command(repo), {}, {}); const running = wizard.run().catch(error => error);
    try {
      expect(wizard.validate()).toContain("重构需求");
      const saving = wizard.saveProject(); await t.frame();
      expect(await t.frame()).toContain("limits.json"); expect(existsSync(join(repo, ".refactor", "limits.json"))).toBeFalse();
      await t.activate("action:apply-config"); await saving;
      const pipeline = JSON.parse(readFileSync(join(repo, ".refactor", "pipeline.json"), "utf8"));
      expect(pipeline.stages.refactor.mode).toBe("ai"); expect(pipeline.task).toBeUndefined();
      expect(JSON.parse(readFileSync(join(repo, ".refactor", "limits.json"), "utf8"))).toHaveProperty("sessions");
      await t.activate("action:cancel"); expect(await running).toBeInstanceOf(CliInputCancelled);
    } finally { await t.close(); }
  });
  test("export saves effective configuration snapshots and a usable host-shell command without changing project defaults", async () => {
    const repo = repository(); const destination = join(repo, "exports"); const t = await terminal(120, 38);
    const wizard = new LaunchWizard(t.ui, command(repo, ["--task", "保留接口 'text_copy'", "--auto-retry", "2"]), { values: ["sessions.testWriter.maxTurns=12"] }, {});
    const running = wizard.run().catch(error => error);
    try {
      await t.activate("action:export"); t.mockInput.pressEnter(); await t.frame();
      t.mockInput.pressKey("a", { ctrl: true }); t.mockInput.pressKey("k", { ctrl: true }); await t.mockInput.pasteBracketedText(destination); await t.activate("dialog:submit"); await t.frame();
      const directory = join(destination, readdirSync(destination)[0]!);
      expect(JSON.parse(readFileSync(join(directory, "limits.json"), "utf8")).sessions.testWriter.maxTurns).toBe(12);
      expect(JSON.parse(readFileSync(join(directory, "pipeline.json"), "utf8")).stages.workflows.mode).toBe("ai");
      const commandText = readFileSync(join(directory, "command.txt"), "utf8"); expect(commandText).toContain("--limits-file"); expect(commandText).toContain("--pipeline-file"); expect(commandText).toContain("text_copy"); expect(commandText).toContain("--auto-retry");
      expect(existsSync(join(repo, ".refactor", "pipeline.json"))).toBeFalse();
      await t.activate("dialog:close"); await t.activate("action:cancel"); expect(await running).toBeInstanceOf(CliInputCancelled);
    } finally { await t.close(); }
  });
  test("resume keeps saved workflow inputs and can return to a fresh run", async () => {
    const repo = repository(); const t = await terminal(120, 38); const wizard = new LaunchWizard(t.ui, command(repo, ["--task", "task", "--resume", "old-session"]), {}, {}); const running = wizard.run().catch(error => error);
    try {
      t.ui.selectSection(1); expect(t.ui.list.options.some(option => option.value === "workflow-mode")).toBeFalse();
      await field(t, "resume"); t.mockInput.pressKey("a", { ctrl: true }); t.mockInput.pressKey("k", { ctrl: true }); await t.activate("dialog:submit");
      expect(t.ui.list.options.some(option => option.value === "workflow-mode")).toBeTrue();
      await t.activate("action:cancel"); expect(await running).toBeInstanceOf(CliInputCancelled);
    } finally { await t.close(); }
  });
  test("test preparation ignores unused refactor configuration and preserves it for a later continuation", async () => {
    const repo = repository(); const t = await terminal(120, 38); const command = parseCliArgs(["tests", "prepare", repo, "--scope", "保护边界输入"]);
    if (command.kind !== "tests") throw new Error("tests required");
    const pipeline = { files: ["missing-for-this-test.json"], values: ["stages.refactor.mode=patch"] };
    const wizard = new LaunchWizard(t.ui, command, {}, pipeline); const running = wizard.run();
    try { await t.activate("action:start"); expect((await running).pipelineOverrides).toEqual(pipeline); }
    finally { await t.close(); }
  });
  test("inline edits win over argv, switch discriminated modes cleanly and are schema validated", () => {
    const repo = repository();
    const limits = resolveLimits({ repoRoot: repo, overrides: { values: ["sessions.testWriter.maxTurns=8"], inline: { sessions: { testWriter: { maxTurns: 12 } } } } });
    expect(limits.limits.sessions.testWriter.maxTurns).toBe(12); expect(limits.sources).toContain("<interactive>");
    const pipeline = resolvePipeline({ repoRoot: repo, overrides: { values: ["stages.refactor.mode=none"], inline: { stages: { refactor: { mode: "ai" } } } } });
    expect(pipeline.pipeline.stages.refactor).toEqual({ mode: "ai" });
    expect(() => resolveLimits({ repoRoot: repo, overrides: { inline: { sessions: { testWriter: { maxTurns: -1 } } } } })).toThrow();
  });
});
