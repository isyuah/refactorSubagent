/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/dep-registry.test.ts —— dep-registry 纯逻辑核心的合同测试
 *
 * 【这个文件锁定了哪些行为】（dep-registry = B 方案 MCP 三工具背后的实现）
 *   validateBuildWorkflowSource（生成即校验的"门卫"）：
 *   ① 合法自驱动源码通过；② 空内容拒；③ 缺 workflowKind 字面量拒；
 *   ④ import node: 拒（"imports a host API"）；⑤ 裸 process 拒；⑥ 语法错误拒。
 *   LocalDependencyRegistry.generate：
 *   ⑦ 落盘到 .refactor/runs/{session}/workflows/build/<id>.ts，id 由 name slug 化
 *      + session 片段组成，返回 revision/lineCount；
 *   ⑧ ★ 非法内容先拒绝后落盘——目录根本不会被创建（fail-closed 无残留）；
 *   ⑨ 同名幂等 create-or-replace：同 id、revision+1、描述更新。
 *   LocalDependencyRegistry.declare：
 *   ⑩ 已知 id 可声明并回读；⑪ 未知 id 拒绝并列出可用清单，且失败不污染既有声明；
 *   ⑫ 空数组 = 显式"无依赖"；⑬ 幂等覆盖（后声明整组替换先声明）。
 *   LocalDependencyRegistry.inspect：
 *   ⑭ 同时列出 run-local 与库条目（status 区分）；⑮ 按精确 id 过滤；⑯ 空库返回空；
 *   ⑰ ★ 描述经 sidecar 持久化——换一个 registry 实例（重启）描述仍在。
 *   LocalDependencyRegistry.resolveBuildEntry：
 *   ⑱ run-local id 解析到真实文件；⑲ 未知 id 返回 null。
 *
 * 【怎么跑】bun test tests/dep-registry.test.ts（纯逻辑 + 临时目录，不开真 Claude）
 *
 * 【本文件是教程注释版】原文件 tests/dep-registry.test.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalDependencyRegistry,
  validateBuildWorkflowSource,
} from "../src/agents/dep-registry.js";

// 合法源码的两块积木：workflowKind 声明行 + 最小默认导出函数。
const VALID_WORKFLOW_KIND = `export const workflowKind = "workflow-driven";
`;

const VALID_BUILD_SOURCE = `${VALID_WORKFLOW_KIND}
export default async ({ context }) => {
  // drive the build via injected capabilities
  return;
};
`;

/** A temp root + registry instance, isolated per test. */
// 测试辅助：临时 workspace + 临时 session 根 + 一个 registry 实例（每个测试独立）。
function makeRegistry(sessionId = "sess-abc123") {
  const root = mkdtempSync(join(tmpdir(), "rfr-depreg-"));
  const sessionRoot = mkdtempSync(join(tmpdir(), "rfr-depreg-sess-"));
  const reg = new LocalDependencyRegistry({
    workspaceRoot: root,
    sessionRoot,
    sessionId,
  });
  return { reg, root, sessionRoot };
}

