/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/resolve-declared.test.ts —— 声明集解析（B 方案）的合同测试
 *
 * 【这个文件锁定了哪些行为】
 *   resolveDeclaredWorkflows（按 DeclaredBuildSet 声明集逐个解析）：
 *   ① 单 build + 自驱动 test 的正常解析（保留 id 与 runLocal 标记）；
 *   ② 多 build 按声明顺序解析（N>1 是 B 方案的卖点）；
 *   ③ ★ 空声明集合配合法解析（"不需要 build"的测试也是一等公民）；
 *   ④ ★ fail-closed：某个声明的 build 源码非法 → 整体 reject；
 *   ⑤ ★ fail-closed：声明的源文件不存在 → 抛错（理由含 does not exist / workflow entry）。
 *
 * 【怎么跑】bun test tests/resolve-declared.test.ts（纯逻辑 + 临时目录，无需 gcc）
 *
 * 【本文件是教程注释版】原文件 tests/resolve-declared.test.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDeclaredWorkflows } from "../src/workflow/resolve-declared.js";

// build 源码模板：最简自驱动构建（声明 workflowKind + 空函数）。
// 注意函数是箭头函数参数解包 (id) —— 模板按 id 生成，实际内容都一样。
const BUILD_SOURCE = (id: string) => `export const workflowKind = "workflow-driven";
export default async () => { return; };
`;

// test 源码模板：最简自驱动测试（声明一条 expect）。
const TEST_SOURCE = `export const workflowKind = "test-workflow-driven";
export default async (ctx) => {
  ctx.expect("exit", 0);
  return;
};
`;

// 测试辅助：建临时项目目录 + 按 kind/name 写 workflow 源码文件。
function tempProject(): { root: string; entry: (kind: string, name: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "rfr-resolvedec-"));
  const entry = (kind: string, name: string): string => {
    const dir = join(root, "wf", kind);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${name}.ts`);
    writeFileSync(p, kind === "build" ? BUILD_SOURCE(name) : TEST_SOURCE, "utf8");
    return p;
  };
  return { root, entry };
}

describe("resolveDeclaredWorkflows", () => {
  // ① 单 build + 自驱动 test：id 与 runLocal 标记都如实保留。
  test("resolves one declared build and a self-driven test", async () => {
    const { root, entry } = tempProject();
    const buildEntry = entry("build", "b1");
    const testEntry = entry("test", "t1");
    const result = await resolveDeclaredWorkflows({
      workspaceRoot: root,
      entryRoot: root,
      testEntry,
      testWorkflowId: "test-1",
      testRevision: 1,
      builds: [{ id: "b1", entry: buildEntry, runLocal: true }],
    });
    expect(result.builds).toHaveLength(1);
    expect(result.builds[0]?.id).toBe("b1");          // 可选链 + ! 的组合：数组元素可能 undefined
    expect(result.builds[0]?.runLocal).toBe(true);
    expect(result.test.manifest.id).toBe("test-1");
  });

  // ② 多 build：按声明顺序解析（B 方案支持 N>1 个构建步骤）。
  test("resolves multiple declared builds", async () => {
    const { root, entry } = tempProject();
    const b1 = entry("build", "b1");
    const b2 = entry("build", "b2");
    const testEntry = entry("test", "t1");
    const result = await resolveDeclaredWorkflows({
      workspaceRoot: root,
      entryRoot: root,
      testEntry,
      testWorkflowId: "test-multi",
      testRevision: 1,
      builds: [
        { id: "b1", entry: b1, runLocal: true },
        { id: "b2", entry: b2, runLocal: false },     // runLocal=false = 来自库
      ],
    });
    expect(result.builds.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(result.builds[1]?.runLocal).toBe(false);
  });

  // ③ 空声明集：完全合法（纯计算类测试可能不需要任何 build）。
  test("resolves with an empty build set (no-dependency test)", async () => {
    const { root, entry } = tempProject();
    const testEntry = entry("test", "t0");
    const result = await resolveDeclaredWorkflows({
      workspaceRoot: root,
      entryRoot: root,
      testEntry,
      testWorkflowId: "test-none",
      testRevision: 1,
      builds: [],
    });
    expect(result.builds).toEqual([]);
    expect(result.test.manifest.id).toBe("test-none");
  });

  // ④ ★ fail-closed：声明集里混进一个非法源码 → 整体解析失败（rejects.toThrow）。
  test("fails closed when a declared build source is invalid", async () => {
    const { root, entry } = tempProject();
    const testEntry = entry("test", "t1");
    const badDir = join(root, "wf", "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "b.ts"), "not a workflow", "utf8");   // 不是合法 workflow 源码
    await expect(
      resolveDeclaredWorkflows({
        workspaceRoot: root,
        entryRoot: root,
        testEntry,
        testWorkflowId: "test-1",
        testRevision: 1,
        builds: [{ id: "bad", entry: join(badDir, "b.ts"), runLocal: true }],
      }),
    ).rejects.toThrow();
  });

  // ⑤ ★ fail-closed：声明的源文件根本不存在 → 抛错（两种理由文案都接受）。
  test("fails when a declared build entry is missing", async () => {
    const { root, entry } = tempProject();
    const testEntry = entry("test", "t1");
    await expect(
      resolveDeclaredWorkflows({
        workspaceRoot: root,
        entryRoot: root,
        testEntry,
        testWorkflowId: "test-1",
        testRevision: 1,
        builds: [{ id: "ghost", entry: join(root, "wf", "build", "ghost.ts"), runLocal: true }],
      }),
    ).rejects.toThrow(/does not exist|workflow entry/);
  });
});
