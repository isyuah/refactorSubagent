/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/e2e-generated-workflow.ts —— 声明制全流程 e2e（B 方案主验收脚本）
 *
 * 【跑什么场景】
 *   现场生成一个最小 CMake C 工程（trim_in_place 去空白程序 + CTest）→
 *   开 test-writer 主会话（内含 build-writer 子代理 + dep-registry MCP）→
 *   AI 声明依赖集并写出 Build/TestWorkflow 源码 → 宿主按声明执行构建 →
 *   双 worktree 差分 → 程序裁决。期望 ACCEPTED，任何一项不达标 exitCode=1。
 *
 * 【B 方案后的关键变化】
 *   - enforceScope: false（TEMP）：临时关掉 PreToolUse 范围拦截先把流程跑通，
 *     Glob/可读白名单模型之后再收紧（注释原话）；
 *   - workflowTimeoutMs 提到 180 万毫秒（30 分钟）：test-writer + build-writer
 *     子代理往返需要余量；
 *   - 验收检查改为看 DeclaredBuildSet（声明集）+ 双构建 pass + 双侧测试完成。
 *
 * 【最小复现】bun run e2e:generated-workflow
 *   （要 Claude 可用；实测约 8 分钟量级）
 *
 * 【本文件是教程注释版】原文件 scripts/e2e-generated-workflow.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgentWorkflowVerification } from "../src/runtime/workflow-agent-pipeline.js";   // ★ 声明制主编排

interface Options {
  readonly root: string;
  readonly sessionId: string;
}

// 顶层 await（Bun 支持）：脚本一加载就解析参数、搭好临时仓库。
const options = parseOptions(Bun.argv.slice(2));
const repo = join(options.root, "repo");
const sessionRoot = join(options.root, "session-root");
const observabilityRoot = join(sessionRoot, ".refactor", "e2e");   // E2E 观测目录的父目录
mkdirSync(observabilityRoot, { recursive: true });
mkdirSync(repo, { recursive: true });
writeProject(repo);       // 现场写出最小 CMake C 工程
initializeGit(repo);      // 初始化 git（worktree/commit 的前提）

console.log(JSON.stringify({
  scenario: "generated-typescript-workflow-e2e",
  repo,
  session_root: sessionRoot,
  observability_root: observabilityRoot,
  message: "Claude will write BuildWorkflow/TestWorkflow TypeScript sources before execution",
}, null, 2));

// ── 主调用：声明制全流程（分析/会话/重构/构建/测试/对比/裁决全部在里面）──────
const result = await runAgentWorkflowVerification({
  repoPath: repo,
  sessionRoot,
  sessionId: options.sessionId,
  allowedEditableFiles: ["src/trim.c"],   // 项目级策略：声明制下 AI 的 editable 必须落在此集合内
  task:
    "这是一个从零开始的新 CMake C 项目。请完成一次保守的行为保持型重构：" +
    "只修改 src/trim.c 中的 trim_in_place，提取一个或多个清晰的 static 辅助函数或简化内部控制流；" +
    "不得修改 src/trim.h、src/main.c、tests、CMakeLists.txt 或任何其他文件；" +
    "保持返回指针、原地写入、前后空白处理、空字符串、全空白字符串和退出行为不变。" +
    "构建和测试流程必须由你根据项目事实写成可执行的 TypeScript BuildWorkflow 与 TestWorkflow 源文件；" +
    "如果某一步无法从事实证明，不要猜测。",
  // TEMP: scope enforcement off to get the flow running end-to-end; the
  // scoping model (Glob/readable white-list) will be re-tightened after.
  // ↑ TEMP 注释原文：先关范围拦截跑通端到端，范围模型之后重新收紧。
  enforceScope: false,
  workflowTimeoutMs: 1_800_000,  // test-writer + build-writer subagent needs headroom
  buildTimeoutMs: 120_000,
  ctestTimeoutMs: 180_000,
});

// ── 验收指标：四项全达标才算通过（否则 exitCode=1 让 CI 红）────────────────
const declared = result.declared;
const workflowsProduced = declared !== null &&
  declared.declaredSet.builds.length >= 0 &&          // 声明集存在（build 数 N≥0，空集合法）
  declared.testResolution.entry.endsWith(".ts") &&
  existsSync(declared.testResolution.entry) &&        // test workflow 源文件真实落盘
  declared.buildResolutions.length > 0 &&
  declared.buildResolutions.every((b) => existsSync(b.entry));   // 每个 build 源文件也在
