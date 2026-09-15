/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/test-workflow.ts —— TestWorkflow 的解析 + 校验 + 物化
 *
 * 【这个文件是干什么的】
 *   它是 build-workflow.ts 的"测试侧孪生兄弟"，做三件事：
 *   ① resolveTestWorkflow：给定 TestWorkflow 源码 + 已选定的 BuildWorkflow 身份，
 *      做沙箱检查、算指纹、（声明式才）执行一次拿测试声明、校验它与 BuildWorkflow
 *      的绑定关系、生成 manifest；
 *   ② materializeTestWorkflow：把声明式 CTest 型 TestWorkflow 变成一份
 *      CTestSuiteSpec（真正可执行的 ctest 参数，超时/并行度由宿主说了算）；
 *   ③ loadTestWorkflowManifest：从注册表目录读一份已持久化的 manifest，
 *      并重验源码指纹（防篡改）。
 *
 * 【TestWorkflow 有哪几种形态】（容易混，一次说清）
 *   Zod 里的 TestWorkflow 是个 union（src/artifacts/test-workflow.ts）：
 *     · CTestWorkflow      runner = "ctest"     —— 声明"去跑 ctest"，附 build_dir、
 *                                                 configuration、extra_args 等；
 *     · TestSpecWorkflow   runner = "test-spec" —— 声明"跑一组 TestSpec 用例"；
 *   之外的第三种形态不在 Zod union 里：
 *     · test-workflow-driven（自驱动）—— 源码顶层写 `export const workflowKind =
 *       "test-workflow-driven"`，函数返回 void，自己跑测试并用 ctx.expect 申报期望。
 *       ⚠️ resolve 阶段它**不执行**，resolution.workflow 为 null；
 *       真正的执行在 src/workflow/test-executor.ts（每侧跑一次）。
 *
 * 【在整个项目里的位置】
 *   上游（谁调用它）：
 *     · src/workflow/resolve-workflows.ts —— 生成路径（:453）、用户提供路径
 *       （inspectProvidedTest）；注册表复用路径则用 test-registry.ts 的
 *       loadTestWorkflow 读持久化数据（不经过本文件）；
 *     · src/agents/test-workflow.ts —— proposeTestWorkflow()（⚠️ 目前未接主流水线）。
 *   下游（它调用谁 / 产出给谁）：
 *     · checkWorkflowSource()（source-policy.ts）、runWorkflow()（runner.ts）；
 *     · materializeCTestSuiteSpec()（artifacts/test-workflow.ts）；
 *     · resolution 交给 registry.ts 的 saveTestWorkflow() 持久化；
 *     · materializeTestWorkflow 被 src/runtime/workflow-pipeline.ts:124 调用，
 *       产出 CTestSuiteSpec 交给 ctest-runner.ts 真正去跑。
 * 🔗 与 registry.ts / test-registry.ts 高度同构：那两个文件管"存/取/筛选"，
 *    本文件管"解析/校验"。四个文件里重复出现的 absoluteWithin / sha256 /
 *    原子写等小工具，讲透一次后其余文件就只作简短呼应。
 *
 * 【先修知识】
 *   · src/artifacts/test-workflow.ts 的 CTestWorkflow / TestSpecWorkflow /
 *     TestWorkflowManifest / CTestMaterializationPolicy；
 *   · src/artifacts/ctest-suite.ts 的 CTestSuiteSpec；
 *   · build-workflow.ts（本目录，结构与本文件几乎平行，建议先读它）。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/test-workflow.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 【语法】node:crypto 的 createHash —— 算 sha256 指纹用（build-workflow.ts 里已详述）。
import { createHash } from "node:crypto";
// 【语法】readFileSync 同步读文件（本项目启动/校验阶段的惯用做法，
//   简单直接；只有在长跑的执行路径上才会改成异步）。
import { readFileSync } from "node:fs";
// 【语法】node:path 的五个工具函数，用途见 build-workflow.ts 里的逐个说明。
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
// CTestSuiteSpec：ctest 的可执行参数（build_dir、configuration、超时、并行度…）。
import { CTestSuiteSpec } from "../artifacts/ctest-suite.js";
import type {
  HostPreflight,
  ProjectDetection,
} from "../artifacts/index.js";
// 【语法】一个 import 里混着"值"和"类型"两种引入：
//   不带 type 的（CTestWorkflow、TestWorkflow、TestWorkflowManifest）是 Zod
//     Schema，运行时真实存在，用来 .parse()；
//   带 type 的是纯 TS 类型（编译后消失）。
//   ⚠️ 注意 `type TestWorkflow as TestWorkflowValue`：因为 TestWorkflow 这个
//   名字已经作为 **Schema 值** 被引入了，所以类型版必须改名叫 TestWorkflowValue，
//   否则同名冲突。这类"Schema 叫 X、类型叫 XValue"的别名在 workflow 目录里到处都是。
import {
  CTestWorkflow,
  materializeCTestSuiteSpec,
  TestSpecWorkflow,
  TestWorkflow,
  TestWorkflowManifest,
  type CTestMaterializationPolicy,
  type TestWorkflow as TestWorkflowValue,
} from "../artifacts/test-workflow.js";
import { checkWorkflowSource } from "./source-policy.js";
import { runWorkflow } from "./runner.js";
import type { WorkflowFacts } from "./types.js";

