/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/build-infrastructure.test.ts —— 项目识别 + 三种构建适配器
 *
 * 【这个文件是干什么的】
 *   锁定"构建基础设施"的门槛行为：
 *     ① detectCProject()  —— 看一眼目录就能判断这是什么构建系统：
 *                            direct-c（裸 .c 文件）/ cmake / ninja，
 *                            并给出 adapter 名和状态（ready / needs-adapter）
 *     ② NinjaAdapter      —— 给 Ninja 项目排构建计划（-C build），并真的构建成功
 *     ③ CMake adapter     —— 真的 configure + build 出一个可执行文件
 *     ④ DirectCompiler    —— 不经过 shell，直接用 argv 数组调 gcc 编译
 *   👉 这一组测试的价值：证明"程序世界"确实能独立完成编译——
 *      AI 只出方案，编译这件事不需要模型参与。
 *
 * 【在整个项目里的位置】
 *   detectCProject 是流水线第 ② 步；buildWorktree 是第 ⑦ 步"双版本构建"的
 *   底层（分别对 baseline / candidate worktree 各跑一次）。
 *   🔗 较新的 BuildWorkflow 路径走 src/workflow/build-executor.ts，
 *      那边的能力由 build-executor.test.ts 覆盖。
 *
 * 【先修知识】CMake / Ninja / 直接调编译器 三种构建方式的区别；
 *   布尔短路技巧 `if (!available) return;`（工具不在就跳过该用例）。
 *
 * 【需要真实 gcc/cmake 吗】需要（这是本组里"最集成"的测试之一）：
 *   · 前两个用例不依赖真实构建，缺 cmake 也能过；
 *   · ninja / cmake / direct-compiler 三个用例会真的编译，若主机上没装
 *     对应工具，用例会提前 return（当作跳过），不会误报失败。
 *   每个真实构建的用例都把超时放宽到 30 秒。
 *
 * 【本文件是教程注释版】原文件 tests/build-infrastructure.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectCProject } from "../src/runtime/project-detector.js";  // ← 被测：项目识别
import { probeHost } from "../src/runtime/host-preflight.js";        // ← 先量主机再识项目
import { buildWorktree, NinjaAdapter } from "../src/runtime/builder.js"; // ← 被测：构建适配器
import type { EnvironmentSpec } from "../src/artifacts/index.js";

// 每个用例都用一个全新的临时目录当"项目根"，互不污染。
function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "rfr-detect-"));
}

describe("C project detection and build infrastructure", () => {
  // 【测什么】最朴素的情形：目录里只有几个 .c 文件、没有任何构建系统文件。
  //   此时必须判成 direct-c，adapter 是 direct-compiler，状态 ready，
  //   并且 source_files 里列出的路径要用相对路径（"src/main.c" 而不是绝对路径）。
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

  // 【测什么】看到 CMakeLists.txt 就判成 cmake。关键在最后一句：
  //   状态取决于主机实测（cmake 装了 → ready；没装 → needs-adapter）。
  //   👉 这正是 fail-closed 的体现："项目是 CMake"和"这台机器能构建 CMake"
  //      是两个独立的事实，必须分开报告。
  test("detects CMake as executable when cmake is measured available", () => {
    const root = tempProject();
    writeFileSync(join(root, "CMakeLists.txt"), "project(example C)\n");
    writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");

    const host = probeHost(root);
    const detection = detectCProject(root, host);
    expect(detection.primary_build_system).toBe("cmake");
    expect(detection.adapter).toBe("cmake");
    expect(detection.status).toBe(host.tools.cmake?.available ? "ready" : "needs-adapter");  // ← ?. 可选链
  }, 30_000);
  // 【测什么】Ninja 全链路：从一份手写的 build.ninja 出发 → 识别为 ninja →
  //   生成构建计划（命令参数是 ["-C", "build"]，即"进 build 目录执行"）→
  //   真的构建出 app.exe，且二进制绝对路径的结尾正确。
  // ⚠️ 第二行的 `if (!...available) return;` 是测试里的"环境跳过"惯例：
  //   主机没装 ninja/gcc 就直接结束这个用例（相当于跳过），而不是让它失败。
  test("detects and builds a real Ninja C project", () => {
    const root = tempProject();
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");
    writeFileSync(
      join(root, "build", "build.ninja"),
      [
        "rule cc",
        "  command = gcc ../main.c -o app.exe",
        "build app.exe: cc",
        "default app.exe",
        "",
      ].join("\n"),
    );

    const host = probeHost(root);
    if (!host.tools.ninja?.available || !host.tools.gcc?.available) return;
    const detection = detectCProject(root, host);
    expect(detection.primary_build_system).toBe("ninja");
    expect(detection.adapter).toBe("ninja");
    expect(detection.status).toBe("ready");

    // 一份手工构造的环境规格：ninja 构建、构建目录 build、产物 build/app。
    const env: EnvironmentSpec = {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "ninja",
        build_dir: "build",
        target: null,
        build_flags: [],
        output: "build/app",
      },
      sanitizers: [],
      determinism: {
        frozen_time_epoch_ms: null,   // ← 不冻结时间（这个用例不关心确定性）
        random_seed: null,
        intercept_headers: [],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    };
    const plan = new NinjaAdapter().plan(root, env, host);
    expect(plan.commands[0]!.args).toEqual(["-C", "build"]);
    const result = buildWorktree(root, env, host);
    expect(result.ok).toBeTrue();
    expect(result.binaryAbs.endsWith(process.platform === "win32" ? "app.exe" : "app")).toBeTrue();
  }, 30000);

  // 【测什么】CMake 适配器能真的走完 configure + build 两步并产出可执行文件。
  //   这是 e2e:cmake 冒烟测试的最小版本（CMakeLists 只有一行 add_executable）。
  test("cmake adapter configures and builds a real executable", () => {
    const root = tempProject();
    writeFileSync(
      join(root, "CMakeLists.txt"),
      "cmake_minimum_required(VERSION 3.15)\nproject(smoke C)\nadd_executable(smoke main.c)\n",
    );
    writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");
    const host = probeHost(root);
    if (!host.tools.cmake?.available) return;

    const env: EnvironmentSpec = {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "cmake",
        source_dir: ".",
        build_dir: "build",
        generator: null,          // ← null = 让 CMake 自己挑默认生成器
        target: null,
        configure_flags: [],
        build_flags: [],
        output: "build/smoke",
      },
      sanitizers: [],
      determinism: {
        frozen_time_epoch_ms: null,
        random_seed: null,
        intercept_headers: [],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    };
    const result = buildWorktree(root, env, host);
    expect(result.ok).toBeTrue();
  }, 30000);

  // 【测什么】direct-compiler 路径：一条 gcc 命令、纯 argv、不开 shell。
  //   "no shell" 很重要——不经 shell 就没有引号转义/命令注入这类问题，
  //   参数数组里写什么就是什么。
  // ⚠️ 这个用例没有 return 提前跳过的分支，意味着它默认 gcc 可用；
  //   在没有 gcc 的机器上会真的失败（本组测试假定 Windows + MinGW 环境）。
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
      sanitizers: [],
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
  }, 30000);
});
