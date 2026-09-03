import { describe, expect, test } from "bun:test";
import { buildWriterDefinition } from "../src/agents/build-writer.js";

describe("buildWriterDefinition", () => {
  test("is a valid AgentDefinition shape", () => {
    const def = buildWriterDefinition();
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.prompt.length).toBeGreaterThan(0);
    expect(Array.isArray(def.tools)).toBe(true);
  });

  test("allowlists only read tools (no Write/Edit/Bash)", () => {
    const def = buildWriterDefinition();
    expect(def.tools).toContain("Read");
    expect(def.tools).toContain("Glob");
    expect(def.tools).toContain("Grep");
    expect(def.tools).not.toContain("Write");
    expect(def.tools).not.toContain("Edit");
    expect(def.tools).not.toContain("Bash");
  });

  test("prompt embeds the workflow-driven build system contract", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain('export const workflowKind = "workflow-driven"');
    expect(def.prompt).toContain("context.validator.assertFile");
    expect(def.prompt).toContain("generateBuildWorkflow");
  });

  test("prompt contains the reporting contract for the test-writer", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain("FINAL message must report");
    expect(def.prompt).toContain("EVERY artifact path");
    expect(def.prompt).toContain("workflow_id");
  });

  test("prompt states the writer has no file-write tools", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain("You cannot write files");
  });

  test("prompt uses the full MCP tool name and forbids imports", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain("mcp__dep-registry__generateBuildWorkflow");
    expect(def.prompt).toContain("never emit import statements at all");
  });

  test("reporting contract requires artifact paths for the test-writer", () => {
    const def = buildWriterDefinition();
    expect(def.prompt).toContain("EVERY artifact path");
    expect(def.prompt).toContain("how the test can invoke it");
  });

  test("declares the dep-registry server so MCP tools reach the subagent", () => {
    const def = buildWriterDefinition();
    expect(def.mcpServers).toEqual(["dep-registry"]);
    expect(def.tools).toContain("mcp__dep-registry__generateBuildWorkflow");
    expect(def.tools).toContain("mcp__dep-registry__inspectWorkflow");
    const custom = buildWriterDefinition("my-dep");
    expect(custom.mcpServers).toEqual(["my-dep"]);
    expect(custom.tools).toContain("mcp__my-dep__generateBuildWorkflow");
  });

  test("honors a custom MCP server name", () => {
    const def = buildWriterDefinition("my-dep");
    expect(def.prompt).toContain("mcp__my-dep__generateBuildWorkflow");
  });
});
