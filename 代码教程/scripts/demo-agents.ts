/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/demo-agents.ts —— 第 3 步演示：把 Claude 接进来
 *
 * 【这个文件是干什么的】
 *   项目演进三部曲的第 3 步，也是"第一个真正用到 AI 的脚本"：
 *   分析（analyzeRepo）和重构（runRefactor）都交给 Claude 做，程序只负责
 *   测环境、验 Schema、建 worktree、编译、跑用例、对比、裁决。
 *   场景仍是 examples/trim-app（项目里最小的 C 工程），
 *   任务用中文写在下面：把 trim() 的循环逻辑提取成 static 辅助函数。
 *
 * 【跑什么 / 要不要 Claude / 多久 / 期望输出】
 *   命令：bun run scripts/demo-agents.ts
 *   要不要 Claude：要 —— 本机必须装好并能登录 Claude Code CLI
 *   （driver.ts 依次找 CLAUDE_CODE_EXECUTABLE → 自带 claude.exe →
 *   %APPDATA%\npm\claude.cmd）。还需要 gcc（验证半场要用）。
 *   耗时：约几分钟（分析会话 + 重构会话各是冷启动，无 wall-clock 上限，
 *   🔗 见《零基础看懂教程.md》任务 6C/8）。
 *   期望输出：final state: ACCEPTED（或 REJECTED/ABORTED —— 程序说了算）、
 *   scope_denials（hook 拦下的越界访问清单，正常应为 []）、
 *   重构 Agent 自己写的 summary、以及完整的 state history。
 *
 * 【在整个项目里的位置】
 *   上游：手工运行。
 *   下游：src/runtime/agent-pipeline.ts 的 runAgentVerification（旧版 AI 路径，
 *         无 workflow 阶段）。它已经算"旧版"了：现在的主路径是
 *         src/runtime/workflow-agent-pipeline.ts（见 e2e-generated-workflow.ts）。
 *
 * 【先修知识】
 *   ① demo-e2e.ts（5 个 artifact 手写版长什么样，AI 产出的就是它们的 AI 版）；
 *   ② 代码教程/src/agents/driver.ts（runAgent：唯一调 SDK 的地方）；
 *   ③ ScopeManifest + PreToolUse hook（scope_denials 从哪来）。
 * 【本文件是教程注释版】
 *   原文件：scripts/demo-agents.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * E2E demo with REAL Claude calls: analyze → refactor → verify.
 * Requires a logged-in claude CLI on this machine.
 *
 *   bun run scripts/demo-agents.ts
 */
// ↑ 原文件自带的英文 doc 注释，一字未动：真实 Claude 调用的端到端演示，
//   流程是 分析 → 重构 → 验证；要求本机装好并登录 claude CLI。
import { cpSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentVerification } from "../src/runtime/agent-pipeline.js";

const BASE = join(import.meta.dir, "..", "examples", "trim-app", "base");

// ── 搭一个一次性的 git 仓库（和 demo-e2e 一样的准备工作）────────────
const root = mkdtempSync(join(tmpdir(), "refactor-agents-"));
const repo = join(root, "repo");
cpSync(BASE, repo, { recursive: true });
execSync("git init -b main", { cwd: repo, stdio: "pipe" });
execSync('git -c user.email=demo@local -c user.name=demo add -A', {
  cwd: repo, stdio: "pipe",
});
execSync(
  'git -c user.email=demo@local -c user.name=demo commit -m base',
  { cwd: repo, stdio: "pipe" },
);

console.log(`repo: ${repo}\nanalyzing + refactoring with Claude…\n`);

// ── runAgentVerification：完整的"AI 分析 → AI 重构 → 程序验证"一次跑完 ──
// 【参数】（AgentPipelineRequest，见 src/runtime/agent-pipeline.ts）
//   repoPath    ：项目根（必须已是 git 仓库，流水线要建 worktree）
//   task        ：自然语言任务，同时喂给分析 Agent 和重构 Agent
//   sessionRoot ：会话目录的根（下面会建 .refactor/sessions/<sessionId>/）
//   sessionId   ：会话 ID
// 【返回】{ store, state, refactorSummary, scopeDenials }
// 【关系】内部依次：probeHost → detectCProject → analyzeRepo（Claude，产出 5 个
//   artifact，schema 校验失败自动重试 1 次）→ createWorktrees → runRefactor
//   （Claude，只能改白名单文件，越界被 SDK 的 PreToolUse hook 当场拒绝）→
//   程序 git commit（AI 禁止碰 git）→ runVerification（编译/跑用例/对比/裁决）。
// 【失败会怎样】项目探测不过 → 直接 abort；构建/测试失败 → REJECTED/ABORTED。
const out = await runAgentVerification({
  repoPath: repo,
  task:
    "把 trim() 中的循环逻辑提取为 util.c 内的 static 辅助函数，消除重复。" +
    "严格保持外部可观察行为不变（stdout、退出码逐字节一致）。",
  sessionRoot: root,
  sessionId: "agent-demo-001",
});

console.log(`\n=== result ===`);
console.log(`final state: ${out.state}`);   // ← ACCEPTED / REJECTED / ABORTED，由程序裁决
console.log(`scope denials (hook-enforced): ${JSON.stringify(out.scopeDenials)}`);
// ↑ 原注释强调这些拒绝是 hook 强制的，不是提示词自觉。空数组 = 没发生越界。
console.log(`\nrefactor agent summary:\n${out.refactorSummary}`);
// ↑ 重构 Agent 最后留下的文字说明（模型写的，仅供参考，不作为证据）

for (const h of out.store.history) {
  console.log(`  ${h.from} → ${h.to}  [${h.artifact_kind ?? "abort"}]`);
}
// ↑ 最后再打印一遍完整状态迁移史 —— 这是判断"走到哪一步断的"的最快方式
