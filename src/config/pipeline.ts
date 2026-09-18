import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  existingBranchPrepareStage,
  fixedRefactorStage,
  patchRefactorStage,
  presetWorkflowsStage,
} from "../runtime/stage-presets.js";
import type { PrepareStage, RefactorStage, StageFlow, WorkflowsStage } from "../runtime/stage-flow.js";
import {
  extractConfigArgs,
  resolveLayeredConfig,
  type FileCheck,
  type LayerOverrides,
  type LayeredConfigSpec,
} from "./layers.js";

/**
 * Pipeline config — where each stage's input comes from, per run.
 *
 * Which stages run is fixed; a stage's INPUT is configurable. Anything not
 * written here keeps its AI default, so a plain run needs no config at all:
 *
 *   {
 *     "stages": {
 *       "workflows": {
 *         "mode": "preset",
 *         "builds": [{ "id": "cmake-debug", "entry": "tools/build-workflow.ts" }],
 *         "testEntry": "tools/test-workflow.ts"
 *       },
 *       "refactor": { "mode": "patch", "patchFile": "tools/fix.patch" }
 *     }
 *   }
 *
 * This is an application concern: the core takes stage FUNCTIONS
 * (`runStageFlow({ ..., flow })`), and this module only translates a layered
 * config file into them. Complex runs — the common shape once a project is
 * trusted — stop being "let the model decide" without giving up the pipeline.
 *
 * Layers, later wins (see `layers.ts`):
 *   1. DEFAULT_PIPELINE < ~/.refactor/pipeline.json < <repo>/.refactor/pipeline.json
 *   2. < --pipeline-file <path> ... < --stage <key.path>=<value> ...
 */

const BuildSource = z
  .object({
    id: z.string().min(1),
    /** Repo-relative or absolute path to the build workflow source. */
    entry: z.string().min(1),
    /** True only for sources generated during this run (they get promoted). */
    runLocal: z.boolean().optional(),
    workflowId: z.string().min(1).optional(),
    revision: z.number().int().positive().optional(),
  })
  .strict();

// Each stage is a discriminated union. Files are checked strictly — a typo
// must not silently keep the AI default — while the merged result strips
// unknown keys, because switching a mode back (--stage ...mode=ai) leaves the
// other mode's fields behind in the layer below.
const WorkflowsAi = z.object({ mode: z.literal("ai") });
const WorkflowsPreset = z.object({
  mode: z.literal("preset"),
  /**
   * Root the entries below are resolved against and must stay inside. Defaults
   * to the repository; a caller that keeps its workflow sources outside the
   * repository (e.g. judgement material injected for verification only) sets
   * it to the directory those sources live under.
   */
  entryRoot: z.string().min(1).optional(),
  builds: z.array(BuildSource).min(1),
  /** Repo-relative or absolute path to the test workflow source. */
  testEntry: z.string().min(1),
  workflowId: z.string().min(1).optional(),
  revision: z.number().int().positive().optional(),
});
const WorkflowsStageFile = z.union([WorkflowsAi.strict(), WorkflowsPreset.strict()]);
const WorkflowsStage = z.union([WorkflowsAi, WorkflowsPreset]);

const PrepareCreate = z.object({ mode: z.literal("create") });
/** Hand over an existing branch that already carries the change. */
const PrepareReuse = z.object({
  mode: z.literal("reuse"),
  branch: z.string().min(1),
  baseSha: z.string().min(1),
});
const PrepareStageFile = z.union([PrepareCreate.strict(), PrepareReuse.strict()]);
const PrepareStage = z.union([PrepareCreate, PrepareReuse]);

const RefactorAi = z.object({ mode: z.literal("ai") });
const RefactorPatch = z.object({ mode: z.literal("patch"), patchFile: z.string().min(1) });
/** Change nothing: only meaningful on top of a reused candidate branch. */
const RefactorNone = z.object({ mode: z.literal("none") });
const RefactorStageFile = z.union([RefactorAi.strict(), RefactorPatch.strict(), RefactorNone.strict()]);
const RefactorStage = z.union([RefactorAi, RefactorPatch, RefactorNone]);

export const Pipeline = z
  .object({
    version: z.literal(1),
    stages: z
      .object({
        workflows: WorkflowsStage,
        prepare: PrepareStage,
        refactor: RefactorStage,
      })
      .strict(),
  })
  .strict();

export type Pipeline = z.infer<typeof Pipeline>;

/** Written-out defaults: every stage keeps its AI implementation. */
export const DEFAULT_PIPELINE: Pipeline = {
  version: 1,
  stages: {
    workflows: { mode: "ai" },
    prepare: { mode: "create" },
    refactor: { mode: "ai" },
  },
};

