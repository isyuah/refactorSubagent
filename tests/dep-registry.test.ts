import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalDependencyRegistry,
  validateBuildWorkflowSource,
} from "../src/agents/dep-registry.js";
import { readVerificationMaterials } from "../src/workflow/verification-materials.js";

const VALID_WORKFLOW_KIND = `export const workflowKind = "workflow-driven";
`;

const VALID_BUILD_SOURCE = `${VALID_WORKFLOW_KIND}
export default async ({ context }) => {
  // drive the build via injected capabilities
  return;
};
`;

/** A temp root + registry instance, isolated per test. */
function makeRegistry(sessionId = "sess-abc123") {
  const root = mkdtempSync(join(tmpdir(), "rfr-depreg-"));
  const sessionRoot = mkdtempSync(join(tmpdir(), "rfr-depreg-sess-"));
  const reg = new LocalDependencyRegistry({
    workspaceRoot: root,
    sessionRoot,
    sessionId,
  });
  return { reg, root, sessionRoot };
}

describe("validateBuildWorkflowSource", () => {
  test("accepts a valid workflow-driven source", () => {
    const check = validateBuildWorkflowSource(VALID_BUILD_SOURCE);
    expect(check.ok).toBe(true);
  });

  test("rejects empty content", () => {
    const check = validateBuildWorkflowSource("   ");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("empty");
  });

  test("rejects missing workflowKind literal", () => {
    const check = validateBuildWorkflowSource("export default () => 1;\n");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("workflowKind");
  });

  test("rejects node: import", () => {
    const check = validateBuildWorkflowSource(
      `${VALID_WORKFLOW_KIND}import { readFileSync } from "node:fs";\n`,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("imports a host API");
  });

  test("rejects bare process usage", () => {
    const check = validateBuildWorkflowSource(
      `${VALID_WORKFLOW_KIND}const x = process.env.FOO;\n`,
    );
    expect(check.ok).toBe(false);
  });

  test("rejects syntax errors", () => {
    const check = validateBuildWorkflowSource(`${VALID_WORKFLOW_KIND}export default ( => {`);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("syntax");
  });
});

describe("LocalDependencyRegistry.generate", () => {
  test("an interrupted source/material registration cannot be reused, and regeneration repairs it", async () => {
    const { reg, root, sessionRoot } = makeRegistry("partial-write");
    const input = { name: "partial", description: "", content: VALID_BUILD_SOURCE, materials: [{ path: "build/verification/probe.c", content: "int main(void) { return 0; }\n" }] };
    const first = await reg.generate(input);
    const entry = (await reg.resolveBuildEntry(first.workflowId))!.entry;
    const sidecar = `${entry}.materials.json`;
    unlinkSync(sidecar);
    mkdirSync(sidecar); // force an actual write failure after the source write
    await expect(reg.generate({ ...input, content: VALID_BUILD_SOURCE + "\n// replacement\n" })).rejects.toThrow();
    expect((await reg.knownBuildIds()).includes(first.workflowId)).toBe(false);
    expect(() => readVerificationMaterials(entry)).toThrow("registration is incomplete");
    const restored = new LocalDependencyRegistry({ workspaceRoot: root, sessionRoot, sessionId: "partial-write" });
    expect(await restored.resolveBuildEntry(first.workflowId)).toBeNull();
    rmdirSync(sidecar);
    await restored.generate(input);
    expect((await restored.resolveBuildEntry(first.workflowId))?.entry).toBe(entry);
    expect(readVerificationMaterials(entry)).toHaveLength(1);
  });

  test("auxiliary inputs and host-computed hashes survive a registry restart", async () => {
    const { reg, root, sessionRoot } = makeRegistry("materials");
    const material = { path: "build/verification/probe.c", content: "int main(void) { return 0; }\n" };
    const generated = await reg.generate({ name: "with-helper", description: "", content: VALID_BUILD_SOURCE, materials: [material] });
    const restored = new LocalDependencyRegistry({ workspaceRoot: root, sessionRoot, sessionId: "materials" });
    const entry = (await restored.resolveBuildEntry(generated.workflowId))!.entry;
    expect(readVerificationMaterials(entry)).toEqual([{ ...material, sha256: createHash("sha256").update(material.content).digest("hex") }]);
    expect((await restored.inspect({ kind: "build", id: generated.workflowId })).items[0]?.materials).toEqual(generated.materials);
    // Replacing a recipe with an empty material set cannot retain an old helper.
    await restored.generate({ name: "with-helper", description: "", content: VALID_BUILD_SOURCE });
    expect(readVerificationMaterials(entry)).toEqual([]);
  });

  test("unsafe and conflicting helper paths fail before any workflow is written", async () => {
    const { reg, root } = makeRegistry();
    for (const path of ["src/main.c", "build/verification/../main.c", "C:/tmp/probe.c", "build\\verification\\probe.c", "build/verification/NUL.c", "build/verification/probe.c:stream"]) {
      await expect(reg.generate({ name: "bad", description: "", content: VALID_BUILD_SOURCE, materials: [{ path, content: "x" }] })).rejects.toThrow("verification material path");
    }
    for (const paths of [["build/verification/a.c", "build/verification/A.c"], ["build/verification/a", "build/verification/a/b.c"]]) {
      await expect(reg.generate({ name: "bad", description: "", content: VALID_BUILD_SOURCE, materials: paths.map((path) => ({ path, content: "x" })) })).rejects.toThrow("conflicting verification material");
    }
    expect(existsSync(join(root, ".refactor", "runs", "sess-abc123", "workflows", "build"))).toBe(false);
  });

  test("materializes a run-local build workflow under the repo run dir", async () => {
    const { reg, root } = makeRegistry();
    const result = await reg.generate({
      name: "My CMake Build",
      description: "builds the test runner",
      content: VALID_BUILD_SOURCE,
    });
    expect(result.workflowId).toMatch(/^my-cmake-build-sess/);
    expect(result.revision).toBe(1);
    expect(result.lineCount).toBeGreaterThan(0);
    const expectedDir = join(root, ".refactor", "runs", "sess-abc123", "workflows", "build");
    expect(existsSync(join(expectedDir, `${result.workflowId}.ts`))).toBe(true);
    // File content matches (with trailing newline normalization).
    const written = readFileSync(join(expectedDir, `${result.workflowId}.ts`), "utf8");
    expect(written.trim()).toBe(VALID_BUILD_SOURCE.trim());
  });

  test("rejects invalid content before writing (fail-closed)", async () => {
    const { reg, root } = makeRegistry();
    await expect(
      reg.generate({ name: "bad", description: "", content: "not a workflow at all" }),
    ).rejects.toThrow(/invalid workflow source/);
    // Nothing materialized.
    const buildDir = join(root, ".refactor", "runs", "sess-abc123", "workflows", "build");
    expect(existsSync(buildDir)).toBe(false);
  });

  test("idempotent create-or-replace by name bumps revision", async () => {
    const { reg } = makeRegistry();
    const first = await reg.generate({ name: "dup", description: "v1", content: VALID_BUILD_SOURCE });
    const second = await reg.generate({ name: "dup", description: "v2", content: VALID_BUILD_SOURCE });
    expect(first.workflowId).toBe(second.workflowId);
    expect(second.revision).toBe(2);
    expect(second.description).toBe("v2");
    // Same file overwritten.
    const readBack = await reg.resolveBuildEntry(first.workflowId);
    expect(readBack?.runLocal).toBe(true);
  });
});

describe("LocalDependencyRegistry.declare", () => {
  test("accepts a known run-local id (after generate)", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "b1", description: "", content: VALID_BUILD_SOURCE });
    const declared = await reg.declare({ buildWorkflowIds: [gen.workflowId] });
    expect(declared).toEqual([gen.workflowId]);
    expect(await reg.currentDeclared()).toEqual([gen.workflowId]);
  });

  test("rejects unknown id with known list", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "known", description: "", content: VALID_BUILD_SOURCE });
    await expect(reg.declare({ buildWorkflowIds: ["nope", gen.workflowId] })).rejects.toThrow(
      /unknown build workflow id\(s\): nope/,
    );
    // Rejected declare leaves prior state unchanged (fail-closed, no partial).
    expect(await reg.currentDeclared()).toEqual([]);
  });

  test("empty set is a valid explicit no-dependency declaration", async () => {
    const { reg } = makeRegistry();
    const declared = await reg.declare({ buildWorkflowIds: [] });
    expect(declared).toEqual([]);
  });

  test("idempotent overwrite replaces the full set", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "b", description: "", content: VALID_BUILD_SOURCE });
    await reg.declare({ buildWorkflowIds: [gen.workflowId] });
    await reg.declare({ buildWorkflowIds: [] });
    expect(await reg.currentDeclared()).toEqual([]);
  });
});

