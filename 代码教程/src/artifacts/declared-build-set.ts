/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/declared-build-set.ts —— B 方案的"声明集凭证"
 *
 * 【这个文件是干什么的】
 *   test-writer 主会话用 declareDependency 声明了 N 个 build 依赖之后，
 *   宿主解析出的整体决策就记录在这份 artifact 里（方案甲：单凭证承载整个
 *   声明集，而不是每个 build 一份 resolution）。
 *
 * 【它在 B 方案时序里的位置】
 *   WORKFLOW_SESSION（test-writer 会话）产出声明 → 宿主 resolve 出本凭证
 *   → 提交状态机（TESTS_READY --declared-build-set--> BUILD_WORKFLOW_READY，
 *   orchestrator 里为它开了快速通道）→ 宿主逐个执行 builds 里的每项
 *   （baseline/candidate 各一次）→ 任一失败 abort，空集跳过。
 *
 * 【与旧版的对比】
 *   旧版每个 build/test 各一份 WorkflowResolution，test 里写死引用的
 *   build_workflow id；声明制下 test 源码自己知道产物路径（从 build-writer
 *   汇报学来 + 自己 assertFile），宿主零产物知识。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/declared-build-set.ts，
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { RelPath, Sha256Hex } from "./common.js";

/**
 * DeclaredBuildSet — the declaration-set resolution artifact for the
 * subagent-driven flow (方案甲：单凭证承载整个声明集).
 *
 * The test-writer session declared N build workflow dependencies via
 * declareDependency. This artifact records that single resolution decision:
 * every declared build's identity, source entry, source hash and whether it is
 * run-local (generated this run) or library-persisted. The host executes every
 * entry (baseline + candidate) before running the test workflow.
 */

// 声明集里的一项 = 一个被声明的 build workflow：
export const DeclaredBuildSetEntry = z.object({
  /** Declared build workflow id (run-local or library). */
  id: z.string().min(1),        // 声明时的 id（本次生成的是 run-local 临时 id，库里的才是稳定 id）
  /** Repo-relative workflow source entry. */
  entry: RelPath,               // 源码入口（仓库相对路径；run-local 的在 runs/{session}/ 下）
  source_hash: Sha256Hex,       // 源码 sha256（审计 + 防篡改）
  /** True when generated this run (run-local); false = persisted library. */
  run_local: z.boolean(),       // ★ 区分"本次刚生成的"与"库里已有的"——curator 据此决定谁能入库
});
export type DeclaredBuildSetEntry = z.infer<typeof DeclaredBuildSetEntry>;

export const DeclaredBuildSet = z.object({
  kind: z.literal("declared-build-set"),
  version: z.literal(1),
  /** Session/test workflow identity this set serves. */
  // ↑ 这份声明集是为哪个 test workflow 服务的（身份绑定，防"张冠李戴"）
  test_workflow_id: z.string().min(1),
  test_workflow_revision: z.number().int().positive(),
  builds: z.array(DeclaredBuildSetEntry),
  /** Stable hash of the ordered declaration (id+revision+entry) for audit. */
  // ↑ 整份声明（按顺序）的稳定哈希——声明顺序也是审计对象
  source_hash: Sha256Hex,
});
export type DeclaredBuildSet = z.infer<typeof DeclaredBuildSet>;
