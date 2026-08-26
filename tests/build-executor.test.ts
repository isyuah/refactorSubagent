import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BuildWorkflowOutput, type HostPreflight } from "../src/artifacts/index.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { executeBuildWorkflow } from "../src/workflow/build-executor.js";

function tempCMakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-build-executor-"));
  writeFileSync(join(root, "CMakeLists.txt"), [
    "cmake_minimum_required(VERSION 3.15)",
    "project(executor_smoke C)",
    "add_executable(executor_smoke main.c)",
    "",
  ].join("\n"));
  writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");
  return root;
}

function output(path: string) {
  return BuildWorkflowOutput.parse({
    kind: "build-workflow-output",
    version: 1,
    workflow_id: "executor-test",
    workflow_revision: 1,
    environment: {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "cmake",
        source_dir: ".",
        build_dir: "build",
        generator: null,
        target: null,
        configure_flags: [],
        build_flags: [],
        output: path,
      },
      sanitizers: [],
      determinism: {
        frozen_time_epoch_ms: null,
        random_seed: null,
        intercept_headers: [],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    },
    artifact: {
      kind: "executable",
      version: 1,
      workflow_id: "executor-test",
      workflow_revision: 1,
      paths: { app: path },
      metadata: {},
    },
  });
}

function policy() {
  return {
    readableGlobs: ["**"],
    writableGlobs: ["build/**"],
    allowedTools: ["cmake"],
    maxProcesses: 2,
    maxOutputBytes: 4 * 1024 * 1024,
    maxFileBytes: 16 * 1024 * 1024,
  };
}

describe("BuildWorkflow executor", () => {
  test("configures and builds a CMake project through the capability broker", async () => {
    const root = tempCMakeProject();
    const host = probeHost(root);
    if (!host.tools.cmake?.available) return;

    const result = await executeBuildWorkflow({
      cwd: root,
      output: output("build/executor_smoke"),
      host,
      policy: policy(),
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("pass");
    expect(result.steps.map((step) => step.name)).toEqual(["configure", "build"]);
    expect(result.steps.every((step) => step.status === "exited" && step.exitCode === 0)).toBeTrue();
    expect(result.missingArtifacts).toEqual([]);
    expect(result.events).toEqual([
      expect.objectContaining({ capability: "process", method: "run", ok: true }),
      expect.objectContaining({ capability: "process", method: "run", ok: true }),
    ]);
  }, 30_000);

  test("rejects a successful build when the declared artifact is absent", async () => {
    const root = tempCMakeProject();
    const host: HostPreflight = probeHost(root);
    if (!host.tools.cmake?.available) return;

    const result = await executeBuildWorkflow({
      cwd: root,
      output: output("build/not-produced"),
      host,
      policy: policy(),
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("failed");
    expect(result.missingArtifacts).toEqual(["app: build/not-produced"]);
    expect(result.failure).toContain("artifacts are missing");
  }, 30_000);
});
