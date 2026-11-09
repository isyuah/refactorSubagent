import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunDisplay, formatRunReport } from "../src/cli/display.js";
import { parseCliArgs } from "../src/cli/args.js";
import { DEFAULT_LIMITS } from "../src/config/limits.js";
import { E2ELogger } from "../src/runtime/log.js";
import { RunReportCollector, type ProgressUpdate, type RunProgressEvent } from "../src/runtime/progress.js";
import { ctestProgressSummary } from "../src/runtime/workflow-progress.js";
import type { CTestComparisonResult } from "../src/artifacts/index.js";

const input = { session: "offline", repo: "repo", task: "task", state: "ABORTED", abort_reason: "fixture stopped", decision_reason: "fixture stopped", finalization_error: null,
  elapsed_ms: 1000, limits: DEFAULT_LIMITS, limit_sources: [], limit_overrides: [], configuration: null,
  refactor_summary: "", log_dir: "evidence", report_path: "evidence/artifacts/run-summary.json" };
function event(update: ProgressUpdate, elapsed_ms = 0): RunProgressEvent {
  return { ...update, elapsed_ms, time: "2026-11-04T00:00:00.000Z", phase: "INIT" };
}
function display(options: Partial<ConstructorParameters<typeof RunDisplay>[0]> = {}) {
  const chunks: string[] = [];
  const output = { write: (text: string) => chunks.push(text), isTTY: false, columns: 120 };
  const renderer = new RunDisplay({ format: "human", verbosity: "detailed", progress: "plain", color: false, output, ...options });
  return { renderer, chunks, text: () => chunks.join("") };
}

describe("CLI progress and report contracts", () => {
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
    expect(tty.join("")).not.toContain("\u001b[36m");
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
});
