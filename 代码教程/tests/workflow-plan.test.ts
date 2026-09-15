/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/workflow-plan.test.ts —— ctx.plan 步骤声明的"状态机测试"
 *
 * 【这个文件锁定了哪些行为】
 *   ① 树状声明：declare 一棵两层的步骤树，返回的根 id 与调用方提供的一致；
 *   ② 完整生命周期 begin → complete 全程合法；
 *   ③ 四种违规必被拒（fail-closed）：
 *      - begin 未声明的步骤（"was not declared"）
 *      - 没 begin 就 complete（"cannot complete while pending"）
 *      - 对 running 的步骤重复 begin（"already running"）
 *      - 树里 id 重复（"not unique"）
 *   ④ 宿主兜底 id：调用方不给 id 时自动分配 p1 / p1.1 / p2；
 *   ⑤ plan.fail 标记失败并记录错误（整个 workflow 仍算 pass——失败是"步骤失败"
 *      不是"声明系统崩了"）；
 *   ⑥ 空 title 的声明被拒。
 *
 * 【为什么重要】
 *   plan 是 Dashboard 可视化和观测的数据来源；它的状态机若允许乱序，
 *   看板上就会出现"凭空完成"的步骤。
 *
 * 【怎么跑】bun test tests/workflow-plan.test.ts（纯逻辑 + 真实子进程，无需 gcc）
 *
 * 【本文件是教程注释版】原文件 tests/workflow-plan.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkflow } from "../src/workflow/runner.js";

// 测试辅助：把一段 workflow 源码写进临时文件。注意模板字符串里嵌模板字符串——
// 内层的反引号会与外层冲突吗？不会：内层源码里没有反引号，只有 ${} 之外的内容。
function tempWorkflow(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-plan-"));
  const entry = join(root, "workflow.ts");
  writeFileSync(entry, source);
  return entry;
}

describe("Workflow plan declarations", () => {
  // ── 测试①：完整树的生命周期（合法路径）────────────────────────────────
  // workflow 声明 build(→configure,compile) + test(→unit) 两棵子树，
  // 按正确顺序 begin/complete 每一步，最后断言整棵树全部 completed。
  test("declares a tree with caller-supplied ids and returns them", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        const ids = await plan.declare([
          { id: "build", title: "Build", description: "compile the project", children: [
            { id: "build.configure", title: "Configure" },
            { id: "build.compile", title: "Compile" },
          ]},
          { id: "test", title: "Test", children: [
            { id: "test.unit", title: "Unit", description: "run unit tests" },
          ]},
        ]);
        // declare returns exactly the supplied ids (roots in tree order).
        // ↑ declare 的返回值 = 调用方提供的根 id 列表（按树的顺序）。
        if (ids.join(",") !== "build,test") throw new Error("unexpected ids: " + ids.join(","));
        await plan.begin("build");              // 父步骤先开始
        await plan.begin("build.configure");    // 子步骤开始
        await plan.complete("build.configure"); // 子步骤完成
        await plan.begin("build.compile");
        await plan.complete("build.compile");
        await plan.complete("build");           // 子步骤全完，父步骤才能完成
        await plan.begin("test");
        await plan.begin("test.unit");
        await plan.complete("test.unit");
        await plan.complete("test");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("pass");
    expect(result.plan).not.toBeNull();     // 运行结果里必须带回整棵 plan 树
    const plan = result.plan!;              // ! 非空断言：上一行已确认不是 null
    expect(plan.steps).toHaveLength(2);     // 两个根步骤
    expect(plan.steps[0]!.id).toBe("build");
    expect(plan.steps[0]!.title).toBe("Build");
    expect(plan.steps[0]!.description).toBe("compile the project");
    expect(plan.steps[0]!.status).toBe("completed");
    expect(plan.steps[0]!.children).toHaveLength(2);
    expect(plan.steps[0]!.children![0]!.id).toBe("build.configure");
    expect(plan.steps[0]!.children![0]!.status).toBe("completed");
    expect(plan.steps[0]!.children![1]!.id).toBe("build.compile");
    expect(plan.steps[0]!.children![1]!.status).toBe("completed");
    expect(plan.steps[1]!.id).toBe("test");
    expect(plan.steps[1]!.status).toBe("completed");
    expect(plan.steps[1]!.children![0]!.id).toBe("test.unit");
    expect(plan.steps[1]!.children![0]!.status).toBe("completed");
  });

  // ── 测试②：begin 未声明的步骤 → workflow 失败 ──────────────────────────
  test("rejects begin on an undeclared step", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.begin("nope");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("was not declared");
  });

  // ── 测试③：没 begin 就 complete → 拒绝（状态机：pending 不能直接跳到 completed）──
  test("rejects complete without begin", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.declare([{ id: "solo", title: "Solo" }]);
        await plan.complete("solo");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("cannot complete while pending");
  });

  // ── 测试④：running 状态重复 begin → 拒绝 ─────────────────────────────
  test("rejects duplicate begin", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.declare([{ id: "solo", title: "Solo" }]);
        await plan.begin("solo");
        await plan.begin("solo");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("already running");
  });

  // ── 测试⑤：调用方不给 id → 宿主兜底分配 p1 / p1.1 / p2 ────────────────
  // 兜底规则：根步骤 p1、p2、…；子步骤 父id.序号。ids[0]! 的 ! 是非空断言。
  test("assigns fallback ids when the workflow omits them", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        const ids = await plan.declare([
          { title: "First", children: [{ title: "First child" }] },
          { title: "Second" },
        ]);
        await plan.begin(ids[0]!);
        await plan.begin(ids[0]! + ".1");      // 字符串拼接出兜底子 id "p1.1"
        await plan.complete(ids[0]! + ".1");
        await plan.complete(ids[0]!);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("pass");
    expect(result.plan!.steps[0]!.id).toBe("p1");
    expect(result.plan!.steps[0]!.children![0]!.id).toBe("p1.1");
    expect(result.plan!.steps[1]!.id).toBe("p2");
  });

  // ── 测试⑥：整棵树里 id 重复 → declare 直接失败 ────────────────────────
  test("rejects duplicate ids across the tree", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.declare([
          { id: "dup", title: "First" },
          { id: "dup", title: "Second" },
        ]);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("not unique");
  });

  // ── 测试⑦：plan.fail 标记失败（workflow 本身仍是 pass）────────────────
  // 语义：步骤失败是"这步没干成"（记录错误信息），不是"声明系统异常"。
  // 所以 status 仍是 pass，但树里该步骤 status="failed"——Dashboard 能画出来。
  test("fail marks the step failed and records the error", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.declare([{ id: "fragile", title: "Fragile" }]);
        await plan.begin("fragile");
        await plan.fail("fragile", "linker exploded");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("pass");
    expect(result.plan!.steps[0]!.id).toBe("fragile");
    expect(result.plan!.steps[0]!.status).toBe("failed");
  });

  // ── 测试⑧：空 title 的声明被拒 ────────────────────────────────────────
  test("declaration with empty title is rejected", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.declare([{ id: "x", title: "" }]);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("title");
  });
});
