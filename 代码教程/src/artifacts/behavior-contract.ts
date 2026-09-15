/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/behavior-contract.ts —— 行为契约
 *
 * 【这个文件是干什么的】
 *   定义 BehaviorContract（行为契约）：一份"重构前后必须保持哪些可观察
 *   行为、每一项比得多严"的声明。它是整个差分对比的**评判标准**。
 *   什么叫"可观察"？就是程序外面能看到的：退出码、信号、标准输出、
 *   标准错误、动了哪些文件（5 个 channel/通道）。程序内部怎么改（换
 *   算法、换数据结构）随便——这正是"行为保持型重构"允许的事。
 *
 * 【在整个项目里的位置】
 *   谁产生：分析 Agent（Claude 只读代码后提方案），见 src/agents/analyze.ts
 *     的 Proposal（一次会话同时交出 contract/scope/deps/tests/env 五份提案，
 *     每一份都要过本目录的 Schema 才算数）。
 *   什么时候：状态机 INIT → CONTRACT_READY，是第一个被提交的 artifact。
 *   谁消费：src/runtime/comparator.ts 按它规定的 mode 逐通道比对；
 *     src/orchestrator/orchestrator.ts 只负责"形状对不对"。
 *
 * 【先修知识】
 *   common.ts（z.string/.min/.refine 的基本用法）、《零基础看懂教程.md》§1.5。
 *
 * 【本文件是教程注释版】
 *   原文件：src/artifacts/behavior-contract.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { z } from "zod";
// ← 【语法】从同目录的 common.js 导入。注意后缀写的是 .js 而不是 .ts——
//   这是 TypeScript 的 ESM 规矩：编译/运行后真的存在的文件是 .js，所以
//   import 路径要按"运行时"写。本项目全仓都是这种写法。
// ⚠️ 小知识：B64 和 RelPath 在本文件里其实一个都没用到（大概是早期版本
//   的遗留），读代码时可以忽略这一行。
import { B64, RelPath } from "./common.js";

/**
 * Behavior Contract — the structured definition of WHICH observable behavior
 * must be preserved and how strictly each channel is compared.
 */
// ── CompareMode：单个通道的比对模式 ─────────────────────────────────
// 【作用】回答"这一通道比得多严"，共 4 档。
// 【语法】z.enum([…]) = "只能是这几个字符串之一"，多一个少一个都不行。
//   这比 z.string() 严得多：写错一个字母（比如 Exact）直接被拦。
// 【这 4 档的含义】（行尾原有的英文注释也解释了一遍）
//   exact     逐字节完全一致（最严）
//   semantic  语义一致：要指名用哪个比较器（比如"文件系统效果不看顺序"）
//   normalize 归一化后一致：先把时间戳、换行符这些噪音洗掉再比
//   ignore    这条通道根本不比
export const CompareMode = z.enum([
  "exact", // byte-identical
  "semantic", // equal under a named comparator (order-insensitive FS effects, …)
  "normalize", // equal after canonicalization (timestamps, line endings)
  "ignore",
]);

// ── ChannelPolicy：一条通道的完整策略 ───────────────────────────────
// 【作用】把"模式"和"模式需要的参数"包在一起。
// 【语法】z.object({ 字段: 校验器, … }) = "必须是一个对象，且每个字段
//   都满足各自的规则"。Zod 默认**多余的字段会被原样保留但不检查**，
//   缺了的字段直接报错（除非写了 .optional() 或 .default()）。
// 【为什么 comparator 要 optional】只有 mode 是 semantic 时才需要比较器
//   的名字；其他模式用不上。"条件必填"这件事 z.object 本身表达不了，
//   所以先放宽成 optional，再由下面 BehaviorContract 的 .refine 补一刀。
export const ChannelPolicy = z.object({
  mode: CompareMode,
  /** Required when mode === 'semantic': comparator id, e.g. `fs-effects-v1`. */
  comparator: z.string().min(1).optional(),
});

