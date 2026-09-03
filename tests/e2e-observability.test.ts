import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2ELogger, resolveLogLevel } from "../src/runtime/e2e-log.js";

function createRun(runId = "run-observe"): { root: string; runId: string; logger: E2ELogger } {
  const root = mkdtempSync(join(tmpdir(), "rfr-observe-"));
  return { root, runId, logger: new E2ELogger(root, runId) };
}

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Parse one run.jsonl line (pino schema). */
function readEventLines(root: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, runId, "run.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("E2E observability", () => {
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

    expect(state).toMatchObject({
      kind: "e2e-state",
      version: 2,
      run_id: runId,
      status: "accepted",
      phase: "ANALYSIS",
      last_event: "candidate accepted",
    });
    expect(events.map((event) => event.event)).toEqual([
      "phase",
      "progress",
      "output",
      "artifact",
      "decision",
    ]);
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
    expect(events[2]).toMatchObject({
      event: "output",
      level: "warn",
      msg: "warning from tool\n",
      stream: "stderr",
    });
    expect(events[3]).toMatchObject({ event: "artifact", msg: "saved artifact summary.json" });
    expect(events[4]).toMatchObject({ event: "decision", level: "info", msg: "candidate accepted" });
    expect(readJsonFile(join(root, runId, "artifacts", "summary.json"))).toEqual({ accepted: true });
    expect(readFileSync(join(root, runId, "logs", "build.log"), "utf8")).toBe("build output\n");
  });

  test("level threshold gates whether trace/debug records are persisted", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-observe-level-"));
    const runId = "run-level";
    const logger = new E2ELogger(root, runId, "warn");

    logger.trace("trace detail", { tool: "Read" });
    logger.debug("debug detail", { tool: "Read" });
    logger.info("info detail");
    logger.warn("warning");
    logger.error("failure");

    const events = readEventLines(root, runId);
    expect(events.map((event) => event.level)).toEqual(["warn", "error"]);
    expect(events.map((event) => event.msg)).toEqual(["warning", "failure"]);
  });

  test("level threshold is overridable via RFR_LOG_LEVEL env", () => {
    const env = { RFR_LOG_LEVEL: "debug" };
    expect(resolveLogLevel(env)).toBe("debug");
    expect(resolveLogLevel({ RFR_LOG_LEVEL: "" })).toBe("info");
    expect(resolveLogLevel({})).toBe("info");
    expect(() => resolveLogLevel({ RFR_LOG_LEVEL: "verbose" })).toThrow(/RFR_LOG_LEVEL/);
  });

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
