import { relative, isAbsolute } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { matchGlob } from "../artifacts/scope-manifest.js";

/**
 * AgentDriver — thin wrapper over the Claude Agent SDK.
 *
 * Enforcement model (fail-closed, NOT prompt-based):
 *   - tool whitelist via allowedTools (analysis agents get no write tools)
 *   - PreToolUse hook denies any Write/Edit whose target falls outside the
 *     Modification Scope — the model cannot bypass this
 */

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface DriverRun {
  /** Final assistant text (empty on error). */
  result: string;
  isError: boolean;
  /** Tool calls denied by the scope hook — surfaced for audit trails. */
  denials: string[];
}

export interface DriverOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  /**
   * Repo-relative editable paths/globs. When set, Write/Edit outside these
   * are denied at the hook layer. Omit for read-only agents.
   */
  editableFiles?: string[];
  maxTurns?: number;
}

export async function runAgent(o: DriverOptions): Promise<DriverRun> {
  const denials: string[] = [];
  const editable = o.editableFiles;

  const hooks: Options["hooks"] =
    editable === undefined
      ? undefined
      : {
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== "PreToolUse") return { continue: true };
                  if (!WRITE_TOOLS.has(input.tool_name)) {
                    return { continue: true };
                  }
                  const ti = input.tool_input as { file_path?: string };
                  const p = ti.file_path ?? "";
                  if (!isAllowedPath(p, o.cwd, editable)) {
                    denials.push(`${input.tool_name}: ${p}`);
                    return {
                      continue: true,
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse" as const,
                        permissionDecision: "deny" as const,
                        permissionDecisionReason:
                          `outside Modification Scope (${editable.join(", ")})`,
                      },
                    };
                  }
                  return { continue: true };
                },
              ],
            },
          ],
        };

  const q = query({
    prompt: o.prompt,
    options: {
      cwd: o.cwd,
      allowedTools: o.allowedTools,
      permissionMode: "acceptEdits",
      systemPrompt: o.systemPrompt,
      maxTurns: o.maxTurns ?? 32,
      hooks,
    },
  });

  let result = "";
  let isError = true;
  for await (const msg of q) {
    if (msg.type === "result") {
      isError = msg.is_error;
      if ("result" in msg) result = msg.result;
    }
  }
  return { result, isError, denials };
}

/** Absolute or already-relative paths are resolved against the agent cwd. */
function isAllowedPath(
  filePath: string,
  root: string,
  editable: readonly string[],
): boolean {
  if (filePath.length === 0) return false;
  const abs = isAbsolute(filePath) ? filePath : `${root}/${filePath}`;
  const rel = relative(root, abs).split("\\").join("/");
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return matchGlob(rel, editable);
}

/** Extract the last fenced ```json block (or bare object) from agent text. */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidates: string[] = [];
  if (fence) candidates.push(...fence.map((f) => f.replace(/```(?:json)?|\s*```/g, "")));
  candidates.push(text.trim());
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next candidate
    }
  }
  throw new Error("no parsable JSON in agent response");
}
