/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/index.ts —— artifacts 的"总大门"（桶导出 + Artifact 联合）
 *
 * 【这个文件是干什么的】
 *   两件事：
 *   ① 把目录里所有 Schema 集中再导出（桶导出/barrel）：其他文件只需要
 *      `import { … } from "../artifacts/index.js"` 一个入口；
 *   ② 定义 Artifact = 全部 artifact 的 z.union（大联合类型），SessionStore
 *      校验任何 artifact 都靠它。AnyArtifact 是它的 TS 类型版。
 *
 * 【语法讲解：export * 】
 *   `export * from "./common.js"` = 把那个模块的所有导出原样转发出去。
 *   桶导出的好处是调用方不用记住每个文件路径；代价是名字必须全局不冲突。
 *
 * 【为什么用 z.union 而不是 z.discriminatedUnion？】
 *   文件头注释给了答案：不少 artifact 带跨字段校验（superRefine/transform），
 *   discriminatedUnion 要求"仅凭 kind 就能立刻选中一个分支"（快速路径），
 *   而 union 是逐个试、试到通过为止——更慢但更宽容，本项目需要后者。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/index.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

// —— 下面 13 个 import：引入"需要组成联合类型"的 Schema ——
import { z } from "zod";
import { BehaviorContract } from "./behavior-contract.js";
import { ScopeManifest } from "./scope-manifest.js";
import { DependencyManifest } from "./dependency-manifest.js";
import { EnvironmentSpec } from "./environment-spec.js";
import { TestSpec } from "./test-spec.js";
import { ObservationTrace } from "./observation-trace.js";
import { PatchRecord } from "./patch-record.js";
import { ComparisonResult } from "./comparison-result.js";
import { SanitizerResult } from "./sanitizer.js";
import { BuildWorkflowManifest, BuildWorkflowOutput } from "./build-workflow.js";
import { RefactorTestTask } from "./refactor-task.js";
import { WorkflowResolution } from "./workflow-resolution.js";
import { DeclaredBuildSet } from "./declared-build-set.js";   // ★ B 方案新增：声明制依赖集
import { CTestBaseline, CTestCandidate, CTestComparisonResult } from "./ctest-suite.js";
import {
  ExpectationBaseline,
  ExpectationCandidate,
  ExpectationComparisonResult,
} from "./expectation-suite.js";
// —— 桶导出区：全部再导出（包括没进联合的 HostPreflight/ProjectDetection 等"审计材料"）——
export * from "./common.js";
export * from "./behavior-contract.js";
export * from "./scope-manifest.js";
export * from "./dependency-manifest.js";
export * from "./environment-spec.js";
export * from "./test-spec.js";
export * from "./observation-trace.js";
export * from "./patch-record.js";
export * from "./comparison-result.js";
export * from "./host-preflight.js";
export * from "./project-detection.js";
export * from "./build-workflow.js";
export * from "./ctest-suite.js";
export * from "./sanitizer.js";
export * from "./refactor-task.js";
export * from "./test-workflow.js";
export * from "./workflow-resolution.js";
export * from "./declared-build-set.js";
export * from "./expectation-suite.js";
/** Union of every artifact kind the orchestrator accepts (some carry cross-field
 * refinements, so plain union instead of discriminatedUnion). */
// ↑ 状态机接受的全部 artifact 大联合——SessionStore.saveArtifact 就用它校验。
export const Artifact = z.union([
  BehaviorContract,
  ScopeManifest,
  DependencyManifest,
  EnvironmentSpec,
  TestSpec,
  ObservationTrace,
  PatchRecord,
  ComparisonResult,
  SanitizerResult,
  RefactorTestTask,
  WorkflowResolution,
  DeclaredBuildSet,   // ★ B 方案新增：进入"状态机接受的 artifact 大联合"
  CTestBaseline,
  CTestCandidate,
  CTestComparisonResult,
  ExpectationBaseline,
  ExpectationCandidate,
  ExpectationComparisonResult,
]);

// AnyArtifact：任意 artifact 的 TS 类型（状态机到处在用，如 AnyArtifact["kind"]）。
export type AnyArtifact = z.infer<typeof Artifact>;
