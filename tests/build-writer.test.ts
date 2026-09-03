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

  test("honors a custom MCP server name", () => {
    const def = buildWriterDefinition("my-dep");
    expect(def.prompt).toContain("mcp__my-dep__generateBuildWorkflow");
  });
});
