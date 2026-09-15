/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/workflows/direct-build.ts —— 声明式 BuildWorkflow（最简版）
 *
 * 【这个文件是干什么的】
 *   用"填表格"的方式描述一次构建：不调用任何能力、不 spawn 任何进程，
 *   函数体只是【return 一个对象字面量】，把"该怎么编译"完整写在返回值里。
 *   这就是本项目说的【声明式（declarative）】形态：
 *     函数在"解析阶段"就被宿主跑一次 → 返回值过 Zod Schema 校验 →
 *     真正的编译由宿主（src/workflow/build-executor.ts）按表格代为执行。
 *   与之相对的是【自驱动（workflow-driven）】形态：函数 return void，在 execute
 *   阶段亲自用注入的 ctx.process / ctx.adapters 把 cmake/gcc 跑起来
 *   （文件里要写 `export const workflowKind = "workflow-driven"`）。
 *   两种形态的对比表见同目录 libuv-build.ts 的文件头。
 *
 * 【这个样例具体在干嘛】
 *   相当于替你敲了这一行命令：
 *     gcc -Wall src/main.c -o build/app       （Windows 上自动变成 build/app.exe）
 *   workflow_id 是 "direct-smoke" —— 它是个"冒烟样例"，用来演示 direct-compiler
 *   这条最简单的构建路径（不经过 CMake/Ninja，直接喊编译器）。
 *
 * 【在整个项目里的位置】
 *   上游：src/workflow/build-workflow.ts 的 resolveBuildWorkflow() 会在解析期
 *         加载并执行本函数，用 BuildWorkflowOutput.parse() 校验返回值，
 *         再把 environment.build.kind === "direct-compiler" 的 requiredTools
 *         记为 ["gcc"]（主机上必须有 gcc，否则后续 fail-closed 阻断）。
 *   下游：src/workflow/build-executor.ts 的 executeBuildWorkflow() 读这份表格：
 *         拼出 gcc 的参数列表（flags + -D 宏 + sources + -o output）、
 *         通过 Capability Broker 真正 spawn gcc，最后检查 artifact.paths 里的
 *         文件确实存在（存在才算 pass）。
 *   ⚠️ 它同样没有被任何脚本/测试引用，是给人读的参考样例；
 *      真正被脚本加载的是 libuv-build.ts（scripts/demo-libuv.ts / demo-libuv-agent.ts）。
 *
 * 【先修知识】
 *   ① import type / export default / 对象字面量（见 echo.ts）；
 *   ② Zod Schema 的概念（"海关安检"）：返回值必须过 src/artifacts/build-workflow.ts
 *     里的 BuildWorkflowOutput，字段名错一个、类型错一个都会被拒。
 * 【本文件是教程注释版】
 *   原文件：examples/workflows/direct-build.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 只导入类型 WorkflowContext（编译后消失），见 echo.ts 的详细解释。
import type { WorkflowContext } from "../../src/workflow/types.js";

