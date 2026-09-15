/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/build-writer.test.ts —— build-writer 子代理定义的"合同测试"
 *
 * 【这个文件锁定了哪些行为】
 *   对 buildWriterDefinition() 返回的 AgentDefinition 逐项断言：
 *   ① 形状合法（description/prompt 非空、tools 是数组）；
 *   ② ★ 工具白名单：只有 Read/Glob/Grep，绝无 Write/Edit/Bash（安全模型的根）；
 *   ③ prompt 内嵌 workflow-driven 规范关键句（workflowKind/assertFile/generateBuildWorkflow）；
 *   ④ 汇报契约在 prompt 里（FINAL message / EVERY artifact path / workflow_id）；
 *   ⑤ prompt 明说"你没有写文件的工具"；
 *   ⑥ prompt 用完整 MCP 工具名 + 禁止 import 语句；
 *   ⑦ 汇报契约要求列全产物路径和调用方式；
 *   ⑧ ★ mcpServers 按名声明（显式 tools 不继承父 MCP 工具的解法），工具名随 server 名拼接；
 *   ⑨ 自定义 server 名贯穿到 prompt 文本。
 *
 * 【怎么跑】bun test tests/build-writer.test.ts（纯逻辑）
 *
 * 【本文件是教程注释版】原文件 tests/build-writer.test.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from "bun:test";
import { buildWriterDefinition } from "../src/agents/build-writer.js";

describe("buildWriterDefinition", () => {
  // 形状测试：三个字段齐全（description/prompt/tools）——SDK 的 agents 选项要求的最小形状。
  test("is a valid AgentDefinition shape", () => {
    const def = buildWriterDefinition();
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.prompt.length).toBeGreaterThan(0);
    expect(Array.isArray(def.tools)).toBe(true);
  });

  // ★ 安全模型测试：只有读工具，绝无写工具/Shell。
  test("allowlists only read tools (no Write/Edit/Bash)", () => {
    const def = buildWriterDefinition();
    expect(def.tools).toContain("Read");
    expect(def.tools).toContain("Glob");
    expect(def.tools).toContain("Grep");
    expect(def.tools).not.toContain("Write");
    expect(def.tools).not.toContain("Edit");
    expect(def.tools).not.toContain("Bash");
  });

  // prompt 必须内嵌构建规范的关键句（workflowKind 声明 / 产物断言 / 生成工具）。
  test("prompt embeds the workflow-driven build system contract", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain('export const workflowKind = "workflow-driven"');
    expect(def.prompt).toContain("context.validator.assertFile");
    expect(def.prompt).toContain("generateBuildWorkflow");
  });

  // 汇报契约三要素都要在 prompt 里：最后一条消息 / 每个产物路径 / workflow id。
  test("prompt contains the reporting contract for the test-writer", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain("FINAL message must report");
    expect(def.prompt).toContain("EVERY artifact path");
    expect(def.prompt).toContain("workflow_id");
  });

  // 子代理必须被明确告知"你没有写文件的工具"——防止它尝试别的写路径。
  test("prompt states the writer has no file-write tools", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain("You cannot write files");
  });

  // 工具全名（mcp__server__tool）+ 禁 import 规范句都要在 prompt 里。
  test("prompt uses the full MCP tool name and forbids imports", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain("mcp__dep-registry__generateBuildWorkflow");
    expect(def.prompt).toContain("never emit import statements at all");
  });

  // 汇报契约必须写明"每个产物路径 + 测试怎么调它"——这是 test-writer 的产物知识来源。
  test("reporting contract requires artifact paths for the test-writer", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain("EVERY artifact path");
    expect(def.prompt).toContain("how the test can invoke it");
  });

  // ★ MCP 桥接测试：mcpServers 按名声明 + tools 点名完整工具名；
  //   自定义 server 名时，mcpServers 与工具名都要跟着变（拼接逻辑正确性）。
  test("declares the dep-registry server so MCP tools reach the subagent", () => {
    const def = buildWriterDefinition();
    expect(def.mcpServers).toEqual(["dep-registry"]);
    expect(def.tools).toContain("mcp__dep-registry__generateBuildWorkflow");
    expect(def.tools).toContain("mcp__dep-registry__inspectWorkflow");
    const custom = buildWriterDefinition("my-dep");
    expect(custom.mcpServers).toEqual(["my-dep"]);
    expect(custom.tools).toContain("mcp__my-dep__generateBuildWorkflow");
  });

  // 自定义 server 名同样要反映到 prompt 文本里。
  test("honors a custom MCP server name", () => {
    const def = buildWriterDefinition("my-dep");
    expect(def.prompt).toContain("mcp__my-dep__generateBuildWorkflow");
  });
});
