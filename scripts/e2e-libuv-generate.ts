/**
 * E2E: AI 从零生成 libuv 的 BuildWorkflow，并验证构建产物正确。
 *
 * 覆盖"生成流程"端到端：
 *   1. resolveWorkflows 生成分支（CMakeFacts 策略对 libuv 返回 null）
 *   2. AI 自主生成 BuildWorkflow（无模板，读项目推断）
 *   3. 程序 schema 校验生成结果
 *   4. execute 真实构建 libuv（CMake configure + build）
 *   5. 产物 uv_run_tests.exe / uv_run_tests_a.exe 存在
 *
 * 不含 refactor/CTest（那是全流程 e2e，见 demo-libuv-agent）。
 *
 * 用法：
 *   bun run scripts/e2e-libuv-generate.ts --source <libuv-checkout>
 */
import { existsSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { probeHost } from "../src/runtime/host-preflight.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { resolveWorkflows } from "../src/workflow/resolve-workflows.js";
import { executeBuildWorkflow } from "../src/workflow/build-executor.js";

const LIBUV_VERSION = "v1.52.1";
const LIBUV_REPO = "https://github.com/libuv/libuv.git";

function argument(name: string): string | null {
  const index = Bun.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < Bun.argv.length ? Bun.argv[index + 1]! : null;
}

function run(program: string, args: string[], cwd: string): string {
  const result = Bun.spawnSync([program, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

const source = argument("--source");
const tempRoot = mkdtempSync(join(tmpdir(), "refactor-libuv-generate-"));
const repo = source === null ? join(tempRoot, "libuv") : resolve(source);
const sessionRoot = join(tempRoot, "session-root");

if (source === null) {
  console.log(`cloning libuv ${LIBUV_VERSION} into ${repo}...`);
  run("git", ["clone", "--depth", "1", "--branch", LIBUV_VERSION, LIBUV_REPO, repo], tempRoot);
} else if (!existsSync(join(repo, "CMakeLists.txt"))) {
  throw new Error(`--source is not a libuv/CMake project: ${repo}`);
}

console.log(`repo: ${repo}`);
console.log(`session root: ${sessionRoot}`);
console.log("=== 1. preflight ===");
const host = probeHost(repo);
const project = detectCProject(repo, host);
console.log(`project: ${project.primary_build_system} (${project.status})`);
if (project.primary_build_system !== "cmake" || project.status !== "ready") {
  throw new Error(`libuv CMake detection is not ready: ${project.reason}`);
}

console.log("=== 2. AI generates BuildWorkflow (strategy returns null for libuv) ===");
const workflows = await resolveWorkflows({
  workspaceRoot: repo,
  sessionRoot,
  host,
  project,
  taskContext: "libuv v1.52.1: build the Debug test suite via CMake; produce uv_run_tests and uv_run_tests_a executables.",
  workflowTimeoutMs: 1_200_000,
});

console.log(`build mode: ${workflows.buildResolution.mode}`);
console.log(`build entry: ${workflows.build.entry}`);
console.log(`build manifest: ${workflows.build.manifest.id}@${String(workflows.build.manifest.revision)}`);
console.log(`build output: ${workflows.build.output === null ? "null (workflow-driven)" : "declarative"}`);
console.log(`test mode: ${workflows.testResolution.mode}`);
console.log(`test manifest: ${workflows.test.manifest.id}`);

if (workflows.buildResolution.mode !== "generated") {
  throw new Error(`expected generated BuildWorkflow, got ${workflows.buildResolution.mode}`);
}
if (!existsSync(workflows.build.entry)) {
  throw new Error(`generated BuildWorkflow source missing: ${workflows.build.entry}`);
}
// Schema 校验通过 = AI 生成结果格式正确（resolveWorkflows 内部已 parse）
console.log("generated BuildWorkflow passed host schema validation");

console.log("=== 3. execute: real libuv build ===");
const output = workflows.build.output;
const execution = await executeBuildWorkflow({
  cwd: repo,
  output,
  entry: workflows.build.entry,
  host,
  project,
  policy: {
    readableGlobs: ["**"],
    writableGlobs: output === null ? ["**"] : ["build/**"],
    allowedTools: output === null ? [] : ["cmake"],
    maxProcesses: 4,
    maxOutputBytes: 32 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
  },
  timeoutMs: 1_800_000,
});

console.log(`build status: ${execution.status}`);
for (const step of execution.steps) {
  console.log(`  step ${step.name}: ${step.status} (exit ${String(step.exitCode)})`);
}
if (execution.missingArtifacts.length > 0) {
  console.log(`missing artifacts: ${execution.missingArtifacts.join(", ")}`);
}

if (execution.status !== "pass") {
  throw new Error(`libuv build failed: ${execution.failure ?? "unknown"}`);
}

console.log("=== 4. artifact verification ===");
const declaredPaths = Object.values(execution.artifact.paths);
console.log(`declared artifacts: ${JSON.stringify(execution.artifact.paths)}`);
const missing = declaredPaths.filter((path) => !existsSync(join(repo, path)));
if (missing.length > 0) {
  throw new Error(`declared artifacts missing on disk: ${missing.join(", ")}`);
}
console.log("all declared artifacts exist on disk");

// 目标产物正确性：uv_run_tests.exe 应可执行且是 PE 文件
for (const [name, path] of Object.entries(execution.artifact.paths)) {
  const absolute = join(repo, path);
  const bytes = Bun.file(absolute).arrayBuffer().then((b) => new Uint8Array(b).slice(0, 2));
  const header = String.fromCharCode(...(await bytes));
  const executable = header === "MZ";
  console.log(`  ${name}: ${path} (PE executable: ${executable})`);
  if (!executable) {
    throw new Error(`artifact ${name} is not a Windows executable (header ${header})`);
  }
}

console.log("\n=== PASS ===");
console.log(`AI generated BuildWorkflow → schema valid → real libuv build → artifacts correct`);
console.log(`session: ${sessionRoot}`);
