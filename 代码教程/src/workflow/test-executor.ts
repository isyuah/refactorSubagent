/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/test-executor.ts —— 自驱动 TestWorkflow 的"两侧执行"
 *
 * 【这个文件是干什么的】
 *   自驱动 TestWorkflow（源码顶层写 `export const workflowKind =
 *   "test-workflow-driven"`）没有声明式对象可以"照着执行"，它自己就是测试
 *   逻辑。所以宿主要做的是：**把同一份源码在 baseline worktree 里跑一遍、
 *   再在 candidate worktree 里跑一遍**，收集两次运行各自用 ctx.expect 申报
 *   的期望，然后交给 expectation-compare.ts 按位置配对比较。
 *   本文件就是"跑一侧"这件事的封装（runTestSide），外加一个"两侧都跑完 +
 *   比较"的便捷封装（executeTestWorkflow）。
 *
 *   记住一个心智模型：workflow 函数**不知道自己在哪一侧**，也不被允许知道。
 *   它只是"在当前目录里把测试跑起来，把看到的值申报出去"。baseline 和
 *   candidate 之间的差异，全部留给宿主在两侧申报完之后去比。
 *
 * 【在整个项目里的位置】
 *   上游（谁调用它）：
 *     · src/runtime/workflow-pipeline.ts —— 真正的生产路径调的是 runTestSide，
 *       而且是**分开**调的：
 *         :228 baseline 侧（前面先执行 baseline 构建，跑完落
 *             expectation-baseline.json 并提交给状态机）；
 *         :269 candidate 侧（先执行 candidate 构建，跑完落
 *             expectation-candidate.json）；
 *         :297 再用 compareExpectations 比较两侧（落
 *             expectation-comparison-result.json）。
 *       之所以不整体调 executeTestWorkflow，是因为生产流水线要在两侧之间
 *       插入构建、artifact 提交、patch 提交等步骤，必须自己控制顺序。
 *     · tests/test-executor.test.ts —— executeTestWorkflow 的唯一真实调用方。
 *   下游（它调用谁）：
 *     · runWorkflow()（runner.ts）—— spawn 一个 bun 子进程跑 workflow 源码
 *       （子进程里 worker.ts 才做 `await import(源码)`）；
 *     · compareExpectations()（expectation-compare.ts）—— 只在
 *       executeTestWorkflow 里用。
 *
 * 【先修知识】
 *   · src/workflow/client.ts 的 ctx.expect 实现（三种调用形态、值怎么收集）；
 *   · src/workflow/types.ts 的 ExpectationDeclaration / WorkflowRunResult；
 *   · src/workflow/expectation-compare.ts（比较语义、"为什么必须同序"）；
 *   · 《零基础看懂教程.md》§1.5 "自驱动 TestWorkflow 的两侧运行模型"。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/test-executor.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 【语法】`import type { ... }` 只引类型，编译后整行消失（详见 expectation-compare.ts）。
//   HostPreflight / ProjectDetection 是宿主实测的主机/项目事实，原样透传给
//   workflow（模型只许基于测量结果行事，不许猜）。
import type {
  HostPreflight,
  ProjectDetection,
} from "../artifacts/index.js";
// runWorkflow：执行一次 workflow 源码（spawn 子进程 + Broker 代理能力）。
import { runWorkflow } from "./runner.js";
// 【语法】同一个 import 语句里混"值"和"类型"：
//   compareExpectations 是真函数（运行时存在）；ExpectationComparisonOutcome
//   是纯类型（编译后消失，所以前面带 type）。
import {
  compareExpectations,
  type ExpectationComparisonOutcome,
} from "./expectation-compare.js";
import type {
  ExpectationDeclaration,
  WorkflowCapabilityPolicy,
  WorkflowEvent,
} from "./types.js";

