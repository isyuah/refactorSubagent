/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/project-detection.ts —— 项目探测结果（"这是个什么 C 工程"）
 *
 * 【这个文件是干什么的】
 *   定义 ProjectDetection artifact：PREFLIGHT 阶段由 runtime/project-detector.ts 的
 *   detectCProject() 产出——这个仓库是什么语言、有哪些构建系统痕迹（CMakeLists.txt、
 *   build.ninja、Makefile…）、主构建系统是哪个、用哪个适配器、当前能不能动手（status）。
 *
 * 【最重要的设计】
 *   status 有三档，其中 needs-adapter 是 fail-closed 的体现：
 *   "发现了 Makefile 但 Make 适配器还没实现" → 明确告诉你做不了，
 *   绝不会装作没看见、把整个项目当一堆 .c 文件直接 gcc 编译了事。
 *
 * 【在整个项目里的位置】
 *   与 host-preflight 一起注入所有 AI 会话；resolve-workflows 生成 workflow 时
 *   也依据 primary_build_system 命名/分类。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/project-detection.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { RelPath } from "./common.js";

// 项目可能属于的构建系统（探测口径）：
export const BuildSystem = z.enum([
  "cmake",
  "ninja",
  "make",
  "msvc",       // Visual Studio 工程/.sln
  "direct-c",   // 没有 CLMAKE 痕迹、只有一堆 .c 的裸项目
]);

// 系统里实际"能接活"的适配器 id。注意 make/msvc 有探测、暂无执行适配器：
export const BuildAdapterId = z.enum([
  "cmake",
  "ninja",
  "make",
  "msvc",
  "direct-compiler",   // 直接 gcc 一把梭（裸 .c 项目用）
  "unsupported",       // 探测到了但接不了 → 配合 needs-adapter 阻断
]);

// 探测结论三档：
export const ProjectDetectionStatus = z.enum([
  "ready",           // 构建系统认识、工具可用、适配器有 → 可以开工
  "needs-adapter",   // 认识构建系统但没有执行适配器 → fail-closed 阻断
  "no-c-sources",    // 连 C 源文件都没有（可能选错目录）
]);

/**
 * Project Detection — measured project facts before an agent proposes a build.
 * Known build markers are reported explicitly; unsupported systems never
 * silently fall back to compiling every .c file.
 */
// ↑ 官方注释：项目探测 = 在 AI 提构建方案之前测得的项目事实。
//   探到的构建标记要如实上报；不支持的系统绝不静默降级成"把所有 .c 都编一遍"。
export const ProjectDetection = z.object({
  kind: z.literal("project-detection"),
  version: z.literal(1),
  repo_root: z.string().min(1),        // 仓库根目录
  language: z.literal("c"),            // 目前只支持 C（多语言是远期规划）
  build_systems: z.array(BuildSystem), // 发现的所有构建系统痕迹（可能不止一个）
  primary_build_system: BuildSystem.nullable(), // 主构建系统（决定用哪个适配器）
  markers: z.array(RelPath),           // 证据文件，如 ["CMakeLists.txt"]——"为什么这么判断"
  source_files: z.array(RelPath),      // 找到的 .c 文件清单
  adapter: BuildAdapterId,             // 准备用哪个适配器
  status: ProjectDetectionStatus,      // ready / needs-adapter / no-c-sources
  reason: z.string().min(1),           // 人读的理由，如 "cmake project detected and cmake adapter is available"
});

// 三个类型一起导出（z.infer 把 Schema 变成 TS 类型）。
export type BuildSystem = z.infer<typeof BuildSystem>;
export type BuildAdapterId = z.infer<typeof BuildAdapterId>;
export type ProjectDetection = z.infer<typeof ProjectDetection>;
