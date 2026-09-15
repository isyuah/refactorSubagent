/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/resolve-declared.ts —— 声明制（B 方案）的解析收口
 *
 * 【这个文件是干什么的】
 *   "B 方案：声明制依赖"落地后，宿主不再替 AI 挑 build workflow。取而代之：
 *   test-writer 会话结束时，宿主手里有
 *     ① 一个 test workflow 的 TypeScript 源文件（AI 写到 runs/<sessionId>/workflows/test/）；
 *     ② 一串 build workflow id（AI 用 declareDependency 工具声明的"依赖集"）。
 *   本文件把这两样东西变成"可以执行的东西"：对每个声明的 build id 调一次
 *   resolveBuildWorkflow（校验源码、算 hash、生成 manifest），再对 test 源文件调一次
 *   resolveTestWorkflow。任何一个 build 解析失败（源码非法 / 文件不存在）就整个抛错——
 *   这叫 fail-closed（关死失败面）：宁可这次运行失败，也绝不带着一个没验证过的 build 往下跑。
 *   注意：这里没有 Claude、没有"选择/打分/猜"——id 早已由宿主对照注册表校验过。
 *
 * 【在整个项目里的位置】
 *   上游：src/runtime/workflow-agent-pipeline.ts 的 runDeclaredResolution()——
 *         它先跑 runWorkflowSession（test-writer 会话），再把声明集逐个 id 解析成
 *         { entry, runLocal }，最后调本文件的 resolveDeclaredWorkflows。
 *   下游：src/workflow/build-workflow.ts 的 resolveBuildWorkflow（解析单个 build）、
 *         src/workflow/test-workflow.ts 的 resolveTestWorkflow（解析 test 源文件）。
 *   产出：ResolvedDeclaredWorkflows { builds, test } 回到 pipeline，builds 逐个交给
 *         executeBuildWorkflow（baseline/candidate 各跑一次），test 交给 executeTestWorkflow。
 *
 * 【先修知识】
 *   · src/agents/dep-registry.ts —— LocalDependencyRegistry：id 从哪来、run-local 是什么；
 *   · src/artifacts/declared-build-set.ts —— DeclaredBuildSet artifact（声明集的落盘形状）；
 *   · resolveBuildWorkflow 的关键语义："workflow-driven" 的 build 在解析阶段**不执行**，
 *     output 为 null，真正执行发生在 execute 阶段（见 build-workflow.ts 里的注释）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/workflow/resolve-declared.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← 只导入类型（import type）：HostPreflight（宿主环境探测结果）与 ProjectDetection（项目识别结果）
//   这两个对象只用来填 manifest 的 applies_to（适用平台/构建系统），不参与逻辑判断
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
// ← resolveBuildWorkflow：解析单个 build workflow 源文件；BuildWorkflowResolution 是它的返回类型
import { resolveBuildWorkflow, type BuildWorkflowResolution } from "./build-workflow.js";
// ← resolveTestWorkflow：解析 test workflow 源文件；TestWorkflowResolution 是它的返回类型
import { resolveTestWorkflow, type TestWorkflowResolution } from "./test-workflow.js";

/**
 * resolve-declared — declaration-set workflow resolution for the
 * subagent-driven flow.
 *
 * The test-writer session produced a TestWorkflow source plus a declaration
 * set of build workflow ids. This module resolves every declared build
 * (fail-closed on unknown/missing), then resolves the test workflow source.
 *
 * There is no Claude selection here: ids are host-validated against the
 * registry's known set, and entries come from the run-local directory or the
 * persisted library.
 */