// ── ExecuteTestWorkflowOptions：执行两侧需要什么 ───────────────────────
export interface ExecuteTestWorkflowOptions {
  /** Workflow source entry (self-driven test workflow). */
  // ← workflow 源码路径。⚠️ 只有一个 entry：两侧跑的是同一份文件，
  //   区别只在 cwd（在哪个 worktree 里跑）。
  readonly entry: string;
  /** Absolute baseline worktree dir. */
  // ← baseline worktree 的绝对路径（改动前的版本）。
  readonly baselineDir: string;
  /** Absolute candidate worktree dir. */
  // ← candidate worktree 的绝对路径（重构后的版本）。
  readonly candidateDir: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  // ← 能力白名单（能读/能写哪些 glob、能用哪些工具、输出上限……）。
  //   生产路径 workflow-pipeline.ts 的 testWorkflowPolicy() 给的是
  //   readableGlobs/writableGlobs = ["**"]、maxProcesses: 4。
  readonly policy?: WorkflowCapabilityPolicy;
  /** Input injected into each run (build artifacts etc.). */
  // ← 注入给 workflow 的输入（两侧相同）。生产路径传的是
  //   { kind: "test-workflow-input", version: 1, build_workflow_id, build_workflow_revision }，
  //   让 workflow 知道它依附的是哪份构建方案。
  readonly input?: unknown;
  // ← 超时（毫秒），**每一侧**的预算。不传默认 120_000（120 秒）。
  readonly timeoutMs?: number;
}

// ── TestRunSide：单侧运行的结果 ────────────────────────────────────────
export interface TestRunSide {
  // 四种状态（沿用 runner.ts 的 WorkflowRunResult 语义）：
  //   pass     正常跑完；failed    抛异常/退出码非 0/断言失败；
  //   timeout  超时被杀；rejected  源码在沙箱检查阶段就被拒了（根本没执行）。
  readonly status: "pass" | "failed" | "timeout" | "rejected";
  // 失败原因；成功时是 null。（`string | null` 联合类型，逼着调用方处理空值。）
  readonly failure: string | null;
  // 这一侧用 ctx.expect 申报的全部期望（顺序 = 调用顺序，比较时就按这个顺序配对）。
  readonly expectations: ExpectationDeclaration[];
  // 能力调用事件流水（fs/process/tools/plan/validator 每次调用的耗时与成败），
  // 纯观测用，不影响判定。
  readonly events: WorkflowEvent[];
}

// ── ExecuteTestWorkflowResult：两侧 + 比较 + 总结论 ────────────────────
export interface ExecuteTestWorkflowResult {
  readonly baseline: TestRunSide;
  readonly candidate: TestRunSide;
  // ⚠️ 可能为 null：任何一侧没跑成功时就不会比较（没有可比的东西）。
  readonly comparison: ExpectationComparisonOutcome | null;
  /** Overall pass only when both sides pass and expectations are consistent. */
  // ← 总结论：两侧都 pass **且** 期望一致才算 pass。
  readonly status: "pass" | "failed";
  readonly failure: string | null;
}

/**
 * Execute a self-driven test workflow twice — once in the baseline worktree,
 * once in the candidate worktree. The workflow declares expectations via
 * ctx.expect (same code both sides); the host pairs declarations by position
 * and compares them relation-wise.
 */
// ── executeTestWorkflow：两侧跑完 + 比较（一把梭封装）───────────────────
// 【作用】把"baseline 跑一次 → candidate 跑一次 → 比较"串成一个调用。
// 【关系】⚠️ 生产流水线（workflow-pipeline.ts）不用它，用的是更底层的
//   runTestSide + compareExpectations（因为要在中间插构建和 artifact 提交）；
//   本函数目前只被 tests/test-executor.test.ts 调用，价值在于把标准流程
//   表达成一个可单测的单元。
// 【细节】返回的 status 只反映"验证结论"，与单侧的 status 不是一回事。
export async function executeTestWorkflow(
  options: ExecuteTestWorkflowOptions,
): Promise<ExecuteTestWorkflowResult> {
  // 第 1 步：先跑 baseline。
  const baseline = await runOnce(options, options.baselineDir);
  if (baseline.status !== "pass") {
    // baseline 就挂了 → 结论直接 failed。⚠️ 注意这里**还是会把 candidate 跑一遍**
    // 再返回：哪怕结论已定，保留另一侧的观测结果对定位问题很有用
    // （是 workflow 本身写错了，还是某个 worktree 环境有问题）。
    return {
      baseline,
      candidate: await runOnce(options, options.candidateDir),
      comparison: null,
      status: "failed",
      failure: `baseline test workflow failed: ${baseline.failure ?? baseline.status}`,
    };
  }

  // 第 2 步：跑 candidate。
  const candidate = await runOnce(options, options.candidateDir);
  if (candidate.status !== "pass") {
    return {
      baseline,
      candidate,
      comparison: null,
      status: "failed",
      failure: `candidate test workflow failed: ${candidate.failure ?? candidate.status}`,
    };
  }

  // 第 3 步：两侧都成功 → 比较期望。
  //   ⚠️ 比较是"按位置配对"：两侧的 expectations 顺序必须一致，
  //   这是写 workflow 时的铁律（详见 expectation-compare.ts 头注释）。
  const comparison = compareExpectations(baseline.expectations, candidate.expectations);
  if (comparison.overall !== "consistent") {
    // 不一致 → 把结构错误和值不匹配的原因拼成一句人读的 failure。
    // 【语法】`[...a, ...b]` 数组展开合并；.map 把每个 mismatch 转成字符串；
    //   .join("; ") 用分号串起来。
    const reasons = [
      ...comparison.errors,
      ...comparison.mismatched.map((m) => `'${m.declaration.name}': ${m.reason}`),
    ];
    return {
      baseline,
      candidate,
      comparison,
      status: "failed",
      failure: `test expectations inconsistent: ${reasons.join("; ")}`,
    };
  }

  // 第 4 步：全部通过。
  return {
    baseline,
    candidate,
    comparison,
    status: "pass",
    failure: null,
  };
}

