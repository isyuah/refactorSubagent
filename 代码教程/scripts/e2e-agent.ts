/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/e2e-agent.ts —— 旧版 AI 全流程（小工程，带断言）
 *
 * 【这个文件是干什么的】
 *   与 demo-agents.ts 是同一件事的两个版本：
 *     demo-agents.ts   = 演示版（人读的多行输出，不设退出码）
 *     e2e-agent.ts     = 回归版（场景名 targeted-claude-agent，
 *                        输出**一个大 JSON**，结尾做硬断言）
 *   流程：把 examples/trim-app/base 拷进临时 git 仓库 →
 *   runAgentVerification()（旧路径 agent-pipeline.ts：Claude 分析 → 建 worktree →
 *   Claude 在 candidate 里受限重构 → 程序 commit/编译/跑用例/对比 → 状态机裁决）。
 *
 * 【跑什么 / 要不要 Claude / 多久 / 期望输出】
 *   命令：bun run e2e:agent
 *   要不要 Claude：要（分析 + 重构两个会话，均冷启动、无 wall-clock 上限）。
 *   还要 gcc（direct-compiler 构建）。耗时的几分钟。
 *   期望输出：一个 JSON，关键字段
 *     state: "ACCEPTED"（safe 提取 static 辅助函数这种改动应当被接受）
 *     scope_denials: []（没越界；不为空说明 hook 拦过模型的手）
 *     history: ["INIT -> CONTRACT_READY", …, "VERIFICATION_RUNNING -> ACCEPTED"]
 *   退出码：state !== "ACCEPTED" → 1。
 *
 * 【在整个项目里的位置】
 *   上游：package.json 的 "e2e:agent"。
 *   下游：src/runtime/agent-pipeline.ts（旧路径 —— 没有 Build/TestWorkflow 阶段，
 *         构建方式直接来自 EnvironmentSpec）。它对应的新路径是
 *         e2e-generated-workflow.ts → workflow-agent-pipeline.ts。
 *   🔗 这也是《零基础看懂教程.md》"读代码顺序"里提到的两条路径分叉点之一。
 *
 * 【先修知识】
 *   ① demo-agents.ts（同一条流水线的讲解版）；
 *   ② demo-e2e.ts（手写 artifact 版，能对照看出 AI 到底替你写了哪 5 个 artifact）；
 *   ③ 代码教程/src/runtime/agent-pipeline.ts。
 * 【本文件是教程注释版】
 *   原文件：scripts/e2e-agent.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import { cpSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";   // ← execFileSync：同步执行命令（不走 shell，参数用数组传）
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentVerification } from "../src/runtime/agent-pipeline.js";

const BASE = join(import.meta.dir, "..", "examples", "trim-app", "base");
const root = mkdtempSync(join(tmpdir(), "refactor-e2e-agent-"));
const repo = join(root, "repo");
cpSync(BASE, repo, { recursive: true });   // ← 递归拷贝示例工程到临时目录

git(repo, ["init", "-b", "main"]);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-m", "base"]);
// ↑ 三步搭出一个最小 git 仓库（必须：流水线要建 worktree、要取 HEAD 的 sha）

console.log(`scenario: targeted-claude-agent`);
console.log(`repo: ${repo}`);
const result = await runAgentVerification({
  repoPath: repo,
  task:
    "把 trim() 中的循环逻辑提取为 util.c 内的 static 辅助函数，消除重复；" +
    "严格保持 stdout、退出码和 trim() 的边界行为不变；如果无法证明安全则不要修改。",
  // ↑ 最后一句话是给模型的"安全阀"：证不出等价就别改 —— 与项目 fail-closed 哲学一致
  sessionRoot: root,
  sessionId: "targeted-agent",
});

console.log(JSON.stringify({
  scenario: "targeted-claude-agent",
  state: result.state,                    // ← 程序裁决，本脚本要求它必须是 ACCEPTED
  scope_denials: result.scopeDenials,     // ← PreToolUse hook 拦下的越界访问（正常为 []）
  session_dir: result.store.sessionDir,   // ← 证据所在地（state.json + artifacts/*.json）
  history: result.store.history.map((event) => `${event.from} -> ${event.to}`),
  // ↑【语法】map + 模板字符串：把迁移史变成 ["INIT -> CONTRACT_READY", …] 的字符串数组
}, null, 2));

if (result.state !== "ACCEPTED") process.exitCode = 1;
// ↑ 硬断言：AI 全流程在这个小工程上应当走到 ACCEPTED，否则本次 e2e 判失败

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  }).trim();
  // ↑ 注意：这里没注入 user.email/user.name —— 与 demo-e2e.ts 不同。
  //   如果这台机器没配过 git 身份，上面的 commit 会直接抛错（典型的环境差异点）。
}
