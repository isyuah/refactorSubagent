import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgentWorkflowVerification } from "../src/runtime/workflow-agent-pipeline.js";

interface Options {
  readonly root: string;
  readonly sessionId: string;
}

const options = parseOptions(Bun.argv.slice(2));
const repo = join(options.root, "repo");
const sessionRoot = join(options.root, "session-root");
const observabilityRoot = join(sessionRoot, ".refactor", "e2e");
mkdirSync(observabilityRoot, { recursive: true });
mkdirSync(repo, { recursive: true });
writeProject(repo);
initializeGit(repo);

console.log(JSON.stringify({
  scenario: "generated-typescript-workflow-e2e",
  repo,
  session_root: sessionRoot,
  observability_root: observabilityRoot,
  message: "Claude will write BuildWorkflow/TestWorkflow TypeScript sources before execution",
}, null, 2));

const result = await runAgentWorkflowVerification({
  repoPath: repo,
  sessionRoot,
  sessionId: options.sessionId,
  allowedEditableFiles: ["src/trim.c"],
  task:
    "这是一个从零开始的新 CMake C 项目。请完成一次保守的行为保持型重构：" +
    "只修改 src/trim.c 中的 trim_in_place，提取一个或多个清晰的 static 辅助函数或简化内部控制流；" +
    "不得修改 src/trim.h、src/main.c、tests、CMakeLists.txt 或任何其他文件；" +
    "保持返回指针、原地写入、前后空白处理、空字符串、全空白字符串和退出行为不变。" +
    "构建和测试流程必须由你根据项目事实写成可执行的 TypeScript BuildWorkflow 与 TestWorkflow 源文件；" +
    "如果某一步无法从事实证明，不要猜测。",
  // TEMP: scope enforcement off to get the flow running end-to-end; the
  // scoping model (Glob/readable white-list) will be re-tightened after.
  enforceScope: false,
  workflowTimeoutMs: 1_800_000,  // test-writer + build-writer subagent needs headroom
  buildTimeoutMs: 120_000,
  ctestTimeoutMs: 180_000,
});

const declared = result.declared;
const workflowsProduced = declared !== null &&
  declared.declaredSet.builds.length >= 0 &&
  declared.testResolution.entry.endsWith(".ts") &&
  existsSync(declared.testResolution.entry) &&
  declared.buildResolutions.length > 0 &&
  declared.buildResolutions.every((b) => existsSync(b.entry));
const buildsPassed = result.verification?.baselineBuild?.status === "pass" &&
  result.verification?.candidateBuild?.status === "pass";
const testsCompleted = result.verification?.baseline !== null &&
  result.verification?.baseline !== undefined &&
  result.verification?.candidate !== null &&
  result.verification?.candidate !== undefined;
const accepted = result.state === "ACCEPTED";

console.log(JSON.stringify({
  scenario: "generated-typescript-workflow-e2e",
  state: result.state,
  workflows_produced: workflowsProduced,
  declared_builds: declared === null ? [] : declared.declaredSet.builds.map((b) => ({
    id: b.id,
    entry: b.entry,
    run_local: b.run_local,
  })),
  test_workflow: declared === null ? null : {
    entry: declared.testResolution.entry,
    id: declared.workflowId,
    revision: declared.workflowRevision,
  },
  builds_passed: buildsPassed,
  tests_completed: testsCompleted,
  scope_denials: result.scopeDenials,
  log_dir: result.logDir,
  history: result.store.history.map((event) => `${event.from} -> ${event.to}`),
}, null, 2));

if (!workflowsProduced || !buildsPassed || !testsCompleted || !accepted) process.exitCode = 1;

function parseOptions(args: readonly string[]): Options {
  const rootArg = valueAfter(args, "--root");
  const sessionId = valueAfter(args, "--session") ?? "generated-workflow-e2e";
  const root = rootArg === null
    ? mkdtempSync(join(tmpdir(), "refactor-generated-workflow-"))
    : resolve(rootArg);
  return { root, sessionId };
}

function valueAfter(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) return null;
  return value;
}

function writeProject(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "CMakeLists.txt"), [
    "cmake_minimum_required(VERSION 3.15)",
    "project(generated_workflow_demo C)",
    "set(CMAKE_C_STANDARD 11)",
    "set(CMAKE_C_STANDARD_REQUIRED ON)",
    "include(CTest)",
    "enable_testing()",
    "add_executable(trim_app src/main.c src/trim.c)",
    "add_executable(trim_test tests/test_trim.c src/trim.c)",
    "target_include_directories(trim_app PRIVATE src)",
    "target_include_directories(trim_test PRIVATE src)",
    "add_test(NAME trim_behavior COMMAND trim_test)",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src", "trim.h"), [
    "#ifndef GENERATED_WORKFLOW_TRIM_H",
    "#define GENERATED_WORKFLOW_TRIM_H",
    "char *trim_in_place(char *value);",
    "#endif",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src", "trim.c"), [
    "#include <ctype.h>",
    "#include \"trim.h\"",
    "",
    "char *trim_in_place(char *value) {",
    "    char *start = value;",
    "    while (*start != '\\0' && isspace((unsigned char)*start)) start++;",
    "    char *end = start;",
    "    while (*end != '\\0') end++;",
    "    while (end > start && isspace((unsigned char)end[-1])) end--;",
    "    *end = '\\0';",
    "    return start;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src", "main.c"), [
    "#include <stdio.h>",
    "#include \"trim.h\"",
    "",
    "int main(int argc, char **argv) {",
    "    for (int index = 1; index < argc; index++) {",
    "        printf(\"%s\\n\", trim_in_place(argv[index]));",
    "    }",
    "    return 0;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(root, "tests", "test_trim.c"), [
    "#include <assert.h>",
    "#include <string.h>",
    "#include \"trim.h\"",
    "",
    "static void assert_trim(char *value, const char *expected_value, const char *expected_returned) {",
    "    char *result = trim_in_place(value);",
    "    assert(strcmp(result, expected_returned) == 0);",
    "    assert(strcmp(value, expected_value) == 0);",
    "}",
    "",
    "int main(void) {",
    "    char normal[] = \"  hello world  \";",
    "    assert_trim(normal, \"  hello world\", \"hello world\");",
    "    char empty[] = \"\";",
    "    assert_trim(empty, \"\", \"\");",
    "    char whitespace[] = \" \\t\\n\";",
    "    assert_trim(whitespace, \" \\t\\n\", \"\");",
    "    char interior[] = \"  a  b  \";",
    "    assert_trim(interior, \"  a  b\", \"a  b\");",
    "    return 0;",
    "}",
    "",
  ].join("\n"));
}

function initializeGit(repo: string): void {
  git(repo, ["init", "-b", "main"]);
  git(repo, ["add", "-A"]);
  if (hasGitHead(repo) && hasNoStagedChanges(repo)) return;
  git(repo, ["commit", "-m", "initial CMake project"]);
}

function hasGitHead(repo: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function hasNoStagedChanges(repo: string): boolean {
  try {
    git(repo, ["diff", "--cached", "--quiet"]);
    return true;
  } catch {
    return false;
  }
}


function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [
    "-c", "user.email=generated-workflow@local",
    "-c", "user.name=generated-workflow",
    ...args,
  ], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  }).trim();
}
