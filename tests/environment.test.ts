import { describe, expect, test } from "bun:test";
import { TestCase } from "../src/artifacts/test-spec.js";
import { probeHost } from "../src/runtime/host-preflight.js";

describe("host preflight and execution-boundary contracts", () => {
  test("measures the current host with a normalized tool map", () => {
    const host = probeHost(process.cwd());
    expect(host.kind).toBe("host-preflight");
    expect(host.tools.gcc).toBeDefined();
    expect(host.working_directory).toBe(process.cwd());
    expect(host.executable_suffix).toBe(process.platform === "win32" ? ".exe" : "");
    if (host.cmake.configure_probe === "pass" && host.cmake.build_probe === "pass") {
      expect(host.cmake.default_generator).not.toBeNull();
      expect(host.cmake.c_compiler).not.toBeNull();
    }
  }, 30_000);

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
  test("does not compile sanitizer probes unless explicitly requested", () => {
    const quick = probeHost(process.cwd());
    expect(quick.sanitizers).toEqual({});
  }, 30_000);
});
