/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/dependency-manifest.ts —— 依赖清单
 *
 * 【这个文件是干什么的】
 *   定义 DependencyManifest（依赖清单）：列出"要改的这段代码依赖哪些
 *   不确定的东西"，以及"每一项打算怎么被控制住"。
 *   为什么要管这个？因为对比实验的前提是**两次运行只有代码不同**。
 *   如果代码里用了当前时间、随机数、网络，两次跑结果本来就会不一样，
 *   那对比就没有意义了。所以必须先把这些"不确定源"一个个揪出来，
 *   并写明隔离手段（冻结时钟 / 固定随机种子 / 临时沙箱目录……）。
 *
 * 【在整个项目里的位置】
 *   谁产生：分析 Agent（analyze.ts 的 Proposal.deps），状态机
 *     SCOPE_READY → DEPENDENCY_READY 时提交。
 *   谁消费：主要作为提示词/流水线里的"隔离方案"参考；状态机只负责
 *     验形状。⚠️ 注意：本文件**没有** import common.ts，是本目录少数
 *     自给自足的文件之一。
 *
 * 【先修知识】
 *   behavior-contract.ts（z.enum / z.object / z.infer 已讲过）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/artifacts/dependency-manifest.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { z } from "zod";

// ── DepKind：依赖的"种类" ───────────────────────────────────────────
// 【作用】给不确定源分类，共 8 类。
// 【语法】z.enum 在 behavior-contract.ts 已详讲：只能取列表里的值。
// 【这 8 类是什么】
//   pure              纯函数，不碰任何外部状态（最理想）
//   time              当前时间
//   randomness        随机数
//   filesystem        读写文件
//   env               环境变量
//   network           网络
//   stateful_external 有状态的外部世界：数据库、IPC、共享内存…
//   concurrency       多线程/并发（时序本身就不确定）
export const DepKind = z.enum([
  "pure",
  "time",
  "randomness",
  "filesystem",
  "env",
  "network",
  "stateful_external", // DB, IPC, shared memory…
  "concurrency",
]);

// ── IsolationStrategy：隔离手段 ─────────────────────────────────────
// 【作用】对每一种不确定源，声明"观测时怎么把它按住"。
// 【这 8 种是什么】
//   real_isolated   给它一个真实但隔离的实例（比如独立临时数据库）
//   freeze          钉死不确定源（时钟固定在某个时刻）
//   seed            固定随机种子，让随机变确定
//   temp_sandbox    每次给一个一次性临时目录/容器
//   record_replay   先录下来再回放（常用于网络）
//   fake            换个假实现
//   mock            打桩，只记录调用
//   reject          没法安全验证 → 直接禁止重构碰它的那部分代码
export const IsolationStrategy = z.enum([
  "real_isolated", // real dependency inside an isolated instance (preferred)
  "freeze", // pin nondeterministic source (fixed clock)
  "seed", // deterministic seeding (rand, PRNGs)
  "temp_sandbox", // throwaway temp dir / container
  "record_replay",
  "fake",
  "mock",
  "reject", // cannot verify safely → block refactoring touching this dep
]);

/** Default strategy per dependency kind — overridable per item. */
// ── DEFAULT_STRATEGY：每类依赖的默认隔离手段 ────────────────────────
// 【作用】一张"种类 → 手段"的速查表，比如时间是 freeze、随机数是 seed。
// 【语法】Record<K, V> 是 TS 的工具类型，意思是"一个对象，键是 K 类型
//   里列出的那些，值都必须是 V 类型"。这里的键类型写的是
//   z.infer<typeof DepKind>，也就是"DepKind 枚举里的那 8 个字符串"——
//   好处：枚举以后加一项，这张表少写一个键，编译器立刻报错。
// 【值】值不是随便写，而是 IsolationStrategy 里的字符串，写错直接编译
//   不过。这就是"用类型把约束写进代码"。
// ⚠️ 现状：全仓搜索过，这个导出目前没有其他文件 import——它是给
//   "自动填 strategy"预留的默认表，暂时只被类型系统使用。
export const DEFAULT_STRATEGY: Record<
  z.infer<typeof DepKind>,
  z.infer<typeof IsolationStrategy>
> = {
  pure: "real_isolated",
  time: "freeze",
  randomness: "seed",
  filesystem: "temp_sandbox",
  env: "fake",
  network: "record_replay",
  stateful_external: "real_isolated",
  concurrency: "reject",
};
// ← 最后一行值得注意：并发（concurrency）默认是 reject——并行程序的行为
//   顺序无法稳定复现，本项目宁可拒绝也不冒险。这同样是 fail-closed。

/**
 * Dependency Manifest — direct/transitive/ambient dependencies of the
 * modification scope and how each will be controlled during observation runs.
 */
// ── DependencyManifest：依赖清单 artifact ───────────────────────────
// 【作用】真正的 artifact：至少一条 dependencies，每条写清名字、种类、
//   手段、证据、备注。
// 【语法】z.array( … ).min(1) 可以拆开看：里面 z.object({...}) 描述"数组
//   的每个元素长什么样"，外面 .min(1) 说"至少 1 条"——一份说"没有依赖"
//   的清单是不收的（你可能漏看了）。
// 【字段】evidence 用数组记"在哪些文件/函数/调用点看到的"，让 AI 的判断
//   可追溯；notes 默认空字符串。
export const DependencyManifest = z.object({
  kind: z.literal("dependency-manifest"),
  version: z.literal(1),

  dependencies: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: DepKind,
        strategy: IsolationStrategy,
        /** Where this dependency was observed: files/functions/callsites. */
        evidence: z.array(z.string().min(1)).default([]),
        notes: z.string().default(""),
      }),
    )
    .min(1),
});

// ← 同样的套路：从 Schema 反推出 TS 类型，供别的文件 import 当类型用。
export type DependencyManifest = z.infer<typeof DependencyManifest>;
