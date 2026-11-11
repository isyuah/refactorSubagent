/**
 * feedback/types — the decision vocabulary of the feedback-repair loop.
 *
 * Three layers, deliberately separated (they were one muddy concept before):
 *   run        one CLI invocation: task, workdirs, budget, final outcome
 *   dialogue   one AI conversation (SDK session id) belonging to a role
 *   round      one execution of build/test/compare with its own evidence
 *
 * The router turns a failure into a DECISION; repair turns a decision into a
 * repaired artifact; replan turns a repair into a reuse/re-execute plan. This
 * module only defines the shapes so each piece stays independently testable.
 */

/** Which AI role a repair targets. */
export type RepairTarget = "test-writer" | "refactor" | "build-writer";

/** Why the candidate side needs the refactor dialogue again. */
export type RefactorTrigger =
  /** The candidate code failed to compile (baseline built fine). */
  | "candidate-build"
  /** The candidate program crashed/hung while baseline ran fine. */
  | "candidate-crash"
  /** Both sides ran; behaviors drifted (the REJECTED verdict). */
  | "behavior-mismatch";

/**
 * How a workflow-side failure presents — the router's key gray zone. A thrown
 * test workflow may be its own bug (script error) or a deliberate guard that
 * detected a broken program (program crash); the classification below is
 * evidence-based, and anything ambiguous must surface as needs-diagnosis.
 */
export type FailureOwner = "script" | "program" | "ambiguous";

/** The decision the router returns for one failed round. */
export type FeedbackDecision =
  | {
      kind: "repair-build";
      /** The side whose build workflow failed (baseline per routing rule 1). */
      side: "baseline" | "candidate";
      /** Structured evidence for the repair build-writer's brief. */
      evidence: RepairEvidence;
    }
  | {
      kind: "repair-refactor";
      trigger: RefactorTrigger;
      evidence: RepairEvidence;
    }
  | {
      kind: "repair-test";
      evidence: RepairEvidence;
    }
  | {
      kind: "stop";
      reason:
        | "environment"
        | "host"
        | "budget-exhausted"
        | "no-progress"
        | "cancelled"
        | "unclassifiable";
      detail: string;
    }
  | {
      /** Reserved gray-zone exit: the router cannot safely classify yet.
       *  The coordinator treats it as a conservative stop until a diagnoser
       *  exists; keeping it a distinct kind makes future reassignment local. */
      kind: "needs-diagnosis";
      detail: string;
    };

/** Evidence bundle handed to whichever repair the router picks. */
export interface RepairEvidence {
  /** Human-readable summary of what failed and where. */
  summary: string;
  /** Failure category/component from the structured attribution. */
  category?: string;
  component?: string;
  /** Which side the failure was measured on. */
  side?: "baseline" | "candidate";
  /** Declared id of the build workflow that failed (multi-build sets). */
  buildId?: string;
  /** The per-expectation behavior diffs (REJECTED rounds only). */
  mismatches?: readonly { name: string; reason: string }[];
  /** Paths the repairing dialogue should read (logs, verdict files). */
  evidencePaths?: readonly string[];
}

/** What a repair produced, and what re-execution it requires. */
export type RepairOutcome =
  | {
      kind: "build-repaired";
      /** Rebuild both sides' affected builds, then re-run affected tests. */
    }
  | {
      kind: "test-repaired";
      /** Build inputs unchanged: reuse both sides' artifacts, re-run both
       *  tests with the SAME (new) exam version, then compare. */
    }
  | {
      kind: "test-repaired-needs-build";
      /** The test repair touched compiled inputs (harness/mock): rebuild the
       *  affected sides' artifacts first, then re-run both tests. */
    }
  | {
      kind: "refactor-repaired";
      /** Candidate source changed: rebuild candidate artifacts, re-run the
       *  candidate test; baseline stays reusable while its facts verify. */
    }
  | {
      kind: "repair-failed";
      detail: string;
    };

/** One recorded round of the loop (state sidecar payload). */
export interface FeedbackRoundRecord {
  /** 1-based round number; round 1 is the initial execution (not budgeted). */
  readonly round: number;
  /** REAL session id that owned this round's verdict. */
  readonly sessionId: string;
  readonly outcome: "ACCEPTED" | "REJECTED" | "ABORTED";
  /** Decision the router made (null when the round succeeded). */
  readonly decision: FeedbackDecision["kind"] | null;
  /** Repair lane attempted this round (null for the initial round). */
  readonly repair: string | null;
  /** Whether this round consumed one feedback budget unit. */
  readonly budgeted: boolean;
  /** Identity of what the round produced (no-progress audit). */
  readonly artifactHash: string | null;
  readonly failureSignature: string | null;
}

/** Dialogue handles the loop keeps alive across rounds. */
export interface DialogueHandles {
  /** SDK conversation id of the test-writer session (authoring dialogue). */
  testWriter?: string;
  /** SDK conversation id of the refactor session (candidate dialogue). */
  refactor?: string;
}

/**
 * feedback-state.json — the run-level sidecar (sibling of
 * stage-checkpoints.json). Terminal verdicts stay immutable; this file only
 * coordinates the loop ABOVE them: how much budget is spent, which
 * conversations continue, what each round recorded.
 */
export interface FeedbackState {
  readonly kind: "feedback-state";
  readonly version: 1;
  /** Configured feedback budget (total attempts; 0 disables the loop). */
  readonly budgetTotal: number;
  /** Attempts already consumed (success or failure both count). */
  budgetUsed: number;
  readonly dialogues: DialogueHandles;
  rounds: FeedbackRoundRecord[];
}
