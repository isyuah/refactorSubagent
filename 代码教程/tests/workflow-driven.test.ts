/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/workflow-driven.test.ts —— 自驱动构建（workflow-driven）的行为锁定
 *
 * 【这个文件锁定了哪些行为】
 *   ① 自驱动 workflow 能通过 resolveBuildWorkflow 的 Schema 校验；
 *   ② ★ resolve 阶段【零副作用】：既不执行函数、也不产生 output（=null）、
 *      磁盘上不出现任何构建痕迹；
 *   ③ ★ execute 阶段才真正重跑函数：真实 gcc 编译出 build/app.exe，产物断言通过；
 *   ④ fail-closed：函数断言一个不存在的产物 → 整个执行判 failed。
 *
 * 【为什么重要】
 *   "resolve 不执行、execute 才执行、产物缺失即失败"是自驱动构建的三根柱子——
 *   这三条若松动，"产物通知"（任务 #1）和幂等性都会塌。
 *
 * 【怎么跑】bun test tests/workflow-driven.test.ts
 *   ⚠️ 集成测试：需要真实 gcc（DRIVEN_POLICY 的 allowedTools 就是 gcc）。
 *
 * 【本文件是教程注释版】原文件 tests/workflow-driven.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeHost } from "../src/runtime/host-preflight.js";
import { resolveBuildWorkflow } from "../src/workflow/build-workflow.js";
import { executeBuildWorkflow } from "../src/workflow/build-executor.js";
import type { BuildWorkflowOutput } from "../src/artifacts/index.js";

// 测试用的能力策略：读/写放开到全仓库，但可执行文件只认 build/**，工具只认 gcc。
// readableGlobs: ["**"] —— "**" 匹配一切相对路径（含子目录）。
const DRIVEN_POLICY = {
  readableGlobs: ["**"],
  writableGlobs: ["**"],
  executableGlobs: ["build/**"],
  allowedTools: ["gcc"],
  maxOutputBytes: 1024 * 1024,   // 子进程输出上限 1 MiB
  maxFileBytes: 1024 * 1024,     // 单文件读写上限 1 MiB
};

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "rfr-driven-"));
}

// 被测的自驱动 workflow 源码（注意：这是"写给 worker 动态执行的字符串"）：
const DRIVEN_WORKFLOW = `
export const workflowKind = "workflow-driven";
// ↑ 宿主靠正则在源码文本里找这一行来识别"自驱动"形态。

export default async ({ process, fs, validator }) => {
  // The function drives the build itself through injected capabilities.
  await fs.mkdir("build");
   await fs.writeFile("main.c", "#include <stdio.h>\\nint main(void){puts(\\"driven\\");return 0;}\\n");
  // ↑ 字符串里的 \\n 是"字面反斜杠+n"——写入文件后才会变成真正的换行。
  const result = await process.run({
    program: "gcc",                       // 必须在 allowedTools 白名单里
    args: ["main.c", "-o", "build/app.exe"],
    cwd: ".",
    timeoutMs: 30000,
  });
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw new Error("gcc failed: " + (result.error ?? String(result.exitCode)));
  }
  // Assert the produced executable exists before completing.
  // fail-closed 断言：产物不在就抛错 → 整个 workflow 判失败。
  await validator.assertFile("build/app.exe", "driven test executable");
};
`;


describe("workflow-driven builds", () => {
  // ── 测试①：Schema 接受自驱动形态，resolve 正常返回 ─────────────────────
  test("resolves a workflow-driven workflow (schema accepts the build kind)", async () => {
    const root = tempProject();
    writeFileSync(join(root, "workflow.ts"), DRIVEN_WORKFLOW);
    const host = probeHost(root);          // 先测量主机（gcc 可用性等）
    const resolution = await resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "driven-smoke",
      revision: 1,
      cwd: root,
      entryRoot: root,
      workspaceRoot: root,
      host: host,
      policy: DRIVEN_POLICY,
    });
    expect(resolution.manifest.id).toBe("driven-smoke");
    // workflow-driven workflows have no static plan: output is null at
    // resolution and produced during execution.
    // ↑ 自驱动没有静态计划：resolve 阶段 output 必为 null（产物只有执行才知道）。
    expect(resolution.output).toBeNull();
  }, 30_000);
  // ↑ test 的第三个参数：该用例自己的超时（毫秒）——默认 5 秒不够编译用。

  // ── 测试②（★）：resolve 是"纯决策"，零副作用 ──────────────────────────
  // 同样的 workflow 再 resolve 一次（这次连 policy 都不传），断言：
  //   output 为 null 且磁盘上【没有】build/ 目录、没有 main.c——
  //   证明"函数没有被执行过"。这是"声明式在 resolve 执行、自驱动不执行"的分界证据。
  test("resolve neither executes the function nor produces output", async () => {
    const root = tempProject();
    writeFileSync(join(root, "workflow.ts"), DRIVEN_WORKFLOW);
    const host = probeHost(root);
    const resolution = await resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "driven-smoke",
      revision: 1,
      cwd: root,
      entryRoot: root,
      workspaceRoot: root,
      host: host,
    });
    expect(resolution.output).toBeNull();
    // Resolution must not have executed the function: no build dir, no main.c.
    expect(existsSync(join(root, "build"))).toBe(false);
    expect(existsSync(join(root, "main.c"))).toBe(false);
  }, 30_000);

  // ── 测试③（★）：execute 才真正重跑函数，产物真实存在 ───────────────────
  // 传 output: null（自驱动的标志）→ executeBuildWorkflow 内部 spawn worker 重跑函数
  // → 真实调用 gcc 编译 → status="pass" 且 build/app.exe 存在。
  test("execute re-runs the workflow function and verifies the produced artifact", async () => {
    const root = tempProject();
    writeFileSync(join(root, "workflow.ts"), DRIVEN_WORKFLOW);
    const host = probeHost(root);
    const execution = await executeBuildWorkflow({
      cwd: root,
      entry: join(root, "workflow.ts"),
      output: null,
      host: host,
      policy: DRIVEN_POLICY,
      timeoutMs: 60_000,
    });
    expect(execution.status).toBe("pass");
    expect(existsSync(join(root, "build", "app.exe"))).toBe(true);
  }, 90_000);

  // ── 测试④（★ fail-closed）：断言不存在的产物 → 判 failed ───────────────
  // 技巧：用 .replace() 把源码里的产物断言路径换成 build/never-exists.exe——
  // 构建照样成功，但 validator.assertFile 找不到"幽灵产物"→ 整个执行必须判失败。
  // 这条测试锁死了"缺产物绝不静默放行"。
  test("execute fails when the workflow-driven function asserts a missing artifact", async () => {
    const root = tempProject();
    // The function builds app.exe but asserts a different (missing) path.
    writeFileSync(join(root, "workflow.ts"), DRIVEN_WORKFLOW.replace(
      'assertFile("build/app.exe", "driven test executable")',
      'assertFile("build/never-exists.exe", "phantom artifact")',
    ));
    const host = probeHost(root);
    const execution = await executeBuildWorkflow({
      cwd: root,
      entry: join(root, "workflow.ts"),
      output: null,
      host: host,
      policy: DRIVEN_POLICY,
      timeoutMs: 60_000,
    });
    expect(execution.status).toBe("failed");
    expect(execution.failure).toContain("never-exists");   // 失败原因要指认到缺失的产物
  }, 90_000);
});
