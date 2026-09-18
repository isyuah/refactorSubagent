import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDeclaredWorkflows } from "../workflow/resolve-declared.js";
import { createWorktrees } from "./worktree.js";
import {
  buildDeclaredResolution,
  halt,
  type PrepareStage,
  type RefactorStage,
  type WorkflowsStage,
} from "./stage-flow.js";

/**
 * stage-presets — AI-free stage implementations, for runs whose input is a
 * file instead of a session.
 *
 * These are the building blocks of "test one capability through the real
 * pipeline": the host still validates, commits, measures and decides; the
 * preset only supplies the stage's input. Configuration maps to them in the
 * application layer (`src/config/pipeline.ts`); the stage functions stay here
 * so a caller can compose them directly.
 */

/** A build workflow source the run should use instead of declaring one. */
export interface PresetBuildSource {
  readonly id: string;
  /** Repo-relative (or absolute) path to the workflow source. */
  readonly entry: string;
  /** True only for sources generated during this run (they get promoted). */
  readonly runLocal?: boolean;
  readonly workflowId?: string;
  readonly revision?: number;
}

export interface PresetWorkflowsSpec {
  readonly builds: readonly PresetBuildSource[];
  /** Repo-relative (or absolute) path to the test workflow source. */
  readonly testEntry: string;
  /**
   * Root the entries are resolved against and must stay inside. Defaults to the
   * repository; a caller whose workflow sources live outside it (judgement
   * material that must not travel with the environment) sets this instead.
   */
  readonly entryRoot?: string;
  readonly workflowId?: string;
  readonly revision?: number;
}

/** Entries are resolved against the entry root; absolute paths must stay inside it. */
function resolveEntry(entryRoot: string, entry: string): string {
  return isAbsolute(entry) ? entry : join(entryRoot, entry);
}

/**
 * Replace the test-writer session with caller-supplied workflow sources. The
 * declaration is fixed; resolution, artifact shapes and every later gate are
 * the same ones the AI path goes through.
 */
export function presetWorkflowsStage(spec: PresetWorkflowsSpec): WorkflowsStage {
  return async (ctx, input) => {
    const workflowId = spec.workflowId ?? "preset-test";
    const revision = spec.revision ?? 1;
    const entryRoot = resolve(spec.entryRoot ?? ctx.repoPath);
    const builds = spec.builds.map((build) => ({
      id: build.id,
      entry: resolveEntry(entryRoot, build.entry),
      runLocal: build.runLocal ?? false,
      ...(build.workflowId !== undefined ? { workflowId: build.workflowId } : {}),
      ...(build.revision !== undefined ? { revision: build.revision } : {}),
    }));
    const testEntry = resolveEntry(entryRoot, spec.testEntry);
    const missing = builds.find((build) => !existsSync(build.entry))?.entry ??
      (existsSync(testEntry) ? null : testEntry);
    if (missing !== null) return halt(`preset workflow source missing: ${missing}`);

    const resolved = await resolveDeclaredWorkflows({
      workspaceRoot: ctx.repoPath,
      entryRoot,
      host: input.preflight.host,
      project: input.preflight.project,
      testEntry,
      testWorkflowId: workflowId,
      testRevision: revision,
      builds,
    });
    return {
      declared: buildDeclaredResolution({
        repoDir: ctx.repoPath,
        testEntry,
        workflowId,
        revision,
        builds,
        resolved,
      }),
    };
  };
}

/**
 * Replace the refactor session with a patch. The host still stages, commits
 * and measures the candidate worktree, so the change set in the record is
 * host-measured, not patch-declared.
 */
export function patchRefactorStage(patchFile: string): RefactorStage {
  return async (ctx, input) => {
    const file = resolveEntry(ctx.repoPath, patchFile);
    if (!existsSync(file)) return halt(`preset patch file missing: ${file}`);
    const applied = spawnSync("git", ["apply", "--whitespace=nowarn", file], {
      cwd: input.candidate.worktrees.candidateDir,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (applied.status !== 0) {
      const detail = (applied.stderr ?? "").trim();
      return halt(
        `preset patch did not apply: ${detail.length > 0 ? detail : `git apply exited ${String(applied.status)}`}`,
      );
    }
    return { summary: `preset patch: ${patchFile}` };
  };
}

/**
 * Refactor stage that edits nothing. Pair it with a prepare stage that hands
 * over a candidate branch which already carries the change (replay), or use it
 * to test the "no changes" gate.
 */
export function fixedRefactorStage(summary: string): RefactorStage {
  return async () => ({ summary });
}

/**
 * Prepare stage that reuses an existing candidate branch instead of creating
 * one. The baseline worktree still comes from the recorded base commit, so the
 * host measures the real diff between the two.
 */
export function existingBranchPrepareStage(spec: {
  readonly branch: string;
  readonly baseSha: string;
}): PrepareStage {
  return async (ctx) => {
    const worktrees = createWorktrees(ctx.repoPath, ctx.store.sessionDir, spec.branch, spec.baseSha);
    return { branch: spec.branch, baseSha: spec.baseSha, worktrees };
  };
}
