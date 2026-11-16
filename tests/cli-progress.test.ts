import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { RunDisplay, formatRunReport } from "../src/cli/display.js";
import { parseCliArgs } from "../src/cli/args.js";
import { DEFAULT_LIMITS } from "../src/config/limits.js";
import { E2ELogger } from "../src/runtime/log.js";
import { RunReportCollector, type ProgressUpdate, type RunProgressEvent } from "../src/runtime/progress.js";
import { ctestProgressSummary } from "../src/runtime/workflow-progress.js";
import type { CTestComparisonResult } from "../src/artifacts/index.js";

const input = { session: "offline", repo: "repo", task: "task", state: "ABORTED", abort_reason: "fixture stopped", decision_reason: "fixture stopped", finalization_error: null,
  failure: null, resume: null,
  elapsed_ms: 1000, limits: DEFAULT_LIMITS, limit_sources: [], limit_overrides: [], configuration: null,
  refactor_summary: "", log_dir: "evidence", report_path: "evidence/artifacts/run-summary.json" };
function event(update: ProgressUpdate, elapsed_ms = 0): RunProgressEvent {
  return { ...update, elapsed_ms, time: "2026-11-04T00:00:00.000Z", phase: "INIT" };
}
function display(options: Partial<ConstructorParameters<typeof RunDisplay>[0]> = {}, tty = false) {
  const chunks: string[] = [];
  const output = { write: (text: string) => chunks.push(text), isTTY: tty, columns: 120 };
  const renderer = new RunDisplay({ format: "human", verbosity: "detailed", progress: "plain", color: false, output, ...options });
  return { renderer, chunks, text: () => chunks.join("") };
}

