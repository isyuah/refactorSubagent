import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probeHost } from "../src/runtime/host-preflight.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { runCTest } from "../src/runtime/ctest-runner.js";
import { resolveBuildWorkflow } from "../src/workflow/build-workflow.js";
import { executeBuildWorkflow } from "../src/workflow/build-executor.js";
import type { CTestSuiteSpec } from "../src/artifacts/index.js";

const LIBUV_VERSION = "v1.52.1";
const LIBUV_REPO = "https://github.com/libuv/libuv.git";
const LIBUV_WORKFLOW_ID = "libuv-v1.52.1-cmake-debug";

function run(program: string, args: string[], cwd: string): string {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed:\n${output}`);
  }
  return output;
}

function sourceArgument(): string | null {
  const index = Bun.argv.indexOf("--source");
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  return value ? resolve(value) : null;
}

const providedSource = sourceArgument();
const tempRoot = mkdtempSync(join(tmpdir(), "refactor-libuv-"));
const repo = providedSource ?? join(tempRoot, "libuv");

if (!providedSource) {
  console.log(`cloning libuv ${LIBUV_VERSION} into ${repo}`);
  run("git", ["clone", "--depth", "1", "--branch", LIBUV_VERSION, LIBUV_REPO, repo], tempRoot);
} else if (!existsSync(join(repo, "CMakeLists.txt"))) {
  throw new Error(`--source is not a libuv/CMake project: ${repo}`);
}

const host = probeHost(repo);
const detection = detectCProject(repo, host);
console.log(JSON.stringify({
  version: LIBUV_VERSION,
  repo,
  cmake: host.tools.cmake,
  build_systems: detection.build_systems,
  primary_build_system: detection.primary_build_system,
  source_file_count: detection.source_files.length,
  adapter: detection.adapter,
  status: detection.status,
  reason: detection.reason,
}, null, 2));

if (detection.primary_build_system !== "cmake" || detection.status !== "ready") {
  throw new Error(`libuv CMake detection is not ready: ${detection.reason}`);
}

const workflow = await resolveBuildWorkflow({
  entry: "examples/workflows/libuv-build.ts",
  workflowId: LIBUV_WORKFLOW_ID,
  revision: 1,
  cwd: process.cwd(),
  host,
  project: detection,
});
if (workflow.output === null) {
  throw new Error("libuv workflow unexpectedly produced no static output");
}
console.log(JSON.stringify({
  workflow: workflow.manifest,
  artifact: workflow.output.artifact,
}, null, 2));

console.log("building libuv Debug test artifacts through BuildWorkflow...");
const result = await executeBuildWorkflow({
  cwd: repo,
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
  timeoutMs: 1_200_000,
});
console.log(JSON.stringify(result, null, 2));

if (result.status !== "pass") {
  process.exitCode = 1;
} else {
  const suite: CTestSuiteSpec = {
    kind: "ctest-suite-spec",
    version: 1,
    build_dir: "build",
    configuration: "Debug",
    timeout_ms: 1_200_000,
    parallelism: 1,
    extra_args: [],
    environment: {},
  };
  console.log("running libuv CTest suite...");
  const testResult = await runCTest({ repoDir: repo, spec: suite, host });
  console.log(JSON.stringify({
    status: testResult.status,
    exit_code: testResult.exit_code,
    duration_ms: testResult.duration_ms,
    summary: testResult.summary,
    failed_tests: testResult.failed_tests,
    failure: testResult.failure,
  }, null, 2));
  if (testResult.status !== "pass") process.exitCode = 1;
}
