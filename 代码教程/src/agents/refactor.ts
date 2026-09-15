/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/agents/refactor.ts —— 重构会话（Claude 动手改代码的地方）
 *
 * 【这个文件是干什么的】
 *   在 candidate worktree 里开一个 Claude 会话执行受限重构：
 *   工具只给 Read/Write/Edit/Glob/Grep（没有 Bash、没有 git）；能写哪些文件
 *   由 ScopeManifest 的 editable 白名单决定，越界调用被 driver.ts 的
 *   PreToolUse hook 当场拒绝并记入 denials——安全不靠提示词自觉。
 *
 * 【B 方案改版后的变化】
 *   +sessionHooks 参数：可传入 logger（B 方案新 pino 日志）和 sessionStore，
 *   会话过程可观测/可恢复。提示词部分未变：REFACTOR_SYSTEM 仍只有
 *   Allowed/Forbidden 两句——没有重构技巧内容（见《C重构技巧优化-研究与结论.md》，
 *   这是任务 3 要补的空白）。
 *
 * 【在整个项目里的位置】
 *   上游：workflow-agent-pipeline.ts（REFACTOR 阶段）与 agent-pipeline.ts（旧路径）；
 *   下游：返回 summary + denials → 程序 git commit → patch-record。
 *
 * 【本文件是教程注释版】原文件 src/agents/refactor.ts（B 方案后），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { join } from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { ScopeManifest } from "../artifacts/index.js";
import type { Logger } from "../runtime/log.js";
import { DEFAULT_AGENT_FORBIDDEN_GLOBS, runAgent } from "./driver.js";
import { REFACTOR_SYSTEM, refactorPrompt } from "./prompts.js";

/**
 * Refactor Agent — edits the candidate worktree under the validated
 * Modification and Observation Scopes. The program, not the prompt, enforces
 * both scopes before every SDK tool call.
 */
export async function runRefactor(
  worktreeDir: string,
  task: string,
  scope: ScopeManifest,
  sessionHooks?: { readonly logger?: Logger; readonly sessionStore?: SessionStore },
): Promise<{ summary: string; denials: string[] }> {
  const editableFiles = scope.editable_files.map((target) => target.file);
  const absoluteEditableFiles = editableFiles.map((file) => join(worktreeDir, file));   // 白名单换成 worktree 绝对路径
  const run = await runAgent({
    cwd: worktreeDir,
    prompt: refactorPrompt(task, absoluteEditableFiles),
    systemPrompt: REFACTOR_SYSTEM,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],   // 无 Bash/git：改代码不需要，也更安全
    readableGlobs: [...scope.readable_globs],
    forbiddenGlobs: [...new Set([...DEFAULT_AGENT_FORBIDDEN_GLOBS, ...scope.forbidden_globs])],   // 默认禁区 ∪ 会话声明的禁区
    editableFiles,
    maxTurns: 80,   // ★ B 方案：上限翻倍（40→80）——重构会话需要更多轮次完成更大范围改动
    logger: sessionHooks?.logger,           // ★ B 方案新增：过程留痕（pino）
    sessionStore: sessionHooks?.sessionStore, // ★ B 方案新增：会话可恢复
  });

  if (run.isError && run.result.length === 0) {
    throw new Error("refactor agent failed without a summary");
  }
  return { summary: run.result, denials: run.denials };   // denials 是"hook 拦下的越界记录"，随 refactor-summary 一起入库
}
