import { z } from "zod";

/**
 * Self-driven TestWorkflow execution artifacts.
 *
 * A self-driven test workflow runs once per worktree and declares
 * expectations via ctx.expect. The host records the declarations observed on
 * each side, then compares them by position using the declared relations.
 * These artifacts carry the baseline evidence, candidate evidence, and the
 * program-owned comparison — mirroring the CTest suite artifacts for the
 * declarative runner.
 */

/** One expectation declaration observed on a side. */
export const ExpectationObserved = z.object({
  name: z.string().min(1),
  relation: z.enum([
    "equal",
    "not-equal",
    "baseline-greater",
    "baseline-less",
    "both-matches",
  ]),
  /** Value observed on this side (JSON-serializable). */
  value: z.unknown(),
  /** Regex source for both-matches relations. */
  pattern: z.string().optional(),
});

/** Baseline evidence: the workflow passed and declared these expectations. */
export const ExpectationBaseline = z.object({
  kind: z.literal("expectation-baseline"),
  version: z.literal(1),
  workflow_passed: z.literal(true),
  expectations: z.array(ExpectationObserved).default([]),
  notes: z.array(z.string().min(1)).default([]),
});

/** Candidate evidence: same shape as baseline. */
export const ExpectationCandidate = z.object({
  kind: z.literal("expectation-candidate"),
  version: z.literal(1),
  workflow_passed: z.literal(true),
  expectations: z.array(ExpectationObserved).default([]),
  notes: z.array(z.string().min(1)).default([]),
});

/** Program-owned comparison of the two sides' expectations. */
export const ExpectationComparisonResult = z.object({
  kind: z.literal("expectation-comparison-result"),
  version: z.literal(1),
  overall: z.enum(["consistent", "inconsistent"]),
  /** Per-declaration verdicts, in declaration order. */
  declarations: z.array(
    z.object({
      name: z.string().min(1),
      relation: z.enum([
        "equal",
        "not-equal",
        "baseline-greater",
        "baseline-less",
        "both-matches",
      ]),
      matched: z.boolean(),
      reason: z.string().default(""),
    }),
  ).default([]),
  /** Structural errors (count mismatch, name mismatch, …). */
  errors: z.array(z.string().min(1)).default([]),
  reason: z.string().min(1),
});

export type ExpectationObserved = z.infer<typeof ExpectationObserved>;
export type ExpectationBaseline = z.infer<typeof ExpectationBaseline>;
export type ExpectationCandidate = z.infer<typeof ExpectationCandidate>;
export type ExpectationComparisonResult = z.infer<typeof ExpectationComparisonResult>;