describe("validateBuildWorkflowSource", () => {
  // ① 合法源码放行。
  test("accepts a valid workflow-driven source", () => {
    const check = validateBuildWorkflowSource(VALID_BUILD_SOURCE);
    expect(check.ok).toBe(true);
  });

  // ② 空内容拒绝（"empty"）。
  test("rejects empty content", () => {
    const check = validateBuildWorkflowSource("   ");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("empty");
  });

  // ③ 缺 workflowKind 字面量拒绝——宿主靠它识别自驱动形态。
  test("rejects missing workflowKind literal", () => {
    const check = validateBuildWorkflowSource("export default () => 1;\n");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("workflowKind");
  });

  // ④ import node: 拒绝——workflow 只许用注入能力（沙箱的根）。
  test("rejects node: import", () => {
    const check = validateBuildWorkflowSource(
      `${VALID_WORKFLOW_KIND}import { readFileSync } from "node:fs";\n`,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("imports a host API");
  });

  // ⑤ 裸 process 使用拒绝（宿主 API 访问）。
  test("rejects bare process usage", () => {
    const check = validateBuildWorkflowSource(
      `${VALID_WORKFLOW_KIND}const x = process.env.FOO;\n`,
    );
    expect(check.ok).toBe(false);
  });

  // ⑥ 语法错误拒绝（落盘前就用转译器试编译——省得执行时才炸）。
  test("rejects syntax errors", () => {
    const check = validateBuildWorkflowSource(`${VALID_WORKFLOW_KIND}export default ( => {`);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("syntax");
  });
});

describe("LocalDependencyRegistry.generate", () => {
  // ⑦ 生成落盘：id = name 的 slug 形式 + session 片段；路径固定在 runs/{session}/workflows/build。
  test("materializes a run-local build workflow under the repo run dir", async () => {
    const { reg, root } = makeRegistry();
    const result = await reg.generate({
      name: "My CMake Build",
      description: "builds the test runner",
      content: VALID_BUILD_SOURCE,
    });
    expect(result.workflowId).toMatch(/^my-cmake-build-sess/);   // "My CMake Build" → my-cmake-build-*（slug 化）
    expect(result.revision).toBe(1);
    expect(result.lineCount).toBeGreaterThan(0);
    const expectedDir = join(root, ".refactor", "runs", "sess-abc123", "workflows", "build");
    expect(existsSync(join(expectedDir, `${result.workflowId}.ts`))).toBe(true);
    // File content matches (with trailing newline normalization).
    const written = readFileSync(join(expectedDir, `${result.workflowId}.ts`), "utf8");
    expect(written.trim()).toBe(VALID_BUILD_SOURCE.trim());   // 内容逐字一致（只忽略首尾空白）
  });

  // ⑧ ★ fail-closed：非法内容在写盘前就被拒绝——连 build 目录都不会出现。
  test("rejects invalid content before writing (fail-closed)", async () => {
    const { reg, root } = makeRegistry();
    await expect(
      reg.generate({ name: "bad", description: "", content: "not a workflow at all" }),
    ).rejects.toThrow(/invalid workflow source/);
    // Nothing materialized.
    const buildDir = join(root, ".refactor", "runs", "sess-abc123", "workflows", "build");
    expect(existsSync(buildDir)).toBe(false);
  });

  // ⑨ 幂等 create-or-replace：同名 → 同 id、revision 递增、描述更新、同一文件被覆盖。
  test("idempotent create-or-replace by name bumps revision", async () => {
    const { reg } = makeRegistry();
    const first = await reg.generate({ name: "dup", description: "v1", content: VALID_BUILD_SOURCE });
    const second = await reg.generate({ name: "dup", description: "v2", content: VALID_BUILD_SOURCE });
    expect(first.workflowId).toBe(second.workflowId);
    expect(second.revision).toBe(2);
    expect(second.description).toBe("v2");
    // Same file overwritten.
    const readBack = await reg.resolveBuildEntry(first.workflowId);
    expect(readBack?.runLocal).toBe(true);
  });
});

describe("LocalDependencyRegistry.declare", () => {
  // ⑩ 已知 id（刚 generate 过的 run-local）可声明，并可回读当前声明集。
  test("accepts a known run-local id (after generate)", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "b1", description: "", content: VALID_BUILD_SOURCE });
    const declared = await reg.declare({ buildWorkflowIds: [gen.workflowId] });
    expect(declared).toEqual([gen.workflowId]);
    expect(await reg.currentDeclared()).toEqual([gen.workflowId]);
  });

  // ⑪ 未知 id 拒绝（错误信息列出来自清单），且失败不留下半套声明（无部分写入）。
  test("rejects unknown id with known list", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "known", description: "", content: VALID_BUILD_SOURCE });
    await expect(reg.declare({ buildWorkflowIds: ["nope", gen.workflowId] })).rejects.toThrow(
      /unknown build workflow id\(s\): nope/,
    );
    // Rejected declare leaves prior state unchanged (fail-closed, no partial).
    expect(await reg.currentDeclared()).toEqual([]);
  });

  // ⑫ 空数组 = 显式声明"无依赖"（会话纪律：必须调用，哪怕是空集）。
  test("empty set is a valid explicit no-dependency declaration", async () => {
    const { reg } = makeRegistry();
    const declared = await reg.declare({ buildWorkflowIds: [] });
    expect(declared).toEqual([]);
  });

  // ⑬ 幂等覆盖：整组替换（先 [b] 后 [] → 当前声明变空）。
  test("idempotent overwrite replaces the full set", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "b", description: "", content: VALID_BUILD_SOURCE });
    await reg.declare({ buildWorkflowIds: [gen.workflowId] });
    await reg.declare({ buildWorkflowIds: [] });
    expect(await reg.currentDeclared()).toEqual([]);
  });
});

