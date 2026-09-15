/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/source-policy.ts —— workflow 源码的"安检门"
 *
 * 【这个文件是干什么的】
 *   workflow 也是不可信代码（它可能是 AI 生成的）。在把它交给子进程执行之前，
 *   先做一次【文本级】静态检查：
 *     ① 文件存在；
 *     ② 扩展名必须是 .ts/.tsx/.js/.jsx；
 *     ③ 源码里不许出现"直接摸宿主能力"的写法（import node:/bun:/fs/child_process、
 *        直接用全局 process、直接用 Bun.*）；
 *     ④ 源码必须能被 Bun 的转译器顺利转译（= 语法正确，类型注解可保留）。
 *   任何一条不过 → 返回 ok:false + 原因。runner.ts 拿到 false 就直接返回
 *   status:"rejected"，【连子进程都不会启动】—— 这是 fail-closed 的第一道门。
 *
 * 【在整个项目里的位置】
 *   上游（谁调用 checkWorkflowSource）：
 *     - src/workflow/runner.ts          （每次执行前）
 *     - src/workflow/build-workflow.ts / test-workflow.ts（解析/校验前）
 *     - src/workflow/registry.ts / test-registry.ts（入库和加载时重验）
 *   下游：node:fs（读源文件）、Bun.Transpiler（试转译）。
 * 【为什么必须禁这些】worker.ts 子进程本身是可以解析 node: 内置模块的
 *   （worker 自己就 import 了 node:url）—— 所以"子进程拿不到 fs"并不是天然的，
 *   而是靠这里把 workflow 源码里所有能摸到宿主 API 的入口全部封掉，
 *   逼它只能走 capability 协议向 broker 申请。这层检查是【文本正则】，
 *   不是语法树分析，属于"便宜的第一道闸"（真正的权限控制在 capabilities.ts 的 policy）。
 * 【先修知识】本文件是讲"正则表达式在真实代码里怎么用"的最好材料。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/source-policy.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// ── FORBIDDEN_IMPORTS：禁用模式清单（一个正则数组）────────────────────
