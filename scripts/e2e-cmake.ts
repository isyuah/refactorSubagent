import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCProject } from "../src/runtime/project-detector.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { executeBuildWorkflow } from "../src/workflow/build-executor.js";
import { resolveBuildWorkflow } from "../src/workflow/build-workflow.js";

const root = mkdtempSync(join(tmpdir(), "refactor-e2e-cmake-"));
writeFileSync(
  join(root, "CMakeLists.txt"),
  [
    "cmake_minimum_required(VERSION 3.15)",
    "project(e2e_cmake_smoke C)",
    "add_executable(e2e_cmake_smoke main.c)",
    "",
  ].join("\n"),
);
writeFileSync(join(root, "main.c"), "#include <stdio.h>\nint main(void) { puts(\"cmake-smoke\"); return 0; }\n");
writeFileSync(
  join(root, "workflow.ts"),
  [
    "export default () => ({",
    '  kind: "build-workflow-output",',
    "  version: 1,",
    '  workflow_id: "e2e-cmake-smoke",',
    "  workflow_revision: 1,",
    "  environment: {",
    '    kind: "environment-spec",',
    "    version: 1,",
    "    build: {",
    '      kind: "cmake",',
    '      source_dir: ".",',
    '      build_dir: "build",',
    "      generator: null,",
    "      target: null,",
    "      configure_flags: [],",
    '      build_flags: ["--config", "Debug"],',
    '      output: "build/e2e_cmake_smoke",',
    "    },",
    "    sanitizers: [],",
    "    determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },",
    '    sandbox: { run_cwd_strategy: "fresh_temp_dir" },',
    "  },",
    "  artifact: {",
    '    kind: "executable",',
    "    version: 1,",
    '    workflow_id: "e2e-cmake-smoke",',
    "    workflow_revision: 1,",
    '    paths: { app: "build/e2e_cmake_smoke" },',
    '    metadata: { scenario: "targeted-cmake-build" },',
    "  },",
    "});",
    "",
  ].join("\n"),
);

const host = probeHost(root);
const project = detectCProject(root, host);
if (project.status !== "ready" || project.primary_build_system !== "cmake") {
  throw new Error(`CMake smoke preflight blocked: ${project.reason}`);
}

const workflow = await resolveBuildWorkflow({
  entry: "workflow.ts",
  cwd: root,
  workflowId: "e2e-cmake-smoke",
  revision: 1,
  host,
  project,
});
const result = await executeBuildWorkflow({
  cwd: root,
  output: workflow.output,
  host,
  policy: {
    readableGlobs: ["**"],
    writableGlobs: ["build/**"],
    allowedTools: ["cmake"],
    maxProcesses: 2,
    maxOutputBytes: 8 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
  },
  timeoutMs: 30_000,
});

console.log(JSON.stringify({
  scenario: "targeted-cmake-build",
  root,
  project: {
    primary_build_system: project.primary_build_system,
    adapter: project.adapter,
    status: project.status,
  },
  workflow: `${workflow.manifest.id}@${String(workflow.manifest.revision)}`,
  status: result.status,
  steps: result.steps.map((step) => ({ name: step.name, status: step.status, exit_code: step.exitCode })),
  missing_artifacts: result.missingArtifacts,
  artifact_exists: existsSync(join(root, "build", process.platform === "win32" ? "Debug/e2e_cmake_smoke.exe" : "e2e_cmake_smoke")),
  failure: result.failure,
}, null, 2));

if (result.status !== "pass") process.exitCode = 1;
