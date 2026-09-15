/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/demo-libuv.ts —— libuv 大基准：固定 workflow + 全量 CTest
 *
 * 【这个文件是干什么的】
 *   把 demo-e2e 的"小玩具工程"换成真实世界的大项目 libuv v1.52.1，
 *   验证三件事：① 探测器认得出 libuv 是 CMake 项目；② 固定的 BuildWorkflow
 *   （examples/workflows/libuv-build.ts，声明式）能真的把它编出来；
 *   ③ CTest 全量套件能跑起来并给出结构化结果。
 *   它【不含 AI、不做对比、不建 worktree】—— 只跑"基线这一侧"，
 *   是最小可复现的"大项目冒烟"。带 AI 的完整版见 demo-libuv-agent.ts，
 *   AI 生成 workflow 的版本见 e2e-libuv-generate.ts。
 *
 * 【跑什么 / 要不要 Claude / 多久 / 期望输出】
 *   命令：bun run demo:libuv
 *         bun run demo:libuv -- --source D:\path\to\libuv-checkout
 *                ↑ "--" 之后参数才会透传给脚本（bun run 的规则）
 *   要不要 Claude：不要。要不要网络：不给 --source 就要（现场 git clone v1.52.1，
 *   浅克隆）。要不要工具：git + cmake + ctest（VS 生成器也行）。
 *   耗时（这台 Windows 主机实测）：clone ~1 分钟（走网络）；
 *   configure ≈22 秒；build ≈85 秒；**全量 CTest 每侧 ≈368 秒**（parallelism 1，
 *   串行跑 ~474 个 TAP 用例）。总计约 8 分钟。
 *   期望输出：三段 JSON（探测结果 / workflow+artifact / 构建结果），
 *   然后是 CTest 结果 JSON。⚠️ libuv 在 Windows 上**不会全绿**
 *   （IPv6/DNS/文件监听等用例环境敏感，🔗 见《零基础看懂教程.md》§1.8），
 *   所以脚本常以退出码 1 结束——这不代表流程坏了，看 failed_tests 列表即可。
 *
 * 【在整个项目里的位置】
 *   上游：package.json 的 "demo:libuv" / "e2e:libuv"。
 *   下游：src/workflow/build-workflow.ts（resolve）、build-executor.ts（执行）、
 *         src/runtime/ctest-runner.ts（跑 CTest）。
 *   它产出的 CTest 结果就是"基线"，demo-libuv-agent.ts 会把同一套流程放进
 *   双 worktree 里跑两遍再做差分。
 *
 * 【先修知识】
 *   ① 代码教程/examples/workflows/libuv-build.ts（那份"构建配方"逐字段讲过）；
 *   ② 代码教程/src/workflow/build-executor.ts（policy 四项限制怎么生效）；
 *   ③ 代码教程/src/artifacts/ctest-suite.ts（CTestSuiteSpec 的字段含义）。
 * 【本文件是教程注释版】
 *   原文件：scripts/demo-libuv.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import { spawnSync } from "node:child_process";   // ← spawnSync：同步启动子进程（比 execSync 更安全，不走 shell）
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
// ↑ 必须与 libuv-build.ts 里 workflow_id 完全一致，否则 resolve 会抛 "id mismatch"

