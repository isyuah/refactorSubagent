import { describe, expect, test } from "bun:test";
import {
  BUILD_WORKFLOW_SYSTEM,
  TEST_WORKFLOW_SYSTEM,
  buildWorkflowPrompt,
  testWorkflowPrompt,
} from "../src/agents/prompts.js";
import { checkToolScope } from "../src/agents/driver.js";
import { workflowAgentScope } from "../src/agents/workflow-generator.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(TEST_WORKFLOW_SYSTEM).toContain('kind: "test-workflow"');
        expect(TEST_WORKFLOW_SYSTEM).toContain("build_workflow_id");
    expect(TEST_WORKFLOW_SYSTEM).toContain('The literal top-level kind must be "test-workflow", never "test"');
  });

  test("documents workflow-driven builds and plan declarations in guidance", () => {
    expect(BUILD_WORKFLOW_SYSTEM).toContain("workflow-driven");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("context.plan.declare");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("stage-level only");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("idempotent");
    expect(TEST_WORKFLOW_SYSTEM).toContain("context.plan");
    expect(TEST_WORKFLOW_SYSTEM).toContain("plan.declare");
  });

  test("binds identity and measured context into source-writing prompts", () => {
    const buildPrompt = buildWorkflowPrompt(
      "demo-cmake",
      1,
      '{"tools":{"cmake":{"available":true}}}',
      '{"primary_build_system":"cmake"}',
      "keep tests enabled",
    );
    expect(buildPrompt).toContain("TypeScript BuildWorkflow source module");
    expect(buildPrompt).toContain("demo-cmake@1");
    expect(buildPrompt).toContain('"primary_build_system":"cmake"');
    expect(buildPrompt).toContain("keep tests enabled");

    const testPrompt = testWorkflowPrompt(
      "demo-ctest",
      1,
      "demo-cmake",
      1,
      '{"tools":{"ctest":{"available":true}}}',
      '{"primary_build_system":"cmake"}',
      "run the smoke suite",
    );
    expect(testPrompt).toContain("TypeScript TestWorkflow source module");
    expect(testPrompt).toContain("demo-ctest@1");
    expect(testPrompt).toContain("demo-cmake@1");
    expect(testPrompt).toContain("run the smoke suite");
  });

  test("allows TestWorkflow to inspect tests without widening its write scope", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "rfr-workflow-scope-"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests", "test_trim.c"), "int main(void) { return 0; }\n");

    const testScope = workflowAgentScope("test");
    expect(checkToolScope(
      "Read",
      { file_path: "tests/test_trim.c" },
      root,
      testScope.readableGlobs,
      testScope.forbiddenGlobs,
      [".refactor/generated-workflows/test/workflow.ts"],
    ).allowed).toBeTrue();
    expect(checkToolScope(
      "Write",
      { file_path: "tests/test_trim.c" },
      root,
      testScope.readableGlobs,
      testScope.forbiddenGlobs,
      [".refactor/generated-workflows/test/workflow.ts"],
    ).allowed).toBeFalse();

    const buildScope = workflowAgentScope("build");
    expect(checkToolScope(
      "Read",
      { file_path: "tests/test_trim.c" },
      root,
      buildScope.readableGlobs,
      buildScope.forbiddenGlobs,
      [".refactor/generated-workflows/build/workflow.ts"],
    ).allowed).toBeFalse();
  });
});
