/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/e2e-cmake.ts —— CMake 冒烟测试（不碰 AI，约 1 分钟）
 *
 * 【这个文件是干什么的】
 *   最小化地验证"CMake 路径"这条链路是通的：
 *     ① 在临时目录里用代码**现场生成**一个极小的 C 工程（CMakeLists.txt + main.c）；
 *     ② 同样用代码生成一份**声明式 BuildWorkflow**（workflow.ts，返回构建配方）；
 *     ③ resolveBuildWorkflow() 解析它 → executeBuildWorkflow() 真的执行
 *        cmake configure + cmake --build；
 *     ④ 检查产物（可执行文件）真的落在了磁盘上。
 *   它是 workflow 子系统（resolve → execute → 产物校验）的"灯泡测试"：
 *   灯亮了才值得去跑更贵的 AI 全流程。
 *
 * 【跑什么 / 要不要 Claude / 多久 / 期望输出】
 *   命令：bun run e2e:cmake
 *   要不要 Claude：不要。要不要工具：cmake（以及它自己找得到的编译器，如 VS/gcc）。
 *   耗时：约 1 分钟（一个小文件的 configure+build；脚本给构建的超时是 30 秒）。
 *   期望输出：一段 JSON ——
 *     status: "pass"、steps: [{name: "configure", …}, {name: "build", …}]、
 *     missing_artifacts: []、artifact_exists: true。
 *   退出码：status !== "pass" → 1。
 *
 * 【在整个项目里的位置】
 *   上游：package.json 的 "e2e:cmake"。
 *   下游：src/runtime/{host-preflight,project-detector}.ts、
 *         src/workflow/{build-workflow,build-executor}.ts。
 *   它和 e2e-libuv-generate.ts 用的是同一对函数（resolve + execute），
 *   差别只在"workflow 源码是脚本写死的还是 AI 生成的"。
 *
 * 【先修知识】
 *   ① 代码教程/examples/workflows/direct-build.ts（最小声明式 workflow）；
 *   ② 代码教程/src/workflow/build-workflow.ts（resolve 做 4 项对账检查）；
 *   ③ 语法：把源码写成字符串数组的技巧（下文第一次出现会讲）。
 * 【本文件是教程注释版】
 *   原文件：scripts/e2e-cmake.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCProject } from "../src/runtime/project-detector.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { executeBuildWorkflow } from "../src/workflow/build-executor.js";
import { resolveBuildWorkflow } from "../src/workflow/build-workflow.js";

const root = mkdtempSync(join(tmpdir(), "refactor-e2e-cmake-"));
// ── 第 1 步：现场写一个最小 C 工程 ────────────────────────────────
// 【语法】["a", "b", ""].join("\n")：把若干行字符串用换行符连起来写文件。
//   这样可以避免在 TS 源码里写一大坨带转义的多行字符串，也更好对齐缩进。
writeFileSync(
  join(root, "CMakeLists.txt"),
  [
    "cmake_minimum_required(VERSION 3.15)",
    "project(e2e_cmake_smoke C)",            // ← project(... C)：声明这是 C 语言工程
    "add_executable(e2e_cmake_smoke main.c)",
    "",
  ].join("\n"),
);
writeFileSync(join(root, "main.c"), "#include <stdio.h>\nint main(void) { puts(\"cmake-smoke\"); return 0; }\n");
// ↑ 一个只会打印一行的 main.c —— 冒烟测试不需要更多
// ── 第 2 步：现场写一份"声明式 BuildWorkflow"源码 ──────────────────
// 【作用】注意：这份 workflow.ts 是**字符串**拼出来的，运行时才写到磁盘，
//   再由 resolveBuildWorkflow 当成一个独立源文件去加载执行。
//   它 return 的对象和 examples/workflows/libuv-build.ts 是同一个形状：
//   environment.spec（怎么构建）+ artifact.paths（承诺产出哪些文件）。
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
    // ↑ null = 让 CMake 自己挑生成器。Windows 上通常挑 Visual Studio 多配置，
    //   于是产物会出现在 build/Debug/ 下（见脚本最后的 artifact_exists 判断）
    "      target: null,",
    "      configure_flags: [],",
    '      build_flags: ["--config", "Debug"],',
    // ↑ "--config Debug" 只在多配置生成器（VS/Xcode）下有意义：选 Debug 配置
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
    // ↑ 键 app 是逻辑名，值是仓库相对路径；执行完宿主会检查这个文件存在
    '    metadata: { scenario: "targeted-cmake-build" },',
    "  },",
    "});",
    "",
  ].join("\n"),
);

// ── 第 3 步：探测 + 解析 + 执行 ──────────────────────────────────
const host = probeHost(root);
const project = detectCProject(root, host);
if (project.status !== "ready" || project.primary_build_system !== "cmake") {
  throw new Error(`CMake smoke preflight blocked: ${project.reason}`);
  // ↑ fail-closed：本来就该认出这是个 CMake 项目；认不出说明探测器有问题
}

const workflow = await resolveBuildWorkflow({
  entry: "workflow.ts",
  cwd: root,
  workflowId: "e2e-cmake-smoke",
  revision: 1,
  host,
  project,
});
// ↑ 声明式 workflow：resolve 阶段会在沙箱子进程里执行一次 workflow.ts 的默认导出，
//   返回值过 BuildWorkflowOutput.parse()，并核对 id/revision 与这里传入的一致
const result = await executeBuildWorkflow({
  cwd: root,
  output: workflow.output,
  host,
  policy: {
    readableGlobs: ["**"],       // ← 能读整个项目
    writableGlobs: ["build/**"], // ← 只能写 build/ 目录
    allowedTools: ["cmake"],     // ← 只许跑 cmake 这一个外部工具
    maxProcesses: 2,
    maxOutputBytes: 8 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
  },
  timeoutMs: 30_000,             // ← 30 秒，超时就整个构建判失败
});

// ── 第 4 步：打印结果并做断言 ────────────────────────────────────
console.log(JSON.stringify({
  scenario: "targeted-cmake-build",
  root,
  project: {
    primary_build_system: project.primary_build_system,
    adapter: project.adapter,
    status: project.status,
  },
  workflow: `${workflow.manifest.id}@${String(workflow.manifest.revision)}`,
  status: result.status,                    // ← "pass" 才算成功
  steps: result.steps.map((step) => ({ name: step.name, status: step.status, exit_code: step.exitCode })),
  // ↑ steps 应该是 configure 和 build 两步（CMake 分支固定这两段）
  missing_artifacts: result.missingArtifacts,   // ← 承诺了但没出现的产物
  artifact_exists: existsSync(join(root, "build", process.platform === "win32" ? "Debug/e2e_cmake_smoke.exe" : "e2e_cmake_smoke")),
  // ↑ 独立于宿主的"第二道检查"：Windows 多配置生成器会把产物放进 build/Debug/，
  //   其他平台直接是 build/e2e_cmake_smoke
  failure: result.failure,
}, null, 2));

if (result.status !== "pass") process.exitCode = 1;