describe("LocalDependencyRegistry.inspect", () => {
  test("lists run-local and persisted library build workflows", async () => {
    const { reg, root } = makeRegistry();
    await reg.generate({ name: "local-one", description: "local desc", content: VALID_BUILD_SOURCE });
    seedLibraryBuild(root, "lib-build");
    const items = await reg.inspect({ kind: "build" });
    const local = items.items.find((item) => item.status === "run-local");
    expect(local?.description).toBe("local desc");
    expect(local?.revision).toBe(1);
    const lib = items.items.find((item) => item.id === "lib-build");
    expect(lib?.status).toBe("library-draft");
    expect(lib?.kind).toBe("build");
  });

  test("filters by exact id", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "target", description: "", content: VALID_BUILD_SOURCE });
    const items = await reg.inspect({ kind: "build", id: gen.workflowId });
    expect(items.items).toHaveLength(1);
    expect(items.items[0]?.id).toBe(gen.workflowId);
  });

  test("empty registry lists nothing", async () => {
    const { reg } = makeRegistry();
    expect((await reg.inspect({ kind: "build" })).items).toEqual([]);
  });

  test("description survives registry rebuild via sidecar", async () => {
    const { reg, root, sessionRoot } = makeRegistry("sess-restore");
    const gen = await reg.generate({
      name: "persistent",
      description: "survives restart",
      content: VALID_BUILD_SOURCE,
    });
    // A fresh registry instance over the same dirs restores run-local from disk.
    const reg2 = new LocalDependencyRegistry({
      workspaceRoot: root,
      sessionRoot,
      sessionId: "sess-restore",
    });
    const items = await reg2.inspect({ kind: "build", id: gen.workflowId });
    expect(items.items).toHaveLength(1);
    expect(items.items[0]?.description).toBe("survives restart");
    expect(items.items[0]?.status).toBe("run-local");
  });
});

