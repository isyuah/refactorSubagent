/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/build-workflow.ts —— BuildWorkflow 的三个"证件"
 *
 * 【这个文件是干什么的】
 *   定义 BuildWorkflow 相关的三种数据：
 *   - BuildWorkflowOutput   workflow 函数（声明式）的返回值：构建环境 + 产物声明；
 *   - BuildWorkflowManifest 注册表里每个 workflow 的"身份证"（id/版本/源码哈希/适用条件）；
 *   - BuildArtifact         逻辑产物清单（名字 → 相对路径），如 shared_tests → build/uv_run_tests。
 *
 * 【注意】这只管"声明式"workflow 的产物形状；自驱动（workflow-driven）构建
 *   返回 void、产物在执行期用 ctx.validator 断言——不经过 BuildWorkflowOutput。
 *
 * 【在整个项目里的位置】
 *   workflow/build-workflow.ts（解析器）校验并执行后落盘；
 *   registry.ts 入库时写 manifest；TestWorkflow 靠 workflow_id/revision 绑定它。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/build-workflow.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { EnvironmentSpec } from "./environment-spec.js";
import { RelPath, Sha256Hex } from "./common.js";

// 产物的大类：
export const BuildArtifactKind = z.enum([
  "executable",   // 可执行文件
  "library",
  "test-suite",   // 测试程序（libuv 的 uv_run_tests 就是它）
  "service",
  "custom",       // 自由形态（自驱动构建校验失败时的占位 artifact 也用它）
]);
export type BuildArtifactKind = z.infer<typeof BuildArtifactKind>;

export const BuildArtifact = z.object({
  kind: BuildArtifactKind,
  version: z.literal(1),
  workflow_id: z.string().min(1),                      // 产物属于哪个 workflow（防"张冠李戴"）
  workflow_revision: z.number().int().positive(),
  /** Logical artifact name → repo-relative path. */
  // ↑ 逻辑名 → 仓库相对路径。用"逻辑名"是为了跨平台：build/uv_run_tests 在
  //   Windows 上实际是 build/Debug/uv_run_tests.exe，由适配器负责补后缀。
  // .refine：至少要声明一个产物，否则这份 workflow 等于什么都没生产。
  paths: z.record(RelPath).refine((paths) => Object.keys(paths).length > 0, {
    message: "build artifact must expose at least one logical path",
  }),
  metadata: z.record(z.unknown()).default({}),   // 自由备注（项目名/版本/配置…）
});
export type BuildArtifact = z.infer<typeof BuildArtifact>;

export const BuildWorkflowOutput = z.object({
  kind: z.literal("build-workflow-output"),
  version: z.literal(1),
  workflow_id: z.string().min(1),
  workflow_revision: z.number().int().positive(),
  /** Compatibility bridge to the current Adapter-backed executor. */
  // ↑ environment：到现有 Adapter 执行器的"兼容桥"——声明式 workflow 最终仍
  //   表达成一份 EnvironmentSpec（cmake/ninja/direct-compiler 参数）交给执行器。
  environment: EnvironmentSpec,
  artifact: BuildArtifact,
});
export type BuildWorkflowOutput = z.infer<typeof BuildWorkflowOutput>;

// 适用条件：注册表里的 workflow 不是万金油，要在什么平台/构建系统/工具组合下才可用。
// 选择候选时 compatibilityReasons 会逐项核对（全空 = 不设限）。
export const BuildWorkflowAppliesTo = z.object({
  build_systems: z.array(z.string()).default([]),
  markers: z.array(z.string()).default([]),            // 项目标志文件（如 CMakeLists.txt）
  platforms: z.array(z.string()).default([]),          // 如 ["win32"]
  architectures: z.array(z.string()).default([]),      // 如 ["x64"]
  required_tools: z.array(z.string()).default([]),     // 如 ["cmake","ctest"]
});

export const BuildWorkflowManifest = z.object({
  kind: z.literal("build-workflow-manifest"),
  version: z.literal(1),
  id: z.string().min(1),                    // 稳定 id，如 "libuv-v1.52.1-cmake-debug"
  revision: z.number().int().positive(),    // 版本号（改动源码 = 升版本）
  entry: RelPath,                           // 源码文件相对路径
  source_hash: Sha256Hex,                   // ⚠️ 源码 sha256：加载时重验，防篡改/防错配
  workflow_api_version: z.literal(1),       // workflow 协议版本（ctx API 变了要升）
  applies_to: BuildWorkflowAppliesTo.default({}),
  /** Human/agent-facing description of what this workflow builds and produces. */
  // ↑ B 方案新增：人/AI 可读的描述——dep-registry 的 inspectWorkflow 靠它给
  //   test-writer 展示"这个 workflow 是干嘛的"，不用返回大段源码。
  description: z.string().max(2048).default(""),
  status: z.enum(["draft", "verified"]).default("draft"),
  // ⚠️ status 目前永远是 draft——没有任何代码把 workflow 晋级为 verified
  //   （"复用从未被验证的 workflow"是任务清单外的已知缺口）。
});
export type BuildWorkflowManifest = z.infer<typeof BuildWorkflowManifest>;
