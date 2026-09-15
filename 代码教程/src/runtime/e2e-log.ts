/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/e2e-log.ts —— 兼容门面（真身已搬进 log.ts）
 *
 * 【这个文件是干什么的】
 *   只做"再导出"（re-export）。B 方案改版把日志实现迁到了基于 pino 的
 *   ./log.ts（E2ELogger 类 + 分级日志），但保留本文件让所有旧的
 *   `import { E2ELogger } from "./e2e-log.js"` 调用点【一行都不用改】。
 *
 * 【教学点：门面模式（facade）】
 *   实现搬家 ≠ 调用方要跟着搬家。用一个薄薄的入口文件"钉住"旧的导入路径，
 *   是重构时最常用的平滑手段——搬的是家，门牌号没变。
 *
 * 【在整个项目里的位置】
 *   workflow-agent-pipeline.ts / workflow-pipeline.ts / 各 e2e 脚本仍从这里
 *   拿 E2ELogger；真正的写入逻辑、日志级别门控（level-gated）、run.jsonl/
 *   state.json 的落盘细节全部在 ./log.ts（教程里有注释版）。
 *
 * 【本文件是教程注释版】原文件 src/runtime/e2e-log.ts（B 方案改版后只剩 10 行），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Backwards-compatible entry point for the pino-backed run logger.
 *
 * The implementation lives in ./log.ts (class E2ELogger). Keeping this file
 * means existing `import { E2ELogger } from "./e2e-log.js"` call sites are
 * unchanged while the backing store moves to pino with level-gated detail.
 */
// ↑ 官方注释翻译：pino 后端日志运行器的向后兼容入口。实现在 ./log.ts 的
//   E2ELogger 类。保留本文件意味着既有调用点不用改，而后端已换成
//   带日志级别门控的 pino。
export { E2ELogger } from "./log.js";                                // 日志器类（真身在 log.ts）
export type { E2EState, LogLevel, Logger } from "./log.js";          // 相关类型
export { resolveLogLevel, isLogLevel } from "./log.js";              // 级别解析/校验工具
