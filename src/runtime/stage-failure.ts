import type { FailureCategory } from "../artifacts/failure-report.js";

/**
 * stage-failure — the error type that carries structured attribution.
 *
 * Historically the subagent layers reported failures as single reason strings
 * ("test-writer session timed out", "refactor agent failed without a summary")
 * that stage-flow re-threw verbatim. Classification then had to substring-match
 * prose. StageFailureError lets a failure site state, next to the message:
 *
 *   - which host category it belongs to (see FailureCategory),
 *   - which component produced it,
 *   - whether retrying the stage could plausibly succeed,
 *   - category-specific structured detail (violation rule/line, build id, ...).
 *
 * stage-flow catches it in its run-level handler and persists those fields as
 * the session's failure-report.json. Plain Errors keep working: they fall back
 * to { category: "internal", component: "stage-flow", retryable: false }.
 *
 * Lives outside stage-flow.ts because the agents layer (workflow-session,
 * refactor) throws it and must not import the pipeline module back.
 */

/** Structured attribution carried by a stage failure. */
export interface StageFailureInfo {
  readonly category: FailureCategory;
  /** Host component that produced the failure ("test-writer-session", ...). */
  readonly component: string;
  /** True when re-running the failed stage could plausibly succeed. */
  readonly retryable?: boolean;
  /** Category-specific fields (violation rule/line, build id, session detail). */
  readonly detail?: Record<string, unknown>;
}

export class StageFailureError extends Error {
  readonly info: StageFailureInfo;

  constructor(message: string, info: StageFailureInfo) {
    super(message);
    this.name = "StageFailureError";
    this.info = info;
  }
}

/** Convenience constructor. */
export function stageFailure(message: string, info: StageFailureInfo): StageFailureError {
  return new StageFailureError(message, info);
}