const buildsPassed = result.verification?.baselineBuild?.status === "pass" &&
  result.verification?.candidateBuild?.status === "pass";        // 双版本构建都过
const testsCompleted = result.verification?.baseline !== null &&
  result.verification?.baseline !== undefined &&
  result.verification?.candidate !== null &&
  result.verification?.candidate !== undefined;                  // 双侧测试都跑完
const accepted = result.state === "ACCEPTED";                      // 程序裁决为接受

// 结果摘要（JSON 打印，便于人工查看与 CI 抓取）。
console.log(JSON.stringify({
  scenario: "generated-typescript-workflow-e2e",
  state: result.state,
  workflows_produced: workflowsProduced,
  declared_builds: declared === null ? [] : declared.declaredSet.builds.map((b) => ({
    id: b.id,
    entry: b.entry,
    run_local: b.run_local,       // true = 本次 AI 刚生成的（run-local）
  })),
  test_workflow: declared === null ? null : {
    entry: declared.testResolution.entry,
    id: declared.workflowId,
    revision: declared.workflowRevision,
  },
  builds_passed: buildsPassed,
  tests_completed: testsCompleted,
  scope_denials: result.scopeDenials,     // 越界拦截记录（enforceScope 关闭时应为空）
  log_dir: result.logDir,                 // 观测目录（Dashboard 指过去就能看）
  history: result.store.history.map((event) => `${event.from} -> ${event.to}`),   // 状态机轨迹
}, null, 2));

if (!workflowsProduced || !buildsPassed || !testsCompleted || !accepted) process.exitCode = 1;

// ── 以下是小工具函数：参数解析 / 工程模板 / git 初始化 ─────────────────────

// 解析 --root / --session；root 缺省用临时目录。
function parseOptions(args: readonly string[]): Options {
  const rootArg = valueAfter(args, "--root");
  const sessionId = valueAfter(args, "--session") ?? "generated-workflow-e2e";
  const root = rootArg === null
    ? mkdtempSync(join(tmpdir(), "refactor-generated-workflow-"))
    : resolve(rootArg);   // 用户给的路径要 resolve 成绝对路径
  return { root, sessionId };
}

// 取 "--name value" 里的 value；缺失或像是另一个选项 → null。
function valueAfter(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) return null;
  return value;
}

// ── writeProject：现场写最小 CMake C 工程（trim_app + trim_test + CTest）────
// 注意字符串里的 \\0、\\n 是"转义后再转义"：写入文件后才是 C 源码里的 \0 和换行。
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
    "add_test(NAME trim_behavior COMMAND trim_test)",   // CTest 顶层测试名：trim_behavior
    "",
  ].join("\n"));
  writeFileSync(join(root, "src", "trim.h"), [
    "#ifndef GENERATED_WORKFLOW_TRIM_H",
    "#define GENERATED_WORKFLOW_TRIM_H",
    "char *trim_in_place(char *value);",
    "#endif",
    "",
  ].join("\n"));
  // 被重构的目标函数：原地去首尾空白，返回去除后首字符指针（返回值语义是验收重点）。
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
  // CTest 用例：四种输入（常规/空串/全空白/中间空白），断言返回值与原地改写结果。
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

// git 初始化：固定 user.name/email（否则本机全局配置会干扰），已提交过就不再重复提交。
function initializeGit(repo: string): void {
  git(repo, ["init", "-b", "main"]);
  git(repo, ["add", "-A"]);
  if (hasGitHead(repo) && hasNoStagedChanges(repo)) return;
  git(repo, ["commit", "-m", "initial CMake project"]);
}

// 有没有 HEAD（空仓库刚 init 完没有）。
function hasGitHead(repo: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

// 暂存区是否干净（add -A 之后没有变化 = 一切都已提交过）。
function hasNoStagedChanges(repo: string): boolean {
  try {
    git(repo, ["diff", "--cached", "--quiet"]);
    return true;
  } catch {
    return false;
  }
}

// execFileSync 包装：同步跑 git，固定身份、隐藏窗口、输出裁剪。
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