// ── ResolveTestWorkflowOptions ────────────────────────────────────────
// 🔗 与 build-workflow.ts 的 ResolveBuildWorkflowOptions 几乎一样，差异有三处，
//    都是"测试侧更强约束"的体现：
//    ① entryRoot / workflowId / revision 在这里是**必填**；
//    ② 多了一个 buildWorkflow 字段（测试必须绑定到某个构建方案上）。
export interface ResolveTestWorkflowOptions {
  readonly entry: string;
  // ← 必填：TestWorkflow 源码相对于哪个根目录。
  readonly entryRoot: string;
  // ← 可选：目标工程根目录（默认 = entryRoot）。
  readonly workspaceRoot?: string;
  // ← 必填：期望的 workflow id / revision。测试侧不允许"源码自说自话"，
  //   因为它必须和 BuildWorkflow 的身份对得上（见下面的 buildWorkflow）。
  readonly workflowId: string;
  readonly revision: number;
  /** Selected BuildWorkflow identity; only id/revision are consumed. */
  // ← 已选定的 BuildWorkflow 身份。⚠️ 只用这两个字段——意思是：TestWorkflow
  //   不需要知道 BuildWorkflow 怎么构建，只需要知道"我依附于哪一个版本"。
  //   这样即便 BuildWorkflow 从声明式换成自驱动，绑定关系依然成立。
  readonly buildWorkflow: { readonly workflow_id: string; readonly workflow_revision: number };
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  // ← 超时（毫秒），默认 60_000。只管"声明式 resolve 这一次执行"，
  //   不管真正的测试跑多久（那个由宿主的 CTest 策略或 test-executor 管）。
  readonly timeoutMs?: number;
}

// ── TestWorkflowResolution：解析结果 ──────────────────────────────────
export interface TestWorkflowResolution {
  readonly entry: string;
  readonly manifest: TestWorkflowManifest;
  /** Declarative workflow object; null for self-driven (test-workflow-driven). */
  // ← 声明式才有对象；自驱动 = null（和 build-workflow.ts 的 output === null
  //   完全对应的另一半）。
  readonly workflow: TestWorkflowValue | null;
  readonly sourceHash: string;
}

