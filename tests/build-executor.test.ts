import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BuildWorkflowOutput } from "../src/artifacts/index.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { executeBuildWorkflow } from "../src/workflow/build-executor.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempCMakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-build-executor-"));
  roots.push(root);
  writeFileSync(join(root, "CMakeLists.txt"), [
    "cmake_minimum_required(VERSION 3.15)",
    "project(executor_smoke C)",
    "add_executable(executor_smoke main.c)",
    "",
  ].join("\n"));
  writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");
  return root;
}

function output(path: string, generator: string | null = null) {
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
        generator,
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
  for (const generator of [null, "Ninja"]) {
    test.skipIf(Bun.which("cmake") === null || (generator === "Ninja" && Bun.which("ninja") === null))(
      `builds using ${generator ?? "the CMake default"} instead of a legacy preflight generator`, async () => {
        const root = tempCMakeProject();
        const measured = probeHost(root);
        const host = {
          ...measured,
          cmake: { ...measured.cmake, default_generator: "obsolete-preflight-generator" },
        };

        const result = await executeBuildWorkflow({
          cwd: root,
          output: output("build/executor_smoke", generator),
          host,
          policy: policy(),
          timeoutMs: 30_000,
        });

        expect(result.status, JSON.stringify({ failure: result.failure, steps: result.steps })).toBe("pass");
        expect(result.steps.map((step) => step.name)).toEqual(["configure", "build"]);
        expect(result.steps.every((step) => step.status === "exited" && step.exitCode === 0)).toBeTrue();
        expect(result.missingArtifacts).toEqual([]);
        expect(result.events).toEqual([
          expect.objectContaining({ capability: "process", method: "run", ok: true }),
          expect.objectContaining({ capability: "process", method: "run", ok: true }),
        ]);
        if (generator !== null) {
          expect(readFileSync(join(root, "build", "CMakeCache.txt"), "utf8"))
            .toContain(`CMAKE_GENERATOR:INTERNAL=${generator}`);
        }
      }, 90_000);
  }

  test.skipIf(Bun.which("cmake") === null)("rejects a successful build when the declared artifact is absent", async () => {
    const root = tempCMakeProject();
    const host = probeHost(root);

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
  }, 90_000);
});
