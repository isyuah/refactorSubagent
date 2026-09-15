/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/test-workflow.ts —— TestWorkflow 的形状与"物化"
 *
 * 【这个文件是干什么的】
 *   定义 TestWorkflow（测试怎么跑）的两种声明式形态、注册表 manifest、
 *   以及一个有趣的函数 materializeCTestSuiteSpec——把"声明"变成"执行参数"。
 *   （自驱动 test-workflow-driven 形态返回 void，不在本文件的联合类型里。）
 *
 * 【两种声明式 TestWorkflow】
 *   - CTestWorkflow   runner="ctest"：跑 CTest，绑定 BuildWorkflow 的 id/revision；
 *   - TestSpecWorkflow runner="test-spec"：跑旧版 TestSpec 用例（兼容通道）。
 *   两者都必须声明自己依赖哪个 BuildWorkflow——构建和测试必须"配对"。
 *
 * 【在整个项目里的位置】
 *   workflow/test-workflow.ts（解析校验）、workflow/test-executor.ts（自驱动执行）、
 *   runtime/workflow-pipeline.ts（调用 materialize 得到 CTestSuiteSpec）。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/test-workflow.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { CTestSuiteSpec } from "./ctest-suite.js";
import { RelPath, Sha256Hex } from "./common.js";
import { TestSpec } from "./test-spec.js";

// workflow 的"身份"（TestWorkflow 必须绑定一个 BuildWorkflow 的这套身份）。
// const（不 export）：模块内部私有，外界通过完整 Schema 使用。
const WorkflowIdentity = z.object({
  workflow_id: z.string().min(1),
  workflow_revision: z.number().int().positive(),
});

// 适用条件（与 build-workflow.ts 的 AppliesTo 同构，但这里各自独立定义）。
const AppliesTo = z.object({
  build_systems: z.array(z.string()).default([]),
  markers: z.array(z.string()).default([]),
  platforms: z.array(z.string()).default([]),
  architectures: z.array(z.string()).default([]),
  required_tools: z.array(z.string()).default([]),
});

// .merge(WorkflowIdentity)：把身份字段"合并"进基础形状——Zod 的 Schema 组合术，
// 两个具体 workflow 都基于它，于是天然都带 workflow_id/revision。
const TestWorkflowBase = z.object({
  kind: z.literal("test-workflow"),
  version: z.literal(1),
}).merge(WorkflowIdentity);

/** A reusable test-environment declaration. Runtime limits remain host-owned. */
// ↑ 官方注释点出一个权力边界：workflow 只声明"怎么跑测试"，
//   超时/并行度等运行时限制永远归宿主（程序）所有——见底部 MaterializationPolicy。
export const CTestWorkflow = TestWorkflowBase.extend({
  runner: z.literal("ctest"),          // 字面量字段：联合类型判别用的"标签"
  build_workflow_id: z.string().min(1),        // ⚠️ 绑定的 BuildWorkflow
  build_workflow_revision: z.number().int().positive(),
  /** Build directory produced by the selected BuildWorkflow. */
  build_dir: RelPath.default("build"),
  configuration: z.string().min(1).default("Debug"),
  /** Additional ctest argv, excluding host-owned timeout policy. */
  extra_args: z.array(z.string()).default([]),   // 额外参数（超时被明确排除在外）
  /** Top-level tests that must be present in the CTest output. */
  // ↑ 硬性要求：输出里必须看到这些顶层目标（如 uv_test/uv_test_a），
  //   少一个 = 环境/执行错误，fail-closed，绝不静默放过。
  required_top_level_tests: z.array(z.string().min(1)).default([]),
  environment: z.record(z.string()).default({}),
});

/** Compatibility runner for projects whose observable tests are TestSpec cases. */
// ↑ 兼容通道：项目没有 CTest、只有 TestSpec 用例时用这个 runner。
export const TestSpecWorkflow = TestWorkflowBase.extend({
  runner: z.literal("test-spec"),
  build_workflow_id: z.string().min(1),
  build_workflow_revision: z.number().int().positive(),
  test_spec: TestSpec,                 // 内嵌整份 TestSpec
});

// TestWorkflow = 两种之一（z.union 按字段自动分辨：runner 是 "ctest" 还是 "test-spec"）。
export const TestWorkflow = z.union([CTestWorkflow, TestSpecWorkflow]);
export type CTestWorkflow = z.infer<typeof CTestWorkflow>;
export type TestSpecWorkflow = z.infer<typeof TestSpecWorkflow>;
export type TestWorkflow = z.infer<typeof TestWorkflow>;

// 注册表 manifest（与 BuildWorkflowManifest 同构：id/版本/源码哈希/适用条件/状态）。
export const TestWorkflowManifest = z.object({
  kind: z.literal("test-workflow-manifest"),
  version: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  entry: RelPath,
  source_hash: Sha256Hex,                    // 加载时重验，防篡改
  workflow_api_version: z.literal(1),
  applies_to: AppliesTo.default({}),
  status: z.enum(["draft", "verified"]).default("draft"),   // 现状永远是 draft
});
export type TestWorkflowManifest = z.infer<typeof TestWorkflowManifest>;

/** Final CTest execution settings materialized by the program, not by Claude. */
// ↑ 最终执行参数由程序决定：默认 20 分钟、串行（parallelism 1）。
// ⚠️ 这两个默认值也是"超时散落"的一员（任务 #6C）；串行也是 e2e 慢的因素之一（任务 #8）。
export const CTestMaterializationPolicy = z.object({
  timeout_ms: z.number().int().positive().default(1_200_000),
  parallelism: z.number().int().positive().default(1),
});
export type CTestMaterializationPolicy = z.infer<typeof CTestMaterializationPolicy>;

// ── isCTestWorkflow：类型守卫 ─────────────────────────────────────────
// 【语法】`workflow is CTestWorkflow` 是类型谓词：这个函数返回 true 时，
//   TS 就把 workflow 当作 CTestWorkflow 类型（调用处免写 as 断言）。
export function isCTestWorkflow(workflow: TestWorkflow): workflow is CTestWorkflow {
  return workflow.runner === "ctest";
}

// ── materializeCTestSuiteSpec：声明 → 可执行的规格 ────────────────────
// 【作用】把 CTestWorkflow 的"声明"加上程序的"运行时策略"（超时/并行度），
//   合成一份真正拿去执行的 CTestSuiteSpec。
// 【参数】workflow 声明；policy 宿主策略。
// 【返回】过 CTestSuiteSpec.parse 校验的规格——注意出口也过 Schema（数据不出门则已，
//   出门必带证件）。
// 【关系】runtime/workflow-pipeline.ts 在 CTest 路径调用它。
export function materializeCTestSuiteSpec(
  workflow: CTestWorkflow,
  policy: CTestMaterializationPolicy,
): z.infer<typeof CTestSuiteSpec> {
  return CTestSuiteSpec.parse({
    kind: "ctest-suite-spec",
    version: 1,
    build_dir: workflow.build_dir,
    configuration: workflow.configuration,
    timeout_ms: policy.timeout_ms,          // 超时来自 policy，不是 workflow 自己说的
    parallelism: policy.parallelism,
    extra_args: [...workflow.extra_args],   // [...x] 复制一份，避免共享引用
    environment: { ...workflow.environment },
  });
}