/** Execute and validate a TestWorkflow against a selected BuildWorkflow. */
// ── resolveTestWorkflow：本文件的主函数 ────────────────────────────────
// 【作用】跑一遍 TestWorkflow（声明式才跑）并校验它对 BuildWorkflow 的绑定。
// 【关系】内部调用 checkWorkflowSource → runWorkflow → TestWorkflow.parse →
//   （ctest 时）materializeCTestSuiteSpec。任何不合法都 throw（fail-closed）。
export async function resolveTestWorkflow(
  options: ResolveTestWorkflowOptions,
): Promise<TestWorkflowResolution> {
  // 第 1 步：把 entry 变绝对路径并确认没逃出 entryRoot（防 ../ 越界）。
  const entry = absoluteWithin(options.entry, options.entryRoot);
  // 第 2 步：沙箱源码检查（禁 node:/bun: import、禁裸 process/Bun、试转译）。
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) throw new Error(checked.reason ?? "test workflow source rejected");

  // 第 3 步：源码指纹。manifest 里会存一份，加载时重验（防篡改）。
  const sourceHash = sha256(checked.source);
  const workspaceRoot = resolve(options.workspaceRoot ?? options.entryRoot);
  // 注入给 workflow 的"实测事实"：宿主只许模型基于测量结果提方案，不许猜。
  const facts: WorkflowFacts = { host: options.host, project: options.project };
  // Self-driven test workflows declare workflowKind = "test-workflow-driven".
  // Like self-driven builds, they are executed later (once per worktree) by
  // the host; resolution neither runs the function nor parses a declarative
  // object.
  // 第 4 步：探测形态。和 build-workflow.ts:65 同一套思路——在**源码文本**上
  //   用正则找 `export const workflowKind = "test-workflow-driven"`。
  //   为什么在文本上找而不先 import？因为自驱动函数一调用就会真的跑测试，
  //   而 resolve 阶段只想"看一眼不干活"。这行 export 必须原样写在顶层。
  const isSelfDriven = /export\s+const\s+workflowKind\s*=\s*["']test-workflow-driven["']/.test(checked.source);
  let workflow: TestWorkflowValue | null = null;
  if (!isSelfDriven) {
    // 第 5 步：声明式 —— 执行一次拿到测试声明。
    // 【关键差异】input 里带了 BuildWorkflow 的 id/revision。声明式 TestWorkflow
    //   的返回值里也必须填同样的 build_workflow_id/revision，下面会逐一比对。
    //   这就是"id/revision 绑定"：防止拿 A 项目的测试方案去测 B 的构建产物。
    const result = await runWorkflow({
      entry,
      cwd: workspaceRoot,
      input: {
        kind: "test-workflow-input",
        version: 1,
        build_workflow_id: options.buildWorkflow.workflow_id,
        build_workflow_revision: options.buildWorkflow.workflow_revision,
      },
      facts,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    if (result.status !== "pass") {
      throw new Error(`test workflow failed: ${result.failure ?? result.status}`);
    }

    // 第 6 步：Zod 校验。TestWorkflow 是个 union（ctest | test-spec），
    //   .parse 会自动判断返回值属于哪一支（靠 runner 字段区分）。
    const parsed = TestWorkflow.parse(result.result);
    // 第 7 步：三重身份校验。
    //   7a：workflow 自己申报的 id 必须等于调用方期望的 id；
    if (parsed.workflow_id !== options.workflowId) {
      throw new Error(
        `test workflow id mismatch: expected '${options.workflowId}', got '${parsed.workflow_id}'`,
      );
    }
    //   7b：revision 同理；
    if (parsed.workflow_revision !== options.revision) {
      throw new Error(
        `test workflow revision mismatch: expected ${String(options.revision)}, got '${parsed.workflow_revision}'`,
      );
    }
    //   7c：⚠️ 最关键的绑定 —— 它申报的 BuildWorkflow 必须就是"当前选定的那个"。
    //   不一致就拒绝，杜绝"测的不是这次构建出来的东西"。
    if (
      parsed.build_workflow_id !== options.buildWorkflow.workflow_id ||
      parsed.build_workflow_revision !== options.buildWorkflow.workflow_revision
    ) {
      throw new Error("test workflow references a different BuildWorkflow");
    }
    // 第 8 步：按 runner 分支做各自的附加校验。
    if (parsed.runner === "ctest") {
      // 8a：再用 CTestWorkflow 这个更窄的 Schema .parse 一次。
      //   【为什么重复 parse？】上面 TestWorkflow.parse 返回的是联合类型，
      //   TS 里要"收窄"到具体某支才能安全访问 build_dir 等字段；这里用
      //   "重新 parse 一遍更窄的 Schema"同时完成两件事：类型收窄 + 字段复检。
      CTestWorkflow.parse(parsed);
      // 8b：试物化一次 CTestSuiteSpec。⚠️ 注意传的是 timeout_ms: 1、
      //   parallelism: 1 —— 这**不是**真正要用的超时，只是"最小合法值"，
      //   目的仅是验证这份声明能被物化成合法的 CTestSuiteSpec（比如
      //   extra_args 格式对不对）。真正的超时/并行度由宿主在执行前决定，
      //   永远不给模型决定运行时策略的机会（"Runtime limits remain
      //   host-owned"）。
      CTestSuiteSpec.parse(materializeCTestSuiteSpec(parsed, {
        timeout_ms: 1,
        parallelism: 1,
      }));
      // 8c：extra_args 会被拼进 ctest 的命令行，禁止出现 NUL 字符
      //   （\0 是 C 字符串结束符，某些底层 API 会被它截断，造成诡异行为）。
      //   【语法】for…of 遍历数组；str.includes(子串) 返回布尔。
      for (const arg of parsed.extra_args) {
        if (arg.includes("\0")) throw new Error("test workflow extra_args cannot contain NUL");
      }
    } else {
      // 8d：test-spec 型：校验附带的 TestSpec（用例清单）结构合法。
      TestSpecWorkflow.parse(parsed);
    }
    workflow = parsed;
  }

  // 第 9 步：生成 manifest（与 build-workflow.ts 几乎一字不差，只差 required_tools）。
  const manifest = TestWorkflowManifest.parse({
    kind: "test-workflow-manifest",
    version: 1,
    id: options.workflowId,
    revision: options.revision,
    // 入口存相对路径 + 统一成正斜杠（跨平台 manifest 长得一致）。
    entry: relative(options.entryRoot, entry).split(sep).join("/"),
    source_hash: sourceHash,
    workflow_api_version: 1,
    applies_to: {
      build_systems: options.project?.build_systems ?? [],
      markers: options.project?.markers ?? [],
      platforms: options.host ? [options.host.platform] : [],
      architectures: options.host ? [options.host.arch] : [],
      // 只有 ctest 型才需要 ctest 这个工具；自驱动没有静态声明，留空。
      required_tools: workflow !== null && workflow.runner === "ctest" ? ["ctest"] : [],
    },
    status: "draft",
  });
  return { entry, manifest, workflow, sourceHash };
}

// ── materializeTestWorkflow：把声明式 TestWorkflow 变成可执行的 CTest 参数 ─
// 【作用】resolution.workflow 是 ctest 型时，套上宿主的运行时策略（超时/并行度）
//   产出一份 CTestSuiteSpec；其余情况返回 null。
// 【参数】policy 是 CTestMaterializationPolicy（Zod 解析出来的对象），
//   字段 timeout_ms（毫秒）与 parallelism（并行度），都由调用方决定。
// 【返回】`CTestSuiteSpec | null` —— 可空：不是 ctest 型（test-spec 型或自驱动）
//   就没有 ctest 参数可产。调用方 workflow-pipeline.ts 拿到 null 会直接中止
//   （"this executor requires CTest"）。
// 【关系】上游 workflow-pipeline.ts:124；内部委托给 artifacts/test-workflow.ts
//   的 materializeCTestSuiteSpec（那里才是真正拼 CTestSuiteSpec 的地方）。
export function materializeTestWorkflow(
  resolution: TestWorkflowResolution,
  policy: CTestMaterializationPolicy,
): CTestSuiteSpec | null {
  if (resolution.workflow === null || resolution.workflow.runner !== "ctest") return null;
  return materializeCTestSuiteSpec(resolution.workflow, policy);
}

// ── absoluteWithin：路径越界防护（与 build-workflow.ts 同款）────────────
// 【作用】把 entry 转绝对路径，并确认它没逃出 root。
// 🔗 与 build-workflow.ts 的 absoluteWithin 逻辑完全相同，只有报错文案不同。
//   本项目刻意在两个文件里各留一份，换取单文件自包含。
function absoluteWithin(entry: string, root: string): string {
  const base = resolve(root);
  const absolute = isAbsolute(entry) ? normalize(entry) : resolve(base, entry);
  const rel = relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`workflow entry escapes entry root: ${entry}`);
  }
  return absolute;
}

