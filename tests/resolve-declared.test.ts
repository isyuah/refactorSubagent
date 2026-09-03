import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDeclaredWorkflows } from "../src/workflow/resolve-declared.js";

const BUILD_SOURCE = (id: string) => `export const workflowKind = "workflow-driven";
export default async () => { return; };
`;

const TEST_SOURCE = `export const workflowKind = "test-workflow-driven";
export default async (ctx) => {
  ctx.expect("exit", 0);
  return;
};
`;

function tempProject(): { root: string; entry: (kind: string, name: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "rfr-resolvedec-"));
  const entry = (kind: string, name: string): string => {
    const dir = join(root, "wf", kind);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${name}.ts`);
    writeFileSync(p, kind === "build" ? BUILD_SOURCE(name) : TEST_SOURCE, "utf8");
    return p;
  };
  return { root, entry };
}

describe("resolveDeclaredWorkflows", () => {
  test("resolves one declared build and a self-driven test", async () => {
    const { root, entry } = tempProject();
    const buildEntry = entry("build", "b1");
    const testEntry = entry("test", "t1");
    const result = await resolveDeclaredWorkflows({
      workspaceRoot: root,
      repoRoot: root,
      testEntry,
      testWorkflowId: "test-1",
      testRevision: 1,
      builds: [{ id: "b1", entry: buildEntry, runLocal: true }],
    });
    expect(result.builds).toHaveLength(1);
    expect(result.builds[0]?.id).toBe("b1");
    expect(result.builds[0]?.runLocal).toBe(true);
    expect(result.test.manifest.id).toBe("test-1");
  });

  test("resolves multiple declared builds", async () => {
    const { root, entry } = tempProject();
    const b1 = entry("build", "b1");
    const b2 = entry("build", "b2");
    const testEntry = entry("test", "t1");
    const result = await resolveDeclaredWorkflows({
      workspaceRoot: root,
      repoRoot: root,
      testEntry,
      testWorkflowId: "test-multi",
      testRevision: 1,
      builds: [
        { id: "b1", entry: b1, runLocal: true },
        { id: "b2", entry: b2, runLocal: false },
      ],
    });
    expect(result.builds.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(result.builds[1]?.runLocal).toBe(false);
  });

  test("resolves with an empty build set (no-dependency test)", async () => {
    const { root, entry } = tempProject();
    const testEntry = entry("test", "t0");
    const result = await resolveDeclaredWorkflows({
      workspaceRoot: root,
      repoRoot: root,
      testEntry,
      testWorkflowId: "test-none",
      testRevision: 1,
      builds: [],
    });
    expect(result.builds).toEqual([]);
    expect(result.test.manifest.id).toBe("test-none");
  });

  test("fails closed when a declared build source is invalid", async () => {
    const { root, entry } = tempProject();
    const testEntry = entry("test", "t1");
    const badDir = join(root, "wf", "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "b.ts"), "not a workflow", "utf8");
    await expect(
      resolveDeclaredWorkflows({
        workspaceRoot: root,
        repoRoot: root,
        testEntry,
        testWorkflowId: "test-1",
        testRevision: 1,
        builds: [{ id: "bad", entry: join(badDir, "b.ts"), runLocal: true }],
      }),
    ).rejects.toThrow();
  });

  test("fails when a declared build entry is missing", async () => {
    const { root, entry } = tempProject();
    const testEntry = entry("test", "t1");
    await expect(
      resolveDeclaredWorkflows({
        workspaceRoot: root,
        repoRoot: root,
        testEntry,
        testWorkflowId: "test-1",
        testRevision: 1,
        builds: [{ id: "ghost", entry: join(root, "wf", "build", "ghost.ts"), runLocal: true }],
      }),
    ).rejects.toThrow(/does not exist|workflow entry/);
  });
});
