import { describe, expect, test } from "bun:test";
import { TestCase } from "../src/artifacts/test-spec.js";
import { probeHost } from "../src/runtime/host-preflight.js";

describe("host preflight and execution-boundary contracts", () => {
  test("measures the current host with a normalized tool map", () => {
    const host = probeHost("E:/Proj/refactorSubagent");
    expect(host.kind).toBe("host-preflight");
    expect(host.tools.gcc).toBeDefined();
    expect(host.working_directory).toBe("E:/Proj/refactorSubagent");
    expect(host.executable_suffix).toBe(process.platform === "win32" ? ".exe" : "");
  });

  test("rejects NUL bytes at the argv process boundary", () => {
    const result = TestCase.safeParse({
      id: "nul",
      kind: "differential",
      argv: ["program", "bad\0arg"],
      stdin: "",
      fixtures: [],
    });
    expect(result.success).toBeFalse();
  });
});
