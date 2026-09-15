/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/expectation-compare.ts —— ctx.expect 声明的"按位置配对"比较器
 *
 * 【这个文件是干什么的】
 *   自驱动 TestWorkflow（源码里写了 `export const workflowKind =
 *   "test-workflow-driven"` 的那种）会在 baseline worktree 里跑一遍、再在
 *   candidate worktree 里跑一遍。两遍跑的是**同一份源码**，函数自己不知道
 *   自己在哪一侧，它只管把观测到的值用 ctx.expect("名字", 值) 申报出去。
 *   本文件要做的就是：把两侧申报出来的两串清单**按出现顺序一一配对**，
 *   再按申报时声明的关系（相等 / 不等 / 大于 / 小于 / 两侧都要匹配正则）
 *   逐一裁决，最后给出 overall = "consistent" | "inconsistent" 的结论。
 *   这是全项目"新旧行为是否一致"的第二条判定路径（第一条是 CTest 对比，
 *   见 src/runtime/ctest-comparator.ts）。
 *
 * 【在整个项目里的位置】
 *   上游（谁调用它）：
 *     · src/runtime/workflow-pipeline.ts —— runSelfDrivenVerification() 在
 *       两侧各跑完一次 runTestSide 之后，把两侧的 expectations 交给它，并把
 *       结果落成 expectation-comparison-result.json 这个 artifact；
 *     · src/workflow/test-executor.ts —— executeTestWorkflow() 内部也调它；
 *     · tests/test-executor.test.ts —— 单测直接调它验证关系语义。
 *   下游（它调用谁）：无。这是个**纯函数**：只依赖入参，不读文件、不开进程，
 *   所以可以被单测秒级覆盖。
 *   产出去向：返回值会被 workflow-pipeline.ts 压缩成 ExpectationComparisonResult
 *   artifact 持久化。⚠️ 持久化层只保留 {name, relation, matched, reason}，
 *   两侧的具体观测值（baselineValue / candidateValue）在落盘时被丢掉了，
 *   只剩 reason 这个**人读字符串**里留了痕迹——复盘 mismatch 时看不到原始值，
 *   这是当前实现已知的一个缺口（教程分析文档的任务 6A / 3.5-2 就在讲它）。
 *
 * 【先修知识】
 *   · src/workflow/types.ts 的 ExpectationDeclaration / ExpectationRelation
 *     （一条期望声明长什么样、有哪几种关系）；
 *   · src/workflow/client.ts 里 ctx.expect 的三种调用形态；
 *   · 《零基础看懂教程.md》§1.5 "自驱动 TestWorkflow 的两侧运行模型"。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/expectation-compare.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 【语法】`import type { … }` —— 只引入"类型"，不引入运行时代码。
//   ExpectationDeclaration / ExpectationRelation 在 types.ts 里是纯 TS 类型
//   （interface / type alias），编译成 JS 之后就不存在了。用 import type 有两个
//   好处：① 明示"这里只用类型"；② 编译时这一行会被整体删掉，不会真的去加载
//   types.ts 模块。
//   另外注意路径后缀是 `.js`：源文件明明是 .ts，import 却写编译产物的 .js——
//   这是 ES Module 的统一约定，本项目所有 import 都这么写。
import type { ExpectationDeclaration, ExpectationRelation } from "./types.js";

/**
 * Compare baseline vs candidate expectation declarations by position.
 *
 * The workflow runs twice (once per worktree) and declares expectations in
 * the same order both times. The host pairs declarations by index and applies
 * the relation semantics:
 *
 *   equal            → baseline.value === candidate.value
 *   not-equal        → baseline.value !== candidate.value
 *   baseline-greater → baseline.value > candidate.value
 *   baseline-less    → baseline.value < candidate.value
 *   both-matches     → both values match the declaration's pattern
 *
 * Positional pairing requires the workflow to declare expectations in a
 * deterministic order with the same count on both sides. The generator
 * prompt instructs the model accordingly.
 */

