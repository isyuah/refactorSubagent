import { z } from "zod";

/**
 * FailureReport — structured attribution for an aborted run.
 *
 * Historically every abort carried a single reason string (the ABORTED
 * transition note). That is enough to answer "what happened" once, but not
 * "what kind of thing happened": retry decisions, resume planning and
 * cross-run statistics all had to parse prose. This record is persisted
 * alongside the transition note as `artifacts/failure-report.json` (a host
 * sidecar, NOT a state-machine artifact — see store.saveFailureReport), so
 * tooling reads typed fields instead of substring-matching messages.
 *
 * The reason string stays authoritative for the run journal; this record is
 * the typed index over it. Fail-closed still applies: an abort without a
 * report is attributed as { category: "internal", retryable: false }.
 */

/** Pipeline stage that owned the failure (mirrors runtime/stage-flow order). */
export const FailureStage = z.enum([
  "preflight",
  "analyze",
  "workflows",
  "prepare",
  "refactor",
  "verify",
]);
export type FailureStage = z.infer<typeof FailureStage>;

/**
 * Closed failure taxonomy. Categories are host judgements, not model claims:
 *   environment    — host/toolchain probe or platform problem (retry may help)
 *   project        — the repo's build system could not be detected/usably shaped
 *   model-session  — an AI session failed as a session (timeout, stall, no output)
 *   policy         — workflow source rejected by the source policy, repairs exhausted
 *   resolution     — a declared/resolved input is missing or unusable (no file,
 *                    no declareDependency, unknown build id)
 *   build          — a declared BuildWorkflow execution failed
 *   test           — the TestWorkflow execution failed on a side
 *   gate           — a host-owned gate tripped (no changes, empty build set)
 *   state-machine  — artifact rejected or transition refused by the orchestrator
 *   internal       — unexpected host error (bug or infrastructure); never retryable
 */
export const FailureCategory = z.enum([
  "environment",
  "project",
  "model-session",
  "policy",
  "resolution",
  "build",
  "test",
  "gate",
  "state-machine",
  "internal",
]);
export type FailureCategory = z.infer<typeof FailureCategory>;

export const FailureReport = z.object({
  kind: z.literal("failure-report"),
  version: z.literal(1),
  /** Stage that owned the failure. */
  stage: FailureStage,
  category: FailureCategory,
  /** Host component that produced it ("test-writer-session", "build-workflow:baseline", ...). */
  component: z.string().min(1),
  /** Same text as the ABORTED transition note (the old single reason string). */
  reason: z.string().min(1),
  /** True when re-running the failed stage could plausibly succeed (timeout, flaky env). */
  retryable: z.boolean(),
  /** Category-specific fields: violation rule/line, build id, workflow status, ... */
  detail: z.record(z.unknown()).default({}),
  /** ISO timestamp of the attribution. */
  at: z.string(),
});
export type FailureReport = z.infer<typeof FailureReport>;
