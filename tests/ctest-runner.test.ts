import { describe, expect, test } from "bun:test";
import { parseCTestOutput } from "../src/runtime/ctest-runner.js";

describe("CTest output parsing", () => {
  test("keeps not-run top-level tests out of the pass path", () => {
    const result = parseCTestOutput([
      "    Start 1: shared",
      "1/2 Test #1: shared .........................***Failed    0.20 sec",
      "    Start 2: static",
      "2/2 Test #2: static .........................***Not Run   0.00 sec",
      "0% tests passed, 2 tests failed out of 2",
      "The following tests FAILED:",
      "  1 - shared (Failed)",
      "  2 - static (Not Run)",
    ].join("\n"));

    expect(result.summary).toEqual({ total: 2, passed: 0, failed: 2, not_run: 1 });
  });

  test("retains TAP failures with their enclosing CTest target", () => {
    const result = parseCTestOutput([
      "    Start 1: uv_test",
      "1/2 Test #1: uv_test .........................***Failed    1.20 sec",
      "not ok 53 - fs_event_watch_dir_short_path",
      "    Start 2: uv_test_a",
      "2/2 Test #2: uv_test_a .......................***Failed    1.30 sec",
      "not ok 55 - fs_event_watch_dir_short_path",
      "0% tests passed, 2 tests failed out of 2",
    ].join("\n"));

    expect(result.failedTests.map((failure) => failure.name)).toEqual([
      "uv_test:fs_event_watch_dir_short_path",
      "uv_test_a:fs_event_watch_dir_short_path",
    ]);
  });
});
