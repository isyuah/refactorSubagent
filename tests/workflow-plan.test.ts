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
  test("declares a tree with caller-supplied ids and returns them", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        const ids = await plan.declare([
          { id: "build", title: "Build", description: "compile the project", children: [
            { id: "build.configure", title: "Configure" },
            { id: "build.compile", title: "Compile" },
          ]},
          { id: "test", title: "Test", children: [
            { id: "test.unit", title: "Unit", description: "run unit tests" },
          ]},
        ]);
        // declare returns exactly the supplied ids (roots in tree order).
        if (ids.join(",") !== "build,test") throw new Error("unexpected ids: " + ids.join(","));
        await plan.begin("build");
        await plan.begin("build.configure");
        await plan.complete("build.configure");
        await plan.begin("build.compile");
        await plan.complete("build.compile");
        await plan.complete("build");
        await plan.begin("test");
        await plan.begin("test.unit");
        await plan.complete("test.unit");
        await plan.complete("test");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("pass");
    expect(result.plan).not.toBeNull();
    const plan = result.plan!;
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.id).toBe("build");
    expect(plan.steps[0]!.title).toBe("Build");
    expect(plan.steps[0]!.description).toBe("compile the project");
    expect(plan.steps[0]!.status).toBe("completed");
    expect(plan.steps[0]!.children).toHaveLength(2);
    expect(plan.steps[0]!.children![0]!.id).toBe("build.configure");
    expect(plan.steps[0]!.children![0]!.status).toBe("completed");
    expect(plan.steps[0]!.children![1]!.id).toBe("build.compile");
    expect(plan.steps[0]!.children![1]!.status).toBe("completed");
    expect(plan.steps[1]!.id).toBe("test");
    expect(plan.steps[1]!.status).toBe("completed");
    expect(plan.steps[1]!.children![0]!.id).toBe("test.unit");
    expect(plan.steps[1]!.children![0]!.status).toBe("completed");
  });

  test("rejects begin on an undeclared step", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.begin("nope");
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
        await plan.declare([{ id: "solo", title: "Solo" }]);
        await plan.complete("solo");
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
        await plan.declare([{ id: "solo", title: "Solo" }]);
        await plan.begin("solo");
        await plan.begin("solo");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("already running");
  });

  test("assigns fallback ids when the workflow omits them", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        const ids = await plan.declare([
          { title: "First", children: [{ title: "First child" }] },
          { title: "Second" },
        ]);
        await plan.begin(ids[0]!);
        await plan.begin(ids[0]! + ".1");
        await plan.complete(ids[0]! + ".1");
        await plan.complete(ids[0]!);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("pass");
    expect(result.plan!.steps[0]!.id).toBe("p1");
    expect(result.plan!.steps[0]!.children![0]!.id).toBe("p1.1");
    expect(result.plan!.steps[1]!.id).toBe("p2");
  });

  test("rejects duplicate ids across the tree", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.declare([
          { id: "dup", title: "First" },
          { id: "dup", title: "Second" },
        ]);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("not unique");
  });

  test("fail marks the step failed and records the error", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.declare([{ id: "fragile", title: "Fragile" }]);
        await plan.begin("fragile");
        await plan.fail("fragile", "linker exploded");
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("pass");
    expect(result.plan!.steps[0]!.id).toBe("fragile");
    expect(result.plan!.steps[0]!.status).toBe("failed");
  });

  test("declaration with empty title is rejected", async () => {
    const entry = tempWorkflow(`
      export default async ({ plan }) => {
        await plan.declare([{ id: "x", title: "" }]);
        return { ok: true };
      };
    `);
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 15_000 });
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("title");
  });
});
