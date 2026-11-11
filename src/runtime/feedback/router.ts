/**
 * feedback/router — turn a failed round into a repair decision.
 *
 * Routing table (six rules, matched against the structured attribution the
 * host already measures — never against prose guessing):
 *
 *   1. baseline build failed  → repair-build (build-writer) — unless the
 *      failure smells like the environment (missing tool/permission), then
 *      stop for the human.
 *   2. candidate build failed (baseline passed) → repair-refactor.
 *   3. test workflow failed as a SCRIPT error → repair-test (test-writer).
 *   4. test workflow failed because the PROGRAM crashed on that side →
 *      repair-refactor.
 *   5. REJECTED (behavior mismatch) → repair-refactor only, with the diff
 *      list. Never build or test repair.
 *   6. host/cancel/unclassifiable → stop, keep the evidence.
 *
 * Gray zones fail closed: when the evidence cannot distinguish script from
 * program (or workflow from environment), the router returns
 * needs-diagnosis, which the coordinator treats as a conservative stop.
 */
import type {
  FeedbackDecision,
  FailureOwner,
  RepairEvidence,
} from "./types.js";

/** The structured inputs the router reads (all host-measured facts). */
export interface RouterInput {
  /** Terminal state of the round ("ACCEPTED" | "REJECTED" | "ABORTED"). */
  readonly state: string;
  /** Structured attribution of an abort (null when the round was a verdict). */
  readonly failure: {
    readonly stage: string;
    readonly category: string;
    readonly component: string;
    readonly retryable: boolean;
    readonly reason: string;
    readonly detail: Record<string, unknown>;
  } | null;
  /** Side the attribution points at, when the component encodes one. */
  readonly side: "baseline" | "candidate" | null;
  /** Declared id of the failed build workflow, from the attribution detail. */
  readonly buildId: string | null;
  /** Behavior diffs of a REJECTED round (empty when none/absent). */
  readonly mismatches: readonly { name: string; reason: string }[];
  /** Owner classification of a test-side failure (script vs program). */
  readonly failureOwner: FailureOwner | null;
  /** Log/evidence paths worth handing to the repairing dialogue. */
  readonly evidencePaths: readonly string[];
}

/**
 * Classify a test-workflow failure by its evidence: did the script itself
 * error, or did the program under test crash? Nonzero exits are legal
 * behavior the exam records — they are NOT script errors by themselves.
 * Returns "ambiguous" when the evidence does not decide (the conservative
 * exit).
 */
export function classifyFailureOwner(reason: string): FailureOwner {
  const text = reason.toLowerCase();
  // Program-shaped failures: the workflow deliberately threw after observing
  // a crash/timeout of the program under test (guards exams use on purpose).
  const programMarkers = [
    "assert failure",
    "exit code 3",
    "exit code 7",
    "nonzero exit",
    "process crashed",
    "spawn_error",
    "did not run or read any implementation artifact",
  ];
  // Script-shaped failures: JS/machinery errors inside the workflow itself.
  // The zod issue codes cover declaration-validation failures the host emits
  // when a workflow produced malformed expectations — definitionally a
  // script error (observed live: an exam passed observed values into the
  // relation slot and the parse rejected hundreds of declarations).
  const scriptMarkers = [
    "typeerror",
    "referenceerror",
    "syntaxerror",
    "cannot find module",
    "is not a function",
    "undefined is not",
    "enoent", // script read a path that does not exist
    "invalid_enum_value", // zod: a declaration field got a wrong-typed value
    "invalid_type", // zod: same, different code
  ];
  const program = programMarkers.some((marker) => text.includes(marker));
  const script = scriptMarkers.some((marker) => text.includes(marker));
  if (program && !script) return "program";
  if (script && !program) return "script";
  return "ambiguous";
}

