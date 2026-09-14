import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStageFlow, resolvePipeline } from "../src/config/pipeline.js";

function tempRoots(): { repo: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "rfr-pipeline-"));
  return { repo: join(root, "repo"), home: join(root, "home") };
}

function writePipeline(repo: string, value: unknown): void {
  mkdirSync(join(repo, ".refactor"), { recursive: true });
  writeFileSync(join(repo, ".refactor", "pipeline.json"), JSON.stringify(value, null, 2));
}

describe("pipeline stage-source config", () => {
  test("defaults keep every stage on its AI implementation", () => {
    const { repo, home } = tempRoots();
    const { pipeline, sources } = resolvePipeline({ repoRoot: repo, homeDir: home });

    expect(sources).toEqual([]);
    expect(pipeline.stages).toEqual({
      workflows: { mode: "ai" },
      prepare: { mode: "create" },
      refactor: { mode: "ai" },
    });
    // No stage is injected, so the run keeps the AI default everywhere.
    expect(buildStageFlow(pipeline)).toEqual({});
  });

  test("a project layer replaces one stage and leaves the others alone", () => {
    const { repo, home } = tempRoots();
    writePipeline(repo, {
      stages: { refactor: { mode: "patch", patchFile: "tools/fix.patch" } },
    });
    const { pipeline, sources } = resolvePipeline({ repoRoot: repo, homeDir: home });

    expect(sources).toHaveLength(1);
    expect(pipeline.stages.workflows).toEqual({ mode: "ai" });
    expect(pipeline.stages.refactor).toEqual({ mode: "patch", patchFile: "tools/fix.patch" });
    const flow = buildStageFlow(pipeline);
    expect(flow.workflows).toBeUndefined();
    expect(typeof flow.refactor).toBe("function");
  });

  test("a mistyped key is rejected instead of silently ignored", () => {
    const { repo, home } = tempRoots();
    writePipeline(repo, { stages: { refactor: { mode: "patch", patchFiel: "tools/fix.patch" } } });

    expect(() => resolvePipeline({ repoRoot: repo, homeDir: home }))
      .toThrow(/invalid pipeline file .*refactor/);
  });

  test("a scalar override wins over the project layer", () => {
    const { repo, home } = tempRoots();
    writePipeline(repo, { stages: { refactor: { mode: "patch", patchFile: "tools/fix.patch" } } });
    const { pipeline } = resolvePipeline({
      repoRoot: repo,
      homeDir: home,
      overrides: { values: ["stages.refactor.mode=ai"] },
    });

    expect(pipeline.stages.refactor).toEqual({ mode: "ai" });
    expect(buildStageFlow(pipeline).refactor).toBeUndefined();
  });

  test("refactor 'none' without a reused candidate branch is refused up front", () => {
    const { repo, home } = tempRoots();
    writePipeline(repo, {
      stages: {
        refactor: { mode: "none" },
        prepare: { mode: "reuse", branch: "refactor/task-1", baseSha: "0".repeat(40) },
      },
    });
    const flow = buildStageFlow(resolvePipeline({ repoRoot: repo, homeDir: home }).pipeline);
    expect(typeof flow.refactor).toBe("function");
    expect(typeof flow.prepare).toBe("function");

    writePipeline(repo, { stages: { refactor: { mode: "none" } } });
    const orphan = resolvePipeline({ repoRoot: repo, homeDir: home }).pipeline;
    expect(() => buildStageFlow(orphan)).toThrow(/prepare\.mode 'reuse'/);
  });

  test("a preset workflows stage needs at least one build source", () => {
    const { repo, home } = tempRoots();
    writePipeline(repo, {
      stages: { workflows: { mode: "preset", builds: [], testEntry: "workflows/test.ts" } },
    });

    expect(() => resolvePipeline({ repoRoot: repo, homeDir: home })).toThrow(/builds/);
  });
});
