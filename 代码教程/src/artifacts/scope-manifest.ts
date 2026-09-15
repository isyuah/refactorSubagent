/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/scope-manifest.ts —— 范围清单
 *
 * 【这个文件是干什么的】
 *   定义 ScopeManifest（范围清单），把三个问题一次说清：
 *     editable_files   允许 AI **改**哪些文件、改里面的哪些符号
 *     readable_globs   允许 AI **读**哪些（glob 通配模式）
 *     forbidden_globs  **绝对禁止碰**哪些（最高优先级）
 *   关键在于：这不是"写在提示词里求 AI 自觉"，而是真的会被程序执行——
 *   🔗 src/agents/driver.ts 里挂了一个 PreToolUse Hook，AI 每次调用
 *   Read/Glob/Grep/Write/Edit 之前，程序先用本文件的 matchGlob() 检查
 *   路径，越界直接 deny，并且记进 scope_denials。
 *
 * 【在整个项目里的位置】
 *   谁产生：分析 Agent（analyze.ts 的 Proposal.scope），状态机
 *     CONTRACT_READY → SCOPE_READY 时提交。
 *   谁消费：① driver.ts 的 Hook（实时拦截越界）；② 状态机的 R4 规则
 *     （orchestrator.ts 拿 PatchRecord.changed_files 逐一 matchGlob，
 *     改了不可改的文件 → REJECTED）；③ 重构 Agent 的提示词。
 *
 * 【先修知识】
 *   common.ts、behavior-contract.ts（z.object / .refine / z.infer 已讲过）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/artifacts/scope-manifest.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { z } from "zod";
import { RelPath } from "./common.js";

/** A file the refactor agent is allowed to rewrite, plus target symbols inside it. */
// ← 【语法】const（没有 export）= 本文件私有的"零件 Schema"，不对外。
//   大 Schema 由小 Schema 拼出来，是 Zod 项目的标准搭法：先定义最小
//   单元，再往上堆。
// 【字段】file：一个相对路径；symbols：至少 1 个符号名（函数/变量名），
//   z.array(z.string().min(1)).min(1) 里外两个 min 别看混——里面那个管
//   "每个字符串非空"，外面那个管"数组至少 1 个元素"。
const EditTarget = z.object({
  file: RelPath,
  symbols: z.array(z.string().min(1)).min(1),
});

/**
 * Scope Manifest — separation of Modification Scope vs Observation Scope.
 * editable ⊆ readable is enforced; forbidden wins over both.
 */
// ── ScopeManifest：范围清单 artifact ────────────────────────────────
// 【作用】一次声明"改/读/禁"三条边界，并且立刻用两条 .refine 自查：
//   ① 每个可改文件必须同时也落在可读范围里（能改却不能读，说不通）；
//   ② 可读范围和禁区不能重叠（否则 AI 无所适从）。
// 【glob 是什么】就是 shell 里那种通配写法：src/**/ *.c、test/*.c、
//   config?.h。** 跨任意多层目录，* 匹配一层内的任意字符，? 匹配一个字符。
// 【关系】这份清单会被原样写进重构 Agent 的提示词，同时变成 Hook 的
//   实时边界。原教程 §1.5 特意提醒：forbidden_globs 是"禁止读/搜索"，
//   不只是"不许改"——两个不同的维度，AI 很容易搞混。
export const ScopeManifest = z
  .object({
    kind: z.literal("scope-manifest"),
    version: z.literal(1),

    editable_files: z.array(EditTarget).min(1),
    /** Globs the agent may read to understand behavior. Must include everything editable. */
    readable_globs: z.array(z.string().min(1)).min(1),
    /** Hard denials; checked before readable/editable. */
    // ← .default([])：可以不写这个字段，等价于空数组 = "没有禁区"。
    forbidden_globs: z.array(z.string().min(1)).default([]),
  })
  // ← 规则 ①：每个 editable 文件都要能在 readable_globs 里匹配上。
  .refine(
    (m) =>
      m.editable_files.every((t) => matchGlob(t.file, m.readable_globs)),
    { message: "every editable file must also be covered by readable_globs" },
  )
  // ← 规则 ②：任何一条 readable 都不许和任何一条 forbidden 有重叠的可能。
  // 【语法】!…every(… some(…)) 的嵌套读法："对所有 readable 来说，都不
  //   存在某个 forbidden 与它可能重叠"。注意这里用了"可能重叠"（保守
  //   判断，见下面 globScopesMayOverlap），宁枉勿纵。
  .refine(
    (m) => m.readable_globs.every((readable) => !m.forbidden_globs.some((forbidden) =>
      globScopesMayOverlap(readable, forbidden))),
    { message: "readable_globs and forbidden_globs must not overlap" },
  );