/**
 * Environment-shaped build failure? The repair build-writer cannot fix a
 * missing toolchain; detecting this up front saves a wasted budget unit.
 * Heuristic by design — the conservative default is "not environment"
 * (so a repair is attempted) only when the evidence clearly says otherwise…
 * which is why the marker list errs toward specificity.
 */
export function isEnvironmentFailure(reason: string): boolean {
  const text = reason.toLowerCase();
  const markers = [
    "is not recognized as an internal or external command", // Windows missing tool
    "command not found",
    "no such file or directory",
    "permission denied",
    "access is denied",
    "the system cannot find the file specified",
    "no compiler",
    "tool not found",
  ];
  return markers.some((marker) => text.includes(marker));
}

/** Decide what the loop does with a failed round. */
export function routeFailure(input: RouterInput): FeedbackDecision {
  const evidenceBase: RepairEvidence = {
    summary: input.failure?.reason ?? input.state,
    ...(input.failure !== null
      ? { category: input.failure.category, component: input.failure.component }
      : {}),
    ...(input.side !== null ? { side: input.side } : {}),
    ...(input.buildId !== null ? { buildId: input.buildId } : {}),
    ...(input.mismatches.length > 0 ? { mismatches: input.mismatches } : {}),
    ...(input.evidencePaths.length > 0 ? { evidencePaths: input.evidencePaths } : {}),
  };

  // Rule 5: a verdict, not an execution failure. Only the refactor dialogue
  // hears about it — the exam and the builds are not negotiable here.
  if (input.state === "REJECTED") {
    return {
      kind: "repair-refactor",
      trigger: "behavior-mismatch",
      evidence: evidenceBase,
    };
  }

  if (input.state !== "ABORTED" || input.failure === null) {
    return {
      kind: "stop",
      reason: "unclassifiable",
      detail: `round ended in state ${input.state} without structured attribution`,
    };
  }

  const { category, reason, stage } = input.failure;

  // Rule 6: host failures and cancellations never auto-repair.
  if (category === "internal" || category === "state-machine") {
    return { kind: "stop", reason: "host", detail: reason };
  }

  // Rule 1: baseline build failure → build-writer repair, unless the
  // environment is the visible culprit.
  if (category === "build" && input.side === "baseline") {
    if (isEnvironmentFailure(reason)) {
      return {
        kind: "stop",
        reason: "environment",
        detail: `baseline build failed on the environment: ${reason}`,
      };
    }
    return { kind: "repair-build", side: "baseline", evidence: evidenceBase };
  }

  // Rule 2: candidate build failure with the baseline passed → the refactor
  // dialogue owns the code that does not compile.
  if (category === "build" && input.side === "candidate") {
    return {
      kind: "repair-refactor",
      trigger: "candidate-build",
      evidence: evidenceBase,
    };
  }

  // Rules 3/4: test-side failures split by WHO failed. Nonzero exits the
  // exam deliberately recorded never reach here (those are mismatches).
  if (category === "test") {
    const owner = input.failureOwner ?? classifyFailureOwner(reason);
    const side = input.side ?? "baseline";
    if (owner === "script") {
      return { kind: "repair-test", evidence: evidenceBase };
    }
    if (owner === "program" && side === "candidate") {
      return {
        kind: "repair-refactor",
        trigger: "candidate-crash",
        evidence: evidenceBase,
      };
    }
    if (owner === "ambiguous") {
      return {
        kind: "needs-diagnosis",
        detail: `cannot tell script error from program failure: ${reason}`,
      };
    }
    // program-shaped failure on the BASELINE side: the exam guards fired on
    // untouched code — the exam's own assumptions are suspect. Stop for the
    // human rather than let the exam reshape itself under failure pressure.
    return {
      kind: "stop",
      reason: "unclassifiable",
      detail: `test guard fired on the baseline side: ${reason}`,
    };
  }

  // Environment category (preflight probes) and everything else: stop.
  return {
    kind: "stop",
    reason: category === "environment" ? "environment" : "unclassifiable",
    detail: reason,
  };
}
