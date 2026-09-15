/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/observation-trace.ts —— 行为观测记录（旧路径的"实验记录本"）
 *
 * 【这个文件是干什么的】
 *   定义 ObservationTrace artifact：对一次构建（baseline 或 candidate）逐用例
 *   观测到的全部外部行为——退出码、信号、stdout/stderr、文件系统副作用、耗时。
 *   文件副作用怎么抓？运行前给目录拍快照、运行后再拍一次、做差（fs-snapshot.ts）。
 *
 * 【fail-closed 亮点】
 *   任何"失败/出错"的用例都必须附带 FailureClassification（失败分类）：
 *   你不能只说"它挂了"，必须说清"为什么挂、和修改范围有没有关系"。
 *   unknown 分类会被状态机 R3 直接阻断流程。
 *
 * 【在整个项目里的位置】
 *   旧路径（runtime/runner.ts 采集、pipeline.ts 提交）专用；
 *   按 baseline/candidate 分文件存储（store.ts 的 storageStem）。
 *   新版 workflow/CTest 路径用 ctest-suite.ts / expectation-suite.ts。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/observation-trace.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { B64, RelPath, Sha256Hex } from "./common.js";
// ↑ Sha256Hex：内容 SHA-256 哈希（十六进制字符串）——文件副作用靠它判断"内容变没变"。

// 单个文件系统副作用：一次运行对某个文件做了什么。
export const FsEffect = z.object({
  path: RelPath,
  op: z.enum(["create", "modify", "delete"]),   // 新建 / 修改 / 删除
  /** sha256 of content after the op; null for delete. */
  sha256: Sha256Hex.nullable(),                 // 删除后没有"内容"可言 → null（.nullable 允许 null 值）
});
export type FsEffect = z.infer<typeof FsEffect>;

/** One executed test case against one build. */
// 单个用例在某个版本上的观测记录：
export const CaseObservation = z.object({
  case_id: z.string().min(1),
  status: z.enum(["observed", "fail", "error"]),
  // ↑ observed = 跑完且可比较；fail = 程序自己退出非零；error = 没能正常执行（崩溃/启动失败）。
  exit_code: z.number().int(),
  /** Signal name on abnormal termination (POSIX shims; null otherwise). */
  // ↑ 被信号杀死时的信号名（Unix 概念，Windows 一般为 null）。
  signal: z.string().nullable().default(null),  // 允许 null 且默认 null（链式写法）
  stdout_b64: B64,                              // 完整输出按 base64 存（可含任意字节）
  stderr_b64: B64,
  filesystem: z.array(FsEffect).default([]),    // 这次运行造成的所有文件副作用
  duration_ms: z.number().nonnegative(),        // 耗时毫秒（非负）
});

/**
 * Failure Classification — fail-closed requires every non-observed baseline
 * case to carry an explicit, explainable classification.
 */
// ↑ 失败分类：不能只说"挂了"，必须归类 + 解释。
export const FailureClassification = z.object({
  category: z.enum([
    "environment",            // 环境问题（缺库、网络、系统差异）——与代码无关
    "preexisting_behavior",   // 旧代码本来就是这个行为（真实存在的历史问题）
    "scope_related",          // 与修改范围有关 → 必须阻断流程！
    "unknown",
    // ↑ unknown 在状态机 R3 里也会阻断——"解释不了"与"有问题"同罪，宁错杀不放过。
  ]),
  related_to_scope: z.boolean(),        // 是否涉及被修改的文件/符号
  explanation: z.string().min(1),       // 必须给出文字解释（min(1) = 不许空话）
});

export const ObservationTrace = z
  .object({
    kind: z.literal("observation-trace"),
    version: z.literal(1),

    build: z.enum(["baseline", "candidate"]),  // 这份记录属于哪个版本
    env_id: z.string().min(1),                 // 环境标识（对比时验证同环境）

    observations: z.array(CaseObservation).min(1),
    /** Required for every case whose status !== 'observed'. */
    failures: z
      .array(
        // .extend：在 FailureClassification 的基础上"加"一个 case_id 字段——
        // 分类必须指明它解释的是哪个用例。
        FailureClassification.extend({ case_id: z.string().min(1) }),
      )
      .default([]),
  })
  // 跨字段校验：每个非 observed 的用例，failures 里必须有同 case_id 的分类条目。
  // filter(...).every(...)：先筛出失败的，再检查全部有解释。
  .refine(
    (t) =>
      t.observations
        .filter((o) => o.status !== "observed")
        .every((o) => t.failures.some((f) => f.case_id === o.case_id)),
    {
      message:
        "fail-closed: every failing/erroring case needs a failure classification",
    },
  );

export type ObservationTrace = z.infer<typeof ObservationTrace>;