describe("LocalDependencyRegistry.resolveBuildEntry", () => {
  test("resolves run-local id to its materialized entry", async () => {
    const { reg } = makeRegistry();
    const gen = await reg.generate({ name: "entry-test", description: "", content: VALID_BUILD_SOURCE });
    const resolved = await reg.resolveBuildEntry(gen.workflowId);
    expect(resolved?.runLocal).toBe(true);
    expect(resolved?.entry.endsWith(`${gen.workflowId}.ts`)).toBe(true);
    expect(existsSync(resolved!.entry)).toBe(true);
  });

  test("returns null for unknown id", async () => {
    const { reg } = makeRegistry();
    expect(await reg.resolveBuildEntry("does-not-exist")).toBeNull();
  });
});

/** Seed a minimal persisted library entry readable by discoverBuildWorkflows. */
function seedLibraryBuild(root: string, id: string): void {
  const revDir = join(root, ".refactorsa", "build-workflows", id, "r1");
  mkdirSync(revDir, { recursive: true });
  const entryPath = join(revDir, "workflow.ts");
  writeFileSync(entryPath, VALID_BUILD_SOURCE, "utf8");
  // loadBuildWorkflow verifies source_hash against the actual file; compute real one.
  const hash = createHash("sha256").update(VALID_BUILD_SOURCE, "utf8").digest("hex");
  writeFileSync(
    join(revDir, "manifest.json"),
    JSON.stringify({
      kind: "build-workflow-manifest",
      version: 1,
      id,
      revision: 1,
      entry: `.refactorsa/build-workflows/${id}/r1/workflow.ts`,
      source_hash: hash,
      workflow_api_version: 1,
      applies_to: { build_systems: [], markers: [], platforms: [], architectures: [], required_tools: [] },
      status: "draft",
    }),
    "utf8",
  );
}
