import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../runtime/log.js";
import { runAgent } from "./driver.js";
import { REFACTOR_SYSTEM, refactorPrompt } from "./prompts.js";
import { DEFAULT_LIMITS, type SessionLimits } from "../config/limits.js";

/**
 * Refactor Agent — edits the candidate worktree. The refactor is deliberately
 * unbounded (no modification-scope manifest): the agent decides what to
 * change, and the behavior-preservation gate (identical workflows on baseline
 * vs candidate) is what keeps the change honest. The candidate runs in a
 * disposable worktree, so even a destructive edit cannot damage the repo.
 */
export async function runRefactor(
  worktreeDir: string,
  task: string,
  sessionHooks?: {
    readonly limits?: SessionLimits;
    readonly logger?: Logger;
    readonly sessionStore?: SessionStore;
  },
): Promise<{ summary: string }> {
  const limits = sessionHooks?.limits ?? DEFAULT_LIMITS.sessions.refactor;
  const run = await runAgent({
    cwd: worktreeDir,
    prompt: refactorPrompt(task),
    systemPrompt: REFACTOR_SYSTEM,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    maxTurns: limits.maxTurns,
    timeoutMs: limits.deadlineMs ?? undefined,
    stallTimeoutMs: limits.stallMs,
    logger: sessionHooks?.logger,
    sessionStore: sessionHooks?.sessionStore,
  });

  if (run.isError && run.result.length === 0) {
    throw new Error("refactor agent failed without a summary");
  }
  return { summary: run.result };
}
