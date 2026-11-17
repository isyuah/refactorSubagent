import type { Limits } from "../config/limits.js";
import { z } from "zod";
import { HostPreflight, CTestSuiteResult } from "../artifacts/index.js";
import { VerificationAnalysisInput } from "../agents/verification-analysis.js";

export const ReviewDocument = z.object({
  version: z.literal(1),
  scenarios: z.array(z.object({
    id: z.string().min(1), title: z.string().min(1), purpose: z.string().min(1),
    inputs: z.array(z.string()).min(1), observations: z.array(z.string()).min(1),
    sourceReferences: z.array(z.string()).min(1),
  }).strict()).min(1),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.scenarios.map(s => s.id)).size !== value.scenarios.length)
    ctx.addIssue({ code: "custom", path: ["scenarios"], message: "scenario ids must be unique" });
});
export type ReviewDocument = z.infer<typeof ReviewDocument>;

export const TrialResult = z.object({
  status: z.enum(["not-run", "pass", "failed"]), duration_ms: z.number().nonnegative(),
  builds: z.array(z.object({ id: z.string(), status: z.enum(["not-run", "pass", "failed"]),
    duration_ms: z.number().nonnegative(), failure: z.string().nullable(), evidence_path: z.string().nullable() })),
  observations: z.array(z.object({ name: z.string(), relation: z.enum(["equal", "not-equal", "baseline-greater", "baseline-less", "both-matches"]),
    value: z.unknown(), pattern: z.string().optional() })),
  ctest: CTestSuiteResult.nullable(),
  failure: z.object({ category: z.enum(["build", "test", "resolution", "model-session", "internal"]),
    reason: z.string(), build_id: z.string().optional() }).nullable(),
  evidence_dir: z.string().nullable(),
});
export type TrialResult = z.infer<typeof TrialResult>;
export const emptyTrial = (): TrialResult => ({ status: "not-run", duration_ms: 0, builds: [], observations: [], ctest: null, failure: null, evidence_dir: null });

export const LocalDialogue = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), root: z.string().min(1) });
export type LocalDialogue = z.infer<typeof LocalDialogue>;
export const PlanMetadata = z.object({
  scope: z.string().trim().min(1), delivery: z.enum(["draft", "complete"]), base_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
  analysis: VerificationAnalysisInput.nullable(), review: ReviewDocument.nullable(),
  host: HostPreflight, trial: TrialResult,
});
export type PlanMetadata = z.infer<typeof PlanMetadata>;
export interface PlanBuild { id: string; workflowId: string; revision: number; source: string; materials: string | null; description: string }
export interface PlanContent { metadata: PlanMetadata; test: { source: string; workflowId: string; revision: number } | null; builds: PlanBuild[] }
export interface PreparationView {
  session: string; repo: string; status: "idle" | "authoring" | "running" | "review" | "closed";
  revision: number; trialOrigin: "saved" | "current"; limits: Limits; content: PlanContent; history: readonly TrialResult[];
  saved: string | null; files: readonly { path: string; content: string | null; previous: string | null }[];
}
