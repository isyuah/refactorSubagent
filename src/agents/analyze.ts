import { z } from "zod";
import {
  BehaviorContract,
  DependencyManifest,
  EnvironmentSpec,
  ScopeManifest,
  TestSpec,
  type AnyArtifact,
  type HostPreflight,
} from "../artifacts/index.js";
import { runAgent, extractJson } from "./driver.js";
import { ANALYZE_SYSTEM, analyzePrompt } from "./prompts.js";

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

/**
 * Analyze Agent — proposes the verification artifacts from repo inspection.
 * Proposals are DATA; the orchestrator re-validates every one against its
 * zod schema and retries once with the schema errors attached.
 */

const Proposal = z.object({
  contract: BehaviorContract,
  scope: ScopeManifest,
  deps: DependencyManifest,
  tests: TestSpec,
  env: EnvironmentSpec.omit({ kind: true, version: true }).extend({
    kind: z.literal("environment-spec").default("environment-spec"),
    version: z.literal(1).default(1),
  }),
});

export interface AnalysisResult {
  contract: z.infer<typeof BehaviorContract>;
  scope: z.infer<typeof ScopeManifest>;
  deps: z.infer<typeof DependencyManifest>;
  tests: z.infer<typeof TestSpec>;
  env: z.infer<typeof EnvironmentSpec>;
}

export async function analyzeRepo(
  repoDir: string,
  taskContext?: string,
  host?: HostPreflight,
): Promise<AnalysisResult> {
  let lastErrors = "";
  for (let attempt = 0; attempt < 2; attempt++) {

    const prompt =
      analyzePrompt(
        taskContext,
        host ? JSON.stringify(host, null, 2) : undefined,
      ) +
      (lastErrors
        ? `\n\nYour previous JSON was REJECTED by validation:\n${lastErrors}\nFix these problems and reply again.`
        : "");

    const run = await runAgent({
      cwd: repoDir,
      prompt,
      systemPrompt: ANALYZE_SYSTEM,
      // Read-only toolset: analysis cannot mutate anything.
      allowedTools: ["Read", "Glob", "Grep"],
      outputFormat: ANALYZE_OUTPUT_FORMAT,
      maxTurns: 24,
    });

    let raw: unknown;
    try {
      raw = run.structuredOutput ?? extractJson(run.result);
    } catch {
      lastErrors = `response was not parsable as structured JSON`;
      continue;
    }


    const parsed = Proposal.safeParse(raw);
    if (parsed.success) return parsed.data;

    lastErrors = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
  }

  throw new Error(`analysis failed schema validation after retry:\n${lastErrors}`);
}

export function proposalArtifacts(a: AnalysisResult): AnyArtifact[] {
  return [a.contract, a.scope, a.deps, a.tests, a.env];
}
