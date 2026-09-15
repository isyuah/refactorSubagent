/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/workflows/libuv-test.ts —— 【声明式 TestWorkflow】样例（ctest runner）
 *
 * 【这个文件是干什么的】
 *   它描述"怎么验证"：用 ctest 跑刚才构建出来的测试套件。
 *   与 libuv-build.ts 成对出现 —— 靠 build_workflow_id/build_workflow_revision
 *   两个字段"指名道姓"地绑定到那个 BuildWorkflow，宿主会校验这对身份证
 *   确实对得上（否则抛 "test workflow references a different BuildWorkflow"）。
 *   等价的命令行大致是（在 build/ 目录里）：
 *     ctest -C Debug
 *
 * 【声明式 vs 自驱动（workflowKind）—— TestWorkflow 这边的两种形态】
 *   声明式（本文件）                          自驱动（test-workflow-driven）
 *   ───────────────────────────────          ───────────────────────────────
 *   文件里没有 workflowKind 导出              文件里写 export const workflowKind =
 *                                            "test-workflow-driven"
 *   return 一个对象（runner: "ctest" 或       return void，函数体里自己想办法把
 *          "test-spec"）                     测试跑起来
 *   resolve 阶段执行一次、过 Zod 校验、        resolve 阶段不执行（workflow === null），
 *   生成 TestWorkflowManifest                 execute 阶段在 baseline/candidate
 *                                            各跑一遍
 *   宿主拿到的是"CTest 参数表"，由程序         函数自己用 ctx.process 跑测试二进制，
 *   调 ctest 并解析 TAP 输出                  用 ctx.expect("用例名", 观测值) 把
 *                                            两侧的观测值声明出去；宿主按下标配对、
 *                                            按 equal/not-equal/baseline-greater/
 *                                            baseline-less/both-matches 关系判定
 *   谁负责超时/并行度：宿主（CTestMaterializationPolicy，
 *   workflow 无权决定 —— 见原文件自带的英文注释 "the host owns timeout and
 *   execution policy"，这就是那句话的意思）
 *
 * 【在整个项目里的位置】
 *   上游：resolveTestWorkflow()（src/workflow/test-workflow.ts）解析它：
 *         执行函数 → TestWorkflow.parse() → 校验 id/revision/build 绑定 →
 *         runner === "ctest" 时再用 CTestWorkflow.parse() 精校验 + 试算一次
 *         CTestSuiteSpec（timeout_ms 传 1 只是做"形状检查"，真实预算由宿主给）。
 *   下游：materializeCTestSuiteSpec() 把它变成 CTestSuiteSpec artifact，
 *         交给 runCTest()（src/runtime/ctest-runner.ts）真正执行；
 *         compareCTestSuites() 对比 baseline/candidate 两侧结果 → 状态机裁决。
 *   谁用它：scripts/demo-libuv-agent.ts（BUILD_WORKFLOW / TEST_WORKFLOW 两个常量）。
 * 【先修知识】
 *   ① libuv-build.ts（本文件绑定的构建配方）；
 *   ② CTest 的"顶层测试 vs TAP 用例"：1 个顶层测试（uv_test）内部跑几百个小用例
 *      —— 这也是《零基础看懂教程.md》里"3 个常见误解"的第 1 条。
 * 【本文件是教程注释版】
 *   原文件：examples/workflows/libuv-test.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 只导入类型（编译后消失）。_context：声明式 TestWorkflow 同样不需要能力包。
import type { WorkflowContext } from "../../src/workflow/types.js";