// ── directBuildWorkflow：声明式 BuildWorkflow 的标准外形 ─────────────
// 【作用】返回一份"构建说明书"（BuildWorkflowOutput）。
// 【语法】参数名 `_context` 以【下划线开头】是 TS/JS 圈的通行约定：
//         "这个参数我收到了但故意不用"。声明式 workflow 天生不需要能力包 ——
//         它只填表，不干活。同时这也避免 linter 报"参数未使用"。
// 【返回】BuildWorkflowOutput。必须同时满足（resolveBuildWorkflow 里逐条检查）：
//           1) 过 BuildWorkflowOutput.parse()（Zod）；
//           2) workflow_id / workflow_revision 与调用方声明的一致（否则 id mismatch）；
//           3) artifact.workflow_id/revision 必须与外层一致（否则 "identity does not match"）；
//           4) artifact.paths 的每个值都必须是"仓库相对路径"（不许写绝对路径、不许逃出工作区）。
// 【关系】resolveBuildWorkflow() 在解析期跑它（默认超时 60_000 毫秒）；
//         executeBuildWorkflow() 在执行期照着它编译；artifact.paths 还会被
//         TestWorkflow/CTest 阶段引用（"构建产出了什么可执行文件"）。
export default function directBuildWorkflow(_context: WorkflowContext) {
  // 一个普通局部变量。声明式 workflow 里可以有任意普通 TS 代码（计算、拼数组），
  // 前提是【纯函数】：同样的输入要返回同样的对象，不许有副作用（不写文件、不发进程）。
  // 这个值在下面第 15 行被引用 —— 对象字面量里可以直接引用外部变量。
  const compiler = "gcc";
  return {
    // ↑ 字面量类型字段：Zod 用 z.literal("build-workflow-output") 检查它，
    //   写错一个字符都会被拒。它是这份数据的"表名"（本项目所有 artifact 都带 kind）。
    kind: "build-workflow-output",
    // ↑ schema 版本号，必须是字面量 1（z.literal(1)）。将来字段大改时才 bump。
    version: 1,
    // ↑ 这份构建方案的"身份证"。调用方（如脚本）可以传 workflowId 期望值，
    //   不一致直接抛错 —— 防止"拿了别的项目的构建方案"这种张冠李戴。
    workflow_id: "direct-smoke",
    // ↑ 同一 id 的第几版。改了方案（比如换编译参数）就 +1，注册表靠它区分新旧。
    workflow_revision: 3,
    // ── environment：构建环境说明书（兼容桥接层）──────────────────────
    // 【语法】嵌套对象字面量：对象的字段又是对象。Zod 里对应 EnvironmentSpec。
    // 【关系】build-executor 按 environment.build.kind 分派到不同的执行器
    //         （direct-compiler / cmake / ninja / workflow-driven / …）。
    environment: {
      kind: "environment-spec",              // ← EnvironmentSpec 的 kind，固定
      version: 1,
      // ── build：具体的构建方式 ──────────────────────────────────
      build: {
        // ↑ kind 决定走哪条执行分支。这里 "direct-compiler" = 直接调编译器，
        //   对应 build-executor.ts 里 `build.kind === "direct-compiler"` 那一支。
        kind: "direct-compiler",
        // ↑ 用哪个编译器（必须是宿主 preflight 实测存在的工具名）。
        //   编译产物在 Windows 上缺 .exe 后缀时执行器会自动补（build/app → build/app.exe）。
        compiler,
        // ↑【语法】这是"属性名与变量同名"的简写：等价于 `compiler: compiler`。
        //   生成的编译命令里原样追加：-Wall（开所有常用警告）。
        flags: ["-Wall"],
        // ↑ 预定义宏，每个条目会被拼成 -D键=值。空对象 = 不定义任何宏。
        defines: {},
        // ↑ 要一起编译的源文件列表（相对工作区根）。⚠️ 至少 1 个（Zod .min(1)）。
        //   本样例只编 main.c —— 如果那个 main.c 引用了别处的函数就会链接失败，
        //   说明这份样例是"命令形状演示"，不是能直接编过 trim-app 的完整配方。
        sources: ["main.c"],
        // ↑ 期望产出的可执行文件路径（仓库相对）。
        //   direct-compiler 分支还会做 artifact 存在性检查（缺失 → status: "failed"）。
        output: "build/app",
      },
      // ↑ 要启用的消毒器（ASan/UBSan 之类）。空数组 = 不启用。
      //   【关系】HostPreflight 必须实测证明每一个都可用，否则 fail-closed。
      sanitizers: [],
      // ── determinism：确定性声明 ────────────────────────────────
      // 【作用】告诉验证环境"这个项目依赖时间/随机数，请把它们钉死"。
      //   frozen_time_epoch_ms: 把 time() 冻结到的毫秒时间戳（null = 不冻结）
      //   random_seed:          rand() 的固定种子（null = 不播种）
      //   intercept_headers:    强制 #include 进每个编译单元的头文件（见
      //                         examples/trim-app/base/shim/determinism.h 的实战用法）
      // 🔗 见 examples/trim-app/base/shim/determinism.h 注释版（把 time()/rand() 重定向）。
      determinism: {
        frozen_time_epoch_ms: null,
        random_seed: null,
        intercept_headers: [],
      },
      // ↑ 运行测试用例时的工作目录策略。目前只有一种取值：每次用全新的临时目录，
      //   保证用例之间、运行之间互不污染（Zod 是 z.literal，写别的值过不了校验）。
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    },
    // ── artifact：这次构建【承诺】产出的东西 ─────────────────────────
    // 【作用】声明"逻辑产物名 → 文件路径"。宿主构建完成后逐个检查文件确实存在，
    //   缺任何一个整次构建判 failed（fail-closed：没有产物 = 没有证据）。
    artifact: {
      kind: "executable",                    // ← 产物类型：可执行文件（其他可选值：
      //   library / test-suite / service / custom，见 BuildArtifactKind）
      version: 1,
      // ⚠️ 必须与外层 workflow_id / workflow_revision 完全一致，
      //    否则 resolveBuildWorkflow 抛 "build artifact identity does not match"。
      workflow_id: "direct-smoke",
      workflow_revision: 3,
      // ↑【语法】键是"逻辑名"（随便起，给人看的），值是"仓库相对路径"。
      //   下游（TestWorkflow、Dashboard、报告）都引用逻辑名而不是硬编码路径。
      //   必须至少有 1 个条目（Zod refine 检查），且不允许绝对路径/越出工作区。
      paths: { app: "build/app" },
      // ↑ 自由格式的备注字段（record of unknown），宿主不解读，只透传给报告/看板。
      metadata: { source: "example" },
    },
  };
}