/** Minimal glob matcher supporting **, * and ? — sufficient for manifest checks. */
// ── matchGlob：一个路径能不能被这些 glob 之一匹配 ───────────────────
// 【作用】本文件唯一被外面调用的函数（driver.ts 的 Hook、orchestrator.ts
//   的 R4 检查都 import 它）。问的是"这个路径命中任意一条 glob 吗"。
// 【参数】path：具体文件路径；globs：一组 glob 模式。
// 【返回】boolean，任一命中即 true。
// 【语法】参数类型 globs: readonly string[] —— readonly 表示"函数保证
//   不修改这个数组"，只是个承诺，不影响调用方。globs.some(g => …) 对每条
//   glob 试一遍，有一个 true 就 short-circuit 返回 true。
export function matchGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// ── globToRegExp：把 glob 翻译成正则表达式 ──────────────────────────
// 【作用】glob 和正则是两种通配语法，这里做一次性翻译，然后就能用
//   正则的 .test() 去匹配路径了。整个函数就是逐字符扫描 + 拼字符串。
// 【语法】function globToRegExp(glob: string): RegExp { … }
//   参数名后冒号是"参数类型"，右括号后的冒号是"返回值类型"——TS 的
//   标注写法，运行时会被擦掉，只给编译器看。
// 【语法】let re = "" —— let 声明可重新赋值的变量（const 声明的不能）。
//   re += "…" 是字符串拼接。
// 【语法】glob[i]! 结尾的 ! 叫"非空断言"：本项目开了 TS 的严格索引检查，
//   按下标取数组元素默认类型是"可能是 undefined"，这里我们明确告诉
//   编译器"i 一定在范围内，不会是 undefined"。它不产生任何运行时代码。
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero segments
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      // ← 普通字符也要小心：正则里 . ^ $ 等是特殊符号，必须加反斜杠转义。
      // 【语法】replace(正则, "\\$&") 里 $& 表示"刚匹配到的那一个字符"，
      //   "\\$&" 就是"在它前面加一个反斜杠"。正则 /[.+^${}()|[\]\\]/g 的
      //   末尾 g 表示全局替换（所有出现都换，不是只换第一处）。
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // ← 【语法】`^${re}$` 是模板字符串（反引号）：${…} 会被替换成变量的值。
  //   前后加 ^ 和 $ 表示"整条路径必须完全匹配"，不是"包含即可"。
  //   new RegExp(字符串) 用字符串动态造一个正则对象。
  return new RegExp(`^${re}$`);
}
// ── globScopesMayOverlap：两条 glob 会不会罩到同一片区域 ────────────
// 【作用】给上面的 refine 规则 ② 用。真正的"两个 glob 是否有交集"是很
//   难的数学问题，这里用一个**保守近似**：只比"通配符之前的字面前缀"。
//   只要有一个前缀为空（比如 **/x 就没有字面前缀）、或者一个是另一个的
//   子目录，就认为"可能重叠"——宁可错杀，不可漏放（fail-closed 风格）。
// 【语法】return 后面那串 a || b || c …… 是"有一个成立就 true"，||
//   会短路：前面已经 true 就不再算后面。
function globScopesMayOverlap(left: string, right: string): boolean {
  const leftPrefix = literalGlobPrefix(left);
  const rightPrefix = literalGlobPrefix(right);
  return leftPrefix.length === 0 || rightPrefix.length === 0 ||
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`);
}

// ── literalGlobPrefix：取 glob 里通配符出现前的字面前缀 ─────────────
// 【作用】"src/te*.c" → "src/te"；"**/*.c" → ""（开头就是通配符）。
// 【语法】glob.search(/[…]/) 找第一个匹配位置，找不到返回 -1。
//   三元表达式 条件 ? a : b：这里"没有通配符就取整个字符串，否则截到
//   通配符之前"。末尾 .replace(/[\\/]+$/, "") 把结尾多余的斜杠去掉。
function literalGlobPrefix(glob: string): string {
  const wildcard = glob.search(/[?*]/);
  return (wildcard < 0 ? glob : glob.slice(0, wildcard)).replace(/[\\/]+$/, "");
}

// ← 【语法】又见同名"类型跟着 Schema 走"。注意右边 typeof ScopeManifest
//   指的是上面那个 const（值），左边 ScopeManifest 是新声明的类型名——
//   两个 namespace 互不干扰，所以同一名字可以并存。
export type ScopeManifest = z.infer<typeof ScopeManifest>;
