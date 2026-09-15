/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/expectation-suite.ts —— 自驱动 TestWorkflow 的期望证据
 *
 * 【先搞懂"自驱动 TestWorkflow"（本项目最新机制）】
 *   一段测试代码，宿主在 baseline worktree 跑一遍、在 candidate worktree 再跑一遍。
 *   函数不知道自己在哪一侧，只管跑测试并调用 ctx.expect("名字", 观测值) 声明。
 *   宿主把两侧声明【按位置配对】，用声明的关系语义（equal / not-equal / …）判定。
 *
 * 【这个文件定义的三个 artifact】
 *   ExpectationBaseline   基线侧跑完记下的声明（证据）
 *   ExpectationCandidate  候选侧跑完记下的声明（证据）
 *   ExpectationComparisonResult 宿主配对比较后的判决
 *   ——和 CTest 那套（ctest-suite.ts）一一对应，只是"考卷"由 workflow 自己出。
 *
 * 【⚠️ 已知缺口（任务清单 #6A 的素材）】
 *   对比结果 declarations 里只存 {name, relation, matched, reason}，
 *   把两侧的观测值丢了——而比较函数 expectation-compare.ts 内部明明有
 *   baselineValue/candidateValue。想看"到底差多少"只能去翻两侧证据文件。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/expectation-suite.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";

/**
 * Self-driven TestWorkflow execution artifacts.
 *
 * A self-driven test workflow runs once per worktree and declares
 * expectations via ctx.expect. The host records the declarations observed on
 * each side, then compares them by position using the declared relations.
 * These artifacts carry the baseline evidence, candidate evidence, and the
 * program-owned comparison — mirroring the CTest suite artifacts for the
 * declarative runner.
 */

/** One expectation declaration observed on a side. */
// 一条期望声明 = workflow 在某一侧 ctx.expect 的一次调用：
export const ExpectationObserved = z.object({
  name: z.string().min(1),          // 期望名（两侧必须同名，配对时校验）
  relation: z.enum([
    "equal",            // 两侧相等（默认）
    "not-equal",        // 两侧必须不同
    "baseline-greater", // 基线值 > 候选值
    "baseline-less",    // 基线值 < 候选值
    "both-matches",     // 两侧都要匹配一个正则
  ]),
  /** Value observed on this side (JSON-serializable). */
  value: z.unknown(),   // ⚠️ z.unknown：任意值都放行（观测值类型五花八门），结构上不设限
  /** Regex source for both-matches relations. */
  pattern: z.string().optional(),  // only-matches 关系用的正则源码
});

/** Baseline evidence: the workflow passed and declared these expectations. */
// ⚠️ workflow_passed: z.literal(true) —— 字面量 true！等于 Schema 层面规定：
//   "workflow 没跑成功根本不配存进来"（fail-closed 从存储层就开始）。
export const ExpectationBaseline = z.object({
  kind: z.literal("expectation-baseline"),
  version: z.literal(1),
  workflow_passed: z.literal(true),
  expectations: z.array(ExpectationObserved).default([]),
  notes: z.array(z.string().min(1)).default([]),
});

/** Candidate evidence: same shape as baseline. */
export const ExpectationCandidate = z.object({
  kind: z.literal("expectation-candidate"),
  version: z.literal(1),
  workflow_passed: z.literal(true),
  expectations: z.array(ExpectationObserved).default([]),
  notes: z.array(z.string().min(1)).default([]),
});

/** Program-owned comparison of the two sides' expectations. */
export const ExpectationComparisonResult = z.object({
  kind: z.literal("expectation-comparison-result"),
  version: z.literal(1),
  overall: z.enum(["consistent", "inconsistent"]),   // 状态机 R6 据此裁决
  /** Per-declaration verdicts, in declaration order. */
  declarations: z.array(
    z.object({
      name: z.string().min(1),
      relation: z.enum([
        "equal",
        "not-equal",
        "baseline-greater",
        "baseline-less",
        "both-matches",
      ]),
      matched: z.boolean(),          // 这条关系成立吗
      reason: z.string().default(""),// 不成立时的一句原因
      // ⚠️ 注意：这里没有 baselineValue/candidateValue 字段——观测值在序列化时丢了
      //   （比较函数里有，任务 #6A 要补）。
    }),
  ).default([]),
  /** Structural errors (count mismatch, name mismatch, …). */
  // 结构性错误：两侧声明数量不同、同名但关系不同等"连比都没法比"的问题。
  errors: z.array(z.string().min(1)).default([]),
  reason: z.string().min(1),   // 一句话总结
});

export type ExpectationObserved = z.infer<typeof ExpectationObserved>;
export type ExpectationBaseline = z.infer<typeof ExpectationBaseline>;
export type ExpectationCandidate = z.infer<typeof ExpectationCandidate>;
export type ExpectationComparisonResult = z.infer<typeof ExpectationComparisonResult>;
