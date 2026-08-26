import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EnvironmentSpec,
  HostPreflight,
  SanitizerResult,
  TestSpec,
} from "../src/artifacts/index.js";
import { SessionStore } from "../src/orchestrator/store.js";
import { buildWorktree, DirectCompilerAdapter } from "../src/runtime/builder.js";
import { parseSanitizerDiagnostics, runSanitizers } from "../src/runtime/sanitizer-runner.js";

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-sanitizer-"));
  writeFileSync(join(root, "main.c"), "int main(void) { return 0; }\n");
  mkdirSync(join(root, "build"), { recursive: true });
  return root;
}

function env(): EnvironmentSpec {
  return {
    kind: "environment-spec",
    version: 1,
    build: {
      kind: "direct-compiler",
      compiler: "gcc",
      flags: [],
      defines: {},
      sources: ["main.c"],
      output: "build/app",
    },
    sanitizers: ["address"],
    determinism: {
      frozen_time_epoch_ms: null,
      random_seed: null,
      intercept_headers: [],
    },
    sandbox: { run_cwd_strategy: "fresh_temp_dir" },
  };
}

function tests(): TestSpec {
  return {
    kind: "test-spec",
    version: 1,
    cases: [{ id: "d1", kind: "differential", argv: ["app"], stdin: "", fixtures: [] }],
  };
}

function host(root: string, available: boolean): HostPreflight {
  return HostPreflight.parse({
    kind: "host-preflight",
    version: 1,
    platform: process.platform,
    arch: process.arch,
    shell: process.platform === "win32" ? "cmd.exe" : "bash",
    supports_posix_shell: process.platform !== "win32",
    executable_suffix: process.platform === "win32" ? ".exe" : "",
    working_directory: root,
    tools: {
      gcc: { available: true, path: "gcc", version: null },
    },
    sanitizers: {
      address: {
        available,
        compiler: "gcc",
        flags: ["-fsanitize=address"],
        reason: available ? "test capability" : "test: libasan unavailable",
      },
      undefined: {
        available: false,
        compiler: "gcc",
        flags: ["-fsanitize=undefined"],
        reason: "not requested",
      },
    },
  });
}

describe("sanitizer safety layer", () => {
  test("refuses an unproven sanitizer request before invoking the compiler", () => {
    const root = tempProject();
    const result = buildWorktree(root, env(), host(root, false));

    expect(result.ok).toBeFalse();
    expect(result.log).toContain("sanitizer 'address' unavailable");
  });

  test("injects measured sanitizer flags into the direct compiler argv", () => {
    const root = tempProject();
    const plan = new DirectCompilerAdapter().plan(root, env(), host(root, true));

    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]!.args).toContain("-fsanitize=address");
  });

  test("records unsupported capability as a schema-valid independent result", () => {
    const root = tempProject();
    const result = runSanitizers({
      worktreeDir: root,
      env: env(),
      spec: tests(),
      build: "baseline",
      envId: "env-baseline-sanitized",
      host: host(root, false),
    });

    expect(result.status).toBe("unsupported");
    expect(result.failure?.category).toBe("unsupported");
    expect(SanitizerResult.safeParse(result).success).toBeTrue();
  });
  test("keeps baseline and candidate sanitizer results separate", () => {
    const root = tempProject();
    const sessionRoot = mkdtempSync(join(tmpdir(), "rfr-sanitizer-session-"));
    const store = SessionStore.create(sessionRoot, "session");
    const baseline = runSanitizers({
      worktreeDir: root,
      env: env(),
      spec: tests(),
      build: "baseline",
      envId: "env-baseline-sanitized",
      host: host(root, false),
    });
    const candidate = runSanitizers({
      worktreeDir: root,
      env: env(),
      spec: tests(),
      build: "candidate",
      envId: "env-candidate-sanitized",
      host: host(root, false),
    });

    store.saveArtifact(baseline);
    store.saveArtifact(candidate);

    expect(store.sanitizer("baseline")?.env_id).toBe("env-baseline-sanitized");
    expect(store.sanitizer("candidate")?.env_id).toBe("env-candidate-sanitized");
  });

  test("classifies sanitizer diagnostics separately from ordinary stderr", () => {
    const findings = parseSanitizerDiagnostics(
      "d1",
      ["address", "undefined"],
      "AddressSanitizer: heap-use-after-free\nruntime error: signed integer overflow",
    );

    expect(findings).toEqual([
      {
        case_id: "d1",
        sanitizer: "address",
        message: "AddressSanitizer: heap-use-after-free",
      },
      {
        case_id: "d1",
        sanitizer: "undefined",
        message: "runtime error: signed integer overflow",
      },
    ]);
  });
});
