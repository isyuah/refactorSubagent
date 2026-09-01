import { selectWorkflow, type WorkflowSelection, type WorkflowSelectionCandidate } from "../agents/workflow-selection.js";

/**
 * Workflow source decision point. The orchestrator asks a chooser which
 * candidate (if any) to use, or whether to generate a fresh workflow.
 *
 * Core code never calls Claude directly: the concrete chooser is injected by
 * the application layer. This keeps reuse/selection logic testable without a
 * model and lets callers swap the decision policy (Claude, deterministic
 * first-valid, external input, ...) without touching the orchestration.
 */
export interface WorkflowChooser {
  choose(options: {
    readonly repoDir: string;
    readonly workflowKind: "build" | "test";
    readonly candidates: readonly WorkflowSelectionCandidate[];
    readonly taskContext?: string;
  }): Promise<WorkflowSelection>;
}

/** Production chooser backed by the Claude WorkflowSelection agent. */
export class ClaudeWorkflowChooser implements WorkflowChooser {
  choose(options: {
    readonly repoDir: string;
    readonly workflowKind: "build" | "test";
    readonly candidates: readonly WorkflowSelectionCandidate[];
    readonly taskContext?: string;
  }): Promise<WorkflowSelection> {
    return selectWorkflow(options);
  }
}

/**
 * Deterministic chooser for CI, tests, or model-free environments.
 *
 * Picks the first usable candidate (valid or draft, no reasons); generates
 * when no candidate is usable. Preferring the earliest revision keeps
 * behavior stable across runs.
 */
export class DeterministicWorkflowChooser implements WorkflowChooser {
  async choose(options: {
    readonly repoDir: string;
    readonly workflowKind: "build" | "test";
    readonly candidates: readonly WorkflowSelectionCandidate[];
    readonly taskContext?: string;
  }): Promise<WorkflowSelection> {
    const usable = options.candidates.findIndex((candidate) =>
      (candidate.status === "valid" || candidate.status === "draft") &&
      candidate.reasons.length === 0,
    );
    if (usable === -1) {
      return { decision: "generate", candidate_index: null, reason: "no usable candidate was available" };
    }
    return {
      decision: "use",
      candidate_index: usable,
      reason: `deterministic chooser selected first usable candidate ${usable}`,
    };
  }
}

/** Chooser that always generates a fresh workflow (useful for regeneration). */
export class AlwaysGenerateChooser implements WorkflowChooser {
  async choose(options: {
    readonly repoDir: string;
    readonly workflowKind: "build" | "test";
    readonly candidates: readonly WorkflowSelectionCandidate[];
    readonly taskContext?: string;
  }): Promise<WorkflowSelection> {
    return { decision: "generate", candidate_index: null, reason: "chooser policy always generates" };
  }
}
