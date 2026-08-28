import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2ELogger } from "../src/runtime/e2e-log.js";
import { createE2EDashboardHandler } from "../src/runtime/e2e-dashboard.js";

function createRun(runId = "run-observe"): { root: string; runId: string; logger: E2ELogger } {
  const root = mkdtempSync(join(tmpdir(), "rfr-observe-"));
  return { root, runId, logger: new E2ELogger(root, runId) };
}

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async (): Promise<string> => {
    while (!predicate(text)) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    return text;
  })();
  const timeout = new Promise<string>((_, reject) => {
    timer = setTimeout(() => reject(new Error("SSE read timed out")), timeoutMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("E2E observability", () => {
  test("persists state, line-oriented events, artifacts, and logs", () => {
    const { root, runId, logger } = createRun();
    logger.phase("ANALYSIS", "analysis started");
    logger.info("analysis completed", { test_case_count: 3 });
    logger.output("stderr", "warning from tool\n");
    logger.artifact("summary.json", { accepted: true });
    logger.logFile("build.log", "build output\n");
    logger.finish("accepted", "candidate accepted");

    const state = readJsonFile(join(root, runId, "state.json"));
    const eventLines = readFileSync(join(root, runId, "run.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(state).toMatchObject({
      kind: "e2e-state",
      version: 1,
      run_id: runId,
      status: "accepted",
      phase: "ANALYSIS",
      last_event: "candidate accepted",
    });
    expect(eventLines.map((event) => event.event)).toEqual([
      "phase",
      "progress",
      "output",
      "artifact",
      "decision",
    ]);
    expect(eventLines[2]).toMatchObject({
      event: "output",
      level: "warn",
      message: "warning from tool\n",
      details: { stream: "stderr" },
    });
    expect(readJsonFile(join(root, runId, "artifacts", "summary.json"))).toEqual({ accepted: true });
    expect(readFileSync(join(root, runId, "logs", "build.log"), "utf8")).toBe("build output\n");
  });

  test("serves runs, evidence, logs, and fail-closed paths", async () => {
    const { root, runId, logger } = createRun();
    logger.phase("PREFLIGHT");
    logger.artifact("facts.json", { cmake: true });
    logger.logFile("preflight.log", "cmake 4.3.1\n");
    logger.finish("rejected", "candidate rejected");
    const handler = createE2EDashboardHandler({ root });

    const runsResponse = handler(new Request("http://dashboard/api/runs"));
    expect(runsResponse.status).toBe(200);
    expect(await runsResponse.json()).toEqual([
      expect.objectContaining({ run_id: runId, status: "rejected", phase: "PREFLIGHT" }),
    ]);

    const detailResponse = handler(new Request(`http://dashboard/api/runs/${runId}`));
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as { state: Record<string, unknown>; events: Array<Record<string, unknown>> };
    expect(detail.state).toMatchObject({ run_id: runId, status: "rejected" });
    expect(detail.events.at(-1)).toMatchObject({ event: "decision", message: "candidate rejected", seq: 3 });

    const artifactsResponse = handler(new Request(`http://dashboard/api/runs/${runId}/artifacts`));
    expect(await artifactsResponse.json()).toEqual([
      expect.objectContaining({ name: "facts.json" }),
    ]);
    const artifactResponse = handler(new Request(`http://dashboard/api/runs/${runId}/artifacts/facts.json`));
    expect(artifactResponse.headers.get("content-type")).toContain("application/json");
    expect(await artifactResponse.json()).toEqual({ cmake: true });

    const logsResponse = handler(new Request(`http://dashboard/api/runs/${runId}/logs`));
    expect(await logsResponse.json()).toEqual([
      expect.objectContaining({ name: "preflight.log" }),
    ]);
    const logResponse = handler(new Request(`http://dashboard/api/runs/${runId}/logs/preflight.log`));
    expect(await logResponse.text()).toBe("cmake 4.3.1\n");

    expect(handler(new Request(`http://dashboard/api/runs/${runId}/artifacts/%2e%2e`)).status).toBe(400);
    expect(handler(new Request("http://dashboard/api/runs/missing")).status).toBe(404);
    expect(handler(new Request("http://dashboard/api/runs", { method: "POST" })).status).toBe(405);
  });

  test("streams the current state and later events through SSE", async () => {
    const { root, runId, logger } = createRun("run-stream");
    logger.phase("PREFLIGHT");
    logger.info("initial event");
    const handler = createE2EDashboardHandler({ root, pollIntervalMs: 200 });
    const controller = new AbortController();
    const response = handler(new Request(`http://dashboard/api/runs/${runId}/stream?after=2`, {
      signal: controller.signal,
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (response.body === null) throw new Error("SSE response has no body");
    const reader = response.body.getReader();

    try {
      const initial = await reader.read();
      expect(initial.done).toBeFalse();
      const initialText = new TextDecoder().decode(initial.value);
      expect(initialText).toContain("event: state");
      expect(initialText).not.toContain("event: event");

      logger.info("late event", { source: "test" });
      const delta = await readSseUntil(reader, (text) => text.includes("late event"));
      expect(delta).toContain("event: event");
      expect(delta).toContain('"message":"late event"');
      expect(delta).toContain('"source":"test"');
    } finally {
      await reader.cancel();
      controller.abort();
    }
  });
});
