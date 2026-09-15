/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/workflows/echo.ts —— workflow 的"Hello World"
 *
 * 【这个文件是干什么的】
 *   全仓库最小的一段 workflow 源码（正文只有 6 行）。它什么都不构建、什么都不测，
 *   只是把"宿主注入给我的上下文对象"里的三个字段原样抄回来返回。
 *   作用是给第一次接触本项目的人看清楚 workflow 的固定外形：
 *     一个 TypeScript 文件 = 一个【默认导出的函数】
 *     （export default function …），宿主会加载这个文件、调用这个函数、
 *     把函数的返回值当作 workflow 的"结果"。
 *
 * 【在整个项目里的位置】
 *   它【不】被任何脚本、任何测试引用（全仓 grep "echo.ts" 无一处命中），
 *   是一份纯粹的"外形样例"。想看真的能跑的样例请看同目录：
 *     - direct-build.ts   声明式 BuildWorkflow（gcc 直接编译）
 *     - libuv-build.ts    声明式 BuildWorkflow（CMake，libuv 基准）
 *     - libuv-test.ts     声明式 TestWorkflow（ctest）
 *   加载并调用这个函数的代码在 src/workflow/runner.ts（runWorkflow）：
 *   它 spawn 一个 bun 子进程执行本文件，把返回值塞进 WorkflowRunResult.result。
 *
 * 【先修知识】
 *   ① TS 的 `import type` / `export default`（下面逐行讲）；
 *   ② 对象字面量（{ key: value } 那种写法）；
 *   ③ 建议先读 代码教程/src/workflow/types.ts 的文件头（"两个进程、一条 JSON 管道"）。
 * 【本文件是教程注释版】
 *   原文件：examples/workflows/echo.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 【语法】`import type { X } from "…"`：只导入"类型"，不导入"值"。
// 编译成 JS 后这一行会整个消失（类型在运行时不存在），所以它不会真的去加载
// src/workflow/types.ts 那个模块，也不会把任何代码打进产物。
// 这里导入的 WorkflowContext 是宿主传给本函数的那个参数的类型：
// 里面有 apiVersion / workspaceRoot / input / facts / capabilities（fs、process、
// tools、adapters、validator、plan、expect）等字段。本项目所有 workflow 文件的
// 第一行都是这句 —— 它是 workflow 作者与宿主之间的"合同"。
// （⚠️ 文件路径带 `.js` 后缀不是笔误：TS 的 ESM 约定"导入路径写编译后的名字"，
//  编译/运行时才找得到同名的 .ts 源码。）
import type { WorkflowContext } from "../../src/workflow/types.js";

// ── echoWorkflow：默认导出的 workflow 函数 ───────────────────────────
// 【作用】打印（抄写）宿主注入的上下文。这是最典型的"自驱动函数"外形。
// 【语法】`export default`：模块默认导出。宿主加载这个文件后拿到的"那个东西"
//         就是它，所以宿主不用知道函数叫什么名字（echoWorkflow 这个名字随便改）。
//         本项目的硬性约定是：【每个 workflow 文件必须有且只有一个 default 导出的函数】。
// 【参数】context: WorkflowContext —— 宿主注入的能力包。本样例只读三个"零风险"字段：
//           - apiVersion:     常量 1（workflow API 的版本号，宿主用它做兼容判断）
//           - workspaceRoot:  字符串，被操作项目（worktree）的绝对路径
//           - input:          unknown 类型，宿主塞进来的输入（声明式 BuildWorkflow
//                             的解析阶段是 { kind: "build-workflow-input", version: 1 }）
//         参数名前的下划线约定（如 direct-build.ts 的 _context）表示"这个参数我不用"；
//         本文件反而不加下划线，因为它确实用了。
// 【返回】一个普通的对象字面量（下面那个 { … }）。它会被 runner 序列化成 JSON，
//         放进 WorkflowRunResult.result 带回主进程。
// 【关系】谁调用它：只有 src/workflow/runner.ts（runWorkflow）会真正执行它。
//         失败会怎样：本函数体里没有任何可能抛错的语句，所以它只会 pass。
// ⚠️ 注意：这个返回值【不是】合法的 BuildWorkflowOutput（缺 kind/version/environment/
//     artifact 等字段）。如果你把它当 BuildWorkflow 交给 resolveBuildWorkflow()，
//     那句 `BuildWorkflowOutput.parse(result.result)` 会立刻抛错 —— 这正是本项目
//     fail-closed 哲学的体现：返回的东西必须过 Zod Schema 才算数，"能跑"不等于"合法"。
export default function echoWorkflow(context: WorkflowContext) {
  // 【语法】对象字面量 + 简写意图：`apiVersion: context.apiVersion` 是
  //         "新对象的 apiVersion 字段 = 旧对象的 apiVersion 字段"。
  //         （TS 里若键名与变量名完全相同，可以写成简写 `{ apiVersion }`，
  //          这里刻意写全，便于小白看清楚"谁赋给谁"。）
  return {
    apiVersion: context.apiVersion,        // ← 常量 1，原样回传
    workspaceRoot: context.workspaceRoot,  // ← 项目根目录绝对路径，原样回传
    input: context.input,                  // ← 宿主给的输入，原样回传
    // ↑ 注意最后一行 `};` 前有逗号（trailing comma）：JS/TS 允许，方便以后加字段
    //   时不用改上一行。
  };
}
