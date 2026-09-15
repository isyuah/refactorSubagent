/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/environment-spec.ts —— 构建环境说明
 *
 * 【这个文件是干什么的】
 *   定义 EnvironmentSpec：描述"这个 C 项目该怎么编译、怎么运行"——
 *   用什么编译器/构建系统、加什么参数、产出哪个可执行文件、要不要开
 *   sanitizer、时间/随机数怎么固定。
 *   它内部定义了 6 种"构建形态"（BuildSpec），用 z.union 合在一起：
 *     direct-compiler  直接一条 gcc 命令编译
 *     cmake            走 CMake
 *     ninja            直接走 Ninja
 *     workflow-driven  由 workflow 源码自己指挥构建（最新方向）
 *     shell-command    一条 shell 命令
 *     legacy           旧版结构（兼容老会话/测试样例）
 *
 * 【在整个项目里的位置】
 *   谁产生：分析 Agent（analyze.ts 的 Proposal.env），状态机
 *     TESTS_READY → ENV_READY（或 TEST_WORKFLOW_READY → ENV_READY）。
 *   ⚠️ 原教程 §1.8 明确提醒：这份 spec 只是 AI 的**建议**。真正执行以
 *     resolve 出来的 Workflow 为准（用户可能 forced 指定别的）；
 *     workflow 路径里 src/runtime/workflow-pipeline.ts 会用
 *     EnvironmentSpec.parse(...) 把"实际采用的构建方式"重新落成这个形状。
 *   谁消费：旧路径 src/runtime/build-adapter.ts / builder.ts 按它执行编译；
 *     新路径 BuildWorkflowOutput.environment 复用它当兼容桥（见
 *     build-workflow.ts）。
 *
 * 【先修知识】
 *   common.ts（RelPath）、sanitizer.ts（SanitizerKind，本文件 import 它）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/artifacts/environment-spec.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { z } from "zod";
import { RelPath } from "./common.js";
import { SanitizerKind } from "./sanitizer.js";

// ── DirectCompilerBuild：一条编译命令直接搞定 ───────────────────────
// 【作用】最朴素的形态：gcc 一把梭，源文件列表、宏定义、输出路径都写死。
// 【语法】defines: z.record(z.string()) —— z.record(V) 表示"一个对象，
//   键名随便，但每个值都得是 V 类型"。这里就是 { 宏名: 宏值 }，
//   例如 { LOG_LEVEL: "3" }。.default({}) 表示可省略，省略就是空对象。
const DirectCompilerBuild = z.object({
  kind: z.literal("direct-compiler"),
  compiler: z.string().min(1),
  flags: z.array(z.string()).default([]),
  defines: z.record(z.string()).default({}),
  sources: z.array(RelPath).min(1),
  output: RelPath,
});

// ── CMakeBuild：走 CMake ────────────────────────────────────────────
// 【作用】主流 C 项目的形态。注意它有大量 .default(...)：AI 提案时可以
//   少写很多字段，程序读出来时字段永远是齐的。
// 【语法】z.string().min(1).nullable().default(null) 三个链一起读：
//   .nullable() = 可以是 null；.default(null) = 没写就当 null。
//   合起来是"可以不写、可以写 null、也可以写字符串"。generator 为 null
//   表示"让 CMake 自己挑生成器"。
const CMakeBuild = z.object({
  kind: z.literal("cmake"),
  /** Directory containing CMakeLists.txt, relative to the worktree root. */
  source_dir: RelPath.default("."),
  /** Out-of-source CMake build directory. */
  build_dir: RelPath.default("build"),
  /** Optional generator, e.g. `Ninja`; null lets CMake choose. */
  generator: z.string().min(1).nullable().default(null),
  /** Optional CMake target; null uses the default all target. */
  target: z.string().min(1).nullable().default(null),
  configure_flags: z.array(z.string()).default([]),
  build_flags: z.array(z.string()).default([]),
  /** Expected repo-relative executable path after the build. */
  output: RelPath,
});
// ── NinjaBuild：直接调 Ninja（不经过 CMake 生成步骤）────────────────
const NinjaBuild = z.object({
  kind: z.literal("ninja"),
  /** Directory containing build.ninja, relative to the worktree root. */
  build_dir: RelPath.default("."),
  /** Optional Ninja target; null builds the graph's default target. */
  target: z.string().min(1).nullable().default(null),
  build_flags: z.array(z.string()).default([]),
  /** Expected repo-relative executable path after the build. */
  output: RelPath,
});

