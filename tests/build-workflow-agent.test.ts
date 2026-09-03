import { describe, expect, test } from "bun:test";
import {
  BUILD_WORKFLOW_SYSTEM,
  TEST_WORKFLOW_SYSTEM,
} from "../src/agents/prompts.js";
describe("Workflow Agent guidance", () => {
  test("requires TypeScript source modules and keeps fail-closed rules explicit", () => {
    expect(BUILD_WORKFLOW_SYSTEM).toContain("source must default-export a function");
    expect(TEST_WORKFLOW_SYSTEM).toContain("source must default-export a function");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("Never\nemit shell commands");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("Be fail-closed");
  });
  test("pins host artifact discriminators and identity fields", () => {
    expect(BUILD_WORKFLOW_SYSTEM).toContain('export const workflowKind = "workflow-driven"');
    expect(BUILD_WORKFLOW_SYSTEM).toContain("context.validator.assertFile");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("return nothing (void)");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("Do NOT return a BuildWorkflowOutput object");
    expect(TEST_WORKFLOW_SYSTEM).toContain('export const workflowKind = "test-workflow-driven"');
        expect(TEST_WORKFLOW_SYSTEM).toContain("ctx.expect");
    expect(TEST_WORKFLOW_SYSTEM).toContain("pairs declarations by ORDER");
  });

  test("documents workflow-driven builds and plan declarations in guidance", () => {
    expect(BUILD_WORKFLOW_SYSTEM).toContain("workflow-driven");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("context.plan.declare");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("stage-level only");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("idempotent");
    expect(TEST_WORKFLOW_SYSTEM).toContain("context.plan");
    expect(TEST_WORKFLOW_SYSTEM).toContain("plan.declare");
  });

});
