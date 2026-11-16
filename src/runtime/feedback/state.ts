import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  DialogueHandles,
  FeedbackRoundRecord,
  FeedbackState,
} from "./types.js";

/**
 * feedback/state — durable run-level coordination state.
 *
 * `feedback-state.json` lives in `.refactor/feedback/<root-session>/`:
 * terminal verdicts stay immutable per the state machine; this sidecar only
 * coordinates the loop ABOVE them. Resuming the same run keeps the budget
 * already spent; the configured total stays the total.
 */

const FILE_NAME = "feedback-state.json";

export function feedbackStatePath(logDir: string): string {
  return join(logDir, FILE_NAME);
}

export function loadFeedbackState(logDir: string): FeedbackState | null {
  const path = feedbackStatePath(logDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FeedbackState;
    if (parsed.kind !== "feedback-state" || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveFeedbackState(logDir: string, state: FeedbackState): void {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(feedbackStatePath(logDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function freshFeedbackState(budgetTotal: number): FeedbackState {
  return {
    kind: "feedback-state",
    version: 1,
    budgetTotal,
    budgetUsed: 0,
    dialogues: {},
    rounds: [],
  };
}

/** Record a dialogue handle (the SDK conversation id a role continues). */
export function rememberDialogue(
  state: FeedbackState,
  role: keyof DialogueHandles,
  sessionId: string,
): FeedbackState {
  return { ...state, dialogues: { ...state.dialogues, [role]: sessionId } };
}

/** Append a round record immutably (history is never rewritten). */
export function recordRound(
  state: FeedbackState,
  round: FeedbackRoundRecord,
): FeedbackState {
  return { ...state, rounds: [...state.rounds, round] };
}

/** Consume one budget unit. Returns the updated state, or null when the
 *  budget is already exhausted (the caller must not start a repair). */
export function consumeBudget(state: FeedbackState): FeedbackState | null {
  if (state.budgetUsed >= state.budgetTotal) return null;
  return { ...state, budgetUsed: state.budgetUsed + 1 };
}

/** Remaining attempts (0 when disabled or exhausted). */
export function budgetRemaining(state: FeedbackState): number {
  return Math.max(0, state.budgetTotal - state.budgetUsed);
}

/**
 * No-progress detection for the early stop: the LAST TWO budgeted rounds
 * produced byte-identical repair artifacts AND the same failure signature.
 * Comparing artifact identity (not failure names alone) lets honest
 * "changed something but still wrong" repairs keep going.
 */
export function detectNoProgress(
  state: FeedbackState,
  lastTwoArtifactHashes: readonly [string | null, string | null],
  lastTwoFailureSignatures: readonly [string | null, string | null],
): boolean {
  const [older, newer] = lastTwoArtifactHashes;
  const [olderFail, newerFail] = lastTwoFailureSignatures;
  if (older === null || newer === null) return false;
  if (olderFail === null || newerFail === null) return false;
  return older === newer && olderFail === newerFail;
}

const FeedbackOwner = z.object({ rootSessionId: z.string().min(1) });

/** Each round points to its run-level state; never infer ownership from an id suffix. */
export function loadFeedbackOwner(sessionRoot: string, sessionId: string): string {
  const path = join(sessionRoot, ".refactor", "e2e", sessionId, "feedback-run.json");
  if (!existsSync(path)) return sessionId;
  return FeedbackOwner.parse(JSON.parse(readFileSync(path, "utf8"))).rootSessionId;
}

export function saveFeedbackOwner(sessionRoot: string, sessionId: string, rootSessionId: string): void {
  const dir = join(sessionRoot, ".refactor", "e2e", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "feedback-run.json"), `${JSON.stringify({ rootSessionId })}\n`, "utf8");
}