// ── BehaviorContract：整个行为契约 artifact ─────────────────────────
// 【作用】这是真正提交给状态机的那个 artifact 的 Schema。
// 【语法】z.literal("behavior-contract") = "必须是这个字符串，一个字都
//   不能差"。每个 artifact 都有 kind + version 两个字面量，相当于证件上
//   的"证件类型"和"版本号"：程序拿到任意 JSON，先看 kind 就知道该用哪个
//   Schema 去验，看 version 就知道数据格式是不是同一代。
// 【语法】kind 字段与变量同名（const BehaviorContract 里有个
//   kind: "behavior-contract"）是本目录的统一惯例，index.ts 靠它区分。
export const BehaviorContract = z
  .object({
    kind: z.literal("behavior-contract"),
    version: z.literal(1),

    // ← 5 条通道，每条都必须给一份 ChannelPolicy（缺一条都不行）。
    //   这 5 项就是"C 程序可观察行为"的完整清单，runtime/comparator.ts
    //   会照着这里的策略一一去比。
    channels: z.object({
      exit_code: ChannelPolicy,
      signals: ChannelPolicy,
      stdout: ChannelPolicy,
      stderr: ChannelPolicy,
      filesystem: ChannelPolicy,
    }),

    // ← allowed_change = "允许改变的东西"。重构当然允许改内部结构；
    //   执行耗时也必须允许（同一程序跑两次耗时都不一样，没法保持）。
    // 【语法】z.boolean() = 必须是 true 或 false。
    allowed_change: z
      .object({
        internal_structure: z.boolean(),
        execution_time: z.boolean(),
      })
      .refine((a) => a.execution_time, {
        message: "execution_time must be allowed; timing is never preserved",
      }),
    // ← 上面这刀是硬规定：谁要是交一份"耗时也必须一致"的契约，直接
    //   拒收。因为耗时天然抖动，坚持比耗时只会让所有重构都被误杀。

    // 【语法】z.array(z.string()) = 字符串数组；.default([]) = 这个字段
    //   可以不写，不写就当 []。.default() 让 JSON 更短，同时保证程序拿到的
    //   永远是数组（不用再写 if (x === undefined)）。
    notes: z.array(z.string()).default([]),
  })
  // ← 最外层再来一刀**跨字段校验**：5 条通道里只要有谁的 mode 是
  //   semantic，它的 comparator 就必须有值。
  // 【语法】Object.values(对象) 取出所有属性值（这里就是 5 份 ChannelPolicy），
  //   .every(…) = 全部满足才返回 true。a !== "semantic" || b !== undefined
  //   是逻辑"或者"：模式不是 semantic 当然过；是 semantic 就必须给比较器。
  // 【语法】.refine 直接接在 .object(...) 后面：refine 返回一个"带附加
  //   规则的新 Schema"，不改动原来的。所以可以一层层 .refine 下去。
  .refine(
    (c) =>
      Object.values(c.channels).every(
        (p) => p.mode !== "semantic" || p.comparator !== undefined,
      ),
    { message: "semantic channel policies require a comparator id" },
  );

// ── 类型推导：从 Schema 得到 TypeScript 类型 ────────────────────────
// 【语法】z.infer<typeof BehaviorContract> = "让 TypeScript 反推出这个
//   Schema 校验通过后的对象长什么样"。typeof 是"取这个变量的类型"，
//   z.infer 再把 Zod 的描述翻译成普通 TS 类型。**规则只写一遍**：改了
//   Schema，类型自动跟着变，不会出现"文档和代码对不上"。
// 【语法】export type BehaviorContract = ... 又声明了一个同名的"类型"。
//   TypeScript 里"值"（那个 Schema 对象）和"类型"（对象的形状）是两个
//   命名空间，所以同名不冲突。这是 Zod 项目的标准写法：用的时候
//   `const x: BehaviorContract = ...`，校验的时候 `BehaviorContract.parse(x)`。
export type BehaviorContract = z.infer<typeof BehaviorContract>;
