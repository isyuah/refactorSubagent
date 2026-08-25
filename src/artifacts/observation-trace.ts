import { z } from "zod";
import { B64, RelPath, Sha256Hex } from "./common.js";

export const FsEffect = z.object({
  path: RelPath,
  op: z.enum(["create", "modify", "delete"]),
  /** sha256 of content after the op; null for delete. */
  sha256: Sha256Hex.nullable(),
});
export type FsEffect = z.infer<typeof FsEffect>;

/** One executed test case against one build. */
export const CaseObservation = z.object({
  case_id: z.string().min(1),
  status: z.enum(["observed", "fail", "error"]),
  exit_code: z.number().int(),
  /** Signal name on abnormal termination (POSIX shims; null otherwise). */
  signal: z.string().nullable().default(null),
  stdout_b64: B64,
  stderr_b64: B64,
  filesystem: z.array(FsEffect).default([]),
  duration_ms: z.number().nonnegative(),
});

/**
 * Failure Classification — fail-closed requires every non-observed baseline
 * case to carry an explicit, explainable classification.
 */
export const FailureClassification = z.object({
  category: z.enum([
    "environment", // infra problem unrelated to scope (missing lib, …)
    "preexisting_behavior", // old code genuinely fails this case
    "scope_related", // touches the modification scope → must block
    "unknown",
  ]),
  related_to_scope: z.boolean(),
  explanation: z.string().min(1),
});

export const ObservationTrace = z
  .object({
    kind: z.literal("observation-trace"),
    version: z.literal(1),

    build: z.enum(["baseline", "candidate"]),
    env_id: z.string().min(1),

    observations: z.array(CaseObservation).min(1),
    /** Required for every case whose status !== 'observed'. */
    failures: z
      .array(
        FailureClassification.extend({ case_id: z.string().min(1) }),
      )
      .default([]),
  })
  .refine(
    (t) =>
      t.observations
        .filter((o) => o.status !== "observed")
        .every((o) => t.failures.some((f) => f.case_id === o.case_id)),
    {
      message:
        "fail-closed: every failing/erroring case needs a failure classification",
    },
  );

export type ObservationTrace = z.infer<typeof ObservationTrace>;
