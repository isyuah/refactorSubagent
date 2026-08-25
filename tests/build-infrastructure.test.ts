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

  test("detects CMake and does not silently choose direct compiler", () => {
    const root = tempProject();
    writeFileSync(join(root, "CMakeLists.txt"), "project(example C)\n");
    writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");

    const detection = detectCProject(root);
    expect(detection.primary_build_system).toBe("cmake");
    expect(detection.adapter).toBe("cmake");
    expect(detection.status).toBe("needs-adapter");
  });

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
  });
});