// ── DeclaredBuildSource：一个"已声明 build"的输入描述 ─────────────────
// 【作用】pipeline 在调用本文件前，已经把声明集里的每个 id 解析成 entry（文件在哪），
//         这里只是把"id + 文件路径 + 是否本次生成"打包成一条记录。
// 【字段】id          声明用的 build workflow id（run-local 时形如 trim-build-sess-abc123）
//         entry       workflow 源文件的绝对路径（run-local 目录下的，或者库 .refactorsa 里的）
//         runLocal    true = 这个 build 是本次运行中由 build-writer 现写的（还没入库）
// 【语法】readonly：TS 的"只读"标记，创建之后不许改，防止中途被误改；
//         workflowId?: string 中的 ? 表示可选字段，可以不传（undefined）
export interface DeclaredBuildSource {
  /** Declared build workflow id. */
  readonly id: string;
  /** Absolute path to the workflow source (run-local or library entry). */
  readonly entry: string;
  /** True when this build was generated during the current run. */
  readonly runLocal: boolean;
  /** Optional host-assigned identity; workflow-driven sources may not carry one. */
  readonly workflowId?: string;
  readonly revision?: number;
}

// ── ResolveDeclaredWorkflowsOptions：resolveDeclaredWorkflows 的入参 ──
// 【字段】workspaceRoot  被测项目根目录（workflow 执行时的工作目录，能力注入的边界）
//         entryRoot      信任边界根：workflow 源文件必须落在这个目录之内（防路径穿越）
//         host / project 可选，用于填 manifest 的 applies_to
//         testEntry      test workflow 源文件的绝对路径（AI 刚写好的那个文件）
//         testWorkflowId / testRevision  宿主给 test workflow 分配的身份（如 test-<sessionId>）
//         builds         声明的 build 列表（调用方已确认 id 都存在）
export interface ResolveDeclaredWorkflowsOptions {
  /** Target project root exposed through workflow capabilities. */
  readonly workspaceRoot: string;
  /** Root used as the trust boundary for workflow source entries. */
  readonly entryRoot: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  /** Absolute entry of the produced TestWorkflow source. */
  readonly testEntry: string;
  /** Host-assigned identity for the test workflow. */
  readonly testWorkflowId: string;
  readonly testRevision: number;
  /** Declared build sources (id → entry), already validated known. */
  readonly builds: readonly DeclaredBuildSource[];
}

// ── ResolvedDeclaredBuild：解析完的一个 build（id 保留原始声明的样子）──
// 【字段】resolution 是 build-workflow.ts 产出的 { entry, manifest, output, sourceHash }；
//         对 workflow-driven 的 build 来说 output 一定是 null（执行推迟到 execute 阶段）
export interface ResolvedDeclaredBuild {
  readonly id: string;
  readonly runLocal: boolean;
  readonly resolution: BuildWorkflowResolution;
}

// ── ResolvedDeclaredWorkflows：本文件的最终产出 ──────────────────────
// 【关系】builds 交给 pipeline 循环执行；test 交给 executeTestWorkflow 做 baseline/candidate 差分
export interface ResolvedDeclaredWorkflows {
  readonly builds: readonly ResolvedDeclaredBuild[];
  readonly test: TestWorkflowResolution;
}

/**
 * Resolve every declared build, then the test workflow source.
 *
 * Self-driven test workflows (test-workflow-driven) carry no static build
 * reference; the executed set is exactly the declared builds, and the test
 * references artifact paths it learned from the build-writer report (asserting
 * them itself via context.validator). Legacy declarative tests still receive a
 * single build identity for their static compatibility check.
 */