/** libuv v1.52.1 Debug CTest suite; the host owns timeout and execution policy. */
// ↑ 原文件自带的英文注释，一字未动：超时与执行策略归宿主管，workflow 说了不算。
// ── libuvTestWorkflow：libuv 的验证配方（声明式 TestWorkflow）────────
// 【作用】返回一个 TestWorkflow 对象（这里用的是 CTestWorkflow 这个分支）。
// 【返回】会过 TestWorkflow.parse()（Zod 的 union：先试 CTestWorkflow，
//         不匹配再试 TestSpecWorkflow）。字段名/取值错一个 → resolve 抛错。
// 【关系】必须与一个已解析的 BuildWorkflow 配对（options.buildWorkflow 传入
//         期望的 id/revision），生成 CTestSuiteSpec 后由宿主在两个 worktree 各跑一遍。
export default function libuvTestWorkflow(_context: WorkflowContext) {
  return {
    kind: "test-workflow",           // ← "表名"，Zod 用 z.literal 校验（TestWorkflowBase）
    version: 1,                      // ← schema 版本，必须是字面量 1
    // ↓ 本 TestWorkflow 自己的身份证，调用方必须传一模一样的 workflowId/revision 对账。
    workflow_id: "libuv-v1.52.1-ctest-debug",
    workflow_revision: 1,            // ← 改了测试方案就 +1
    // ↑ runner 取值只有两种："ctest"（用 CTest 跑）或 "test-spec"（用本项目自定义
    //   的 TestSpec 用例集跑）。libuv 这种自带 CTest 集成的项目当然用 "ctest"。
    runner: "ctest",
    // ── 绑定 BuildWorkflow ─────────────────────────────────────
    // 【作用】声明"我测的是哪个构建方案产出的东西"。宿主会逐字符比对
    //   这两个字段与已解析 BuildWorkflow 的 workflow_id/workflow_revision，
    //   不一致直接拒绝 —— 防止"用 A 配方构建、用 B 配方的参数去测"的错配。
    //   ⚠️ 注意它只绑定【身份】，不绑定产物路径：产物路径由构建的 artifact.paths
    //      提供，ctest 只需要知道 build_dir（见下）。
    build_workflow_id: "libuv-v1.52.1-cmake-debug",
    build_workflow_revision: 1,
    // ↑ BuildWorkflow 的构建目录（与 libuv-build.ts 里 build.build_dir 一致）。
    //   ctest 就是在这个目录里跑的（ctest --build-dir 语义 / runCTest 的 repoDir+build_dir）。
    build_dir: "build",
    // ↑ 多配置生成器下的配置名，等价于 ctest -C Debug。
    //   必须与构建时 --config Debug 一致，否则 ctest 找不到对应的测试可执行文件。
    configuration: "Debug",
    // ↑ 额外的 ctest 命令行参数（比如 -R 按正则筛测试）。空数组 = 不加任何参数。
    //   ⚠️ 这里【不许】塞超时类参数：超时是宿主的 CTestMaterializationPolicy 管的
    //      （timeout_ms 默认 1_200_000 毫秒、parallelism 默认 1）；
    //      另有校验：extra_args 里不许出现 NUL 字符（防注入）。
    extra_args: [],
    // ── 必须出现的顶层测试 ───────────────────────────────────
    // 【作用】"fail-closed 的完备性检查"：解析出的 CTest 结果里必须能看到这几个
    //   顶层测试，少了任何一个说明测试根本没跑全（比如编译开关没开），不能当通过。
    //   【为什么是这两个】libuv 编出两个测试运行器：uv_test（对应动态库版
    //   uv_run_tests）和 uv_test_a（对应静态版 uv_run_tests_a）—— 名字与
    //   build 产物一一对应。⚠️ 它们是"顶层测试"，每个里面还有 ~几百个 TAP 小用例；
    //   CTest 报告说 "2 tests failed out of 2" 指的是这 2 个顶层目标挂了，
    //   不是说全部用例都挂（初学者最容易误解的点）。
    required_top_level_tests: ["uv_test", "uv_test_a"],
    // ↑ 跑 ctest 时附加的环境变量（键值对）。空对象 = 用继承的环境。
    //   例如想固定时区/语言可以在这里写。宿主会按 policy 过滤后传入子进程。
    environment: {},
  };
}
