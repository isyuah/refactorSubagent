import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeHost } from "../src/runtime/host-preflight.js";
import { resolveBuildWorkflow } from "../src/workflow/build-workflow.js";
import { executeBuildWorkflow } from "../src/workflow/build-executor.js";
import type { BuildWorkflowOutput } from "../src/artifacts/index.js";

const DRIVEN_POLICY = {
  readableGlobs: ["**"],
  writableGlobs: ["**"],
  executableGlobs: ["build/**"],
  allowedTools: ["gcc"],
  maxOutputBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
};

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "rfr-driven-"));
}

const DRIVEN_WORKFLOW = `
export const workflowKind = "workflow-driven";

export default async ({ process, fs, validator }) => {
  // The function drives the build itself through injected capabilities.
  await fs.mkdir("build");
   await fs.writeFile("main.c", "#include <stdio.h>\\nint main(void){puts(\\"driven\\");return 0;}\\n");
  const result = await process.run({
    program: "gcc",
    args: ["main.c", "-o", "build/app.exe"],
    cwd: ".",
    timeoutMs: 30000,
  });
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw new Error("gcc failed: " + (result.error ?? String(result.exitCode)));
  }
  // Assert the produced executable exists before completing.
  await validator.assertFile("build/app.exe", "driven test executable");
};
`;


describe("workflow-driven builds", () => {
  test("resolves a workflow-driven workflow (schema accepts the build kind)", async () => {
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
      policy: DRIVEN_POLICY,
    });
    expect(resolution.manifest.id).toBe("driven-smoke");
    // workflow-driven workflows have no static plan: output is null at
    // resolution and produced during execution.
    expect(resolution.output).toBeNull();
  }, 30_000);

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
    expect(execution.failure).toContain("never-exists");
  }, 90_000);
});
