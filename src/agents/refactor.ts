import { runAgent } from "./driver.js";
import { REFACTOR_SYSTEM, refactorPrompt } from "./prompts.js";

/**
 * Refactor Agent — edits the candidate worktree under the Modification Scope.
 * The driver's PreToolUse hook denies out-of-scope writes; the program (not
 * the agent) commits afterwards, so the agent never touches git.
 */
export async function runRefactor(
  worktreeDir: string,
  task: string,
  editableFiles: readonly string[],
): Promise<{ summary: string; denials: string[] }> {
  const run = await runAgent({
    cwd: worktreeDir,
    prompt: refactorPrompt(task, editableFiles),
    systemPrompt: REFACTOR_SYSTEM,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    editableFiles: [...editableFiles],
    maxTurns: 40,
  });

  if (run.isError && run.result.length === 0) {
    throw new Error("refactor agent failed without a summary");
  }
  return { summary: run.result, denials: run.denials };
}
