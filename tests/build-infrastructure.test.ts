import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectCProject } from "../src/runtime/project-detector.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { buildWorktree } from "../src/runtime/builder.js";
import type { EnvironmentSpec } from "../src/artifacts/index.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "rfr-detect-"));
}

describe("C project detection and build infrastructure", () => {
  test("classifies explicit C sources as direct-c", () => {
    const root = tempProject();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.c"), "int main(void){return 0;}\n");

    const detection = detectCProject(root);
    expect(detection.primary_build_system).toBe("direct-c");
    expect(detection.adapter).toBe("direct-compiler");
    expect(detection.status).toBe("ready");
    expect(detection.source_files).toEqual(["src/main.c"]);
  });

  test("detects CMake as executable when cmake is measured available", () => {
    const root = tempProject();
    writeFileSync(join(root, "CMakeLists.txt"), "project(example C)\n");
    writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");

    const host = probeHost(root);
    const detection = detectCProject(root, host);
    expect(detection.primary_build_system).toBe("cmake");
    expect(detection.adapter).toBe("cmake");
    expect(detection.status).toBe(host.tools.cmake?.available ? "ready" : "needs-adapter");
  });

  test("cmake adapter configures and builds a real executable", () => {
    const root = tempProject();
    writeFileSync(
      join(root, "CMakeLists.txt"),
      "cmake_minimum_required(VERSION 3.15)\nproject(smoke C)\nadd_executable(smoke main.c)\n",
    );
    writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");
    const host = probeHost(root);
    if (!host.tools.cmake?.available) return;

    const env: EnvironmentSpec = {
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
        output: "build/smoke",
      },
      determinism: {
        frozen_time_epoch_ms: null,
        random_seed: null,
        intercept_headers: [],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    };
    const result = buildWorktree(root, env, host);
    expect(result.ok).toBeTrue();
  }, 30000);

  test("direct compiler adapter builds with argv and no shell", () => {
    const root = tempProject();
    writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");
    const env: EnvironmentSpec = {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "direct-compiler",
        compiler: "gcc",
        flags: ["-Wall"],
        defines: {},
        sources: ["main.c"],
        output: "build/app",
      },
      determinism: {
        frozen_time_epoch_ms: null,
        random_seed: null,
        intercept_headers: [],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    };

    const result = buildWorktree(root, env, probeHost(root));
    expect(result.ok).toBeTrue();
    expect(result.binaryAbs.endsWith(process.platform === "win32" ? "app.exe" : "app")).toBeTrue();
  }, 30000);
});
