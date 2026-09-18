import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CTestSuiteResult } from "../src/artifacts/index.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { SessionStore } from "../src/orchestrator/store.js";
import {
  classifyCTestBaseline,
  compareCTestSuites,
  createCTestCandidate,
} from "../src/runtime/ctest-comparator.js";
import { happyPath, patch } from "./fixtures.js";

function failedSuite(): CTestSuiteResult {
  return {
    kind: "ctest-suite-result",
    version: 1,
    status: "fail",
    exit_code: 8,
    duration_ms: 12,
    summary: { total: 1, passed: 0, failed: 1, not_run: 0 },
    top_level_tests: ["project_tests"],
    failed_tests: [
      { name: "project_tests:network_case", output: "network timeout unavailable" },
    ],
    stdout_b64: "",
    stderr_b64: "",
    failure: { category: "test_failure", explanation: "one test failed" },
  };
}

describe("CTest consistent-failure warnings", () => {
  test("both sides failing identically reaches ACCEPTED with a durable warning", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-ctest-warning-"));
    const store = SessionStore.create(root, "same-failure");
    const orchestrator = new Orchestrator(store);
    for (const artifact of happyPath().slice(0, 4)) {
      expect(orchestrator.submit(artifact).ok).toBeTrue();
    }

    const baseline = classifyCTestBaseline(failedSuite());
    const candidate = createCTestCandidate(failedSuite());
    const comparison = compareCTestSuites(baseline, candidate);

    expect(comparison.overall).toBe("consistent");
    expect(comparison.warnings).toHaveLength(1);
    expect(comparison.warnings[0]).toContain("both ended with status 'fail'");

    expect(orchestrator.submit(baseline).ok).toBeTrue();
    expect(orchestrator.submit(patch()).ok).toBeTrue();
    expect(orchestrator.submit(candidate).ok).toBeTrue();
    const result = orchestrator.submit(comparison);

    expect(result).toEqual({
      ok: true,
      from: "VERIFICATION_RUNNING",
      to: "ACCEPTED",
      warnings: comparison.warnings,
    });
    expect(store.state).toBe("ACCEPTED");
    expect(store.artifact("ctest-comparison-result")?.warnings).toEqual(comparison.warnings);
    const reopened = SessionStore.open(root, "same-failure");
    expect(reopened.history.at(-1)?.warnings).toEqual(comparison.warnings);
  });

  test("orchestrator rejects a consistent failed comparison that drops its warning", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-ctest-warning-"));
    const store = SessionStore.create(root, "missing-warning");
    const orchestrator = new Orchestrator(store);
    for (const artifact of happyPath().slice(0, 4)) orchestrator.submit(artifact);

    const baseline = classifyCTestBaseline(failedSuite());
    const candidate = createCTestCandidate(failedSuite());
    const comparison = compareCTestSuites(baseline, candidate);
    orchestrator.submit(baseline);
    orchestrator.submit(patch());
    orchestrator.submit(candidate);

    const result = orchestrator.submit({ ...comparison, warnings: [] });
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.reason).toContain("warning drift");
    expect(store.state).toBe("VERIFICATION_RUNNING");
  });
});
