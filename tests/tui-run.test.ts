import { describe, expect, test } from "bun:test";
import { RunScreen } from "../src/cli/tui/run.js";
import { RunReportCollector, type ProgressUpdate, type RunProgressEvent } from "../src/runtime/progress.js";
import { DEFAULT_LIMITS } from "../src/config/limits.js";
import { terminal } from "./tui-helpers.js";

const startup = { session: "offline", repo: "repo", task: "保护中文返回值", log_dir: "evidence", pipeline: "offline", pipeline_sources: [], limits: DEFAULT_LIMITS, limit_sources: [] };
const event = (update: ProgressUpdate, elapsed_ms = 0): RunProgressEvent => ({ ...update, elapsed_ms, time: "2026-11-17T00:00:00Z", phase: "INIT" });
function report(state: string) {
  return new RunReportCollector().finish({ session: "offline", repo: "repo", task: "保护中文返回值", state,
    abort_reason: state === "ABORTED" ? "缺少必需产物" : null, decision_reason: state === "REJECTED" ? "返回值不一致" : "已完成比较",
    failure: null, resume: null, finalization_error: null, elapsed_ms: 2345, limits: DEFAULT_LIMITS, limit_sources: [], limit_overrides: [], configuration: null,
    refactor_summary: "提取校验函数。", log_dir: "evidence", report_path: "evidence/artifacts/run-summary.json" }, ["first", "second"]);
}