const PipelineFile = z
  .object({
    version: z.literal(1).optional(),
    stages: z
      .object({
        workflows: WorkflowsStageFile.optional(),
        prepare: PrepareStageFile.optional(),
        refactor: RefactorStageFile.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface ResolvedPipeline {
  readonly pipeline: Pipeline;
  /** Files that existed and contributed, in merge order. */
  readonly sources: readonly string[];
  /** Paths that were checked but do not exist (diagnostics only). */
  readonly missing: readonly string[];
}

/** Layer paths for a repo, in merge order. */
export function pipelinePaths(repoRoot: string, homeDir = homedir()): string[] {
  return [
    join(homeDir, ".refactor", "pipeline.json"),
    join(repoRoot, ".refactor", "pipeline.json"),
  ];
}

const PIPELINE_LAYERS: LayeredConfigSpec<{ repoRoot: string; homeDir: string }, Pipeline> = {
  name: "pipeline",
  overrideNoun: "stage",
  defaults: DEFAULT_PIPELINE,
  resolve: (merged) => Pipeline.parse(merged),
  checkFile: checkPipelineFile,
  paths: ({ repoRoot, homeDir }) => pipelinePaths(repoRoot, homeDir),
  parseValue: (text) => {
    const value = Number(text);
    return Number.isFinite(value) && text.trim().length > 0 ? value : text;
  },
};

function checkPipelineFile(json: unknown): FileCheck {
  const parsed = PipelineFile.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  if (issue === undefined) return { ok: false, issue: "schema mismatch" };
  const path = issue.path.join(".");
  return { ok: false, issue: path.length > 0 ? `${path}: ${issue.message}` : issue.message };
}

/** Resolve stage sources for one run. Throws on a malformed file or override. */
export function resolvePipeline(options: {
  readonly repoRoot: string;
  readonly overrides?: LayerOverrides;
  /** Override for the user-level directory; tests point this at a temp dir. */
  readonly homeDir?: string;
}): ResolvedPipeline {
  const resolved = resolveLayeredConfig(
    PIPELINE_LAYERS,
    { repoRoot: options.repoRoot, homeDir: options.homeDir ?? homedir() },
    options.overrides,
  );
  return { pipeline: resolved.value, sources: resolved.sources, missing: resolved.missing };
}

/**
 * Translate the config into the stage functions the core takes. Omitted
 * stages stay out of the flow, which is what keeps them on the AI default.
 */
export function buildStageFlow(pipeline: Pipeline): StageFlow {
  const stages = pipeline.stages;
  const flow: {
    workflows?: WorkflowsStage;
    prepare?: PrepareStage;
    refactor?: RefactorStage;
  } = {};
  if (stages.workflows.mode === "preset") {
    flow.workflows = presetWorkflowsStage({
      builds: stages.workflows.builds,
      testEntry: stages.workflows.testEntry,
      ...(stages.workflows.entryRoot !== undefined ? { entryRoot: stages.workflows.entryRoot } : {}),
      ...(stages.workflows.workflowId !== undefined ? { workflowId: stages.workflows.workflowId } : {}),
      ...(stages.workflows.revision !== undefined ? { revision: stages.workflows.revision } : {}),
    });
  }
  if (stages.prepare.mode === "reuse") {
    flow.prepare = existingBranchPrepareStage({
      branch: stages.prepare.branch,
      baseSha: stages.prepare.baseSha,
    });
  }
  if (stages.refactor.mode === "patch") {
    flow.refactor = patchRefactorStage(stages.refactor.patchFile);
  }
  if (stages.refactor.mode === "none") {
    if (stages.prepare.mode !== "reuse") {
      throw new Error(
        "pipeline config: stages.refactor.mode 'none' needs stages.prepare.mode 'reuse' " +
          "— a fresh candidate branch would have nothing to verify",
      );
    }
    flow.refactor = fixedRefactorStage("preset: candidate branch already carries the change");
  }
  return flow;
}

/** One-line summary for logs and run records. */
export function describePipeline(pipeline: Pipeline): string {
  const { workflows, prepare, refactor } = pipeline.stages;
  const workflowsText = workflows.mode === "ai"
    ? "ai"
    : `preset(${String(workflows.builds.length)} builds: ${workflows.builds.map((b) => b.id).join(", ")})`;
  const prepareText = prepare.mode === "create" ? "create" : `reuse(${prepare.branch})`;
  const refactorText = refactor.mode === "ai"
    ? "ai"
    : refactor.mode === "patch"
      ? `patch(${refactor.patchFile})`
      : "none";
  return `workflows=${workflowsText}; prepare=${prepareText}; refactor=${refactorText}`;
}

/**
 * Pull `--pipeline-file <path>` and `--stage <key.path>=<value>` out of argv.
 * Both are repeatable; everything else is returned untouched.
 */
export function extractPipelineArgs(argv: readonly string[]): {
  readonly overrides: LayerOverrides;
  readonly remaining: readonly string[];
} {
  return extractConfigArgs(argv, { file: "--pipeline-file", value: "--stage" });
}
