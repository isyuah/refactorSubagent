import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aliasLibraryId,
  curateBuildWorkflow,
  loadAliases,
  saveAlias,
} from "../src/workflow/curator.js";
import { discoverBuildWorkflows } from "../src/workflow/registry.js";

const VALID_BUILD = `export const workflowKind = "workflow-driven";
export default async () => { return; };
`;

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-curator-"));
  mkdirSync(join(root, ".refactor", "runs", "s1", "workflows", "build"), { recursive: true });
  return root;
}

describe("curator alias", () => {
  test("alias round-trips through the alias file", () => {
    const root = tempRepo();
    expect(aliasLibraryId(root, "my-build-s1")).toBeNull();
    saveAlias(root, "my-build-s1", "my-build");
    expect(aliasLibraryId(root, "my-build-s1")).toBe("my-build");
    expect(loadAliases(root).aliases["my-build-s1"]).toBe("my-build");
  });
});

describe("curateBuildWorkflow", () => {
  test("promotes a run-local build into the library and records the alias", async () => {
    const root = tempRepo();
    const runLocalEntry = join(root, ".refactor", "runs", "s1", "workflows", "build", "trim-build-s1.ts");
    writeFileSync(runLocalEntry, VALID_BUILD, "utf8");

    const result = await curateBuildWorkflow({
      repoRoot: root,
      entry: runLocalEntry,
      runLocalId: "trim-build-s1",
    });
    expect(result.promoted).toBe(true);
    expect(result.libraryId).toBe("trim-build");
    expect(aliasLibraryId(root, "trim-build-s1")).toBe("trim-build");

    const discovered = discoverBuildWorkflows(root);
    const lib = discovered.find((c) => c.manifest?.id === "trim-build");
    expect(lib).toBeDefined();
    expect(lib?.status).toBe("draft");
    expect(existsSync(lib!.entry!)).toBe(true);
  });

  test("idempotent: second promote does not duplicate", async () => {
    const root = tempRepo();
    const runLocalEntry = join(root, ".refactor", "runs", "s1", "workflows", "build", "dup-s1.ts");
    writeFileSync(runLocalEntry, VALID_BUILD, "utf8");

    await curateBuildWorkflow({ repoRoot: root, entry: runLocalEntry, runLocalId: "dup-s1" });
    const second = await curateBuildWorkflow({ repoRoot: root, entry: runLocalEntry, runLocalId: "dup-s1" });
    expect(second.promoted).toBe(true);
    expect(discoverBuildWorkflows(root).filter((c) => c.manifest?.id === "dup")).toHaveLength(1);
  });

  test("missing source is not promoted", async () => {
    const root = tempRepo();
    const result = await curateBuildWorkflow({
      repoRoot: root,
      entry: join(root, ".refactor", "runs", "s1", "workflows", "build", "ghost-s1.ts"),
      runLocalId: "ghost-s1",
    });
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("missing");
  });

  test("honors an explicit library id", async () => {
    const root = tempRepo();
    const runLocalEntry = join(root, ".refactor", "runs", "s1", "workflows", "build", "x-s1.ts");
    writeFileSync(runLocalEntry, VALID_BUILD, "utf8");
    const result = await curateBuildWorkflow({
      repoRoot: root,
      entry: runLocalEntry,
      runLocalId: "x-s1",
      libraryId: "custom-lib-name",
    });
    expect(result.libraryId).toBe("custom-lib-name");
    expect(aliasLibraryId(root, "x-s1")).toBe("custom-lib-name");
  });
});
