/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/host-preflight.ts —— 主机事实 Schema（测量结果的"格式合同"）
 *
 * 【这个文件是干什么的】
 *   只定义数据形状，不做测量。真正的测量在 ../runtime/host-preflight.ts 的
 *   probeHost()（同名不同目录，注意区分：一个是 Schema、一个是探测程序）。
 *   产出的 JSON 会存进 session 并原文注入所有 AI 会话。
 *
 * 【灵魂在一行注释里】
 *   "facts measured by the program, never inferred by Claude"
 *   —— 这些事实由程序测量，绝不允许 Claude 推断。paths 故意不用 RelPath：
 *   它们是这台机器上的绝对路径（如 E:\Scoop\...\gcc.EXE），不是仓库内相对路径。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/host-preflight.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { SanitizerCapability } from "./sanitizer.js";

// 单个工具的探测结果：
export const ToolProbe = z.object({
  available: z.boolean(),          // PATH 上找得到吗
  path: z.string().nullable(),     // 绝对路径；找不到为 null
  version: z.string().nullable(),  // 版本号；普通探测不跑 --version 所以常为 null
});

// CMake 的深度探测结果（只有 cmake 有这种待遇，因为它太关键）：
export const CMakePreflight = z.object({
  version: z.string().nullable().default(null),
  generators: z.array(z.string()).default([]),           // 本机可用的生成器列表（如 Ninja / Visual Studio 18 2026）
  default_generator: z.string().nullable().default(null),// 迷你工程实测的默认生成器
  c_compiler: z.string().nullable().default(null),       // CMake 实际找到的 C 编译器（可能是 VS 的 cl.exe！）
  configure_probe: z.enum(["pass", "fail", "not-run"]).default("not-run"), // 试配置成功吗
  build_probe: z.enum(["pass", "fail", "not-run"]).default("not-run"),     // 试编译成功吗
  reason: z.string().nullable().default(null),           // 结论或失败原因（人读）
});

/**
 * Host Preflight — facts measured by the program, never inferred by Claude.
 * Paths are absolute host paths and intentionally are not RelPath values.
 */
export const HostPreflight = z.object({
  kind: z.literal("host-preflight"),
  version: z.literal(1),
  platform: z.string().min(1),      // 'win32' / 'linux' / …
  arch: z.string().min(1),          // 'x64' / 'arm64' / …
  shell: z.enum(["cmd.exe", "powershell.exe", "bash", "unknown"]),
  supports_posix_shell: z.boolean(),// 有没有 POSIX shell（决定能不能用 mkdir -p 这类命令）
  executable_suffix: z.string(),    // Windows: ".exe"；其他平台空串
  working_directory: z.string().min(1),
  // z.record(ToolProbe)：{ 工具名 → 探测结果 } 的字典，键不固定（gcc/cmake/ninja/…）。
  tools: z.record(ToolProbe),
  cmake: CMakePreflight.default({}),       // 没提供就用默认值（全是 null/not-run）
  sanitizers: z.record(SanitizerCapability).default({}),
});

export type HostPreflight = z.infer<typeof HostPreflight>;
export type ToolProbe = z.infer<typeof ToolProbe>;
export type CMakePreflight = z.infer<typeof CMakePreflight>;
