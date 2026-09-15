/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/ctest-suite.ts —— CTest 一族 Schema（规格/结果/对比）
 *
 * 【这个文件是干什么的】
 *   新版验证路径（CTest 路径）的核心数据结构，四个主角：
 *   - CTestSuiteSpec        怎么跑（目录/配置/超时/并行度）——"考试安排"
 *   - CTestSuiteResult      跑出了什么（状态/计数/失败清单/原始输出）——"成绩单"
 *   - CTestBaseline         基线成绩 + 程序给出的失败分类——"预防性体检报告"
 *   - CTestComparisonResult 新旧对比——"判决书"（状态机 R6 据此裁决）
 *
 * 【必须理解的一件事（最容易误解）】
 *   libuv 实测输出 "0% tests passed, 2 tests failed out of 2"：这里的 2 是
 *   【顶层 CTest 目标】（uv_test / uv_test_a），不是里面 ~474 个 TAP 内层用例。
 *   total/passed/failed 数的是顶层目标。
 *
 * 【在整个项目里的位置】
 *   runtime/ctest-runner.ts 产出 Result；runtime/workflow-pipeline.ts 组装
 *   Baseline/Candidate 并提交状态机；runtime/ctest-comparator.ts 产出对比。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/ctest-suite.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { B64, RelPath } from "./common.js";

// ── CTestSuiteSpec：CTest 跑法参数 ─────────────────────────────────────
export const CTestSuiteSpec = z.object({
  kind: z.literal("ctest-suite-spec"),
  version: z.literal(1),
  build_dir: RelPath,                                  // CMake 构建目录（通常 "build"）
  configuration: z.string().min(1).default("Debug"),   // 多配置生成器的配置名
  // ⚠️ 默认 60 万毫秒 = 10 分钟。大项目（libuv 实测每侧 ~368 秒）接近极限，
  //   pipeline 物化时会把兜底提到 1_200_000——超时值散落各处是任务 #6C 的主题。
  timeout_ms: z.number().int().positive().default(600_000),
  // 并行度：null = 用 CTest 默认。⚠️ 流水线里实际硬编码 1（串行），任务 #8 提过。
  parallelism: z.number().int().positive().nullable().default(null),
  extra_args: z.array(z.string()).default([]),         // 额外命令行参数
  environment: z.record(z.string()).default({}),       // 附加环境变量
});

// ── CTestSummary：顶层计数 ────────────────────────────────────────────
// ⚠️ 再次强调：这里数的是顶层 CTest 目标（如 uv_test、uv_test_a），不是内层 TAP 用例。
export const CTestSummary = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  not_run: z.number().int().nonnegative(),   // 没跑的（依赖缺失等被 CTest 跳过）
});

// 一条失败记录：名字 + 失败时的断言输出（原文，方便事后归因）。
export const CTestFailure = z.object({
  name: z.string().min(1),
  output: z.string().default(""),
});

// ── CTestSuiteResult：一次 CTest 运行的完整成绩单 ──────────────────────
export const CTestSuiteResult = z.object({
  kind: z.literal("ctest-suite-result"),
  version: z.literal(1),
  status: z.enum(["pass", "fail", "timeout", "error"]),
  exit_code: z.number().int().nullable(),   // ctest 进程退出码（libuv 实测为 8 = 有失败）
  duration_ms: z.number().nonnegative(),
  summary: CTestSummary,
  /** Top-level CTest targets observed in the process output. */
  top_level_tests: z.array(z.string().min(1)).default([]),
  failed_tests: z.array(CTestFailure),      // 失败清单（含内层 TAP 失败归属到顶层目标）
  stdout_b64: B64,                          // 原始输出全量保存（base64）——复盘证据
  stderr_b64: B64,
  failure: z
    .object({                               // 整体失败的分类说明（pass 时为 null）
      category: z.enum(["environment", "test_failure", "unknown"]),
      explanation: z.string().min(1),
    })
    .nullable(),
});

// 基线失败分类（结构同旧版 FailureClassification，但 test 名直接对应 CTest 目标）。
export const CTestFailureClassification = z.object({
  test: z.string().min(1),
  category: z.enum(["environment", "preexisting_behavior", "scope_related", "unknown"]),
  related_to_scope: z.boolean(),
  explanation: z.string().min(1),
});

