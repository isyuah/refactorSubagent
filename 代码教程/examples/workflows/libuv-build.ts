/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/workflows/libuv-build.ts —— 【声明式 BuildWorkflow】标准样例
 *
 * 【这个文件是干什么的】
 *   它是 libuv v1.52.1 在 Windows 上的"构建配方"，也是本项目里最标准的
 *   声明式 BuildWorkflow 样例：函数体不干任何活，只 return 一份
 *   BuildWorkflowOutput 对象（workflow_id / revision、environment.spec、
 *   artifact.paths 三大块），真正的构建由宿主照着这份表格代为执行。
 *   等价的命令行大致是：
 *     cmake -S . -B build -DBUILD_TESTING=ON -DLIBUV_BUILD_TESTS=ON -DLIBUV_BUILD_BENCH=OFF
 *     cmake --build build --config Debug
 *   编出来两个测试运行器：build/uv_run_tests（动态链接版）和 build/uv_run_tests_a（静态版）。
 *
 * 【声明式 vs 自驱动（workflowKind）—— 两种形态一张表看懂】
 *   ┌──────────────┬─────────────────────────────┬─────────────────────────────┐
 *   │              │ 声明式（本文件）             │ 自驱动（workflow-driven）    │
 *   ├──────────────┼─────────────────────────────┼─────────────────────────────┤
 *   │ 文件里要写    │ 什么都不用写（缺省就是声明式）│ export const workflowKind =  │
 *   │              │                             │ "workflow-driven"            │
 *   │ 函数返回什么  │ BuildWorkflowOutput 对象     │ void（什么都不返回）          │
 *   │ 什么时候执行  │ 解析期（resolve）就跑一次，   │ execute 阶段才真正运行，      │
 *   │              │ 纯函数、无副作用             │ 且每个 worktree 各跑一次      │
 *   │ 谁来干活      │ 宿主 build-executor.ts 照表格 │ 函数自己用注入的能力          │
 *   │              │ spawn cmake/ninja/gcc        │ ctx.process/adapters/validator│
 *   │ 产物从哪来    │ 函数返回的 artifact.paths    │ 函数自己 ctx.validator.assertFile│
 *   │              │ （resolve 阶段就已知）        │ 断言（跑完才知道）            │
 *   │ 适合谁       │ 常规 CMake/编译器项目（模板   │ 需要 if/循环/多次命令的       │
 *   │              │ 策略能自动生成的就是这种）    │ 复杂项目                     │
 *   └──────────────┴─────────────────────────────┴─────────────────────────────┘
 *   宿主用一行正则识别形态：/export\s+const\s+workflowKind\s*=\s*["']workflow-driven["']/
 *   （src/workflow/build-workflow.ts:65）。本文件没有这句 → 判为声明式。
 *   ⚠️ 自驱动 BuildWorkflow 的 output 在 resolve 阶段是 null（产物只有执行完才知道），
 *      这正是《零基础看懂教程.md》任务 1 里"产物通知断线"的根源。
 *
 * 【在整个项目里的位置】
 *   谁用它：scripts/demo-libuv.ts / scripts/demo-libuv-agent.ts 通过
 *           resolveBuildWorkflow({ entry: "examples/workflows/libuv-build.ts", … }) 加载它；
 *           （demo-libuv.ts 里 workflow.output === null 会直接抛错，因为声明式必有静态 output。）
 *   下游：executeBuildWorkflow() 按 environment.build.kind === "cmake" 分支执行
 *         configure + build 两步；TestWorkflow（libuv-test.ts）通过
 *         build_workflow_id 指回本文件，用它的 build/ 目录跑 ctest。
 * 【先修知识】
 *   ① import type / export default / 对象字面量（echo.ts 已讲）；
 *   ② CMake 的 configure/build 两段式；
 *   ③ 代码教程/src/artifacts/build-workflow.ts（BuildWorkflowOutput 的 Zod 定义）。
 * 【本文件是教程注释版】
 *   原文件：examples/workflows/libuv-build.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 只导入类型（编译后消失）。WorkflowContext 在声明式 workflow 里用不上，
// 所以参数名带下划线（见 direct-build.ts 的解释）。
import type { WorkflowContext } from "../../src/workflow/types.js";

/** libuv v1.52.1 Windows baseline: CMake Debug tests, benchmark disabled. */
// ↑ ↑ 这是原文件自带的英文注释，一字未动：说明这份配方的定位
//    （"Windows 基线：CMake Debug 配置的测试目标，关掉 benchmark"）。
// ── libuvBuildWorkflow：libuv 的构建配方（声明式）────────────────────
// 【作用】返回 BuildWorkflowOutput；【返回值会先过 BuildWorkflowOutput.parse()】，
//         字段名/类型错一个都会让 resolve 直接抛错（fail-closed）。
// 【关系】resolveBuildWorkflow() 解析期执行它并做 4 项检查（id 一致、revision 一致、
//         artifact 身份一致、路径全部是仓库相对路径）；随后 executeBuildWorkflow()
//         在 baseline 和 candidate 两个 worktree 里【各执行一遍】同样的表格，
//         这样新旧两个版本的二进制才是同一配方编出来的，对比才有意义。
export default function libuvBuildWorkflow(_context: WorkflowContext) {
  return {
    kind: "build-workflow-output",   // ← artifact 的"表名"，Zod 用 z.literal 校验
    version: 1,                      // ← schema 版本，必须是字面量 1
    // ↓ workflow 的身份证。脚本会传 workflowId: "libuv-v1.52.1-cmake-debug" 来对账，
    //   不一致就抛 "build workflow id mismatch"。
    workflow_id: "libuv-v1.52.1-cmake-debug",
    workflow_revision: 1,            // ← 同一配方的第 1 版；改配方要 +1（注册表靠它区分）
    // ── environment：构建环境说明书（build-executor 照它分派）────────
    environment: {
      kind: "environment-spec",      // ← EnvironmentSpec 的 kind，固定写法
      version: 1,
      // ── build：kind = "cmake" → 走 CMake 分支（configure + build 两步）──
      build: {
        kind: "cmake",               // ← 其他可选值：direct-compiler / ninja / workflow-driven …
        // ↑ CMakeLists.txt 所在目录（相对 worktree 根）。"." = 就是项目根。
        //   执行时被拼成 `cmake -S . -B build` 里的 -S 参数。
        source_dir: ".",
        // ↑ out-of-source 构建目录（编译产物与源码分开，可整个删掉重来）。
        //   对应 `cmake -B build`，也是 TestWorkflow 里 build_dir 要指向的目录。
        build_dir: "build",
        // ↑ 指定生成器（如 "Ninja"）。null = 让 CMake 自己挑。
        //   实测这台 Windows 主机挑的是 Visual Studio 多配置生成器 —— 所以产物
        //   会落在 build/Debug/ 而不是 build/ 下面（见 artifact.paths 的说明）。
        generator: null,
        // ↑ 只编某个 target。null = 默认 all（全编）。
        target: null,
        // ── configure 阶段的 -D 开关 ────────────────────────────
        configure_flags: [
          // ↑ 打开 CMake 的 CTest 集成（否则不会生成任何 test 目标，ctest 无事可跑）。
          "-DBUILD_TESTING=ON",
          // ↑ libuv 自己的开关：把测试运行器（uv_run_tests / uv_run_tests_a）编出来。
          "-DLIBUV_BUILD_TESTS=ON",
          // ↑ 不编 benchmark（省一半编译时间，benchmark 对行为验证没用）。
          "-DLIBUV_BUILD_BENCH=OFF",
        ],
        // ↑ build 阶段参数，拼在 `cmake --build build` 后面。
        //   "--config Debug" 只在多配置生成器（VS/Xcode）下有意义：选 Debug 配置，
        //   这也是产物出现在 build/Debug/ 目录的原因。
        build_flags: ["--config", "Debug"],
        // ↑ "期望出现的可执行文件"。⚠️ 它只是单个字符串（BuildSpec 的 output 字段），
        //   而下面 artifact.paths 才是完整的产物清单 —— 两者都做存在性检查。
        //   Windows 上执行器会自动补 .exe，CMake 分支还会额外尝试 build/Debug/ 等变体。
        output: "build/uv_run_tests",
      },
      sanitizers: [],                // ← 不启用 ASan/UBSan（本机缺 -lasan/-lubsan，阶段三 UNSUPPORTED）
      determinism: {                 // ← libuv 依赖时间/随机/DNS，本项目这里全部不冻结：
        frozen_time_epoch_ms: null,  //    这正是它有一批"环境敏感失败"的原因之一
        random_seed: null,           //    （对比时它们会出现在 added/removed failures 里）。
        intercept_headers: [],       //    🔗 对比 trim-app：那边 frozen/seed/头文件三件套全用上
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },  // ← 跑用例时用全新临时目录
    },
    // ── artifact：本次构建【承诺】产出的逻辑产物清单 ───────────────────
    // 【作用】构建结束后宿主逐个检查这些文件存在；缺任何一个 → status: "failed"
    //         （fail-closed：没有产物就没有证据，后续测试无从谈起）。
    artifact: {
      kind: "test-suite",            // ← 产物类型：一套测试（区别于 executable / library）
      version: 1,
      // ⚠️ 必须与外层 workflow_id / workflow_revision 完全一致，否则解析报错。
      workflow_id: "libuv-v1.52.1-cmake-debug",
      workflow_revision: 1,
      // ↑【逐字段】键 = 逻辑名（下游引用它，不硬编码路径），值 = 仓库相对路径。
      //   shared_tests: 动态链接 libuv 的测试运行器（跑时要能找到 uv.dll）
      //   static_tests: 静态链接版，libuv 惯例用 _a 后缀（uv_run_tests_a），
      //                 不依赖 DLL，是最常用的那一个（CTest 顶层目标同名）。
      //   ⚠️ Windows 多配置生成器会把它们放进 build/Debug/ —— 执行器的
      //      artifactCandidates() 会同时尝试 build/uv_run_tests(.exe) 和
      //      build/Debug/uv_run_tests(.exe)，所以这份声明依然能通过检查。
      paths: {
        shared_tests: "build/uv_run_tests",
        static_tests: "build/uv_run_tests_a",
      },
      // ↑ 自由备注（宿主不解读，只透传给报告/看板/注册表）。
      metadata: {
        project: "libuv",
        version: "v1.52.1",
        configuration: "Debug",
        ctest: true,                 // ← 提示"这个产物是给 ctest 用的"，对应 TestWorkflow
      },
    },
  };
}
