import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestCase } from "../src/artifacts/test-spec.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { detectCProject } from "../src/runtime/project-detector.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-preflight-"));
  roots.push(root);
  return root;
}

interface MetadataReply {
  status: number | null;
  stdout: string;
  stderr?: string;
  error?: { message: string };
}

/** Isolate the process spy and PATH so other tests keep their real toolchain. */
function isolatedPreflight(options: {
  cmakePresent?: boolean;
  version?: MetadataReply;
  capabilities?: MetadataReply;
} = {}): {
  host: ReturnType<typeof probeHost>;
  project: ReturnType<typeof detectCProject>;
  calls: { program: string; args: string[] }[];
} {
  const root = tempProject();
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (options.cmakePresent !== false) {
    writeFileSync(join(bin, process.platform === "win32" ? "cmake.EXE" : "cmake"), "placeholder");
  }
  // Discovery must also succeed when the real project has unresolved dependencies.
  writeFileSync(join(root, "CMakeLists.txt"), "find_package(missing_provider REQUIRED)\n");
  writeFileSync(join(root, "main.c"), '#include "missing_generated.h"\n');
  const replies = [
    options.version ?? { status: 0, stdout: "cmake version 3.31.0\n" },
    options.capabilities ?? { status: 0, stdout: JSON.stringify({ generators: [{ name: "Ninja" }] }) },
  ];
  const script = `
    import { spyOn } from "bun:test";
    import { syncBuiltinESMExports } from "node:module";
    const replies = ${JSON.stringify(replies)};
    const calls = [];
    const childProcess = require("node:child_process");
    spyOn(childProcess, "spawnSync").mockImplementation((program, args) => {
      calls.push({ program, args });
      const reply = replies[calls.length - 1];
      if (!reply) throw new Error("Unexpected Preflight process: " + JSON.stringify(args));
      return { stderr: "", ...reply };
    });
    syncBuiltinESMExports();
    const { probeHost } = await import(${JSON.stringify(new URL("../src/runtime/host-preflight.ts", import.meta.url).href)});
    const { detectCProject } = await import(${JSON.stringify(new URL("../src/runtime/project-detector.ts", import.meta.url).href)});
    console.log(JSON.stringify({
      host: probeHost(${JSON.stringify(root)}),
      project: detectCProject(${JSON.stringify(root)}),
      calls,
    }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, PATH: bin, PATHEXT: ".EXE" },
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString());
}

describe("host preflight and execution-boundary contracts", () => {
  test("measures the current host with a normalized tool map", () => {
    const host = probeHost(process.cwd());
    expect(host.kind).toBe("host-preflight");
    expect(host.tools.gcc).toBeDefined();
    expect(host.working_directory).toBe(process.cwd());
    expect(host.executable_suffix).toBe(process.platform === "win32" ? ".exe" : "");
  }, 30_000);

  test("default preflight only queries CMake metadata and never configures or compiles", () => {
    const { host, project, calls } = isolatedPreflight();
    expect(calls.map((call) => call.args)).toEqual([["--version"], ["-E", "capabilities"]]);
    expect(calls.every((call) => call.program === host.tools.cmake?.path)).toBeTrue();
    expect(host.cmake.version).toBe("3.31.0");
    expect(host.cmake.generators).toEqual(["Ninja"]);
    for (const field of ["default_generator", "c_compiler", "configure_probe", "build_probe"]) {
      expect(host.cmake).not.toHaveProperty(field);
    }
    expect(host.sanitizers).toEqual({});
    expect(project.status).toBe("detected");
  });

  test.each([
    { reply: { status: 1, stdout: "", stderr: "metadata query failed" }, reason: "metadata query failed" },
    { reply: { status: 0, stdout: "{broken json" }, reason: "invalid metadata" },
    { reply: { status: 0, stdout: "{}" }, reason: "missing generators array" },
  ])("keeps tool discovery separate from failed CMake metadata: $reason", ({ reply, reason }) => {
    const { host, project, calls } = isolatedPreflight({ capabilities: reply });
    expect(host.tools.cmake?.available).toBeTrue();
    expect(host.cmake.generators).toEqual([]);
    expect(host.cmake.reason).toContain(reason);
    expect(project.status).toBe("detected");
    expect(calls).toHaveLength(2);
  });

  test("records a failed version query without losing other CMake metadata", () => {
    const { host } = isolatedPreflight({
      version: { status: null, stdout: "", error: { message: "version query timed out" } },
    });
    expect(host.tools.cmake?.available).toBeTrue();
    expect(host.cmake.version).toBeNull();
    expect(host.cmake.generators).toEqual(["Ninja"]);
    expect(host.cmake.reason).toContain("version query timed out");
  });

  test("distinguishes source discovery from missing host tools and absent sources", () => {
    const { host, project, calls } = isolatedPreflight({ cmakePresent: false });
    expect(host.tools.cmake?.available).toBeFalse();
    expect(host.tools.gcc?.available).toBeFalse();
    expect(host.cmake.version).toBeNull();
    expect(host.cmake.generators).toEqual([]);
    expect(calls).toEqual([]);
    expect(project.status).toBe("detected");
    expect(project.primary_build_system).toBe("cmake");
    expect(detectCProject(tempProject()).status).toBe("no-c-sources");
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
