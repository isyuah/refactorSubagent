/** Test-only contracts shared by the isolated SDK session, runner and judge. */
import { createHash } from "node:crypto";
import { z } from "zod";

export const ScoutOptionsSchema = z.object({
  model: z.string().trim().min(1).optional(),
  maxTurns: z.number().int().positive().max(100).default(24),
  deadlineMs: z.number().int().positive().default(300_000),
  stallMs: z.number().int().positive().default(90_000),
}).strict();
export type ScoutOptions = z.infer<typeof ScoutOptionsSchema>;

const Source = z.object({ path: z.string().min(1), sha256: z.string().length(64), content: z.string() }).strict();
export const ScoutInputSchema = z.object({
  version: z.literal(1),
  task: z.string().min(1),
  preflight: z.object({ host: z.unknown(), project: z.unknown() }).strict(),
  sources: z.array(Source).min(1),
  agent: z.object({
    prompt: z.string().min(1), tools: z.array(z.string()), skills: z.array(z.string()),
    options: ScoutOptionsSchema,
    skill: Source,
  }).strict(),
}).strict();
export type ScoutInput = z.infer<typeof ScoutInputSchema>;

export const ScoutResultSchema = z.object({
  version: z.literal(1),
  ok: z.boolean(),
  timedOut: z.boolean(),
  error: z.string().nullable(),
  elapsedMs: z.number().nonnegative(),
  submitted: z.boolean(),
  sourceIntegrity: z.enum(["unchanged", "changed", "unverified"]),
  sourceChanges: z.array(z.string()),
  // The production MCP store validates the report before accepting it.
  report: z.record(z.unknown()).nullable(),
  summary: z.string(),
}).strict();
export type ScoutResult = z.infer<typeof ScoutResultSchema>;

export const ScoutReferenceSchema = z.object({
  version: z.literal(1),
  difficulty: z.enum(["basic", "intermediate", "advanced"]),
  objective: z.string().min(1),
  acceptableApproaches: z.array(z.string().min(1)).min(1),
  pitfalls: z.array(z.string().min(1)).min(1),
  absentPaths: z.array(z.string().min(1)).default([]),
  facts: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]+$/),
    weight: z.number().int().positive(),
    critical: z.boolean(),
    requirement: z.string().min(1),
    anchors: z.array(z.object({
      path: z.string().min(1), contains: z.array(z.string().min(1)).min(1),
    }).strict()).min(1),
  }).strict()).min(1),
}).strict().superRefine((reference, ctx) => {
  const ids = reference.facts.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate fact ids" });
});
export type ScoutReference = z.infer<typeof ScoutReferenceSchema>;

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Reference anchors are checked against the exact input, including on re-scoring. */
export function validateScoutEvidence(input: ScoutInput, reference: ScoutReference): void {
  const sources = new Map(input.sources.map((source) => [source.path, source]));
  if (sources.size !== input.sources.length) throw new Error("duplicate snapshot source paths");
  for (const source of [...input.sources, input.agent.skill]) {
    if (sha256(source.content) !== source.sha256) throw new Error(`snapshot hash mismatch: ${source.path}`);
  }
  for (const path of reference.absentPaths) {
    if (sources.has(path)) throw new Error(`stale scout reference: expected missing source ${path}`);
  }
  for (const fact of reference.facts) {
    for (const anchor of fact.anchors) {
      const source = sources.get(anchor.path);
      if (source === undefined || !anchor.contains.every((text) => source.content.includes(text))) {
        throw new Error(`stale scout reference: ${fact.id} at ${anchor.path}`);
      }
    }
  }
}
