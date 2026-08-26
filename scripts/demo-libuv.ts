import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probeHost } from "../src/runtime/host-preflight.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { buildWorktree } from "../src/runtime/builder.js";
import { runCTest } from "../src/runtime/ctest-runner.js";
import type { CTestSuiteSpec, EnvironmentSpec } from "../src/artifacts/index.js";

const LIBUV_VERSION = "v1.52.1";
const LIBUV_REPO = "https://github.com/libuv/libuv.git";

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

const env: EnvironmentSpec = {
  kind: "environment-spec",
  version: 1,
  build: {
    kind: "cmake",
    source_dir: ".",
    build_dir: "build",
    generator: null,
    target: null,
    configure_flags: [
      "-DBUILD_TESTING=ON",
      "-DLIBUV_BUILD_TESTS=ON",
      "-DLIBUV_BUILD_BENCH=OFF",
    ],
    build_flags: ["--config", "Debug"],
    output: "build/uv_run_tests",
  },
  sanitizers: [],
  determinism: {
    frozen_time_epoch_ms: null,
    random_seed: null,
    intercept_headers: [],
  },
  sandbox: { run_cwd_strategy: "fresh_temp_dir" },
};

console.log("building libuv Debug uv_run_tests...");
const result = buildWorktree(repo, env, host);
console.log(result.log);
console.log(JSON.stringify({
  ok: result.ok,
  binary: result.binaryAbs,
  exists: existsSync(result.binaryAbs),
}, null, 2));

if (!result.ok) {
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
