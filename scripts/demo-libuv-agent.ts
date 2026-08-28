/**
 * Real Claude + Workflow-backed CTest E2E for libuv v1.52.1.
 *
 * The checkout is temporary unless --source is supplied. The controller uses
 * fixed, reviewed BuildWorkflow/TestWorkflow source modules, while Claude is
 * responsible for analysis and the scoped candidate refactor.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runAgentWorkflowVerification } from "../src/runtime/workflow-agent-pipeline.js";

const LIBUV_VERSION = "v1.52.1";
const LIBUV_REPO = "https://github.com/libuv/libuv.git";
const WORKFLOW_ROOT = resolve(import.meta.dir, "..", "examples", "workflows");
const BUILD_WORKFLOW = join(WORKFLOW_ROOT, "libuv-build.ts");
const TEST_WORKFLOW = join(WORKFLOW_ROOT, "libuv-test.ts");

function argument(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  const value = index < 0 ? undefined : Bun.argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

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

const source = argument("--source");
const tempRoot = mkdtempSync(join(tmpdir(), "refactor-libuv-agent-"));
const repo = source === null ? join(tempRoot, "libuv") : resolve(source);
const sessionRoot = join(tempRoot, "session-root");
const sessionId = argument("--session") ?? "libuv-agent-001";

if (source === null) {
  console.log(`cloning libuv ${LIBUV_VERSION} into ${repo}`);
  run("git", ["clone", "--depth", "1", "--branch", LIBUV_VERSION, LIBUV_REPO, repo], tempRoot);
} else if (!existsSync(join(repo, "CMakeLists.txt"))) {
  throw new Error(`--source is not a libuv/CMake project: ${repo}`);
}

console.log(`repo: ${repo}`);
console.log(`session root: ${sessionRoot}`);
console.log("running Claude Analyze → Workflow resolution → scoped Refactor → CTest differential verification...\n");

const result = await runAgentWorkflowVerification({
  repoPath: repo,
  sessionRoot,
  sessionId,
  task:
    "对 libuv v1.52.1 的 src/strscpy.c 做保守的行为保持型 C 重构：" +
    "只允许修改该文件中 uv__strscpy 的内部结构，优先提取清晰的 static 辅助逻辑或简化控制流；" +
    "不得修改公开 API、返回值、内存写入语义、测试、构建文件或其他文件。" +
    "如果无法证明安全则不要修改。",
  build: {
    entry: BUILD_WORKFLOW,
    entryRoot: dirname(BUILD_WORKFLOW),
    id: "libuv-v1.52.1-cmake-debug",
    revision: 1,
    force: true,
  },
  test: {
    entry: TEST_WORKFLOW,
    entryRoot: dirname(TEST_WORKFLOW),
    id: "libuv-v1.52.1-ctest-debug",
    revision: 1,
    force: true,
  },
  allowedEditableFiles: ["src/strscpy.c"],
  buildTimeoutMs: 1_200_000,
  ctestTimeoutMs: 1_200_000,
  knownEnvironmentPatterns: [
    /IPv6/i,
    /UDP/i,
    /DNS/i,
    /short path/i,
    /unavailable/i,
    /refused/i,
    /timed out/i,
  ],
});

console.log("=== result ===");
console.log(`final state: ${result.state}`);
console.log(`session: ${result.store.sessionDir}`);
console.log(`logs: ${result.logDir}`);
console.log(`scope denials: ${JSON.stringify(result.scopeDenials)}`);
const verification = result.verification;
if (verification?.baseline !== null && verification?.baseline !== undefined) {
  console.log(`baseline CTest: ${verification.baseline.result.status}`);
  console.log(`baseline failures: ${verification.baseline.result.failed_tests.map((failure) => failure.name).join(", ") || "none"}`);
}
if (verification?.candidate !== null && verification?.candidate !== undefined) {
  console.log(`candidate CTest: ${verification.candidate.result.status}`);
}
if (verification?.comparison !== null && verification?.comparison !== undefined) {
  console.log(`CTest comparison: ${verification.comparison.overall}`);
}
if (result.refactorSummary.length > 0) {
  console.log(`\nrefactor summary:\n${result.refactorSummary}`);
}
console.log("\nstate history:");
for (const event of result.store.history) {
  console.log(`  ${event.from} -> ${event.to} [${event.artifact_kind ?? "abort"}]`);
}

if (result.state !== "ACCEPTED") process.exitCode = 1;