describe("CLI progress and report contracts", () => {
  test("semantic color leaves AI and process bodies in the default color and sanitizes external styles", () => {
    const colored = display({ color: true, env: {} }, true);
    const plain = display({ color: false, env: {} }, true);
    const context = { side: "candidate" as const, build_id: "aux", log_path: "logs/aux.log" };
    const updates: ProgressUpdate[] = [
      { type: "phase", name: "WORKFLOW_SESSION" },
      { type: "agent-text", agent_id: "root", role: "test-writer", text: "AI_BODY_ONLY\u001b[41m\u001b[0m" },
      { type: "agent-tool", agent_id: "root", role: "test-writer", id: "write", name: "Write", target: "verification/辅助.c", action: "start" },
      { type: "agent-tool", agent_id: "root", role: "test-writer", id: "write", name: "Write", target: "verification/辅助.c", action: "end" },
      { type: "command-output", id: "process", stream: "stderr", text: "PROCESS_BODY_ONLY\u001b[41m\u001b[0m\n", context },
      { type: "build", side: "candidate", id: "aux", status: "pass" },
      { type: "command-end", id: "spawn", status: "spawn_error", exit_code: null, duration_ms: 1, error: "fixture missing program", context },
      { type: "command-end", id: "timeout", status: "timeout", exit_code: null, duration_ms: 20, error: null, context },
      { type: "command-end", id: "cancel", status: "stopped", exit_code: null, duration_ms: 10, error: null, context },
      { type: "log", level: "warn", message: "注意覆盖边界" },
      { type: "log", level: "error", message: "错误说明" },
    ];
    updates.forEach((update, index) => { colored.renderer.receive(event(update, index * 10)); plain.renderer.receive(event(update, index * 10)); });
    colored.renderer.stop(); plain.renderer.stop();
    expect(colored.text()).toContain("\u001b[");
    expect(stripVTControlCharacters(colored.text())).toBe(plain.text());
    expect(colored.text()).not.toContain("\u001b[41m");
    expect(colored.text()).toContain(":\nAI_BODY_ONLY\n");
    expect(colored.text()).toContain("] PROCESS_BODY_ONLY\n");
    expect(colored.text()).toContain("\u001b[32m通过\u001b[0m");
    // stderr is a stream label, not an inferred failure.
    expect(colored.text()).toContain("\u001b[33mstderr\u001b[0m");
    expect(colored.text()).not.toContain("\u001b[31mPROCESS_BODY_ONLY");
    expect(colored.text()).toContain("\u001b[31mspawn_error\u001b[0m");
    expect(colored.text()).toContain("\u001b[33mtimeout\u001b[0m");
    expect(colored.text()).toContain("\u001b[33mstopped\u001b[0m");
  });

  test("each output stream chooses color independently and reports remain plain by default", () => {
    const report = new RunReportCollector().finish(input, []);
    const colorReport = { color: true, output: { isTTY: true }, env: {} };
    const colored = formatRunReport(report, "summary", colorReport);
    expect(colored).toContain("\u001b[");
    expect(stripVTControlCharacters(colored)).toBe(formatRunReport(report, "summary"));
    for (const options of [
      { ...colorReport, color: false }, { ...colorReport, output: { isTTY: false } },
      { ...colorReport, env: { NO_COLOR: "" } }, { ...colorReport, env: { TERM: "dumb" } },
    ]) expect(formatRunReport(report, "summary", options)).not.toContain("\u001b");
    for (const [options, tty] of [
      [{ color: false, env: {} }, true], [{ color: true, env: {} }, false],
      [{ color: true, env: { NO_COLOR: "" } }, true], [{ color: true, env: { TERM: "dumb" } }, true],
    ] as const) {
      const f = display(options, tty);
      f.renderer.receive(event({ type: "phase", name: "REFACTOR" }));
      f.renderer.stop();
      expect(f.text()).not.toContain("\u001b");
    }
    const ttyProgress = display({ color: true, env: {} }, true);
    ttyProgress.renderer.receive(event({ type: "phase", name: "REFACTOR" }));
    expect(ttyProgress.text()).toContain("\u001b[");
    expect(formatRunReport(report, "summary", { ...colorReport, output: { isTTY: false } })).not.toContain("\u001b");
    const pipedProgress = display({ color: true, env: {} });
    pipedProgress.renderer.receive(event({ type: "phase", name: "REFACTOR" }));
    expect(pipedProgress.text()).not.toContain("\u001b");
    expect(formatRunReport(report, "summary", colorReport)).toContain("\u001b[");
    ttyProgress.renderer.stop(); pipedProgress.renderer.stop();
    for (const [state, code] of [["ACCEPTED", 32], ["REJECTED", 31], ["ABORTED", 33]] as const) {
      expect(formatRunReport({ ...report, state }, "summary", colorReport)).toContain(`\u001b[${code}m${state}\u001b[0m`);
    }
  });

  test("quick tools display one friendly completion while slow and unknown tools retain starts", () => {
    const f = display();
    const names = [
      ["Read", "读取文件"], ["Write", "写入文件"], ["Edit", "修改文件"], ["Glob", "查找文件"], ["Grep", "搜索内容"],
      ["mcp__dep-registry__inspectWorkflow", "查询构建方案"], ["mcp__dep-registry__declareDependency", "登记构建依赖"],
      ["mcp__dep-registry__generateBuildWorkflow", "保存构建方案"], ["mcp__dep-registry__submitVerificationAnalysis", "提交验证方案"],
    ];
    for (const [index, [name, label]] of names.entries()) {
      const tool = { type: "agent-tool" as const, agent_id: "root", role: "test-writer", id: `tool-${index}`, name: name!, target: "safe-target" };
      const before = f.text();
      f.renderer.receive(event({ ...tool, action: "start" }, 100));
      f.renderer.receive(event({ ...tool, action: "start" }, 100));
      expect(f.text()).toBe(before);
      f.renderer.receive(event({ ...tool, action: "end" }, 125));
      f.renderer.receive(event({ ...tool, action: "end" }, 125));
      const added = f.text().slice(before.length).trim().split("\n");
      expect(added).toHaveLength(1);
      expect(added[0]).toContain(`${label} safe-target · 完成 · 25ms`);
    }
    for (const name of ["Task", "Agent", "Bash", "mcp__custom__inspectWorkflow", "SomeFutureTool", "toString"]) {
      const tool = { type: "agent-tool" as const, agent_id: "root", role: "test-writer", id: name, name, target: "build-writer" };
      const before = f.text();
      f.renderer.receive(event({ ...tool, action: "start" }, 130));
      expect(f.text().slice(before.length)).toContain("开始");
      f.renderer.receive(event({ ...tool, action: "end" }, 160));
      expect(f.text().slice(before.length).trim().split("\n")).toHaveLength(2);
    }
    f.renderer.stop();
    expect(f.text()).toContain("子任务 构建编写");
    expect(f.text()).toContain("custom/inspectWorkflow");
    expect(f.text()).not.toContain("mcp__");
  });

  test("concurrent tools stay associated with their sessions, expose activity and explain missing results", () => {
    let now = 0;
    const f = display({ now: () => now });
    const a = { type: "agent-tool" as const, role: "test-writer", agent_id: "session-a", id: "same-id", name: "Write", target: "a.c" };
    const b = { ...a, agent_id: "session-b", name: "Read", target: "b.c" };
    f.renderer.receive(event({ ...a, action: "start" }, 10));
    f.renderer.receive(event({ ...b, action: "start" }, 20));
    now = 10_000;
    f.renderer.receive(event({ type: "agent-activity", agent_id: "session-b", role: "test-writer", text: "heartbeat", heartbeat: true }, 10_000));
    now = 11_000;
    f.renderer.tick();
    expect(f.text()).toContain("当前: 读取文件（另 1 项）");
    expect(f.text()).toContain("无活动 11.0s");
    f.renderer.receive(event({ ...b, action: "end", failed: true }, 12_000));
    expect(f.text()).toContain("读取文件 b.c · 失败 · 12.0s");
    f.renderer.receive(event({ ...a, action: "end" }, 13_000));
    expect(f.text()).toContain("写入文件 a.c · 完成 · 13.0s");
    f.renderer.receive(event({ ...a, id: "orphan", name: "mcp__other__tool", target: "", action: "end" }, 14_000));
    expect(f.text().trim().split("\n").at(-1)).toEndWith("other/tool · 完成");
    f.renderer.receive(event({ ...a, id: "unfinished", action: "start" }, 15_000));
    f.renderer.stop();
    const closed = f.text();
    expect(closed).toContain("写入文件 a.c · 未收到完成结果");
    f.renderer.stop(); f.renderer.tick();
    expect(f.text()).toBe(closed);

    const interrupted = display({ now: () => 0 });
    interrupted.renderer.receive(event({ ...a, action: "start" }));
    interrupted.renderer.interrupt("SIGINT");
    expect(interrupted.text()).toContain("已中断；未收到完成结果");
    expect(interrupted.text()).not.toContain(" · 完成");
  });

  test("colored activity in a narrow terminal stays on one row with complete Unicode and style resets", () => {
    const chunks: string[] = [];
    const f = display({ color: true, progress: "auto", env: {}, output: { isTTY: true, columns: 45, write: (text) => chunks.push(text) } });
    f.renderer.receive(event({ type: "phase", name: "WORKFLOW_SESSION" }));
    f.renderer.receive(event({ type: "agent-tool", agent_id: "a", role: "test-writer", id: "t", action: "start",
      name: "mcp__服务__检查👨‍👩‍👧‍👦中文e\u0301\u001b[41m\n".repeat(10), target: "中文路径/文件.c" }));
    const status = chunks.at(-1)!;
    expect(stripVTControlCharacters(status)).not.toMatch(/[\r\n]/);
    expect(Bun.stringWidth(status)).toBeLessThan(45);
    expect(status).not.toContain("\u001b[41m");
    expect(status).not.toMatch(/[\ud800-\udbff]$/u);
    expect(status).toContain("\u001b[0m");
    f.renderer.interrupt("SIGTERM");
    expect(chunks.at(-1)).toEndWith("\n");
  });

  test("parses display options without changing the run defaults", () => {
    expect(parseCliArgs(["run", "repo", "--task", "task"])).toMatchObject({ verbosity: "detailed", progress: "auto", color: true });
    expect(parseCliArgs(["run", "repo", "--task", "task", "--verbosity", "summary", "--progress", "off", "--no-color"])).toMatchObject({ verbosity: "summary", progress: "off", color: false });
    expect(() => parseCliArgs(["run", "--task", "task", "--verbosity", "trace"])).toThrow();
  });

  test("heartbeat and tool liveness never reset the idle timer; clearing the TTY status is idempotent", () => {
    let now = 0;
    const f = display({ now: () => now });
    f.renderer.receive(event({ type: "phase", name: "REFACTOR" }, 0));
    f.renderer.receive(event({ type: "agent-text", role: "refactor", agent_id: "root", text: "正在检查" }, 1000));
    now = 5000;
    f.renderer.receive(event({ type: "log", level: "info", message: "still running", heartbeat: true }, 5000));
    now = 6000;
    f.renderer.receive(event({ type: "agent-activity", role: "refactor", agent_id: "root", text: "tool alive", heartbeat: true }, 6000));
    now = 11_000;
    f.renderer.tick();
    expect(f.text()).toContain("总耗时 11.0s");
    expect(f.text()).toContain("无活动 10.0s");
    expect(f.text()).not.toContain("tool alive");
    f.renderer.stop();

    const tty: string[] = [];
    const t = display({ progress: "auto", output: { write: (text) => tty.push(text), isTTY: true, columns: 120 }, now: () => now, env: { NO_COLOR: "1" } });
    t.renderer.receive(event({ type: "phase", name: "REFACTOR" }));
    expect(tty.at(-1)).toContain("状态:");
    t.renderer.stop();
    expect(tty.at(-1)).toBe("\r\u001b[2K");
    const length = tty.length;
    t.renderer.stop();
    t.renderer.tick();
    expect(tty).toHaveLength(length);
    expect(tty.join("")).not.toMatch(/\u001b\[[0-9;]*m/);
    const interrupted = display();
    interrupted.renderer.interrupt("SIGINT");
    const before = interrupted.text();
    interrupted.renderer.tick();
    expect(interrupted.text()).toBe(before);
  });

  test("detailed and summary share events, with native output and AI text shown only at the requested detail", () => {
    const detail = display();
    const summary = display({ verbosity: "summary" });
    const context = { side: "baseline" as const, build_id: "aux", log_path: "logs/aux.log" };
    for (const update of [
      { type: "agent-text", role: "test-writer", agent_id: "root", text: "AI_REPLY_ONLY" },
      { type: "command-start", id: "p1", program: "tool", args: ["--token", "do-not-display"], cwd: "repo", context },
      { type: "command-output", id: "p1", stream: "stdout", text: "中文分块", context },
      { type: "command-output", id: "p1", stream: "stdout", text: "输出\n" + "x".repeat(9000), context },
      { type: "command-output", id: "p1", stream: "stderr", text: "\u001b[31mFAILURE_TAIL\u001b[0m\n", context },
      { type: "command-end", id: "p1", status: "exited", exit_code: 1, duration_ms: 10, error: null, context },
    ] satisfies ProgressUpdate[]) {
      detail.renderer.receive(event(update));
      summary.renderer.receive(event(update));
    }
    detail.renderer.stop(); summary.renderer.stop();
    expect(detail.text()).toContain("AI_REPLY_ONLY");
    expect(summary.text()).not.toContain("AI_REPLY_ONLY");
    expect(detail.text()).toContain("中文分块输出");
    expect(summary.text()).not.toContain("中文分块输出");
    expect(summary.text()).toContain("FAILURE_TAIL");
    for (const f of [detail, summary]) {
      expect(f.text()).not.toContain("do-not-display");
      expect(f.text()).not.toContain("\u001b");
      expect(f.text()).toContain("logs/aux.log");
    }
    const silent = display({ format: "json", progress: "auto" });
    silent.renderer.receive(event({ type: "phase", name: "REFACTOR" }));
    silent.renderer.tick(); silent.renderer.stop();
    expect(silent.text()).toBe("");
  });

  test("the report retains every build, marks work not executed, and avoids double-counting nested timing or costs", () => {
    const collector = new RunReportCollector();
    for (const [update, ms] of [
      [{ type: "stage", name: "verify", action: "start" }, 100],
      [{ type: "phase", name: "BASELINE_BUILD" }, 100],
      [{ type: "build", side: "baseline", id: "first", status: "pass", duration_ms: 200 }, 300],
      [{ type: "phase", name: "CANDIDATE_BUILD" }, 300],
      [{ type: "build", side: "baseline", id: "second", status: "failed", failure: "missing artifact", duration_ms: 300 }, 600],
      [{ type: "stage", name: "verify", action: "end", failed: true }, 600],
      [{ type: "phase", name: "CLEANUP" }, 600],
      [{ type: "stage", name: "cleanup", action: "start" }, 600],
      [{ type: "stage", name: "cleanup", action: "end" }, 1000],
      [{ type: "agent-usage", usage: { agent_id: "root", role: "test-writer", cost_usd: 0.5 } }, 1000],
      [{ type: "agent-usage", usage: { agent_id: "root", role: "test-writer", cost_usd: 0.5 } }, 1000],
      [{ type: "agent-usage", usage: { agent_id: "child", parent_id: "root", role: "build-writer", cost_usd: 0.2 } }, 1000],
    ] satisfies [ProgressUpdate, number][]) collector.accept(event(update, ms));
    const report = collector.finish(input, ["first", "second"]);
    expect(report.builds.map((build) => build.status)).toEqual(["pass", "failed", "not-run", "not-run"]);
    expect(report.tests.every((run) => run.status === "not-run")).toBeTrue();
    expect(report.stage_timings.find((stage) => stage.name === "verify")?.elapsed_ms).toBe(500);
    expect(report.stage_timings.find((stage) => stage.name === "cleanup")?.elapsed_ms).toBe(400);
    expect(report.cost_usd).toBe(0.5);
    expect(formatRunReport(report, "summary")).toContain("missing artifact");
  });

  test("mismatches have bounded Unicode previews and summary points to full evidence", () => {
    const collector = new RunReportCollector();
    collector.accept(event({ type: "comparison", comparison: { overall: "inconsistent", total: 12, matched: 0, mismatched: 12,
      checks: Array.from({ length: 12 }, (_, i) => ({ name: `check-${i}`, matched: false, reason: "changed", baseline: "😀".repeat(3000), candidate: "新版" })),
      errors: ["structural mismatch"], reason: "behavior differs: " + "😀".repeat(3000), evidence_paths: ["full.json"] } }));
    const report = collector.finish(input, []);
    const detailed = formatRunReport(report, "detailed");
    const summary = formatRunReport(report, "summary");
    expect(detailed).toContain("check-11");
    expect(detailed).toContain("😀".repeat(1024));
    expect(detailed).not.toContain("😀".repeat(1025));
    expect(detailed).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(summary).not.toContain("check-10");
    expect(summary).toContain("full.json");
    expect(summary).toContain(report.report_path);
  });

  test("CTest comparison reflects missing targets and subtest failures without inventing passing results", () => {
    const summary = ctestProgressSummary({ baseline_status: "pass", candidate_status: "fail", baseline_top_level_tests: ["suite"], candidate_top_level_tests: [],
      baseline_failed_tests: [], candidate_failed_tests: ["suite:inner"], overall: "inconsistent", reason: "drift" } as unknown as CTestComparisonResult);
    expect(summary.mismatched).toBe(3);
    expect(summary.checks.find((check) => check.name === "失败集合/suite:inner")).toMatchObject({ baseline: false, candidate: true });
  });

  test("a failing display observer cannot interrupt execution events at non-trace log levels", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-progress-log-"));
    const logger = new E2ELogger(root, "events", "error");
    const collected: RunProgressEvent[] = [];
    logger.subscribe(() => { throw new Error("display disconnected"); });
    logger.subscribe((event) => collected.push(event));
    logger.progress({ type: "agent-text", role: "test-writer", agent_id: "a", text: "visible without trace" });
    logger.phase("REFACTOR"); logger.close();
    expect(collected.map((event) => event.type)).toEqual(["agent-text", "phase"]);
    // Display-only text does not unexpectedly enlarge the durable info log.
    expect(readFileSync(join(logger.runDir, "run.jsonl"), "utf8")).not.toContain("visible without trace");
  });
  test("feedback rounds keep repair counts, clear old activity, and honor JSON silence", () => {
    let clock = 0;
    const live = display({ progress: "auto", color: true, env: {}, now: () => clock }, true);
    const json = display({ format: "json", progress: "auto" });
    const updates: ProgressUpdate[] = [
      { type: "feedback", feedback: { action: "start", owner_session: "original", resumed_from: "aborted", budget_total: 3, budget_used: 1, state_dir: "evidence/feedback" } },
      { type: "feedback", feedback: { action: "round-start", round: 5, session: "resumed", repair: null } },
      { type: "agent-tool", action: "start", id: "unfinished", agent_id: "old", role: "test-writer", name: "Read", target: "unfinished.c" },
      { type: "feedback", feedback: { action: "round-end", round: 5, session: "resumed", state: "REJECTED", reason: "output differs", log_dir: "evidence/resumed" } },
      { type: "feedback", feedback: { action: "repair-start", round: 6, session: "resumed-fb6", lane: "refactor", evidence: { summary: "REJECTED", mismatches: [{ name: "output", reason: "differs" }] }, budget_total: 3, budget_used: 2, dialogue_id: "old-dialogue", reuse_baseline: true } },
      { type: "feedback", feedback: { action: "round-start", round: 6, session: "resumed-fb6", repair: "refactor" } },
      { type: "phase", name: "WORKFLOW_SESSION" },
      { type: "log", level: "info", message: "heartbeat", heartbeat: true },
    ];
    for (const [index, update] of updates.entries()) {
      clock = index * 1000;
      live.renderer.receive(event(update, clock)); json.renderer.receive(event(update, clock));
    }
    clock += 10_000;
    live.renderer.tick();
    const text = stripVTControlCharacters(live.text());
    expect(text).toContain("1/3");
    expect(text).toContain("2/3");
    expect(text).toContain("第 6 轮");
    expect(text).toContain("继续原重构对话");
    expect(text).toContain("原版构建与测试观测复用");
    expect(text).toContain("未收到完成结果");
    const status = stripVTControlCharacters(live.chunks.at(-1)!);
    expect(status).toContain("无活动 11.0s");
    expect(status).not.toContain("当前: 读取文件");
    expect(json.text()).toBe("");
    live.renderer.interrupt("SIGINT"); json.renderer.stop();
    expect(stripVTControlCharacters(live.text())).toContain("收到 SIGINT");
  });

});