/** Baseline CTest evidence plus the program-owned failure classification. */
// ── CTestBaseline：基线证据 + 失败分类 ─────────────────────────────────
// superRefine 做"双向审计"（与 orchestrator 的 checkCTestBaseline 呼应，双保险）：
//   ① 每个失败都必须有分类；② 每条分类必须对应真实失败。
// ⚠️ "__suite__" 补丁：整包崩但一条具名失败都没有时，合成一个虚拟名参与审计，
//   防止"零失败"骗过检查。
export const CTestBaseline = z
  .object({
    kind: z.literal("ctest-baseline"),
    version: z.literal(1),
    result: CTestSuiteResult,
    failure_classifications: z.array(CTestFailureClassification),
    notes: z.array(z.string().min(1)).default([]),   // 备注，如"环境失败保持可见、不会被忽略"
  })
  .superRefine((value, context) => {
    const failed = new Set(value.result.failed_tests.map((test) => test.name));
    if (failed.size === 0 && value.result.status !== "pass") failed.add("__suite__");
    const classified = new Set(value.failure_classifications.map((failure) => failure.test));
    for (const name of failed) {
      if (!classified.has(name)) {
        // context.addIssue：superRefine 里"记一笔错误"的标准写法（可指定出错字段路径）。
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failure_classifications"],
          message: `failed CTest target lacks classification: ${name}`,
        });
      }
    }
    for (const failure of value.failure_classifications) {
      if (!failed.has(failure.test)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failure_classifications"],
          message: `classification has no failed CTest target: ${failure.test}`,
        });
      }
    }
  });

/** Candidate CTest evidence kept separate from the baseline classification. */
// ↑ 候选侧证据：不带分类字段——分类是基线专属的"体检报告"，候选不需要重新分类。
export const CTestCandidate = z.object({
  kind: z.literal("ctest-candidate"),
  version: z.literal(1),
  result: CTestSuiteResult,
  notes: z.array(z.string().min(1)).default([]),
});

/** Program-owned comparison of the same TestWorkflow on baseline/candidate. */
// ── CTestComparisonResult：判决书 ─────────────────────────────────────
// ⚠️ 与 ComparisonResult（旧路径）不同：这里的 overall 是【手填】的字段——
//   但别担心，状态机 checkCTestComparison 会回查两侧证据重算每一个字段，
//   伪造在语义审计那一关必被抓（R6）。
// 语法彩蛋：CTestSuiteResult.shape.status —— 直接复用另一个 Schema 里的字段定义，
//   避免把 z.enum(["pass","fail","timeout","error"]) 抄一遍。
export const CTestComparisonResult = z.object({
  kind: z.literal("ctest-comparison-result"),
  version: z.literal(1),
  baseline_status: CTestSuiteResult.shape.status,
  candidate_status: CTestSuiteResult.shape.status,
  baseline_top_level_tests: z.array(z.string().min(1)),
  candidate_top_level_tests: z.array(z.string().min(1)),
  baseline_failed_tests: z.array(z.string().min(1)),
  candidate_failed_tests: z.array(z.string().min(1)),
  added_failures: z.array(z.string().min(1)),     // 新增失败：candidate 有、baseline 无 → 直接 inconsistent
  removed_failures: z.array(z.string().min(1)),   // 消失失败：可能是行为变化！目前只记录不告警（任务 #9）
  overall: z.enum(["consistent", "inconsistent"]),
  reason: z.string().min(1),                      // 人读结论（如 "CTest drift: added=[…] removed=[…]"）
});

// —— 8 个类型导出 ——
export type CTestSuiteSpec = z.infer<typeof CTestSuiteSpec>;
export type CTestSummary = z.infer<typeof CTestSummary>;
export type CTestFailure = z.infer<typeof CTestFailure>;
export type CTestSuiteResult = z.infer<typeof CTestSuiteResult>;
export type CTestFailureClassification = z.infer<typeof CTestFailureClassification>;
export type CTestBaseline = z.infer<typeof CTestBaseline>;
export type CTestCandidate = z.infer<typeof CTestCandidate>;
export type CTestComparisonResult = z.infer<typeof CTestComparisonResult>;
