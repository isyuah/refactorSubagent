/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/comparison-result.ts —— 差分对比结果（旧路径的"判决书"）
 *
 * 【这个文件是干什么的】
 *   定义 ComparisonResult artifact：逐用例、逐通道地记录 baseline 和 candidate
 *   的行为对比结论。"通道"指一种可观察行为：退出码 / 信号 / stdout / stderr / 文件副作用。
 *   状态机（orchestrator.ts）看到 overall === "inconsistent" 会直接改判 REJECTED（R6）。
 *
 * 【注意：这是旧路径的对比】
 *   workflow/CTest 路径用的是 ctest-suite.ts 的 CTestComparisonResult 和
 *   expectation-suite.ts 的 ExpectationComparisonResult；本文件服务于
 *   runtime/pipeline.ts + runtime/comparator.ts 的旧差分路径（e2e:differential）。
 *
 * 【本文件最有教学价值的一点】
 *   overall 不是手填的，而是 .transform 从 per_case 自动推导——想伪造"一致"
 *   连 Schema 都过不去（一致的定义就写在代码里）。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/comparison-result.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";

// 单个行为通道的判定结果：
export const ChannelVerdict = z.enum([
  "match",         // 这个通道两边一致
  "mismatch",      // 这个通道两边不一致（任何一个 mismatch 就足以判 inconsistent）
  "not_compared", // mode: ignore or case skipped upstream
  // ↑ 两种来源：行为契约里把该通道设为 ignore（明确不比）；或该用例上游被跳过
  //   （比如 baseline 就失败了，candidate 无从比起）。
]);

// 单个用例的对比记录：
const PerCase = z.object({
  case_id: z.string().min(1),      // 对应 TestSpec 里的用例 id
  verdict: z.enum(["match", "mismatch", "skipped_baseline_failure"]),
  // ↑ skipped_baseline_failure：baseline 失败的用例跳过对比（这本身要被 R3 审计）。
  // z.record(V)：键不固定的字典 { 通道名 → 判定 }，如 { exit_code: "match", stdout: "mismatch" }。
  channels: z.record(ChannelVerdict).default({}),
  detail: z.string().default(""),  // 人读的诊断说明（比如两边 stdout 的差异摘要）
});

/**
 * Comparison Result — verdict of differential running, per channel per case,
 * under the policy defined by the Behavior Contract.
 */
// ↑ 官方注释：对比结果 = 按"行为契约定义的策略"，对每个用例的每个通道给出判定。
export const ComparisonResult = z
  .object({
    kind: z.literal("comparison-result"),
    version: z.literal(1),

    baseline_env_id: z.string().min(1),   // baseline 用的环境 id（证明两边在同一环境语义下运行）
    candidate_env_id: z.string().min(1),

    per_case: z.array(PerCase).min(1),    // 至少对比过一个用例
  })
  // .transform：校验通过后"加工"数据——这里为整份结果补算一个 overall 字段。
  // every(...)：所有用例都通过才有 consistent；只要有一个 mismatch 就是 inconsistent。
  // ("consistent" as const)：把宽泛的 string 收窄成字面量类型，让 TS 类型精确。
  .transform((r) => ({
    ...r,                                 // 保留原有全部字段
    overall: r.per_case.every((c) => c.verdict !== "mismatch")
      ? ("consistent" as const)
      : ("inconsistent" as const),
  }));

export type ComparisonResult = z.infer<typeof ComparisonResult>;

/** Input shape (before `overall` is derived by .transform). */
// ↑ z.input：transform 之前的"输入形状"——提交者不用（也不该）自己填 overall。
export type ComparisonResultInput = z.input<typeof ComparisonResult>;