/**
 * Commanded by the workflow function itself: the host re-runs the workflow
 * and the function drives the build through injected capabilities. The
 * workflow returns artifact paths in its result; no declarative plan exists.
 */
// ── WorkflowDrivenBuild：workflow 自己驱动构建 ───────────────────────
// 【作用】最新的方向：构建步骤不再用这份 JSON 描述，而是写在一段
//   TypeScript workflow 源码里（它通过能力代理向宿主申请"帮我跑 cmake"）。
//   所以这里只剩一个 kind 标记，没有任何计划字段。
// 🔗 详见 src/workflow/build-workflow.ts / build-executor.ts；
//   也解释了为什么这个对象没有 output 字段——产物要到 execute 阶段才知道。
const WorkflowDrivenBuild = z.object({
  kind: z.literal("workflow-driven"),
});

// ── ShellCommandBuild / LegacyBuild ─────────────────────────────────
// 【作用】shell-command = "跑一条命令，产物是这个路径"；legacy 是项目
//   早期的结构，注释原话说明它是为了老会话和测试样例继续能过校验而保留。
const ShellCommandBuild = z.object({
  kind: z.literal("shell-command"),
  command: z.string().min(1),
  binary: RelPath,
});

/** Pre-structured-plan shape retained for old sessions and fixtures. */
const LegacyBuild = z.object({
  cc: z.string().min(1).default("gcc"),
  flags: z.array(z.string()).default([]),
  defines: z.record(z.string()).default({}),
  command: z.string().min(1),
  binary: RelPath,
});
 // ← 【语法】z.union([A, B, C, …]) = "必须是其中某一个"。
 // 【这行怎么读】依次试每个候选，谁校验通过就用谁。6 种形态都有各自的
 //   kind 字面量，所以实际是靠 kind 区分的。
 // ⚠️ 细节：Zod 另有一个 z.discriminatedUnion（先看 kind 再分派，更快、
 //   报错更准）。这里用的是普通 union——index.ts 的注释原话解释了原因：
 //   有些 artifact 带跨字段 refine，没法用 discriminatedUnion，索性统一。
 // ⚠️ 注意这一段原有的缩进并不整齐（有的行 2 个空格、有的 3 个），
 //   原代码如此，注释版必须保持一致。
 export const BuildSpec = z.union([
   DirectCompilerBuild,
   CMakeBuild,
  NinjaBuild,
  WorkflowDrivenBuild,
   ShellCommandBuild,
   LegacyBuild,
 ]);

// ── EnvironmentSpec：环境说明 artifact ──────────────────────────────
// 【作用】把"构建方式 + sanitizer + 确定性设置 + 沙箱策略"打包。
// 【语法】z.number().int() = 必须是整数。后面接 .nullable() 表示可以
//   为 null：frozen_time_epoch_ms 为 null 就是"不冻结时间"（毫秒时间戳）。
// 【字段】sandbox.run_cwd_strategy 只有 z.literal("fresh_temp_dir") 一种
//   取值——每次运行都给一个全新临时目录当工作目录，这条目前是硬规定，
//   所以枚举只有一个值。
export const EnvironmentSpec = z.object({
  kind: z.literal("environment-spec"),
  version: z.literal(1),
  build: BuildSpec,
  /** Requested instrumentation; HostPreflight must prove each one available. */
  // ← 要开的检测器（address/undefined）。⚠️ "要"不等于"能"：真正可不可用
  //   由程序实测的 HostPreflight 说了算（🔗 host-preflight.ts）。
  sanitizers: z.array(SanitizerKind).default([]),
  determinism: z.object({
    frozen_time_epoch_ms: z.number().int().nullable(),
    random_seed: z.number().int().nullable(),
    intercept_headers: z.array(RelPath).default([]),
  }),
  sandbox: z.object({
    run_cwd_strategy: z.literal("fresh_temp_dir"),
  }),
});

// ← 【语法】一个文件导出多个类型时，可以在下面连续写几行 export type。
//   注意 WorkflowDrivenBuildSpec 这个类型名和上面 const 的名字不同——
//   因为"值"已经占了 WorkflowDrivenBuild 这个名字，类型想换个叫法也行。
export type BuildSpec = z.infer<typeof BuildSpec>;
export type DirectCompilerBuild = z.infer<typeof DirectCompilerBuild>;
export type NinjaBuild = z.infer<typeof NinjaBuild>;
export type WorkflowDrivenBuildSpec = z.infer<typeof WorkflowDrivenBuild>;
export type EnvironmentSpec = z.infer<typeof EnvironmentSpec>;
