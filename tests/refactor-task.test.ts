import { describe, expect, test } from "bun:test";
import { createLibuvRefactorTask, RefactorTestTask } from "../src/artifacts/refactor-task.js";

const sourceRoot = "C:/Users/Yu/AppData/Local/Temp/refactor-libuv-in4Ow9/libuv";
const evidence = {
  sourceRoot,
  workflowId: "libuv-v1.52.1-cmake-debug",
  workflowRevision: 1,
  baselineSummary: { total: 2, passed: 0, failed: 2, not_run: 0 },
  baselineTopLevelTests: ["uv_test", "uv_test_a"],
  baselineFailures: [
    {
      test: "uv_test_a:fs_event_watch_dir_short_path",
      category: "environment" as const,
      related_to_scope: false,
      explanation: "Windows short-path filesystem behavior is host-sensitive.",
    },
  ],
};

describe("libuv refactor test task", () => {
  test("requires classifications for failed baselines and source tests for official coverage", () => {
    expect(() => RefactorTestTask.parse({
      kind: "refactor-test-task",
      version: 1,
      project: { name: "x", version: "1", language: "c", repository: "https://example.com/x" },
      workflow: { id: "x", revision: 1 },
      baseline: {
        status: "fail",
        suite: { kind: "ctest-suite-spec", version: 1, build_dir: "build", configuration: "Debug", timeout_ms: 1000, parallelism: 1, extra_args: [], environment: {} },
        summary: { total: 1, passed: 0, failed: 1, not_run: 0 },
        top_level_tests: ["x"],
        failure_classifications: [],
        notes: [],
      },
      candidates: [{
        file: "src/a.c",
        symbols: ["a"],
        source_tests: [],
        verification: "official-test-covered",
        rationale: "missing evidence",
      }],
      test_plan: {
        cases: [{
          id: "case",
          category: "normal",
          candidate_file: "src/a.c",
          candidate_symbol: "a",
          source_test: null,
          scenario: "x",
          expected_invariant: "x",
        }],
        required_before_acceptance: ["x"],
      },
    })).toThrow();
  });

  test("generates the fixed libuv task from checkout evidence", () => {
    const task = createLibuvRefactorTask(evidence);
    expect(task.project).toEqual(expect.objectContaining({ name: "libuv", version: "v1.52.1" }));
    expect(task.baseline.status).toBe("fail");
    expect(task.baseline.failure_classifications[0]!.category).toBe("environment");
    expect(task.candidates.map((candidate) => candidate.file)).toEqual([
      "src/strscpy.c",
      "src/strtok.c",
      "src/version.c",
    ]);
    expect(task.candidates[2]!.verification).toBe("dedicated-harness-required");
    expect(task.test_plan.cases).toHaveLength(6);
  });
});
