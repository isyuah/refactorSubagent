import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkflow } from "../src/workflow/runner.js";

function tempWorkflow(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-plan-"));
  const entry = join(root, "workflow.ts");
  writeFileSync(entry, source);
  return entry;
}

describe("Workflow plan declarations", () => {
  test("declares a tree, marks begin/complete, and returns the assembled plan", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        const [build, test] = await plan.declare([
          { title: "Build", description: "compile the project", children: [
            { title: "Configure" },
            { title: "Compile" },
          ]},
          { title: "Test", children: [
            { title: "Unit", description: "run unit tests" },
          ]},
        ]);
        await plan.begin(build);
        await plan.begin(build + ".1");
        await plan.complete(build + ".1");
        await plan.begin(build + ".2");
        await plan.complete(build + ".2");
        await plan.complete(build);
        await plan.begin(test);
        await plan.begin(test + ".1");
        await plan.complete(test + ".1");
        await plan.complete(test);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("pass");
    expect(result.plan).not.toBeNull();
    const plan = result.plan!;
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.title).toBe("Build");
    expect(plan.steps[0]!.description).toBe("compile the project");
    expect(plan.steps[0]!.status).toBe("completed");
    expect(plan.steps[0]!.children).toHaveLength(2);
    expect(plan.steps[0]!.children![0]!.status).toBe("completed");
    expect(plan.steps[0]!.children![1]!.status).toBe("completed");
    expect(plan.steps[1]!.title).toBe("Test");
    expect(plan.steps[1]!.status).toBe("completed");
    expect(plan.steps[1]!.children![0]!.status).toBe("completed");
  });

  test("rejects begin on an undeclared step", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.begin("p999");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("was not declared");
  });

  test("rejects complete without begin", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        const [step] = await plan.declare([{ title: "Solo" }]);
        await plan.complete(step);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("cannot complete while pending");
  });

  test("rejects duplicate begin", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        const [step] = await plan.declare([{ title: "Solo" }]);
        await plan.begin(step);
        await plan.begin(step);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("already running");
  });

  test("fail marks the step failed and records the error", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        const [step] = await plan.declare([{ title: "Fragile" }]);
        await plan.begin(step);
        await plan.fail(step, "linker exploded");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("pass");
    expect(result.plan!.steps[0]!.status).toBe("failed");
  });

  test("declaration with empty title is rejected", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.declare([{ title: "" }]);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("title");
  });
});
