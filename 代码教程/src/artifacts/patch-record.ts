/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/patch-record.ts —— 候选 patch 记录（"Claude 到底改了什么"）
 *
 * 【这个文件是干什么的】
 *   Claude 在 candidate worktree 改完代码后，程序 git commit 并记录：
 *   提交在哪个分支、commit 哈希、改了哪些文件、以及一段改动总结。
 *   状态机在 BASELINE_READY → PATCH_CREATED 时收下它，并执行 R4 检查
 *   （changed_files 必须全部在 ScopeManifest 白名单内）。
 *
 * 【设计意图（文件头注释原文的翻译）】
 *   patch 以 commit 形式挂在候选分支上：接受 = 快进/合并这个分支；
 *   拒绝 = 丢弃 worktree。diff 本身在被 ACCEPTED 之前绝不会落到主分支上。
 *
 * 【已知缺口（写教程时补充）】
 *   只存 commit_sha + changed_files，不存 diff 本体，summary 只保留第一行
 *   （截 500 字符）——想逐行复查只能去分支上 git show。任务清单讨论过
 *   补一个"patch-diff 证据文件 + 结构化变更报告"。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/patch-record.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { RelPath } from "./common.js";

export const PatchRecord = z.object({
  kind: z.literal("patch-record"),
  version: z.literal(1),

  /** Candidate git worktree branch holding the refactoring commit(s). */
  branch: z.string().min(1),   // 候选分支名，如 "refactor/agent-<session-id>"
  /** HEAD sha of the candidate at submission time. */
  // regex(/^[0-9a-f]{7,40}$/)：git 哈希——7 到 40 位十六进制（短哈希到完整哈希都接受）。
  commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  base_commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/),   // 从哪个基线提交切出来的

  /** Files touched; orchestrator re-checks against ScopeManifest.editable_files. */
  // ↑ 改动的文件清单；状态机 R4 会再查一遍是否都在白名单内（不信任任何前序检查）。
  changed_files: z.array(RelPath).min(1),   // 至少改了一个文件（改都不改就不该走到这）

  summary: z.string().min(1),  // 改动总结（⚠️ 生产代码只写入第一行、截 500 字符）
});

export type PatchRecord = z.infer<typeof PatchRecord>;