/* ─────────────────────────────────────────────────────────────────────
 * 【核心问题】为什么必须"同序"？为什么不能按名字配对？
 *
 * 两侧跑的是同一份源码，宿主却**没有一个可靠的身份可以把两侧的声明连起来**
 * （ctx.expect 只交了 name 和 value，没有全局唯一 id）。本文件采用最朴素的
 * 方案：第 i 条对第 i 条——按下标配对。这个方案成立的前提是：两次运行里
 * ctx.expect 的调用次数、顺序完全一致。
 *
 * 反过来想"能不能按名字配对"：可以，但会**掩盖一类真正的行为变化**。
 * 比如 candidate 侧某个用例提前失败，循环少跑了一轮、少申报了一条期望——
 * 按名字配对会把"少了一条"悄悄吞掉（剩下的照样对得上），而按位置配对会
 * 立刻报出 count mismatch。这正是本项目的 fail-closed 哲学：说不清楚 = 不一致。
 *
 * 所以写自驱动 TestWorkflow 有三条铁律（生成提示词 src/agents/prompts.ts 的
 * TEST_WORKFLOW_SYSTEM 原文就写了 "expectation count and order MUST be
 * identical across the two runs"）：
 *   1. 不要在 expect 之前提前 return（一侧少一串声明 → 数量不等 → 直接 inconsistent）；
 *   2. 不要在依赖环境的值上分支后再决定 expect 几条（顺序会错位）；
 *   3. 名字要稳定且唯一——同序但名字对不上会被当结构错误报出来（第 63 行兜底）。
 * ───────────────────────────────────────────────────────────────────── */

// ── ExpectationComparisonOutcome：比较结果的三层结构 ──────────────────
// 【作用】一次比较的完整产出，分三层：
//   · errors     —— 结构性错误（数量不等、名字对不上、关系对不上、缺 pattern）；
//   · mismatched —— 结构没问题，但关系不成立（例如两侧值不相等）；
//   · matched    —— 关系成立的项。
// 【语法】`readonly` 修饰属性：属性只能在创建时赋值、之后不许改（TS 的编译期
//   检查，运行时没有开销）。`"consistent" | "inconsistent"` 是字符串字面量
//   联合类型：这个字段只允许这两个字符串，写成别的会编译报错——比裸 string
//   安全得多，也是本项目所有 artifact 字段的标准写法。
export interface ExpectationComparisonOutcome {
  readonly overall: "consistent" | "inconsistent";
  /** Declarations whose relation held on both sides. */
  // 【语法】`ReadonlyArray<T>`：只读数组（不能 push/pop，只能遍历）。
  //   这里 T 是一个内联的对象类型，字段里出现了 `unknown`——它是 TS 里
  //   "任何值都行，但我对它一无所知" 的类型（比 any 安全：用之前必须先收窄）。
  //   期望值本来就是任意 JSON，所以用 unknown 最诚实。
  readonly matched: ReadonlyArray<{
    readonly declaration: ExpectationDeclaration;
    readonly baselineValue: unknown;
    readonly candidateValue: unknown;
  }>;
  /** Declarations whose relation did not hold (with reason). */
  // ⚠️ mismatched 里的 declaration 用的是 baseline 侧那条（第 72 行的 entry
  //    里放的是 b），candidate 侧的 declaration 本身不返回——只能靠
  //    candidateValue 看到它的值。
  readonly mismatched: ReadonlyArray<{
    readonly declaration: ExpectationDeclaration;
    readonly baselineValue: unknown;
    readonly candidateValue: unknown;
    readonly reason: string;
  }>;
  /** Structural problems: count mismatch, missing pattern, … */
  // ⚠️ 只要 errors 非空，overall 就一定是 inconsistent——即使每一对
  //    都"看起来匹配"。结构对不上时任何结论都不可信。
  readonly errors: string[];
}

