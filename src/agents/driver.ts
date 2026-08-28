import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { matchGlob } from "../artifacts/scope-manifest.js";

const moduleRequire = createRequire(import.meta.url);

/**
 * AgentDriver — thin wrapper over the Claude Agent SDK.
 *
 * Enforcement model (fail-closed, NOT prompt-based):
 *   - tools + allowedTools define the model's available and auto-allowed tools;
 *   - PreToolUse hook validates every read/search/write path;
 *   - denied operations are surfaced in the run result for audit and gating.
 */

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Conservative source/configuration view used before a manifest exists. */
export const DEFAULT_AGENT_READABLE_GLOBS = [
  "CMakeLists.txt",
  "cmake/**",
  "config/**",
  "include/**",
  "src/**",
  "*.c",
  "*.h",
] as const;

/** Trees that model-facing agents must never inspect by default. */
export const DEFAULT_AGENT_FORBIDDEN_GLOBS = [
  "test/**",
  "tests/**",
  "baseline/**",
  ".refactor/**",
  "node_modules/**",
] as const;

export interface DriverRun {
  /** Final assistant text (empty on error). */
  result: string;
  /** Native SDK structured output, when outputFormat was requested. */
  structuredOutput?: unknown;
  isError: boolean;
  /** True when the host deadline closed the SDK query. */
  timedOut: boolean;
  /** Tool calls denied by the scope hook — surfaced for audit trails. */
  denials: string[];
}

export interface DriverOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  /** Repo-relative globs the agent may read/search. Empty means deny all scoped tools. */
  readableGlobs?: string[];
  /** Repo-relative hard denials checked before readableGlobs. */
  forbiddenGlobs?: string[];
  /** Repo-relative files/globs the agent may rewrite. */
  editableFiles?: string[];
  maxTurns?: number;
  /** Host deadline for the SDK query. Omitted means no deadline. */
  timeoutMs?: number;
  /** Override Claude Code executable; defaults to the bundled SDK binary on Windows. */
  executable?: string;
  outputFormat?: Options["outputFormat"];
}

export interface ScopeCheck {
  readonly allowed: boolean;
  readonly reason: string | null;
}

export async function runAgent(o: DriverOptions): Promise<DriverRun> {
  const denials: string[] = [];
  const readable = o.readableGlobs ?? [];
  const forbidden = o.forbiddenGlobs ?? [];
  const editable = o.editableFiles ?? [];
  const timeoutMs = normalizeTimeout(o.timeoutMs);

  const hooks: Options["hooks"] = {
    PreToolUse: [
      {
        matcher: "Read|Glob|Grep|Write|Edit|MultiEdit|NotebookEdit",
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const check = checkToolScope(
              input.tool_name,
              input.tool_input,
              o.cwd,
              readable,
              forbidden,
              editable,
            );
            if (check.allowed) {
              const updatedInput = normalizeToolInput(input.tool_name, input.tool_input, o.cwd);
              return updatedInput === null
                ? {}
                : {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      updatedInput,
                    },
                  };
            }
            const reason = check.reason ?? "operation denied by agent scope";
            denials.push(`${input.tool_name}: ${reason}`);
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: reason,
              },
            };
          },
        ],
      },
    ],
  };

  const executable = o.executable ?? resolveClaudeExecutable();
  const abortController = new AbortController();
  const q = query({
    prompt: o.prompt,
    options: {
      cwd: o.cwd,
      tools: o.allowedTools,
      allowedTools: o.allowedTools,
      permissionMode: "acceptEdits",
      settingSources: ["user"],
      settings: { disableAllHooks: true },
      persistSession: false,
      systemPrompt: o.systemPrompt,
      maxTurns: o.maxTurns ?? 32,
      abortController,
      ...(o.outputFormat ? { outputFormat: o.outputFormat } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      hooks,
    },
  });
  let result = "";
  let structuredOutput: unknown;
  let isError = true;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      q.close();
    }, timeoutMs);
  }
  try {
    for await (const msg of q) {
      if (msg.type === "result") {
        isError = msg.is_error;
        if ("result" in msg) result = msg.result;
        if ("structured_output" in msg) structuredOutput = msg.structured_output;
      }
    }
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    q.close();
    clearTimeout(timer);
  }
  if (timedOut) {
    const reason = `Claude agent timed out after ${String(timeoutMs)}ms`;
    result = result.length === 0 ? reason : `${result}\n${reason}`;
    isError = true;
  }
  return { result, structuredOutput, isError, timedOut, denials };
}

function normalizeTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("agent timeout must be a positive finite number");
  }
  return Math.max(1, Math.floor(timeoutMs));
}


/**
 * Validate a Claude Code tool call before execution.
 * Search tools are denied when their search root could include a forbidden tree;
 * this is intentionally conservative because the hook cannot inspect results
 * before the tool runs.
 */
export function checkToolScope(
  toolName: string,
  rawInput: unknown,
  root: string,
  readableGlobs: readonly string[] = [],
  forbiddenGlobs: readonly string[] = [],
  editableFiles: readonly string[] = [],
): ScopeCheck {
  if (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName)) {
    return { allowed: true, reason: null };
  }

  const input = recordInput(rawInput);
  const filePath = typeof input.file_path === "string"
    ? input.file_path
    : typeof input.notebook_path === "string"
      ? input.notebook_path
      : null;

  if (WRITE_TOOLS.has(toolName)) {
    if (filePath === null || filePath.length === 0) {
      return { allowed: false, reason: "write tool did not provide file_path" };
    }
    const resolved = relativeAgentPath(filePath, root);
    if (!resolved.allowed) return resolved;
    if (matchesScope(resolved.path, forbiddenGlobs)) {
      return { allowed: false, reason: `path is forbidden: ${resolved.path}` };
    }
    if (!matchesScope(resolved.path, editableFiles)) {
      return { allowed: false, reason: `path is outside Modification Scope: ${resolved.path}` };
    }
    return { allowed: true, reason: null };
  }

  if (toolName === "Read") {
    if (filePath === null || filePath.length === 0) {
      return { allowed: false, reason: "Read did not provide file_path" };
    }
    const resolved = relativeAgentPath(filePath, root);
    if (!resolved.allowed) return resolved;
    if (matchesScope(resolved.path, forbiddenGlobs)) {
      return { allowed: false, reason: `path is forbidden: ${resolved.path}` };
    }
    if (!matchesScope(resolved.path, readableGlobs)) {
      return { allowed: false, reason: `path is outside Observation Scope: ${resolved.path}` };
    }
    return { allowed: true, reason: null };
  }

  const explicitPath = typeof input.path === "string" && input.path.length > 0
    ? input.path
    : ".";
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const fileGlob = typeof input.glob === "string" ? input.glob : "";
  if (
    containsParentTraversal(explicitPath) ||
    containsParentTraversal(pattern) ||
    containsParentTraversal(fileGlob)
  ) {
    return { allowed: false, reason: "search path or glob contains parent traversal" };
  }

  const searchPath = deriveSearchPath(toolName, explicitPath, pattern, fileGlob);
  const resolved = relativeAgentPath(searchPath, root);
  if (!resolved.allowed) return resolved;
  if (matchesScope(resolved.path, forbiddenGlobs)) {
    return { allowed: false, reason: `search root is forbidden: ${resolved.path}` };
  }
  if (!matchesScope(resolved.path, readableGlobs)) {
    return { allowed: false, reason: `search root is outside Observation Scope: ${resolved.path}` };
  }
  if (maySearchForbidden(resolved.path, forbiddenGlobs)) {
    return { allowed: false, reason: `search may include forbidden paths below: ${resolved.path}` };
  }
  return { allowed: true, reason: null };
}

/**
 * Normalize a scope-checked tool call so Claude Code executes it under the
 * requested agent cwd rather than the parent process cwd.
 */
