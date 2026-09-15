/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/test-spec.ts —— 测试规格（用什么输入去考验新旧两版代码）
 *
 * 【这个文件是干什么的】
 *   定义 TestSpec artifact：一列"测试用例"。每个用例 = 启动一次编译出来的可执行文件：
 *   给它什么命令行参数（argv）、喂什么标准输入（stdin）、先往运行目录放哪些文件（fixtures）。
 *   它由 Analyze Agent 在分析阶段提出，是 BASELINE_READY / VERIFICATION_RUNNING
 *   阶段真正去执行的"考卷"。
 *
 * 【两种用例的区别（核心概念）】
 *   - regression（回归）：我知道正确答案——expect_exit_code 写死期望值；
 *   - differential（差分）：不写死答案，分别喂给 baseline 和 candidate，
 *     比较两边表现是否一致（这才是"行为保持"的主证据）。
 *
 * 【在整个项目里的位置】
 *   分析阶段（DEPENDENCY_READY → TESTS_READY）由状态机收下；
 *   旧路径 runtime/runner.ts 逐用例执行它；新版 workflow 路径下它更多是
 *   "AI 测试设计意图"的记录（实际执行以 TestWorkflow 为准）。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/test-spec.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { B64, RelPath } from "./common.js";   // B64 = base64 字符串、RelPath = 相对路径（公共 Schema）

/**
 * Test Spec — regression tests + differential input set.
 * For C MVP every case is one invocation of the built binary.
 */
// ↑ 官方注释：测试规格 = 回归测试 + 差分输入集。C 语言 MVP 阶段，每个用例就是
//   "把编译出的可执行文件跑一次"。

export const TestCase = z.object({
  id: z.string().min(1),                       // 用例唯一标识（如 "trim-boundary-empty"）
  kind: z.enum(["regression", "differential"]), // 两种用例类型（见文件头说明）
  /** argv is passed to CreateProcess/exec; NUL cannot cross that boundary. */
  // ↑ argv 会原样传给操作系统的进程创建 API（Windows CreateProcess / Unix exec），
  //   而 C 字符串以 NUL(\0) 结尾——参数里带 NUL 就会被截断甚至注入。
  //   .refine(自定义校验)：对值做 Schema 表达不了的检查，不过就报 message 里的错。
  argv: z.array(
    z.string().refine((value) => !value.includes("\0"), {
      message: "argv values cannot contain NUL bytes",
    }),
  ),
  stdin: B64.default(""),                      // 标准输入（base64，可装任意二进制）。不填 = 空串
  /** Files materialized into the fresh run cwd before execution. */
  // ↑ fixtures：运行前"铺"进全新临时工作目录的文件（每个测试都从干净目录开始）。
  fixtures: z
    .array(z.object({ path: RelPath, content_b64: B64 }))
    .default([]),                              // .default：不提供就当空数组
  /** Regression-only expectation; differential cases compare against baseline instead. */
  // ↑ 期望退出码只有 regression 用例需要；differential 用例的"答案"就是 baseline 本身。
  // .optional()：字段可以缺席（undefined）。
  expect_exit_code: z.number().int().optional(),
});

/** ids unique + regression cases carry an expectation. */
// ↑ .refine 挂在对象上 = 跨字段校验。一次性检查三条规则（一个都不满足就整份拒绝）：
//   ① 至少有 1 个 differential 用例（差分是核心证据，没有它就没有对比）；
//   ② 用例 id 全局唯一（new Set(...).size === length 是"无重复"的惯用写法）；
//   ③ 每个 regression 用例都必须带 expect_exit_code（回归的"回归"意义所在）。
export const TestSpec = z
  .object({
    kind: z.literal("test-spec"),   // kind/version 是全项目 artifact 的统一"身份证"
    version: z.literal(1),
    cases: z.array(TestCase).min(1), // 至少一个用例
  })
  .refine(
    (s) =>
      s.cases.some((c) => c.kind === "differential") &&
      new Set(s.cases.map((c) => c.id)).size === s.cases.length &&
      s.cases.every(
        (c) => c.kind === "differential" || c.expect_exit_code !== undefined,
      ),
    {
      message:
        "need ≥1 differential case, unique case ids, and expectations on all regression cases",
    },
  );

// z.infer：从 Schema 反推出 TS 类型（校验规则和类型定义一处维护）。
export type TestSpec = z.infer<typeof TestSpec>;