// ── compareExpectations：本文件唯一导出的函数（也是全部逻辑所在）──────
// 【作用】把 baseline / candidate 两侧的期望声明数组按下标配对并逐项裁决。
// 【参数】baseline / candidate —— 两次运行各自收集到的 ExpectationDeclaration
//   数组，顺序 = ctx.expect 被调用的顺序。`readonly T[]` 表示"我不会改你的数组"。
// 【返回】ExpectationComparisonOutcome（见上）。
// 【关系】上游 workflow-pipeline.ts / test-executor.ts 调它；它内部调用
//   evaluateRelation（关系裁决）、looseEqual / toNumber / stringify（工具函数）。
//   只要有任何 error 或 mismatch，overall 就是 inconsistent，宿主据此
//   中止验证并把会话判为失败（fail-closed）。
export function compareExpectations(
  baseline: readonly ExpectationDeclaration[],
  candidate: readonly ExpectationDeclaration[],
): ExpectationComparisonOutcome {
  // 【语法】`ExpectationComparisonOutcome["matched"]` 是"索引访问类型"：
  //   意思是"取出 ExpectationComparisonOutcome 里名为 matched 的那个字段的
  //   类型"。好处是改接口时这里的类型自动跟着变，不用抄第二遍。
  const matched: ExpectationComparisonOutcome["matched"] = [];
  const mismatched: ExpectationComparisonOutcome["mismatched"] = [];
  const errors: string[] = [];
  // Local mutable accumulation then freeze at return.
  // 【语法】这三行有点绕，拆开看：
  //   `typeof matched` 取"变量 matched 的类型"，`(typeof matched)[number]`
  //   再取出这个只读数组的**元素类型**，`Array<…>` 包一层就得到了一个
  //   **可变**数组类型。也就是说：matched / mismatched 两个空数组从头到尾
  //   没被真正用过（只在返回值里被 matchedRef / mismatchedRef 替代），
  //   它们存在的唯一意义是当"类型锚点"——接口承诺对外只读，内部却需要
  //   push，于是用这种写法把同一份元素类型既当只读又当可变用。
  const matchedMutable: Array<(typeof matched)[number]> = [];
  const mismatchedMutable: Array<(typeof mismatched)[number]> = [];
  // 【语法】不加类型注解的 `const matchedRef = matchedMutable` 会自动推断出
  //   同样的可变数组类型，最后 return 时它们被"降级"当成只读数组交出去。
  const matchedRef = matchedMutable;
  const mismatchedRef = mismatchedMutable;

  // 第一道关卡：数量必须相等。不等 = 结构性错误 = overall 一定 inconsistent。
  // 【语法】模板字符串（反引号 + ${…}）把变量嵌进字符串；String(x) 把数字
  //   转成文本（TS 严格模式下模板字符串不允许直接嵌 unknown，所以显式转一次）。
  if (baseline.length !== candidate.length) {
    errors.push(
      `expectation count mismatch: baseline declared ${String(baseline.length)}, candidate declared ${String(candidate.length)}`,
    );
    // Compare what pairs up; the rest are structural errors.
    // ← 注意：数量不等**不会直接 return**。能配上的前 min 对还是照样比，
    //   这样报错信息里既知道"少了几条"，也知道"配上的那些值差在哪"。
  }

  // 第二道关卡：逐对比较。只比 min(两侧长度) 对，多出来的那条已经在上面报错了。
  // 【语法】`let i = 0` 的经典 for 循环——这里必须用下标，因为按下标配对正是
  //   本函数的全部意义（for…of 拿不到下标）。
  const paired = Math.min(baseline.length, candidate.length);
  for (let i = 0; i < paired; i++) {
    // 【语法】末尾的 `!` 叫"非空断言"：向编译器保证 baseline[i] 不是 undefined。
    //   因为 i < paired ≤ 数组长度，所以这个断言是真的；但它是"我相信你"
    //   而不是"运行时检查"，写错了不会在编译期暴露。
    const b = baseline[i]!;
    const c = candidate[i]!;
    // 第三道关卡：名字必须一致。不一致说明两侧的声明顺序已经错位了，
    //   这时硬把值比下去毫无意义，所以记一条 error 并 continue 跳过这一对。
    // 【语法】continue = 跳过本轮循环剩下的部分，直接进入下一对。
    if (b.name !== c.name) {
      errors.push(`expectation name mismatch at index ${i}: baseline '${b.name}' vs candidate '${c.name}'`);
      continue;
    }
    // 第四道关卡：关系必须一致。baseline 申明"相等"、candidate 申明"大于"，
    //   这对期望本身就自相矛盾，同样按结构错误处理。
    if (b.relation !== c.relation) {
      errors.push(`expectation relation mismatch at index ${i} ('${b.name}'): baseline '${b.relation}' vs candidate '${c.relation}'`);
      continue;
    }
    // 走到这里的每一对：结构与身份都没问题，只剩"关系成不成立"这一件事。
    const check = evaluateRelation(b, c);
    const entry = {
      declaration: b,
      baselineValue: b.value,
      candidateValue: c.value,
    };
    if (check.ok) {
      matchedRef.push(entry);
    } else {
      // 【语法】`{ ...entry, reason: check.reason }` 是对象展开（spread）：
      //   把 entry 的所有字段抄一份，再把 reason 字段加上/覆盖。
      mismatchedRef.push({ ...entry, reason: check.reason });
    }
  }

  // 总结陈词：有任何 error（结构错）或 mismatch（值不对）→ inconsistent。
  // 【语法】`条件 ? A : B` 三元表达式；`||` 短路求值。
  return {
    overall: errors.length > 0 || mismatchedRef.length > 0 ? "inconsistent" : "consistent",
    matched: matchedRef,
    mismatched: mismatchedRef,
    errors,
  };
}