export function normalizeToolInput(
  toolName: string,
  rawInput: unknown,
  root: string,
): Record<string, unknown> | null {
  const input = recordInput(rawInput);
  if (toolName === "Read" || WRITE_TOOLS.has(toolName)) {
    const field = typeof input.file_path === "string"
      ? "file_path"
      : typeof input.notebook_path === "string"
        ? "notebook_path"
        : null;
    if (field === null) return null;
    const path = input[field];
    if (typeof path !== "string" || !relativeAgentPath(path, root).allowed) return null;
    return { ...input, [field]: resolve(root, path) };
  }
  if (toolName !== "Glob" && toolName !== "Grep") return null;
  const explicitPath = typeof input.path === "string" && input.path.length > 0
    ? input.path
    : ".";
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const fileGlob = typeof input.glob === "string" ? input.glob : "";
  if (containsParentTraversal(explicitPath) || containsParentTraversal(pattern) || containsParentTraversal(fileGlob)) {
    return null;
  }
  const searchPath = deriveSearchPath(toolName, explicitPath, pattern, fileGlob);
  if (!relativeAgentPath(searchPath, root).allowed) return null;
  return { ...input, path: resolve(root, searchPath) };
}

function recordInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function deriveSearchPath(
  toolName: string,
  explicitPath: string,
  pattern: string,
  fileGlob: string,
): string {
  if (explicitPath !== ".") return explicitPath;
  const filter = toolName === "Glob" ? pattern : fileGlob;
  const prefix = literalGlobPrefix(filter.replaceAll("\\", "/"));
  return prefix.length > 0 ? prefix : explicitPath;
}

function relativeAgentPath(filePath: string, root: string): ScopeCheck & { readonly path: string } {
  const base = resolve(root);
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath);
  const rel = relative(base, absolute).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return { allowed: false, path: rel, reason: `path escapes agent cwd: ${filePath}` };
  }

  let current = absolute;
  while (true) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) {
        const real = realpathSync(current);
        const realRel = relative(base, real).split(sep).join("/");
        if (realRel === ".." || realRel.startsWith("../") || isAbsolute(realRel)) {
          return { allowed: false, path: rel, reason: `path resolves outside agent cwd: ${filePath}` };
        }
      } else {
        const real = realpathSync(current);
        const realRel = relative(base, real).split(sep).join("/");
        if (realRel === ".." || realRel.startsWith("../") || isAbsolute(realRel)) {
          return { allowed: false, path: rel, reason: `path resolves outside agent cwd: ${filePath}` };
        }
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return { allowed: false, path: rel, reason: `cannot inspect agent path: ${filePath}` };
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return { allowed: true, path: rel.length === 0 ? "." : rel, reason: null };
}

function matchesScope(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => {
    const normalized = glob.replaceAll("\\", "/");
    const base = normalized.endsWith("/**") ? normalized.slice(0, -3) : null;
    return matchGlob(path, [normalized]) || (base !== null && (path === base || path.startsWith(`${base}/`)));
  });
}

function maySearchForbidden(searchRoot: string, forbiddenGlobs: readonly string[]): boolean {
  if (forbiddenGlobs.length === 0) return false;
  if (searchRoot === ".") return true;
  return forbiddenGlobs.some((glob) => {
    const prefix = literalGlobPrefix(glob.replaceAll("\\", "/"));
    if (prefix.length === 0) return true;
    return searchRoot === prefix || searchRoot.startsWith(`${prefix}/`) || prefix.startsWith(`${searchRoot}/`);
  });
}

function literalGlobPrefix(glob: string): string {
  const wildcard = glob.search(/[?*]/);
  const prefix = wildcard < 0 ? glob : glob.slice(0, wildcard);
  return prefix.replace(/\/+$/, "");
}

function containsParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part === "..");
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

function resolveClaudeExecutable(): string | undefined {
  const configured = process.env.CLAUDE_CODE_EXECUTABLE;
  if (configured && existsSync(configured)) return configured;
  if (process.platform !== "win32") return undefined;

  try {
    const bundled = moduleRequire.resolve("@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");
    if (existsSync(bundled)) return bundled;
  } catch {
    // The platform package is optional; fall back to the installed CLI shim.
  }

  const candidates = [
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.cmd") : "",
    process.env.USERPROFILE
      ? join(process.env.USERPROFILE, "AppData", "Roaming", "npm", "claude.cmd")
      : "",
  ];
  return candidates.find((candidate) => candidate.length > 0 && existsSync(candidate));
}