describe("OpenTUI full run presentation", () => {
  test.each(["ACCEPTED", "REJECTED", "ABORTED"])("%s uses the final report, all builds and unexecuted steps", async state => {
    const t = await terminal(120, 38); const screen = new RunScreen(t.ui, "detailed"); screen.start(startup);
    try {
      screen.receive(event({ type: "stage", name: "verify", action: "start" }, 10));
      screen.receive(event({ type: "build", side: "baseline", id: "first", status: "running" }));
      const final = report(state); const finished = screen.finish(final); await t.frame();
      expect(await t.frame()).toContain(state);
      const builds = screen.sections().find(section => section.id === "execution")!.items();
      expect(builds.filter(item => item.label.includes("构建"))).toHaveLength(4);
      expect(builds.every(item => item.description!.includes("未执行"))).toBeTrue();
      const stages = screen.sections()[0]!.items();
      expect((await stages.find(item => item.id === "stage/1/verify")!.detail()).paragraphs.map(p => p.text).join("\n")).toContain("未执行");
      if (state === "ABORTED") expect(await t.frame()).toContain("缺少必需产物");
      await t.activate("action:exit"); await finished;
    } finally { screen.stop(); await t.close(); }
  });
  test("rounds preserve repeated build IDs and mismatch values while tools merge and AI replies remain separate", async () => {
    const t = await terminal(120, 38); const screen = new RunScreen(t.ui, "detailed"); screen.start(startup);
    try {
      for (const update of [
        { type: "agent-text", agent_id: "root", role: "test-writer", text: "第一段" },
        { type: "agent-text", agent_id: "root", role: "test-writer", text: "第二段" },
        { type: "agent-tool", agent_id: "root", role: "test-writer", id: "write", name: "Write", target: "verification/辅助.c", action: "start" },
        { type: "agent-tool", agent_id: "root", role: "test-writer", id: "write", name: "Write", target: "verification/辅助.c", action: "end" },
        { type: "build", side: "candidate", id: "same", status: "failed", failure: "编译错误" },
        { type: "comparison", comparison: { overall: "REJECTED", total: 1, matched: 0, mismatched: 1, reason: "不同", errors: [], evidence_paths: ["evidence/values.json"], checks: [{ name: "复制长度", matched: false, reason: "长度错误", baseline: 5, candidate: 6 }] } },
        { type: "feedback", feedback: { action: "round-start", round: 2, session: "second", repair: "refactor" } },
        { type: "build", side: "candidate", id: "same", status: "pass" },
      ] satisfies ProgressUpdate[]) screen.receive(event(update));
      const sections = screen.sections();
      const builds = sections.find(section => section.id === "execution")!.items(); expect(builds).toHaveLength(2);
      expect(builds.map(item => item.description)).toEqual(["第 1 轮 · 失败", "第 2 轮 · 成功"]);
      const agent = await sections.find(section => section.id === "agents")!.items()[0]!.detail();
      const text = agent.paragraphs.map(p => p.text).join("\n"); expect(text).toContain("第一段\n\n第二段"); expect(text.match(/写入文件/g)).toHaveLength(1);
      const check = await sections.find(section => section.id === "comparison")!.items()[1]!.detail();
      expect(check.paragraphs.map(p => p.text)).toContain("原版\n5"); expect(check.paragraphs.map(p => p.text)).toContain("候选版\n6");
    } finally { screen.stop(); await t.close(); }
  });
  test("repair activity belongs to its attempted round and a failed repair never creates fictitious builds", async () => {
    const t = await terminal(120, 38); const screen = new RunScreen(t.ui, "detailed"); screen.start(startup);
    try {
      screen.receive(event({ type: "feedback", feedback: { action: "repair-start", round: 2, session: "repair-second", lane: "build", evidence: { summary: "原版构建脚本缺少参数" }, budget_total: 3, budget_used: 1, dialogue_id: null, reuse_baseline: false } }));
      screen.receive(event({ type: "command-start", id: "repair", program: "cc", args: [], cwd: "repo" }));
      let sections = screen.sections();
      expect(sections.find(section => section.id === "execution")!.items()[0]!.description).toContain("第 2 轮");
      const details = (await sections.find(section => section.id === "feedback")!.items()[1]!.detail()).paragraphs.map(p => p.text).join("\n");
      expect(details).toContain("原版构建脚本缺少参数"); expect(details).toContain("重新验证两侧");
      const final = report("ABORTED");
      const completed = screen.finish({ ...final, feedback: { owner_session: "offline", resumed_from: null, budget_total: 3, budget_used_before: 0, budget_used: 1, stopped_because: "repair-failed", stop_detail: "未交付", state_dir: "state", dialogue_dir: "dialogue",
        rounds: [{ round: 1, session: "offline", repair: null, state: "ABORTED", reason: "缺少参数", elapsed_ms: 200, stage_timings: final.stage_timings, log_dir: "evidence", report_path: "evidence/round-summary.json" }], build_repairs: [{ round: 2, delivered: false, elapsed_ms: 100, log_dir: "repair-evidence" }] } });
      await t.frame(); sections = screen.sections();
      const builds = sections.find(section => section.id === "execution")!.items().filter(item => item.label.includes("构建"));
      expect(builds).toHaveLength(4); expect(builds.every(item => item.description!.includes("第 1 轮"))).toBeTrue();
      await t.activate("action:exit"); await completed;
    } finally { screen.stop(); await t.close(); }
  });
  test("summary retains failed command output, hides successful output, and surfaces finalization errors", async () => {
    const t = await terminal(120, 38); const screen = new RunScreen(t.ui, "summary"); screen.start(startup);
    try {
      const context = { side: "baseline" as const, build_id: "first", log_path: "evidence/first.log" };
      for (const id of ["success", "failure"]) {
        screen.receive(event({ type: "command-start", id, program: "cc", args: ["辅助.c"], cwd: "repo", context }));
        screen.receive(event({ type: "command-output", id, stream: "stderr", text: "undefined reference to dep\n", context }));
        screen.receive(event({ type: "command-end", id, status: "exited", exit_code: id === "success" ? 0 : 1, duration_ms: 200, error: null, context }));
      }
      const executions = screen.sections().find(section => section.id === "execution")!.items();
      expect((await executions[0]!.detail()).paragraphs.map(p => p.text).join("\n")).not.toContain("undefined reference");
      const failure = (await executions[1]!.detail()).paragraphs.map(p => p.text).join("\n"); expect(failure).toContain("undefined reference"); expect(failure).toContain("失败"); expect(failure).toContain("退出码：1"); expect(failure).toContain("evidence/first.log");
      const final = { ...report("ACCEPTED"), finalization_error: "无法写入结果文件" }; const finished = screen.finish(final); await t.frame();
      expect(await t.frame()).toContain("无法写入结果文件"); await t.activate("action:exit"); await finished;
    } finally { screen.stop(); await t.close(); }
  });
});
