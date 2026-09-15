/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/dep-registry-server.test.ts —— dep-registry MCP server 绑定层测试
 *
 * 【锁定了哪些行为】
 *   1. createDependencyMcpServer 能成功构造，server 名是 "dep-registry"
 *      （工具名前缀 mcp__dep-registry__xx 就来自它）；
 *   2. 背后的注册表逻辑链路成立：generate（生成 run-local id）→ declare（声明依赖）
 *      → inspect（元数据可见、status=run-local、描述正确）；
 *   3. declare 未知 id 会被拒（错误信息含 unknown）。
 *   测试对象：src/agents/dep-registry-server.ts（薄绑定层）+ src/agents/dep-registry.ts
 *   （真正的逻辑）。刻意不真正调用 MCP 工具——那需要起 Claude 会话，由 spike/e2e 覆盖；
 *   这里只证明"server 能造出来 + 它包着的逻辑是对的"。
 *
 * 【本文件是教程注释版】
 *   原文件：tests/dep-registry-server.test.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
// ← mkdtempSync 建一次性临时目录
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ← 被测的注册表实现（generate/declare/inspect 的真实逻辑都在这里）
import {
  LocalDependencyRegistry,
} from "../src/agents/dep-registry.js";
// ← 被测对象：把注册表包成 MCP server 的绑定层
import { createDependencyMcpServer } from "../src/agents/dep-registry-server.js";

// ← 一份最小的合法 workflow-driven build 源码（generate 必须能通过 source-policy 校验）
const VALID_SOURCE = `export const workflowKind = "workflow-driven";
export default async () => { return; };
`;

// ── makeServer：搭一套"临时仓库 + 注册表 + MCP server" ───────────────
// 【作用】每个测试独占一套目录，互不污染；root 当仓库根，sessionRoot 存本次运行的产物
function makeServer() {
  const root = mkdtempSync(join(tmpdir(), "rfr-depserver-"));
  const sessionRoot = mkdtempSync(join(tmpdir(), "rfr-depserver-sess-"));
  const registry = new LocalDependencyRegistry({
    workspaceRoot: root,
    sessionRoot,
    sessionId: "sess-test",
  });
  const server = createDependencyMcpServer({ registry });
  // The SDK server instance shape: tools live under _tools or similar. For a
  // unit test we only verify construction succeeds and exposes the expected
  // tool names; actual tool invocation is covered by the SDK (spike).
  return { server, registry };
}

describe("createDependencyMcpServer", () => {
  // 【测什么】server 能构造出来，名字是 "dep-registry"。
  // 【为什么重要】SDK 里工具全名是 mcp__<server名>__<工具名>，workflow-session 的
  //   allowlist 也按这个名字放行。名字对不上 = 工具被静默拒绝，模型怎么调都不通。
  test("constructs without error", () => {
    const { server } = makeServer();
    expect(server).toBeTruthy();
    expect(server.name).toBe("dep-registry");
  });

  // 【测什么】generate → declare → inspect 三步连起来成立：run-local id 形如
  //   hello-sess…，声明后原样返回，inspect 里能看到 status=run-local 和描述。
  // 【为什么重要】这就是 test-writer 会话在一次运行里走的最短路径——本测试用纯逻辑
  //   证明了这条链路成立，不用真的起 Claude。
  test("registry integration: generate then declare then inspect", async () => {
    const { registry } = makeServer();
    const gen = await registry.generate({
      name: "hello",
      description: "builds hello",
      content: VALID_SOURCE,
    });
    // ← run-local id = <slug>-<会话短 id>，所以正则要求以 hello-sess 开头
    expect(gen.workflowId).toMatch(/^hello-sess/);

    const declared = await registry.declare({ buildWorkflowIds: [gen.workflowId] });
    expect(declared).toEqual([gen.workflowId]);

    const items = await registry.inspect({ kind: "build" });
    const mine = items.items.find((item) => item.id === gen.workflowId);
    expect(mine?.status).toBe("run-local");
    expect(mine?.description).toBe("builds hello");
  });

  // 【测什么】declare 一个不存在的 id 会被拒，错误信息带 unknown。
  // 【为什么重要】fail-closed 的关键一环：宁可让 AI 在同会话里看到报错并修正，
  //   也绝不让一个不存在的 build id 混进依赖集（后面解析阶段才发现就太晚了）。
  test("declare rejects unknown id via registry", async () => {
    const { registry } = makeServer();
    await expect(registry.declare({ buildWorkflowIds: ["ghost"] })).rejects.toThrow(/unknown/);
  });
});