// 【作用】源码里命中任何一条就不放行。
// 【语法】数组元素的类型是 RegExp —— 正则字面量 /…/ 在 TS/JS 里就是值，
//   可以放进数组、当参数传、调用 .test()。
const FORBIDDEN_IMPORTS = [
  // ① `import { … } from "node:fs"` —— 显式带 node:/bun: 协议前缀的导入。
  //    \s+ 表示 from 和引号之间至少要有一个空白。
  /from\s+["'](?:node:|bun:)/,
  // ② 动态导入：`await import("node:fs")`（防绕过：不用 from 也能加载模块）。
  /import\s*\(\s*["'](?:node:|bun:)/,
  // ③ CommonJS 老写法：`require("node:fs")`。
  /require\s*\(\s*["'](?:node:|bun:)/,
  // ④ 不带 node: 前缀的裸模块名（Node/Bun 会自动按内置模块解析！）。
  //    (?:…|…) 是一串可选名的"或"；注意 ①~③ 用 \s+、这里用 \s*，
  //    所以 `from"fs"` 这种没空格的怪写法也逃不掉。
  //    封的是 fs（文件）、child_process（起进程）、worker_threads（线程）、
  //    net/http/https（网络）、os（系统信息）、process（node:process 模块）。
  /from\s*["'](?:fs|child_process|worker_threads|net|http|https|os|process)["']/,
  // ⑤ 全局对象 process 的属性访问 —— 但【例外】允许 .run / .start / .wait / .stop。
  //    【为什么留这个口子】这四个名字正好是 WorkflowProcess 能力的四个方法
  //    （见 types.ts）。workflow 作者如果写了 `const { process } = context;` 再
  //    `process.run({...})`，这里允许通过；而 Node 的全局 process（process.env /
  //    process.exit / process.argv…）全被拦下。
  //    【语法】★★★ 环视断言（lookaround）★★★ —— 它们匹配"位置"而不是字符：
  //    (?<![\w.])  负向后行：左边【不能】是字母数字下划线或点号。
  //                作用是放过 context.process.run 这种成员访问（前面有点），
  //                也放过 myprocess.exit（前面有字母）。
  //    process\s*\. 要匹配的正文：process 后任意空白再一个点
  //    (?!run\b|start\b|wait\b|stop\b) 负向前行：右边【不能】是这四个词之一
  //                （\b 词边界，防止 process.runtime 也被误放行）。
  //    合起来：只拦"独立出现的 process.<别的>"。
  /(?<![\w.])process\s*\.(?!run\b|start\b|wait\b|stop\b)/,
  // ⑥ 直接用 Bun 全局对象（Bun.file / Bun.write / Bun.spawn 都能绕开 broker）。
  /(?<![\w.])Bun\s*\./,
];

// ── WorkflowSourceCheck：检查结果的形状────────────────────────────
// 【参数】ok：过没过；source：读到的源码原文（检查没过也带回去，
//   方便上层记日志/存档）；reason：失败原因（人读），成功时是 null。
export interface WorkflowSourceCheck {
  ok: boolean;
  source: string;
  reason: string | null;
}

// ── checkWorkflowSource：本文件唯一导出的函数（安检门本体）──────────────
// 【参数】entry：workflow 源码路径（绝对或相对宿主当前目录）。
// 【返回】WorkflowSourceCheck。【注意】它不 throw —— "文件不存在"也是检查结果，
//   不是异常。这符合项目风格：给调用方一个可以判断的对象，而不是让它写 try/catch。
// 【关系】四个失败出口分别在下面四段，成功出口只有一个（最后一行 return）。
export function checkWorkflowSource(entry: string): WorkflowSourceCheck {
  const source = readWorkflowSource(entry);
  if (source === null) {
    return { ok: false, source: "", reason: `workflow entry does not exist: ${entry}` };
  }
  // 【语法】/\.(?:ts|tsx|js|jsx)$/.test(entry)：
  //   \. 一个真正的点；(?:ts|tsx|js|jsx) 四种扩展名任一；$ 字符串结尾。
  //   .test(str) 返回布尔值 —— 只判断"有没有匹配"，不关心匹配到什么。
  if (!/\.(?:ts|tsx|js|jsx)$/.test(entry)) {
    return { ok: false, source, reason: "workflow entry must be a TypeScript or JavaScript module" };
  }
  // 【语法】★★★ .find(谓词) ★★★：返回数组里第一个满足条件的元素，找不到返回 undefined。
  //   这里顺便把"是哪条正则命中的"拿到手 —— 不过当前代码只报统一的一句 reason，
  //   没有用具体是哪条（这是可以改进的小地方：把 pattern 也拼进 reason 会更好定位）。
  const forbidden = FORBIDDEN_IMPORTS.find((pattern) => pattern.test(source));
  if (forbidden !== undefined) {
    return {
      ok: false,
      source,
      reason: "workflow directly imports a host API; use injected capabilities instead",
      // ↑ 报错信息同时是给 AI 的修改指令：请改用 ctx.fs / ctx.process 这些注入的能力。
    };
  }
  try {
    // 【作用】Bun.Transpiler 是 Bun 内置的转译器（TS → JS），transformSync 同步地把
    //   源码转一遍。这里【不使用】转译结果，只为验证一件事：源码能被合法解析。
    //   语法错误（少个括号、非法字符）在这一步就会被抓住，而不是等到子进程里
    //   动态 import 时才炸 —— 更早失败、报错更便宜。
    //   错误信息里写 "type-preserving transpilation"：Bun 转译时保留类型注解的剥离
    //   方式，不做完整类型检查（那要交给 bunx tsc --noEmit）。
    new Bun.Transpiler({ loader: loaderFor(entry) }).transformSync(source);
  } catch (error) {
    return {
      ok: false,
      source,
      reason: `workflow syntax/type-preserving transpilation failed: ${errorMessage(error)}`,
    };
  }
  return { ok: true, source, reason: null };
}

// ── readWorkflowSource：读文件（私有）──────────────────────────────
// 【返回】string = 源码；null = 文件不存在（用 null 而不是空串，区分"读到了空文件"）。
// 【语法】isAbsolute 判断是否已是绝对路径；resolve(process.cwd(), entry) 把相对路径
//   拼到宿主当前工作目录后面。（runner.ts 里有个几乎一样的 resolveEntry。）
function readWorkflowSource(entry: string): string | null {
  const absolute = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

// ── loaderFor：按扩展名告诉转译器该按什么语法解析──────────────────────
// 【返回】"ts" | "tsx" | "jsx" | "js" —— 正好是 Bun.Transpiler 认的四种 loader。
//   x 结尾的两种意味着文件里可能含 JSX 标签（React 那种 <div>）。
// 【语法】一串提前 return：从最特殊的（.tsx）往下判断，最后兜底 "ts"。
function loaderFor(entry: string): "ts" | "tsx" | "js" | "jsx" {
  if (entry.endsWith(".tsx")) return "tsx";
  if (entry.endsWith(".jsx")) return "jsx";
  if (entry.endsWith(".js")) return "js";
  return "ts";
}

// ── errorMessage：把"未知类型的异常"变成字符串（私有）──────────────────
// 【为什么需要】JS 里 throw 的可以是任何值（一个字符串、一个数字都行），
//   catch 到的 err 在 TS 里默认是 unknown，不能直接 .message。
// 【语法】`error instanceof Error ? error.message : String(error)` 三目运算符：
//   是 Error 实例就取 message；否则用 String() 强转成文本兜底。
//   这个 4 行小函数在项目里被复制了多次（capabilities.ts 等都有同款）——
//   它是处理 unknown 异常的标准姿势。
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