describe("LocalDependencyRegistry.inspect", () => {
  // ⑭ 库条目与 run-local 条目一起列出，用 status 区分（library-draft / run-local）。
  test("lists run-local and persisted library build workflows", async () => {
    const { reg, root } = makeRegistry();
    await reg.generate({ name: "local-one", description: "local desc", content: VALID_BUILD_SOURCE });
    seedLibraryBuild(root, "lib-build");   // 手工往注册表种一个库条目
    const items = await reg.inspect({ kind: "build" });
    const local = items.items.find((item) => item.status === "run-local");
    expect(local?.description).toBe("local desc");
    expect(local?.revision).toBe(1);
    const lib = items.items.find((item) => item.id === "lib-build");
    expect(lib?.status).toBe("library-draft");
    expect(lib?.kind).toBe("build");
  });

  // ⑮ 按精确 id 过滤。
  test("filters by exact id", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "target", description: "", content: VALID_BUILD_SOURCE });
    const items = await reg.inspect({ kind: "build", id: gen.workflowId });
    expect(items.items).toHaveLength(1);
    expect(items.items[0]?.id).toBe(gen.workflowId);
  });

  // ⑯ 空库返回空列表（不是 null/错误）。
  test("empty registry lists nothing", async () => {
    const { reg } = makeRegistry();
    expect((await reg.inspect({ kind: "build" })).items).toEqual([]);
  });

  // ⑰ ★ 描述经 sidecar 文件持久化：新建 registry 实例（模拟重启）后描述还在，
  //    status 仍是 run-local——"本次生成物在会话内可恢复"。
  test("description survives registry rebuild via sidecar", async () => {
    const { reg, root, sessionRoot } = makeRegistry("sess-restore");
    const gen = await reg.generate({
      name: "persistent",
      description: "survives restart",
      content: VALID_BUILD_SOURCE,
    });
    // A fresh registry instance over the same dirs restores run-local from disk.
    const reg2 = new LocalDependencyRegistry({
      workspaceRoot: root,
      sessionRoot,
      sessionId: "sess-restore",
    });
    const items = await reg2.inspect({ kind: "build", id: gen.workflowId });
    expect(items.items).toHaveLength(1);
    expect(items.items[0]?.description).toBe("survives restart");
    expect(items.items[0]?.status).toBe("run-local");
  });
});

describe("LocalDependencyRegistry.resolveBuildEntry", () => {
  // ⑱ run-local id 解析到真实落盘文件（entry 以 <id>.ts 结尾且存在）。
  test("resolves run-local id to its materialized entry", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "entry-test", description: "", content: VALID_BUILD_SOURCE });
    const resolved = await reg.resolveBuildEntry(gen.workflowId);
    expect(resolved?.runLocal).toBe(true);
    expect(resolved?.entry.endsWith(`${gen.workflowId}.ts`)).toBe(true);
    expect(existsSync(resolved!.entry)).toBe(true);
  });

  // ⑲ 未知 id → null（不是抛错——查询语义）。
  test("returns null for unknown id", async () => {
    const { reg } = makeRegistry();
    expect(await reg.resolveBuildEntry("does-not-exist")).toBeNull();
  });
});

/** Seed a minimal persisted library entry readable by discoverBuildWorkflows. */
// 测试辅助：手工种一个最小库条目（workflow.ts + manifest.json）。
// ★ 关键：manifest 的 source_hash 必须是真哈希（createHash("sha256") 现算）——
//   loadBuildWorkflow 加载时会重验 hash，假的过不了关。
function seedLibraryBuild(root: string, id: string): void {
  const revDir = join(root, ".refactorsa", "build-workflows", id, "r1");
  mkdirSync(revDir, { recursive: true });
  const entryPath = join(revDir, "workflow.ts");
  writeFileSync(entryPath, VALID_BUILD_SOURCE, "utf8");
  // loadBuildWorkflow verifies source_hash against the actual file; compute real one.
  const hash = createHash("sha256").update(VALID_BUILD_SOURCE, "utf8").digest("hex");
  writeFileSync(
    join(revDir, "manifest.json"),
    JSON.stringify({
      kind: "build-workflow-manifest",
      version: 1,
      id,
      revision: 1,
      entry: `.refactorsa/build-workflows/${id}/r1/workflow.ts`,
      source_hash: hash,
      workflow_api_version: 1,
      applies_to: { build_systems: [], markers: [], platforms: [], architectures: [], required_tools: [] },
      status: "draft",
    }),
    "utf8",
  );
}
