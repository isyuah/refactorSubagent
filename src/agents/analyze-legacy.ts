/**
 * analyze-legacy — the original model-backed analysis (5 schema artifacts).
 *
 * Kept only so the retired TestSpec-runner path (agent-pipeline) still
 * compiles and runs. The declared-mode workflow path uses analyze.ts
 * (host-side probing, no model round trip). Do not extend this file.
 */
import { z } from "zod";
import {
  BehaviorContract,
  DependencyManifest,
  EnvironmentSpec,
  ScopeManifest,
  TestSpec,
  type AnyArtifact,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import {
  DEFAULT_AGENT_FORBIDDEN_GLOBS,
  DEFAULT_AGENT_READABLE_GLOBS,
  runAgent,
  extractJson,
} from "./driver.js";
import { ANALYZE_SYSTEM, analyzePrompt } from "./prompts.js";

const ANALYZE_READABLE_GLOBS = [
  ...DEFAULT_AGENT_READABLE_GLOBS,
  "CMakeLists.txt",
  "cmake/**",
  "config/**",
] as const;

function analysisReadableGlobs(project?: ProjectDetection): string[] {
  const globs = new Set<string>(ANALYZE_READABLE_GLOBS);
  for (const file of project?.source_files ?? []) {
    const parts = file.split("/");
    if (parts.some((part) => ["test", "tests", "baseline", ".refactor", "node_modules"].includes(part))) continue;
    if (parts.length > 1) globs.add(`${parts.slice(0, -1).join("/")}/**`);
  }
  return [...globs];
}
const ANALYZE_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      contract: { type: "object" },
      scope: { type: "object" },
      deps: { type: "object" },
      tests: { type: "object" },
      env: { type: "object" },
    },
    required: ["contract", "scope", "deps", "tests", "env"],
    additionalProperties: false,
  },
};

/** Analyze proposals are data; the host validates them before state changes. */
const Proposal = z.object({
  contract: BehaviorContract,
  scope: ScopeManifest,
  deps: DependencyManifest,
  tests: TestSpec,
  env: EnvironmentSpec,
});

export interface AnalysisResult {
  contract: z.infer<typeof BehaviorContract>;
  scope: z.infer<typeof ScopeManifest>;
  deps: z.infer<typeof DependencyManifest>;
  tests: z.infer<typeof TestSpec>;
  env: z.infer<typeof EnvironmentSpec>;
}

export async function analyzeRepoLegacy(
  repoDir: string,
  taskContext?: string,
  host?: HostPreflight,
  project?: ProjectDetection,
): Promise<AnalysisResult> {
  let lastErrors = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      analyzePrompt(
        taskContext,
        host ? JSON.stringify(host, null, 2) : undefined,
        project ? JSON.stringify(project, null, 2) : undefined,
      ) +
      (lastErrors
        ? `\n\nYour previous JSON was REJECTED by validation:\n${lastErrors}\nFix these problems and reply again.`
        : "");

    const run = await runAgent({
      cwd: repoDir,
      prompt,
      systemPrompt: ANALYZE_SYSTEM,
      allowedTools: ["Read", "Glob", "Grep"],
      readableGlobs: analysisReadableGlobs(project),
      forbiddenGlobs: [...DEFAULT_AGENT_FORBIDDEN_GLOBS],
      outputFormat: ANALYZE_OUTPUT_FORMAT,
      maxTurns: 24,
    });

    let raw: unknown;
    try {
      raw = run.structuredOutput ?? extractJson(run.result);
    } catch {
      lastErrors = "response was not parsable as structured JSON";
      continue;
    }

    const parsed = Proposal.safeParse(raw);
    if (parsed.success) return parsed.data;

    lastErrors = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
  }

  throw new Error(`analysis failed schema validation after retry:\n${lastErrors}`);
}

export function proposalArtifacts(a: AnalysisResult): AnyArtifact[] {
  return [a.contract, a.scope, a.deps, a.tests, a.env];
}
