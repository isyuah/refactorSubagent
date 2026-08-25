import { z } from "zod";

export const ChannelVerdict = z.enum([
  "match",
  "mismatch",
  "not_compared", // mode: ignore or case skipped upstream
]);

const PerCase = z.object({
  case_id: z.string().min(1),
  verdict: z.enum(["match", "mismatch", "skipped_baseline_failure"]),
  channels: z.record(ChannelVerdict).default({}),
  detail: z.string().default(""),
});

/**
 * Comparison Result — verdict of differential running, per channel per case,
 * under the policy defined by the Behavior Contract.
 */
export const ComparisonResult = z
  .object({
    kind: z.literal("comparison-result"),
    version: z.literal(1),

    baseline_env_id: z.string().min(1),
    candidate_env_id: z.string().min(1),

    per_case: z.array(PerCase).min(1),
  })
  .transform((r) => ({
    ...r,
    overall: r.per_case.every((c) => c.verdict !== "mismatch")
      ? ("consistent" as const)
      : ("inconsistent" as const),
  }));

export type ComparisonResult = z.infer<typeof ComparisonResult>;

/** Input shape (before `overall` is derived by .transform). */
export type ComparisonResultInput = z.input<typeof ComparisonResult>;
