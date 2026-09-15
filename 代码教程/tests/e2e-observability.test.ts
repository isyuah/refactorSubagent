/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/e2e-observability.test.ts —— 观测层（pino 日志）的合同测试
 *
 * 【这个文件锁定了哪些行为】（B 方案改版后，观测后端已换成 log.ts 的 pino 实现）
 *   ① 完整一轮日志落盘：state.json（v2）+ run.jsonl 逐行事件 + artifacts/ + logs/
 *      ——且 run.jsonl 每行是 pino 风格 {event, level, msg, ...details}；
 *   ② ★ 日志级别门控：构造 E2ELogger 传 "warn" 后，trace/debug/info 被丢弃，
 *      只剩 warn/error 落盘（这正是改版前"每事件同步全量写"的性能解法）；
 *   ③ 级别可由环境变量 RFR_LOG_LEVEL 覆盖；非法值抛错（fail-closed）；
 *   ④ 默认就应用 env 级别（还原现场的环境变量操作范式 try/finally）。
 *
 * 【怎么跑】bun test tests/e2e-observability.test.ts（纯逻辑 + 临时目录）
 *
 * 【本文件是教程注释版】原文件 tests/e2e-observability.test.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2ELogger, resolveLogLevel } from "../src/runtime/e2e-log.js";
// ↑ e2e-log.ts 现在是"兼容门面"：真身在 log.ts（pino 实现）——从哪里 import 都一样。

// 测试辅助：建临时目录 + 一个新 logger。
function createRun(runId = "run-observe"): { root: string; runId: string; logger: E2ELogger } {
  const root = mkdtempSync(join(tmpdir(), "rfr-observe-"));
  return { root, runId, logger: new E2ELogger(root, runId) };
}

// 读 JSON 文件并断言成 Record（泛型收窄用）。
function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Parse one run.jsonl line (pino schema). */
// 读 run.jsonl 的每一行为对象：trim → 按行拆 → 过滤空行 → 逐行 JSON.parse。
function readEventLines(root: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, runId, "run.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("E2E observability", () => {
  // ── 测试①：一轮完整日志的落盘合同 ─────────────────────────────────────
  // phase/info/output/artifact/logFile/finish 各调一次，然后逐项核对四类落盘物。
  test("persists pino state, line-oriented events, artifacts, and logs", () => {
    const { root, runId, logger } = createRun();
    logger.phase("ANALYSIS", "analysis started");
    logger.info("analysis completed", { test_case_count: 3 });
    logger.output("stderr", "warning from tool\n");
    logger.artifact("summary.json", { accepted: true });
    logger.logFile("build.log", "build output\n");
    logger.finish("accepted", "candidate accepted");

    const state = readJsonFile(join(root, runId, "state.json"));
    const events = readEventLines(root, runId);

    // toMatchObject：只断言列出的字段（其余字段存在与否不管）——比 toEqual 宽容。
    expect(state).toMatchObject({
      kind: "e2e-state",
      version: 2,                 // ★ B 方案升到 v2（log.ts 的 pino 实现）
      run_id: runId,
      status: "accepted",
      phase: "ANALYSIS",
      last_event: "candidate accepted",
    });
    // 事件顺序与种类必须精确一致：phase → progress → output → artifact → decision。
    expect(events.map((event) => event.event)).toEqual([
      "phase",
      "progress",
      "output",
      "artifact",
      "decision",
    ]);
    // 每条事件的字段核对（msg 是 pino 的消息字段名；details 平铺进事件本身）。
    expect(events[0]).toMatchObject({
      event: "phase",
      level: "info",
      msg: "analysis started",
      phase: "ANALYSIS",
    });
    expect(events[1]).toMatchObject({
      event: "progress",
      msg: "analysis completed",
      test_case_count: 3,
    });
    // output 事件：stderr 来的自动升为 warn 级，并带 stream 字段。
    expect(events[2]).toMatchObject({
      event: "output",
      level: "warn",
      msg: "warning from tool\n",
      stream: "stderr",
    });
    expect(events[3]).toMatchObject({ event: "artifact", msg: "saved artifact summary.json" });
    expect(events[4]).toMatchObject({ event: "decision", level: "info", msg: "candidate accepted" });
    // artifacts/ 与 logs/ 的实际文件内容也要一字不差。
    expect(readJsonFile(join(root, runId, "artifacts", "summary.json"))).toEqual({ accepted: true });
    expect(readFileSync(join(root, runId, "logs", "build.log"), "utf8")).toBe("build output\n");
  });

  // ── 测试②（★）：级别门控——低于阈值的记录根本不落盘 ─────────────────────
  // 构造时传 "warn"：trace/debug/info 全被丢掉，只剩 warn/error 两行。
  // 这是改版的核心收益：详细记录可开可关，不再"每个事件都全量重写 state.json"。
  test("level threshold gates whether trace/debug records are persisted", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-observe-level-"));
    const runId = "run-level";
    const logger = new E2ELogger(root, runId, "warn");   // 第三参 = 最低落盘级别

    logger.trace("trace detail", { tool: "Read" });
    logger.debug("debug detail", { tool: "Read" });
    logger.info("info detail");
    logger.warn("warning");
    logger.error("failure");

    const events = readEventLines(root, runId);
    expect(events.map((event) => event.level)).toEqual(["warn", "error"]);
    expect(events.map((event) => event.msg)).toEqual(["warning", "failure"]);
  });

  // ── 测试③：RFR_LOG_LEVEL 环境变量覆盖默认级别；非法值抛错 ───────────────
  test("level threshold is overridable via RFR_LOG_LEVEL env", () => {
    const env = { RFR_LOG_LEVEL: "debug" };
    expect(resolveLogLevel(env)).toBe("debug");
    expect(resolveLogLevel({ RFR_LOG_LEVEL: "" })).toBe("info");   // 空串 = 用默认
    expect(resolveLogLevel({})).toBe("info");                      // 没设 = 用默认
    expect(() => resolveLogLevel({ RFR_LOG_LEVEL: "verbose" })).toThrow(/RFR_LOG_LEVEL/);   // 非法值 fail-closed
  });

  // ── 测试④：new E2ELogger 不传级别时默认吃环境变量 ──────────────────────
  // 改环境变量的标准范式：存旧值 → try 里改 → finally 里还原（不能污染其他测试）。
  test("RunLogger applies the env level by default", () => {
    const previous = process.env["RFR_LOG_LEVEL"];
    process.env["RFR_LOG_LEVEL"] = "debug";
    try {
      const logger = new E2ELogger(
        mkdtempSync(join(tmpdir(), "rfr-observe-env-")),
        "run-default",
      );
      expect(logger.level).toBe("debug");
    } finally {
      if (previous === undefined) delete process.env["RFR_LOG_LEVEL"];
      else process.env["RFR_LOG_LEVEL"] = previous;
    }
  });
});