// ── run：跑一个外部命令，失败就把两路输出一起抛出来 ─────────────────
// 【参数】program：可执行名；args：参数数组；cwd：在哪个目录跑。
// 【返回】stdout+stderr 拼接的字符串（clone 时没用它，但出错时能直接看到原因）。
// 【语法】result.stdout ?? ""：spawnSync 的 stdout 类型是 string | null，?? 兜成空串。
function run(program: string, args: string[], cwd: string): string {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    shell: false,          // ← 不经过 shell，参数不会被空格/引号二次解释（更安全）
    windowsHide: true,     // ← Windows 上不弹出黑色控制台窗口
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed:\n${output}`);
  }
  return output;
}

// ── sourceArgument：手写的 --source 参数解析 ───────────────────────
// 【作用】从命令行里找 "--source" 的下一个词（本地 libuv checkout 的路径）。
// 【语法】Bun.argv 是完整参数数组；indexOf 找到位置后取 index+1。
function sourceArgument(): string | null {
  const index = Bun.argv.indexOf("--source");
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  return value ? resolve(value) : null;   // ← 转绝对路径；没给就返回 null
}

const providedSource = sourceArgument();
const tempRoot = mkdtempSync(join(tmpdir(), "refactor-libuv-"));
const repo = providedSource ?? join(tempRoot, "libuv");
// ↑【语法】?? 空值合并：给了 --source 就用它，否则用临时目录里的 libuv

// ── 第 1 步：拿到 libuv 源码 ──────────────────────────────────────
if (!providedSource) {
  console.log(`cloning libuv ${LIBUV_VERSION} into ${repo}`);
  run("git", ["clone", "--depth", "1", "--branch", LIBUV_VERSION, LIBUV_REPO, repo], tempRoot);
  // ↑ --depth 1 浅克隆（只要这一个 tag 的快照，省几百 MB）；--branch 直接切到 v1.52.1
} else if (!existsSync(join(repo, "CMakeLists.txt"))) {
  throw new Error(`--source is not a libuv/CMake project: ${repo}`);
  // ↑ fail-closed：给的目录不像 libuv（没有 CMakeLists.txt）就立刻停，
  //   避免后面拿一堆毫无意义的报错刷屏
}

// ── 第 2 步：探测主机与项目（真 AI 流程也会做的第一件事）────────────
const host = probeHost(repo);
const detection = detectCProject(repo, host);
console.log(JSON.stringify({
  version: LIBUV_VERSION,
  repo,
  cmake: host.tools.cmake,                 // ← cmake 在不在、版本号
  build_systems: detection.build_systems,
  primary_build_system: detection.primary_build_system,
  source_file_count: detection.source_files.length,
  adapter: detection.adapter,
  status: detection.status,
  reason: detection.reason,
}, null, 2));
// ↑ JSON.stringify(x, null, 2)：第三个参数 2 = 用 2 个空格缩进（"美化打印"）

if (detection.primary_build_system !== "cmake" || detection.status !== "ready") {
  throw new Error(`libuv CMake detection is not ready: ${detection.reason}`);
  // ↑ fail-closed：不是 ready 就不往下走（例如没装 cmake 时会在这里停）
}

// ── 第 3 步：解析固定的 BuildWorkflow ─────────────────────────────
// 【参数】entry：workflow 源文件（相对 cwd）；workflowId/revision：对账用；
//   cwd：解析的根目录；host/project：注入给 workflow 的事实。
// 【关系】libuv-build.ts 是声明式 —— resolve 阶段会在沙箱里把它执行一次，
//   返回值过 BuildWorkflowOutput.parse()，拿到静态产物清单（shared_tests/static_tests）。
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
  // ↑ 声明式 workflow 一定有静态 output；是 null 说明形态判断出错了
}
console.log(JSON.stringify({
  workflow: workflow.manifest,
  artifact: workflow.output.artifact,
}, null, 2));

console.log("building libuv Debug test artifacts through BuildWorkflow...");
// ── 第 4 步：真的执行构建 ─────────────────────────────────────────
// 【policy】workflow 子进程的能力边界（四道栅栏）：
//   readableGlobs   能读哪些文件（** = 全部）
//   writableGlobs   能写哪些文件（只有 build/ 目录）
//   allowedTools    允许跑哪些外部工具（只有 cmake）
//   maxProcesses / maxOutputBytes / maxFileBytes  进程数与输出、写入的量上限
const result = await executeBuildWorkflow({
  cwd: repo,
  output: workflow.output,
  host,
  policy: {
    readableGlobs: ["**"],
    writableGlobs: ["build/**"],
    allowedTools: ["cmake"],
    maxProcesses: 2,
    maxOutputBytes: 8 * 1024 * 1024,      // ← 8 MB：子进程累计输出超过就杀
    maxFileBytes: 32 * 1024 * 1024,       // ← 32 MB：单文件写入上限
  },
  timeoutMs: 1_200_000,                   // ← 20 分钟（毫秒！整个构建的总预算）
});
console.log(JSON.stringify(result, null, 2));

if (result.status !== "pass") {
  process.exitCode = 1;                   // ← 构建失败：退出码 1，结果已打印在上面
} else {
  // ── 第 5 步：跑全量 CTest ─────────────────────────────────────
  const suite: CTestSuiteSpec = {
    kind: "ctest-suite-spec",
    version: 1,
    build_dir: "build",                   // ← ctest 在这个目录里找 CTestTestfile.cmake
    configuration: "Debug",               // ← VS 多配置生成器必须指定配置
    timeout_ms: 1_200_000,                // ← 20 分钟，整个套件的预算（实测 ~368 秒）
    parallelism: 1,                       // ← ⚠️ 硬编码串行。开大能提速，但 libuv 的
    extra_args: [],                       //    网络/文件监听用例并行化可能引入新的 flaky
    environment: {},
  };
  console.log("running libuv CTest suite...");
  const testResult = await runCTest({ repoDir: repo, spec: suite, host });
  console.log(JSON.stringify({
    status: testResult.status,
    exit_code: testResult.exit_code,
    duration_ms: testResult.duration_ms,
    summary: testResult.summary,          // ← 形如 "0% tests passed, 2 tests failed out of 2"
    failed_tests: testResult.failed_tests,// ← 顶层失败目标及各自输出
    failure: testResult.failure,
  }, null, 2));
  // ⚠️ 常见误解：summary 里的 "2 tests failed" 指的是 2 个【顶层 CTest 目标】
  //    （uv_test / uv_test_a），不是里面 ~474 个 TAP 用例全挂 ——
  //    每个 uv_run_tests 进程内部会跑几百个用例。
  if (testResult.status !== "pass") process.exitCode = 1;
}
