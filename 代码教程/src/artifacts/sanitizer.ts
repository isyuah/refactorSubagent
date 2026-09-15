/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/sanitizer.ts —— sanitizer（内存/未定义行为检测器）结果
 *
 * 【背景小知识】sanitizer 是编译器自带的"运行时体检"：
 *   - address（ASan）：抓越界、use-after-free 等内存错误；
 *   - undefined（UBSan）：抓有符号溢出、错误对齐等 C 未定义行为。
 *   重构最怕"改完没崩但埋了雷"，sanitizer 就是抓雷的。
 *
 * 【这个文件是干什么的】
 *   定义 SanitizerCapability（这台机器能不能用）和 SanitizerResult（跑出来什么结果）。
 *   核心原则写在注释里："availability is never inferred from a flag name"——
 *   不看 flag 名猜能力，必须真编译一次。本机实测缺 -lasan/-lubsan → UNSUPPORTED，
 *   流程如实记录、绝不伪造 pass。
 *
 * 【在整个项目里的位置】
 *   能力部分由 runtime/host-preflight.ts 的 probeSanitizers 产出；
 *   结果部分由 runtime/sanitizer-runner.ts 产出，baseline/candidate 各一份。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/sanitizer.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { B64 } from "./common.js";

// 支持的 sanitizer 种类（未来可扩展更多）：
export const SanitizerKind = z.enum(["address", "undefined"]);
export type SanitizerKind = z.infer<typeof SanitizerKind>;

/** Measured compiler capability; availability is never inferred from a flag name. */
// ↑ 能力=实测结论。compiler 记录"用哪个编译器测的"，flags 记录"试了哪些 flag"，
//   reason 记录"凭什么下这个结论"——三件套保证结论可追溯。
export const SanitizerCapability = z.object({
  available: z.boolean(),
  compiler: z.string().nullable(),   // 测试用的编译器；没有编译器为 null
  flags: z.array(z.string()),        // 尝试的 flags（如 ["-fsanitize=address"]）
  reason: z.string().min(1),
});
export type SanitizerCapability = z.infer<typeof SanitizerCapability>;

// 一次发现（sanitizer 报告的问题）：
export const SanitizerFinding = z.object({
  case_id: z.string().min(1),        // 哪个测试用例触发的
  sanitizer: SanitizerKind,          // 哪种 sanitizer 报的
  message: z.string().min(1),        // 诊断消息原文
});
export type SanitizerFinding = z.infer<typeof SanitizerFinding>;

// 单个用例在 sanitizer 构建下的运行结果：
export const SanitizerCaseResult = z.object({
  case_id: z.string().min(1),
  status: z.enum(["observed", "finding", "runtime_failure", "timeout"]),
  // ↑ observed=正常跑完；finding=报了问题；runtime_failure=运行崩了；timeout=超时。
  exit_code: z.number().int().nullable(),
  stdout_b64: B64,
  stderr_b64: B64,
  duration_ms: z.number().nonnegative(),
});
export type SanitizerCaseResult = z.infer<typeof SanitizerCaseResult>;

// 整体结果（一个构建版本一份）：
export const SanitizerResult = z
  .object({
    kind: z.literal("sanitizer-result"),
    version: z.literal(1),
    build: z.enum(["baseline", "candidate"]),  // 属于哪个版本
    env_id: z.string().min(1),
    requested: z.array(SanitizerKind).min(1),  // 请求了哪些 sanitizer（至少一个）
    status: z.enum([
      "pass",             // 全部干净
      "findings",         // 发现了问题（重构要警惕！）
      "unsupported",      // 这台机器根本跑不了 sanitizer
      "build_failure",    // sanitizer 构建本身失败
      "runtime_failure",
      "timeout",
    ]),
    exit_code: z.number().int().nullable(),
    duration_ms: z.number().nonnegative(),
    case_results: z.array(SanitizerCaseResult).default([]),
    findings: z.array(SanitizerFinding).default([]),
    stdout_b64: B64,
    stderr_b64: B64,
    failure: z
      .object({           // 失败时的结构化说明（pass 时必须是 null，见下面第二条 refine）
        category: z.enum([
          "diagnostic",
          "unsupported",
          "build_failure",
          "runtime_failure",
          "timeout",
          "unknown",
        ]),
        explanation: z.string().min(1),
      })
      .nullable(),
  })
  // 校验①：说 status 是 "findings"，findings 数组就不能是空的（不许"无病呻吟"）。
  .refine(
    (result) => result.status !== "findings" || result.findings.length > 0,
    { message: "findings status requires at least one sanitizer finding" },
  )
  // 校验②：三元表达式做一致性检查——pass ⇒ failure 必须是 null；
  //   非 pass ⇒ failure 必须给出（不许静默失败）。
  .refine(
    (result) => result.status === "pass" ? result.failure === null : result.failure !== null,
    { message: "non-pass sanitizer results require an explicit failure" },
  );

export type SanitizerResult = z.infer<typeof SanitizerResult>;