// ── sha256：源码指纹（与 build-workflow.ts 同款）──────────────────────
function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Read a persisted test workflow manifest and verify its source hash. */
// ── loadTestWorkflowManifest：从磁盘读 manifest 并重验指纹 ─────────────
// 【作用】给定 manifest.json 的路径，读出登记信息、找到源码、重新算一遍
//   sha256 并与 manifest 里存的 source_hash 比对。不一致 = 有人改过源码 = 拒绝。
//   这就是"注册表防篡改"的那道锁（registry.ts 的 loadBuildWorkflow 同款思路）。
// 【参数】manifestPath：manifest.json 的路径；entryRoot：解析 manifest.entry
//   的基准目录。
// 【返回】{ manifest, entry } —— 注意它只返回 manifest 和源码路径，
//   **不**返回声明式对象。想要对象得去 test-registry.ts 的 loadTestWorkflow
//   （那个版本会顺带读 test-workflow.json 并做身份交叉校验）。
// ⚠️ 目前全仓库没有任何地方调用它（src 和 tests 都没有）——属于"已建未接线"
//   的导出函数，逻辑与 test-registry.ts 的 loadTestWorkflow 重叠。读到它时
//   不要误以为它是主路径。
export function loadTestWorkflowManifest(
  manifestPath: string,
  entryRoot: string,
): { manifest: TestWorkflowManifest; entry: string } {
  // 【语法】JSON.parse(readFileSync(path, "utf8")) 读文件并解析成对象；
  //   解析结果直接喂给 Zod 的 .parse 做结构校验（类型不对就抛错）。
  const manifest = TestWorkflowManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  // manifest.entry 是相对路径，先确认它没逃出 entryRoot。
  const entry = absoluteWithin(manifest.entry, entryRoot);
  // 再做一次沙箱源码检查（拿到的 checked.source 是清理后的源码文本）。
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) throw new Error(checked.reason ?? `test workflow source rejected: ${entry}`);
  // 重算指纹并与登记值比对：任何一字之差都会被抓住。
  const actual = sha256(checked.source);
  if (actual !== manifest.source_hash) {
    throw new Error(
      `test workflow source hash mismatch: expected ${manifest.source_hash}, got ${actual}`,
    );
  }
  return { manifest, entry };
}
