import { join } from "node:path";
import type { ScopeManifest } from "../artifacts/index.js";
import { DEFAULT_AGENT_FORBIDDEN_GLOBS, runAgent } from "./driver.js";
import { REFACTOR_SYSTEM, refactorPrompt } from "./prompts.js";

/**
 * Refactor Agent — edits the candidate worktree under the validated
 * Modification and Observation Scopes. The program, not the prompt, enforces
 * both scopes before every SDK tool call.
 */
export async function runRefactor(
  worktreeDir: string,
  task: string,
  scope: ScopeManifest,
): Promise<{ summary: string; denials: string[] }> {
  const editableFiles = scope.editable_files.map((target) => target.file);
  const absoluteEditableFiles = editableFiles.map((file) => join(worktreeDir, file));
  const run = await runAgent({
    cwd: worktreeDir,
    prompt: refactorPrompt(task, absoluteEditableFiles),
    systemPrompt: REFACTOR_SYSTEM,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    readableGlobs: [...scope.readable_globs],
    forbiddenGlobs: [...new Set([...DEFAULT_AGENT_FORBIDDEN_GLOBS, ...scope.forbidden_globs])],
    editableFiles,
    maxTurns: 40,
  });

  if (run.isError && run.result.length === 0) {
    throw new Error("refactor agent failed without a summary");
  }
  return { summary: run.result, denials: run.denials };
}