/** Run the self-driven test workflow once in a single worktree (one side). */
// ── runTestSide：执行单侧（生产路径真正用的函数）──────────────────────
// 【作用】在 cwd 指定的 worktree 里把 workflow 源码跑一遍，把单侧结果原样带回来。
// 【参数】entry：workflow 源码路径；cwd：worktree 目录（workflow 的全部文件
//   操作和进程都被限制在这个目录里）；options：可选的 host/project/policy/
//   input/timeoutMs。
// 【返回】TestRunSide —— 其中 expectations 是本侧申报的期望清单，
//   宿主会拿 baseline 侧和 candidate 侧的清单去做比较。
// 【关系】上游 workflow-pipeline.ts（baseline 和 candidate 各调一次）；
//   下游 runWorkflow()（spawn 子进程）。它自己**不做任何比较**——
//   "单侧执行"和"两侧比较"被刻意拆开，好让流水线在中间插构建步骤。
// 【默认值】input 不传时给一个最小的 test-workflow-input；
//   timeoutMs 不传默认 120_000（120 秒/侧）——⚠️ 比声明式 resolve 阶段的
//   60_000 大一倍，因为这里是真的在跑测试。全项目的超时数值目前散落在
//   各文件里（见分析文档任务 6C），这是其中一处。
export async function runTestSide(
  entry: string,
  cwd: string,
  options: {
    readonly host?: HostPreflight;
    readonly project?: ProjectDetection;
    readonly policy?: WorkflowCapabilityPolicy;
    readonly input?: unknown;
    readonly timeoutMs?: number;
  },
): Promise<TestRunSide> {
  const result = await runWorkflow({
    entry,
    cwd,
    input: options.input ?? { kind: "test-workflow-input", version: 1 },
    facts: { host: options.host, project: options.project },
    policy: options.policy,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  // 从 WorkflowRunResult 里挑出四个字段组成 TestRunSide：
  //   丢掉 exitCode / stdout / stderr / plan（本层不关心），保留
  //   status / failure / expectations / events。
  // 【语法】对象字面量的属性名与变量名相同时可以只写一次（简写属性）。
  return {
    status: result.status,
    failure: result.failure,
    expectations: result.expectations,
    events: result.events,
  };
}

// ── runOnce：私有辅助 —— 在指定目录跑一侧 ─────────────────────────────
// 【作用】把 executeTestWorkflow 的 options 翻译成 runTestSide 的参数，
//   避免 baseline/candidate 两处重复抄同样的字段。
// 【语法】函数前没有 export：模块内私有，外部拿不到。
//   `async function` 没有 return 类型注解 —— TS 推断为 Promise<TestRunSide>。
async function runOnce(
  options: ExecuteTestWorkflowOptions,
  cwd: string,
): Promise<TestRunSide> {
  return runTestSide(options.entry, cwd, {
    host: options.host,
    project: options.project,
    policy: options.policy,
    input: options.input,
    timeoutMs: options.timeoutMs,
  });
}
