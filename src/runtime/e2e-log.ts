/**
 * Backwards-compatible entry point for the pino-backed run logger.
 *
 * The implementation lives in ./log.ts (class E2ELogger). Keeping this file
 * means existing `import { E2ELogger } from "./e2e-log.js"` call sites are
 * unchanged while the backing store moves to pino with level-gated detail.
 */
export { E2ELogger } from "./log.js";
export type { E2EState, LogLevel, Logger } from "./log.js";
export { resolveLogLevel, isLogLevel } from "./log.js";
