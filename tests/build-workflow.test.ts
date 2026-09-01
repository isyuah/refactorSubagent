import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCliArgs } from "../src/cli/args.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { resolveBuildWorkflow } from "../src/workflow/build-workflow.js";
import {
  discoverBuildWorkflows,
  loadBuildWorkflow,
  saveBuildWorkflow,
} from "../src/workflow/registry.js";

function tempBuildProject(workflow: string): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-build-workflow-"));
  writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");
  writeFileSync(join(root, "workflow.ts"), workflow);
  return root;
}

const validWorkflow = `
export default ({ facts }) => ({
  kind: "build-workflow-output",
  version: 1,
  workflow_id: "direct-smoke",
  workflow_revision: 3,
  environment: {
    kind: "environment-spec",
    version: 1,
    build: {
      kind: "direct-compiler",
      compiler: "gcc",
      flags: [],
      defines: {},
      sources: ["main.c"],
      output: "build/app"
    },
    sanitizers: [],
    determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },
    sandbox: { run_cwd_strategy: "fresh_temp_dir" }
  },
  artifact: {
    kind: "executable",
    version: 1,
    workflow_id: "direct-smoke",
    workflow_revision: 3,
    paths: { app: "build/app" },
    metadata: { detected: facts.project?.primary_build_system ?? null }
  }
});
`;

describe("BuildWorkflow planning and registry", () => {
  test("parses the build workflow CLI command", () => {
    expect(parseCliArgs([
      "workflow",
      "build",
      "workflow.ts",
      "--id",
      "direct-smoke",
      "--revision",
      "3",
      "--manifest-out",
      ".refactorsa/build.json",
      "--format",
      "json",
    ])).toEqual({
      kind: "workflow-build",
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: process.cwd(),
      manifestOut: ".refactorsa/build.json",
      save: false,
      timeoutMs: 60_000,
      format: "json",
    });
  });

  test("validates workflow output and generates a source-hashed manifest", async () => {
    const root = tempBuildProject(validWorkflow);
    const host = probeHost(root);
    const project = detectCProject(root, host);
    const result = await resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: root,
      host,
      project,
    });

    expect(result.manifest.id).toBe("direct-smoke");
    expect(result.manifest.revision).toBe(3);
    expect(result.manifest.source_hash).toHaveLength(64);
    expect(result.output).not.toBeNull();
    if (result.output === null) return;
    if (!("kind" in result.output.environment.build) || result.output.environment.build.kind !== "direct-compiler") {
      throw new Error("expected direct compiler environment");
    }
    expect(result.output.environment.build.kind).toBe("direct-compiler");
    expect(result.output.artifact.paths).toEqual({ app: "build/app" });
    expect(result.manifest.status).toBe("draft");
  }, 60_000);

  test("rejects an artifact path that escapes the workflow workspace", async () => {
    const root = tempBuildProject(validWorkflow.replace('"build/app" },', '"../outside" },'));
    await expect(resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: root,
    })).rejects.toThrow("escapes workspace");
  }, 60_000);

  test("saves and discovers a workflow revision with a verified source hash", async () => {
    const root = tempBuildProject(validWorkflow);
    const host = probeHost(root, { skipCMakeProbe: true });
    const project = detectCProject(root, host);
    const resolution = await resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: root,
      host,
      project,
    });
    const saved = saveBuildWorkflow(root, resolution);
    const loaded = loadBuildWorkflow(saved.manifestPath, root);
    const candidates = discoverBuildWorkflows(root, host, project);

    expect(readFileSync(saved.entry, "utf8")).toBe(validWorkflow);
    expect(loaded.manifest.source_hash).toBe(resolution.sourceHash);
    expect(loaded.output?.artifact.paths).toEqual({ app: "build/app" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe("draft");
  }, 30_000);

  test("marks a persisted workflow stale after source drift", async () => {
    const root = tempBuildProject(validWorkflow);
    const resolution = await resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: root,
    });
    const saved = saveBuildWorkflow(root, resolution);
    writeFileSync(saved.entry, `${validWorkflow}\n// drift\n`);

    expect(() => loadBuildWorkflow(saved.manifestPath, root)).toThrow("source hash mismatch");
    expect(discoverBuildWorkflows(root)).toEqual([
      expect.objectContaining({ status: "stale" }),
    ]);
  });
});
