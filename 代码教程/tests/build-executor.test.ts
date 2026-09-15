/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/build-executor.test.ts —— 通过能力 Broker 真正执行构建
 *
 * 【这个文件是干什么的】
 *   锁定 executeBuildWorkflow()（src/workflow/build-executor.ts）的两个行为：
 *     ① 正面：一个 CMake 工程经由能力 Broker（capability broker）完成
 *        configure + build 两步，每步退出码 0，产物齐全，事件流里能
 *        看到两次 process.run 调用；
 *     ② 反面（更重要）：构建"成功"了，但 workflow 声明的产物路径
 *        （build/not-produced）根本不存在 → 整体判 failed，
 *        missingArtifacts 里写明缺了什么，failure 里说 "artifacts are missing"。
 *   👉 ② 就是"执行期产物校验"：不能只看编译命令退出码是不是 0——
 *      必须证明【声明的那个文件】真的被产出。这是自驱动 BuildWorkflow
 *      的诚实性底线。
 *
 * 【在整个项目里的位置】
 *   流水线第 ⑦ 步"双版本构建"的执行器，baseline / candidate 各跑一次。
 *   policy() 里那些数字就是 Capability Broker 的权限/资源上限
 *   （可写 glob、允许的工具、进程数、输出/文件大小上限）。
 *
 * 【先修知识】Capability Broker（见教程 §1.5：workflow 源码跑在 bun 子进程里，
 *   想干活必须向主进程申请）；executeBuildWorkflow 的返回结构
 *   { status, steps, events, missingArtifacts, failure }。
 *
 * 【需要真实 gcc/cmake 吗】需要 cmake（真正会 configure + build）。
 *   两个用例都有 `if (!host.tools.cmake?.available) return;`——没装 cmake
 *   就当作跳过，不会误报。超时 30 秒。
 *
 * 【本文件是教程注释版】原文件 tests/build-executor.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BuildWorkflowOutput, type HostPreflight } from "../src/artifacts/index.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { executeBuildWorkflow } from "../src/workflow/build-executor.js";

// 造一个最小 CMake 工程。
function tempCMakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-build-executor-"));
  writeFileSync(join(root, "CMakeLists.txt"), [
    "cmake_minimum_required(VERSION 3.15)",
    "project(executor_smoke C)",
    "add_executable(executor_smoke main.c)",
    "",
  ].join("\n"));
  writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");
  return root;
}

// ── output(path)：按给定产物路径造一份"声明式 BuildWorkflow 输出" ──────
// 【作用】声明式形态下，产物路径在 resolve 期就定了；这个工厂函数让测试
//        能随便指定一个路径——想测"产物不存在"就传一个根本不会被产出的路径。
// 【语法】BuildWorkflowOutput.parse({...})：用 Zod 造合法对象（字段错了当场报错），
//        比手写类型断言更严格。
function output(path: string) {
  return BuildWorkflowOutput.parse({
    kind: "build-workflow-output",
    version: 1,
    workflow_id: "executor-test",
    workflow_revision: 1,
    environment: {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "cmake",
        source_dir: ".",
        build_dir: "build",
        generator: null,
        target: null,
        configure_flags: [],
        build_flags: [],
        output: path,
      },
      sanitizers: [],
      determinism: {
        frozen_time_epoch_ms: null,
        random_seed: null,
        intercept_headers: [],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    },
    artifact: {
      kind: "executable",
      version: 1,
      workflow_id: "executor-test",
      workflow_revision: 1,
      paths: { app: path },
      metadata: {},
    },
  });
}

// 能力策略（Capability Broker 的权限单）：
//   可读一切、只许写 build/**、只许用 cmake 工具、最多 2 个子进程、
//   输出上限 4MB、单文件上限 16MB。数字用 4 * 1024 * 1024 写法更直观。
function policy() {
  return {
    readableGlobs: ["**"],
    writableGlobs: ["build/**"],
    allowedTools: ["cmake"],
    maxProcesses: 2,
    maxOutputBytes: 4 * 1024 * 1024,
    maxFileBytes: 16 * 1024 * 1024,
  };
}

describe("BuildWorkflow executor", () => {
  // 【测什么】正面路径 + 事件可观测性：
  //   · status = "pass"；
  //   · 步骤名恰好是 ["configure", "build"]（顺序也锁定）；
  //   · 每一步 status 都是 "exited" 且退出码 0（"exited" 表示进程正常结束，
  //     与被杀/超时等其他状态区分开）；
  //   · missingArtifacts 为空；
  //   · events 里正好两条 process.run 且都成功——证明构建确实是通过
  //     Broker 的 process 能力完成的（可审计）。
  test("configures and builds a CMake project through the capability broker", async () => {
    const root = tempCMakeProject();
    const host = probeHost(root);
    if (!host.tools.cmake?.available) return;

    const result = await executeBuildWorkflow({
      cwd: root,
      output: output("build/executor_smoke"),
      host,
      policy: policy(),
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("pass");
    expect(result.steps.map((step) => step.name)).toEqual(["configure", "build"]);
    expect(result.steps.every((step) => step.status === "exited" && step.exitCode === 0)).toBeTrue();
    expect(result.missingArtifacts).toEqual([]);
    expect(result.events).toEqual([
      expect.objectContaining({ capability: "process", method: "run", ok: true }),
      expect.objectContaining({ capability: "process", method: "run", ok: true }),
    ]);
  }, 30_000);

  // 【测什么】产物校验的 fail-closed：CMake 真的编译成功了，但声明的产物
  //   路径（build/not-produced）不存在 → 整体判 "failed"，并明确列出
  //   缺失项 "app: build/not-produced"。
  //   👉 对应教程说的"缺失产物 fail-closed"：宁可拒绝，也不接受
  //      "构建好像成功了"这种没有证据的说法。
  test("rejects a successful build when the declared artifact is absent", async () => {
    const root = tempCMakeProject();
    const host: HostPreflight = probeHost(root);
    if (!host.tools.cmake?.available) return;

    const result = await executeBuildWorkflow({
      cwd: root,
      output: output("build/not-produced"),
      host,
      policy: policy(),
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("failed");
    expect(result.missingArtifacts).toEqual(["app: build/not-produced"]);
    expect(result.failure).toContain("artifacts are missing");
  }, 30_000);
});
