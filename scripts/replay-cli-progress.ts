/** Offline display demo: no model calls, builds, edits, or target repository required. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AgentProgress } from "../src/agents/progress.js";
import type { VerificationAnalysis } from "../src/agents/verification-analysis.js";
import { RunDisplay, formatRunReport } from "../src/cli/display.js";
import type { CliVerbosity } from "../src/cli/args.js";
import { DEFAULT_LIMITS } from "../src/config/limits.js";
import type { Logger } from "../src/runtime/log.js";
import { RunReportCollector, type RunReport, type ProgressUpdate } from "../src/runtime/progress.js";

let verbosity: CliVerbosity = "detailed";
let destination: string | undefined;
let color = true;
const args = Bun.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--verbosity" && (args[index + 1] === "detailed" || args[index + 1] === "summary")) verbosity = args[++index] as CliVerbosity;
  else if (arg === "--out" && args[index + 1] && !args[index + 1]!.startsWith("--")) destination = resolve(args[++index]!);
  else if (arg === "--no-color") color = false;
  else throw new Error("Usage: bun scripts/replay-cli-progress.ts [--verbosity detailed|summary] [--no-color] [--out <example directory>]");
}

const analysis: VerificationAnalysis = {
  subject: "金额解析与空输入边界（离线模拟）",
  recommendation: { strategy: "source-harness", rationale: "公开函数可以独立调用，直接观察返回值和错误文本。", alternatives: ["复用整套命令行测试"] },
  behaviors: ["合法金额", "空输入", "超出整数范围"],
  dependencies: [{ name: "C 标准库", kind: "compile", treatment: "real", rationale: "保留真实数字转换。" },
    { name: "通知服务", kind: "external", treatment: "test-double", rationale: "隔离网络并固定返回值。", seam: "notification_send()",
      simulate: ["发送成功", "服务不可用"], retainReal: "金额解析、边界检查和错误处理", lostCoverage: ["真实通知服务的网络集成"] }],
  evidence: [{ basis: "source", reference: "src/invoice.c:parse_amount", finding: "纯参数校验可从公开函数入口观察。" }],
  limitations: ["本示例只演示界面，所有消息与观测值均为模拟数据。"], openQuestions: [],
};

function replay(mode: CliVerbosity, capture = false): string {
  const chunks: string[] = [];
  const output = capture ? { isTTY: true, write: (text: string) => chunks.push(text) } : process.stderr;
  let elapsed = 0;
  let phase = "INIT";
  let collector = new RunReportCollector();
  const display = new RunDisplay({ format: "human", verbosity: mode, progress: "plain", color, output,
    now: () => elapsed, ...(capture ? { env: {} } : {}) });
  const emit = (update: ProgressUpdate, at = elapsed): void => {
    elapsed = at;
    if (update.type === "phase") phase = update.name;
    const event = { ...update, elapsed_ms: elapsed, phase, time: "2026-11-09T00:00:00.000Z" };
    collector.accept(event);
    display.receive(event);
  };
  const logger: Logger = { level: "info", trace() {}, debug() {}, info() {}, warn() {}, error() {}, progress: emit };
  const task = "[离线回放] 提取金额校验，保持行为不变";
  const logDir = "example-evidence/display-replay";
  display.start({ repo: "example/invoice-demo", task, session: "offline-display-replay", log_dir: logDir,
    pipeline: "离线模拟消息；不执行模型、构建或测试", pipeline_sources: [], limits: DEFAULT_LIMITS, limit_sources: [], auto_retry: 3 });
  try {
    emit({ type: "feedback", feedback: { action: "start", owner_session: "offline-display-replay", resumed_from: null,
      budget_total: 3, budget_used: 0, state_dir: "example-evidence/feedback/offline-display-replay" } });
    emit({ type: "feedback", feedback: { action: "round-start", round: 1, session: "offline-display-replay", repair: null } });
    emit({ type: "phase", name: "PREFLIGHT" });
    emit({ type: "stage", name: "preflight", action: "start" });
    emit({ type: "stage", name: "preflight", action: "end" }, 100);
    emit({ type: "phase", name: "WORKFLOW_SESSION" }, 120);
    emit({ type: "stage", name: "workflows", action: "start" });
    const agent = new AgentProgress(logger, "test-writer", "离线模拟");
    const assistant = (id: string, content: unknown[], parent?: string): void => agent.accept({ type: "assistant", parent_tool_use_id: parent, message: { id, content } });
    const tool = (id: string, name: string, input: Record<string, unknown>, parent?: string): void => assistant(id, [{ type: "tool_use", id, name, input }], parent);
    const result = (id: string, parent?: string): void => agent.accept({ type: "user", parent_tool_use_id: parent,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "模拟结果" }] } });
    elapsed = 200;
    assistant("intro", [{ type: "text", text: "先检查金额解析的公开入口，再编写独立辅助程序覆盖空输入和越界金额。" }]);
    elapsed = 250; tool("read-source", "Read", { file_path: "src/invoice.c" });
    elapsed = 260; tool("read-header", "Read", { file_path: "include/invoice.h" });
    display.tick();
    elapsed = 280; result("read-source");
    elapsed = 290; result("read-header");
    elapsed = 400; tool("write-helper", "Write", { file_path: "verification/amount_harness.c", content: "不向界面展示的模拟代码" });
    elapsed = 408; result("write-helper");
    elapsed = 500; tool("build-task", "Task", { subagent_type: "build-writer", description: "为辅助程序编写构建方案" });
    agent.accept({ type: "system", subtype: "task_started", tool_use_id: "build-task", subagent_type: "build-writer" });
    elapsed = 600;
    assistant("build-text", [{ type: "text", text: "提交构建脚本和固定辅助代码，实际编译由后续验证阶段执行。" }], "build-task");
    elapsed = 700; tool("save-build", "mcp__dep-registry__generateBuildWorkflow", { name: "amount-harness", content: "模拟脚本，不会执行" }, "build-task");
    elapsed = 718; result("save-build", "build-task");
    elapsed = 750; tool("submit-plan", "mcp__dep-registry__submitVerificationAnalysis", analysis);
    emit({ type: "strategy", report: analysis, path: `${logDir}/artifacts/verification-analysis.json` });
    elapsed = 755; result("submit-plan");
    elapsed = 800; tool("declare", "mcp__dep-registry__declareDependency", { buildWorkflowIds: ["invoice-cli", "amount-harness"] });
    elapsed = 805; result("declare");
    elapsed = 900; result("build-task");
    agent.accept({ type: "result", session_id: "offline-sdk-replay", num_turns: 3, usage: { input_tokens: 120, output_tokens: 60 } });
    emit({ type: "stage", name: "workflows", action: "end" }, 1000);
    emit({ type: "phase", name: "PREPARE" }, 1100);
    emit({ type: "stage", name: "prepare", action: "start" });
    const base = "1".repeat(40), candidate = "2".repeat(40);
    emit({ type: "workspace", branch: "refactor/offline-demo", base_sha: base, baseline_dir: "example-worktrees/baseline", candidate_dir: "example-worktrees/candidate" });
    emit({ type: "stage", name: "prepare", action: "end" }, 1200);
    emit({ type: "phase", name: "REFACTOR" }, 1300);
    emit({ type: "stage", name: "refactor", action: "start" });
    emit({ type: "candidate", candidate: { branch: "refactor/offline-demo", base_sha: base, commit_sha: candidate, changed_files: ["src/invoice.c"] } });
    emit({ type: "stage", name: "refactor", action: "end" }, 2000);
    emit({ type: "phase", name: "VERIFICATION" }, 2100);
    emit({ type: "stage", name: "verify", action: "start" });
    for (const side of ["baseline", "candidate"] as const) {
      emit({ type: "phase", name: side === "baseline" ? "BASELINE_BUILD" : "CANDIDATE_BUILD" });
      for (const id of ["invoice-cli", "amount-harness"]) {
        const context = { side, build_id: id, log_path: `${logDir}/logs/${side}-${id}.log` };
        emit({ type: "build", side, id, status: "running" });
        emit({ type: "command-start", id, program: "cmake", args: ["--build", "build", "--target", id], cwd: `example-worktrees/${side}`, context });
        emit({ type: "command-output", id, stream: "stdout", text: "[1/2] Building C object\n[2/2] Linking executable\n", context });
        emit({ type: "command-end", id, status: "exited", exit_code: 0, duration_ms: 100, error: null, context }, elapsed + 100);
        emit({ type: "build", side, id, status: "pass", duration_ms: 100 });
      }
      emit({ type: "phase", name: side === "baseline" ? "BASELINE_TEST_WORKFLOW" : "CANDIDATE_TEST_WORKFLOW" });
      emit({ type: "test", side, status: "pass", checks: 3, duration_ms: 50 }, elapsed + 50);
    }
    emit({ type: "phase", name: "COMPARISON" });
    emit({ type: "comparison", comparison: { overall: "inconsistent", total: 3, matched: 2, mismatched: 1,
      checks: [{ name: "合法金额", matched: true, reason: "返回值一致" }, { name: "越界金额", matched: true, reason: "错误处理一致" },
        { name: "空输入", matched: false, reason: "候选版把空输入当作金额 0", baseline: "错误: 金额不能为空", candidate: "0" }],
      errors: [], reason: "3 个检查项中有 1 项行为发生变化。", evidence_paths: ["comparison.json"] } }, elapsed + 10);
    emit({ type: "stage", name: "verify", action: "end" });
    emit({ type: "phase", name: "CLEANUP" });
    emit({ type: "stage", name: "cleanup", action: "start" });
    emit({ type: "stage", name: "cleanup", action: "end" }, elapsed + 20);
    const firstReport = collector.finish({ session: "offline-display-replay", repo: "example/invoice-demo", task, state: "REJECTED",
      abort_reason: null, failure: null, resume: null, decision_reason: "空输入处理发生变化。", finalization_error: null, elapsed_ms: elapsed,
      limits: DEFAULT_LIMITS, limit_sources: [], limit_overrides: [], configuration: null,
      refactor_summary: "提取金额校验函数；模拟结果发现空输入行为改变，因此拒绝本次改动。", log_dir: logDir, report_path: `${logDir}/artifacts/run-summary.json` }, ["invoice-cli", "amount-harness"]);
    emit({ type: "feedback", feedback: { action: "round-end", round: 1, session: "offline-display-replay", state: "REJECTED",
      reason: "空输入处理发生变化。", log_dir: logDir } });
    emit({ type: "feedback", feedback: { action: "repair-start", round: 2, session: "offline-display-replay-fb2", lane: "refactor",
      evidence: { summary: "候选版把空输入当作金额 0", side: "candidate", mismatches: [{ name: "空输入", reason: "应当返回输入错误" }] },
      budget_total: 3, budget_used: 1, dialogue_id: "original-refactor-conversation", reuse_baseline: true } }, elapsed + 100);
    const secondStart = elapsed;
    collector = new RunReportCollector();
    emit({ type: "feedback", feedback: { action: "round-start", round: 2, session: "offline-display-replay-fb2", repair: "refactor" } });
    emit({ type: "phase", name: "WORKFLOW_SESSION" });
    emit({ type: "strategy", report: analysis, path: "example-evidence/verification-analysis.json" });
    emit({ type: "workspace", branch: "refactor/offline-demo", base_sha: base, baseline_dir: "example-worktrees/baseline", candidate_dir: "example-worktrees/candidate" });
    emit({ type: "phase", name: "REFACTOR" });
    emit({ type: "stage", name: "refactor", action: "start" });
    const repairAgent = new AgentProgress(logger, "refactor", "离线模拟");
    repairAgent.accept({ type: "assistant", message: { id: "repair-reply", content: [{ type: "text", text: "收到空输入的失配证据。我会恢复原来的错误分支，保留其他重构。" }] } });
    repairAgent.accept({ type: "result", session_id: "original-refactor-conversation", result: "空输入行为已修复。", num_turns: 1 });
    emit({ type: "candidate", candidate: { branch: "refactor/offline-demo", base_sha: base, commit_sha: "3".repeat(40), changed_files: ["src/invoice.c"] } });
    emit({ type: "stage", name: "refactor", action: "end" }, elapsed + 900);
    emit({ type: "phase", name: "VERIFICATION" });
    emit({ type: "stage", name: "verify", action: "start" });
    for (const id of ["invoice-cli", "amount-harness"]) emit({ type: "build", side: "baseline", id, status: "reused", duration_ms: 0 });
    emit({ type: "test", side: "baseline", status: "reused", checks: 3, duration_ms: 0 });
    emit({ type: "phase", name: "CANDIDATE_BUILD" });
    for (const id of ["invoice-cli", "amount-harness"]) {
      emit({ type: "build", side: "candidate", id, status: "running" });
      emit({ type: "build", side: "candidate", id, status: "pass", duration_ms: 100 }, elapsed + 100);
    }
    emit({ type: "phase", name: "CANDIDATE_TEST_WORKFLOW" });
    emit({ type: "test", side: "candidate", status: "pass", checks: 3, duration_ms: 50 }, elapsed + 50);
    emit({ type: "phase", name: "COMPARISON" });
    emit({ type: "comparison", comparison: { overall: "consistent", total: 3, matched: 3, mismatched: 0,
      checks: ["合法金额", "越界金额", "空输入"].map((name) => ({ name, matched: true, reason: "一致" })),
      errors: [], reason: "3 个检查项行为一致。", evidence_paths: ["comparison.json"] } });
    emit({ type: "stage", name: "verify", action: "end" });
    emit({ type: "phase", name: "CLEANUP" });
    emit({ type: "feedback", feedback: { action: "round-end", round: 2, session: "offline-display-replay-fb2", state: "ACCEPTED",
      reason: null, log_dir: `${logDir}-fb2` } });
    emit({ type: "feedback", feedback: { action: "stop", reason: "accepted", detail: null, budget_total: 3, budget_used: 1 } });
    const lastReport = collector.finish({ session: "offline-display-replay-fb2", repo: "example/invoice-demo", task, state: "ACCEPTED",
      abort_reason: null, failure: null, resume: null, decision_reason: "空输入行为已恢复，所有检查项一致。", finalization_error: null,
      elapsed_ms: elapsed - secondStart, limits: DEFAULT_LIMITS, limit_sources: [], limit_overrides: [], configuration: null,
      refactor_summary: "提取金额校验函数；根据反馈恢复空输入的错误处理，重新验证通过。",
      log_dir: `${logDir}-fb2`, report_path: `${logDir}-fb2/artifacts/round-summary.json` }, ["invoice-cli", "amount-harness"]);
    const report: RunReport = { ...lastReport, session: "offline-display-replay", elapsed_ms: elapsed,
      report_path: `${logDir}/artifacts/run-summary.json`, feedback: {
        owner_session: "offline-display-replay", resumed_from: null, budget_total: 3, budget_used_before: 0, budget_used: 1,
        stopped_because: "accepted", stop_detail: null, state_dir: "example-evidence/feedback/offline-display-replay",
        dialogue_dir: `${logDir}/sessions`, build_repairs: [],
        rounds: [firstReport, lastReport].map((round, index) => ({ round: index + 1, session: round.session,
          repair: index === 0 ? null : "refactor", state: round.state, reason: round.decision_reason,
          elapsed_ms: round.elapsed_ms, stage_timings: round.stage_timings, log_dir: round.log_dir,
          report_path: `${round.log_dir}/artifacts/round-summary.json` })),
      } };
    display.stop();
    const formatted = `${formatRunReport(report, mode, { color, output: capture ? { isTTY: true } : process.stdout, ...(capture ? { env: {} } : {}) })}\n`;
    if (capture) chunks.push(formatted);
    else process.stdout.write(formatted);
    return chunks.join("");
  } finally { display.stop(); }
}

if (destination) {
  mkdirSync(destination, { recursive: true });
  const examples = (["detailed", "summary"] as const).map((mode) => {
    const ansi = replay(mode, true);
    writeFileSync(join(destination, `${mode}.ansi`), ansi);
    writeFileSync(join(destination, `${mode}.txt`), stripVTControlCharacters(ansi));
    return `<details ${mode === "detailed" ? "open" : ""}><summary>${mode === "detailed" ? "详细模式" : "摘要模式"}</summary><pre>${ansiHtml(ansi)}</pre></details>`;
  });
  writeFileSync(join(destination, "preview.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CLI 彩色离线回放</title><style>
body{background:#15191f;color:#e6e9ef;margin:24px;font:15px/1.65 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 Consolas,monospace;padding:20px;background:#1c222b}summary{cursor:pointer;font-weight:bold}
.c1-34{color:#77aaff;font-weight:bold}.c34{color:#77aaff}.c35{color:#d49cf6}.c36{color:#77d5df}.c32{color:#92d9a1}.c33{color:#f3d18b}.c31{color:#ff9898}.c2{opacity:.7}
@media(prefers-color-scheme:light){body{background:#fff;color:#20252d}pre{background:#f4f6f8}.c1-34,.c34{color:#245cb5}.c35{color:#883ca0}.c36{color:#076b78}.c32{color:#287238}.c33{color:#8a6000}.c31{color:#b02424}}
</style><h1>CLI 彩色离线回放</h1><p>以下均为模拟 SDK 消息与观测值；没有调用模型或执行构建、测试。</p>${examples.join("\n")}</html>`);
  console.log(`离线示例已保存: ${destination}`);
} else replay(verbosity);

function ansiHtml(ansi: string): string {
  const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  let html = "", offset = 0, open = false;
  for (const match of ansi.matchAll(/\u001b\[([0-9;]+)m/g)) {
    html += escape(ansi.slice(offset, match.index));
    if (open) html += "</span>";
    open = match[1] !== "0";
    if (open) html += `<span class="c${match[1]!.replaceAll(";", "-")}">`;
    offset = match.index! + match[0].length;
  }
  return html + escape(ansi.slice(offset)) + (open ? "</span>" : "");
}