// ── resolveDeclaredWorkflows：把"声明集"变成"可执行集合"（本文件唯一导出函数）────
// 【作用】① 逐个解析声明的 build（任何一个失败 → 抛错，整个解析作废 = fail-closed）；
//         ② 解析 test workflow 源文件（校验语法/source-policy、算 hash、生成 manifest）；
//         ③ 把 {builds, test} 一起返回。
// 【参数】options —— 见上面 ResolveDeclaredWorkflowsOptions 的逐字段说明
// 【返回】Promise<ResolvedDeclaredWorkflows>；async 函数返回 Promise，调用方用 await 拿值
// 【语法】for...of：按顺序遍历数组（这里刻意串行，保证失败能立刻中断、日志顺序也可预测）；
//         await：等一个异步操作做完再走下一行——resolveBuildWorkflow 内部可能要执行子进程
// 【关系】上游 workflow-agent-pipeline.runDeclaredResolution 调用；下游 resolveBuildWorkflow /
//         resolveTestWorkflow。任何一个 build 源码非法或文件缺失 → 抛 Error → pipeline 直接 abort
export async function resolveDeclaredWorkflows(
  options: ResolveDeclaredWorkflowsOptions,
): Promise<ResolvedDeclaredWorkflows> {
  // ← 结果累积器：先建一个空数组，解析完一个就 push 一个
  const builds: ResolvedDeclaredBuild[] = [];
  // ← 串行遍历每个声明的 build。⚠️ 顺序即执行顺序：宿主之后会按这个顺序跑 build
  for (const source of options.builds) {
    // ← 真正的解析动作：读文件 → source-policy 校验（禁 import、必须声明 workflowKind）
    //   → 算 sha256 → 生成 manifest。workflow-driven 的 build 在这里**不执行**
    const resolution = await resolveBuildWorkflow({
      entry: source.entry,
      workflowId: source.workflowId,
      revision: source.revision,
      cwd: options.workspaceRoot,
      entryRoot: options.entryRoot,
      workspaceRoot: options.workspaceRoot,
      host: options.host,
      project: options.project,
    });
    // ← id 用的是"声明时的那个 id"（可能是 run-local id），不是 manifest 里的 id——
    //   这样 pipeline 后续按 id 对账时两边说的是同一套名字
    builds.push({ id: source.id, runLocal: source.runLocal, resolution });
  }

  // ← 解析 test workflow。buildWorkflow 传的是"单个 build 引用"（见下面 singleBuildReference）：
  //   这是给老式 declarative test 用的兼容通道；self-driven test 不用它
  const test = await resolveTestWorkflow({
    entry: options.testEntry,
    entryRoot: options.entryRoot,
    workspaceRoot: options.workspaceRoot,
    workflowId: options.testWorkflowId,
    revision: options.testRevision,
    buildWorkflow: singleBuildReference(builds),
    host: options.host,
    project: options.project,
  });

  // ← 一起交还调用方：builds 是"要跑的"，test 是"跑完 build 之后要执行的"
  return { builds, test };
}

/** Legacy single-build identity for declarative tests; empty for none/many. */

// ── singleBuildReference：把 N 个 build 压成"一个引用"（老格式兼容）────
// 【作用】旧式 declarative test workflow 的源码里写死了"我依赖哪个 build"（workflow_id +
//         workflow_revision），解析时宿主要把这个身份喂进去做一致性校验。声明制下 build 可能是
//         0 个或多个，没法一一对应，所以：恰好 1 个 → 用它的真实身份；0 个或多个 → 填空值占位。
// 【参数】builds 已解析完的 build 列表
// 【返回】{ workflow_id, workflow_revision } —— 只在这两个字段上消费
// 【语法】builds[0]! 末尾的 ! 是"非空断言"：告诉编译器"我确定这不是 undefined"（前面刚判过 length===1）；
//         "" 和 0 是"空引用"的占位值，resolveTestWorkflow 对 self-driven test 不会去校验它们
// 【关系】只被上面的 resolveDeclaredWorkflows 调用（文件内私有函数，没有 export）
function singleBuildReference(builds: readonly ResolvedDeclaredBuild[]): {
  readonly workflow_id: string;
  readonly workflow_revision: number;
} {
  if (builds.length === 1) {
    // ← 恰好一个 build：把它的 manifest 身份透传给 test 解析器做静态兼容检查
    const manifest = builds[0]!.resolution.manifest;
    return { workflow_id: manifest.id, workflow_revision: manifest.revision };
  }
  // ← 0 个（无依赖测试）或多个（N>1 声明）：老格式表达不了，给空占位
  return { workflow_id: "", workflow_revision: 0 };
}