// ── evaluateRelation：单对期望的关系裁决 ──────────────────────────────
// 【作用】给定同一对名字/关系下的两个观测值，判断声明的关系是否成立。
// 【返回】`{ ok: true } | { ok: false; reason: string }` —— 可辨识联合
//   (discriminated union)：调用方靠 `check.ok` 的真假区分两种形态，
//   TS 会据此自动收窄出 reason 字段（ok 为 true 时根本没有 reason）。
//   这是本项目表示"可能失败的小步骤"最常用的返回形态。
function evaluateRelation(
  baseline: ExpectationDeclaration,
  candidate: ExpectationDeclaration,
): { ok: true } | { ok: false; reason: string } {
  // 【语法】`as ExpectationRelation` 是类型断言："我知道它就是这个类型"。
  //   因为前面已经确认两侧 relation 相同，取 baseline 的那份就够了；
  //   断言只是告诉编译器，运行时什么也不做。
  const relation = baseline.relation as ExpectationRelation;
  // 【语法】switch 的每个 case 用了 `{}` 包起来——因为要在 case 里声明
  //   const 变量，加花括号能形成独立作用域，避免不同 case 之间的变量重名冲突。
  switch (relation) {
    case "equal": {
      // 两侧必须完全相等。looseEqual 见下方注释（⚠️ 它不是 JS 的 ===）。
      const ok = looseEqual(baseline.value, candidate.value);
      return ok
        ? { ok: true }
        : { ok: false, reason: `values differ: baseline=${stringify(baseline.value)} candidate=${stringify(candidate.value)}` };
    }
    case "not-equal": {
      // 与 equal 恰好相反：用来断言"这个值必须变"（例如重构后某个计数应当不同）。
      const ok = !looseEqual(baseline.value, candidate.value);
      return ok
        ? { ok: true }
        : { ok: false, reason: `values are equal (${stringify(baseline.value)}), expected different` };
    }
    case "baseline-greater": {
      // 方向性断言：baseline 必须严格大于 candidate。
      // 典型用法：重构后某个应当变小的开销（baseline > candidate）。
      const b = toNumber(baseline.value);
      const c = toNumber(candidate.value);
      // 转不成数字 → 不是"值不对"而是"这个关系根本没法判"，
      // 给出带两侧原值的 reason，方便人定位是哪一侧的类型出了问题。
      if (b === null || c === null) {
        return { ok: false, reason: `non-numeric values for baseline-greater: baseline=${stringify(baseline.value)} candidate=${stringify(candidate.value)}` };
      }
      return b > c
        ? { ok: true }
        : { ok: false, reason: `baseline ${String(b)} is not greater than candidate ${String(c)}` };
    }
    case "baseline-less": {
      // 与 baseline-greater 镜像：baseline 必须严格小于 candidate。
      // 典型用法：重构后跑得更快（baseline 耗时 < candidate 耗时）——
      // 但注意耗时本身有抖动，用这种关系断言要非常小心 flaky。
      const b = toNumber(baseline.value);
      const c = toNumber(candidate.value);
      if (b === null || c === null) {
        return { ok: false, reason: `non-numeric values for baseline-less: baseline=${stringify(baseline.value)} candidate=${stringify(candidate.value)}` };
      }
      return b < c
        ? { ok: true }
        : { ok: false, reason: `baseline ${String(b)} is not less than candidate ${String(c)}` };
    }
    case "both-matches": {
      // 两侧的值都要匹配同一个正则。典型用法：断言输出格式稳定
      // （"两侧都是 ^obs- 开头"），而不关心具体值是多少。
      // pattern 存在 declaration 里，所以两侧只要有一侧带了就行——
      // 这里统一取 baseline 那份（前面已经保证两侧 relation 相同，
      // 但 pattern 是另一个字段，没有强制相等检查，取哪侧都一样）。
      const pattern = baseline.pattern;
      if (pattern === undefined || pattern.length === 0) {
        return { ok: false, reason: `both-matches requires a pattern (got none)` };
      }
      // 【语法】`let regex: RegExp` 先声明类型再赋值——因为要 try/catch：
      //   new RegExp 收到一个非法 pattern 会**抛异常**，不能写成一行 const。
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (cause) {
        // 【语法】catch (cause) 捕获到的类型是 unknown，所以要 instanceof
        //   判断一下才能安全取 .message；`x instanceof Error ? a : b` 是标准写法。
        return { ok: false, reason: `invalid pattern '${pattern}': ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      // 两侧都必须是字符串**且**匹配。类型不对（比如传了个对象）直接算失败。
      // 【语法】regex.test(str) 返回 true/false，表示是否匹配。
      const bOk = typeof baseline.value === "string" && regex.test(baseline.value);
      const cOk = typeof candidate.value === "string" && regex.test(candidate.value);
      return bOk && cOk
        ? { ok: true }
        : { ok: false, reason: `pattern '${pattern}' did not match both sides (baseline ${bOk ? "ok" : "no"}, candidate ${cOk ? "ok" : "no"})` };
    }
    default:
      // 类型系统理论上已经把 relation 限定在五种之内，走到这里是防御性兜底
      // （比如数据来自 JSON 反序列化、没过 Zod 校验）。宁可报错也不静默通过。
      return { ok: false, reason: `unsupported relation: ${String(relation)}` };
  }
}

// ── looseEqual："宽"相等——equal 关系的实际判定标准 ──────────────────
// 【作用】比较两个任意 JSON 值是否"相等"。名字里的 loose 是相对 === 而言：
//   JS 的 === 对两个对象永远返回 false（比的是引用），而这里要比"内容"。
// 【规则】
//   · number / string / boolean 同类型 → 用 ===（严格相等）；
//   · 一边是 null 或 undefined → 用 ===（所以 null ≠ undefined 也不等）；
//   · 两边都是对象 → JSON.stringify 后比字符串（内容相等即相等）；
//     ⚠️ stringify 对"键顺序"敏感：{a:1,b:2} 和 {b:2,a:1} 会被判为不等，
//        虽然语义上它们是同一个对象。
//   · 其余（类型不同）→ 兜底转成字符串比。
// ⚠️ 最后这行兜底是个隐性的坑：baseline 给数字 1、candidate 给字符串 "1"
//    时，前面所有分支都不命中，会落到 String(a) === String(b) → "1"==="1"
//    → 判为相等。类型不同还判等，通常意味着 workflow 写错了，但这里不报错。
function looseEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a === "object" && typeof b === "object") {
    // 【语法】try { … } catch { … } 不写 catch 参数：JS 允许捕获但不使用异常
    //   对象（比如 stringify 循环引用会抛错），此时保守地判为不等。
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a) === String(b);
}

// ── toNumber：把观测值尽量转成数字（给大于/小于关系用）────────────────
// 【规则】数字原样返回；字符串用 Number() 转，转出 NaN 就返回 null（表示
//   "转不了"）；其他类型一律 null。
// ⚠️ Number() 的边界行为要心里有数：Number("") === 0、Number(" 12 ") === 12、
//    Number("0x10") === 16——空字符串会被当成 0 参与大小比较。声明期望时
//    传干净的数字或纯数字字符串最安全。
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// ── stringify：把任意值变成可读字符串（只用于拼 reason）──────────────
// 【作用】错误信息里要展示两侧的原始值。JSON.stringify 对大多数值都好用
//   （数字 → "1"、对象 → '{"a":1}'、undefined → undefined），
//   但遇到循环引用会抛异常，所以包一层 try/catch 兜底成 String(value)。
// 注意：它只影响 reason 字符串的好看程度，不影响判定结果。
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
