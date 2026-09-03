import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  query,
  type AgentDefinition,
  type McpServerConfig,
  type Options,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";

/** Tool-owned plugin dir (workflow-spec skill). Relative to this source. */
const TOOL_PLUGIN_DIR = resolve(import.meta.dir, "..", "..", ".claude", "plugins", "workflow-spec");
import { matchGlob } from "../artifacts/scope-manifest.js";
import type { Logger } from "../runtime/log.js";

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
  /** Run-scoped logger; session events are mirrored at trace/debug level. */
  logger?: Logger;
  /**
   * Mirror the full AI session transcript to this store. The SDK still writes
   * the local copy; this adapter receives a secondary durable copy so the host
   * can inspect exact tool calls/results even at info level. Overrides the
   * CLI's session dir via CLAUDE_CONFIG_DIR when provided.
   */
  sessionStore?: SessionStore;
  /** Override Claude Code executable; defaults to the bundled SDK binary on Windows. */
  executable?: string;
  outputFormat?: Options["outputFormat"];
  /** Skills to enable for this session (plugin:skill names). When omitted,
   *  no skills are visible to the model — skills only load when listed here,
   *  giving the host exact control over when a skill's full content loads. */
  skills?: string[];
  /** Programmatically defined subagents (Agent tool) visible in this session. */
  agents?: Record<string, AgentDefinition>;
  /** In-process MCP servers exposed as tools (mcp__<name>__<tool>). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Extra tool names to auto-allow (e.g. mcp__server__tool). */
  extraAllowedTools?: string[];
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
  const combinedAllowed = o.extraAllowedTools !== undefined && o.extraAllowedTools.length > 0
    ? [...(o.allowedTools ?? []), ...o.extraAllowedTools]
    : o.allowedTools;
  const q = query({
    prompt: o.prompt,
    options: {
      cwd: o.cwd,
      tools: combinedAllowed,
      allowedTools: combinedAllowed,
      permissionMode: "acceptEdits",
      settingSources: ["user"],
      plugins: [{ type: "local", path: TOOL_PLUGIN_DIR }],
      settings: { disableAllHooks: true },
      // The SDK requires local persistence when mirroring to a sessionStore.
      persistSession: o.sessionStore !== undefined,
      // eager: flush every transcript frame so an interrupted run (host kill,
      // timeout abort) still leaves the full conversation on disk for analysis.
      sessionStoreFlush: o.sessionStore !== undefined ? ("eager" as const) : undefined,
      ...(o.sessionStore !== undefined ? { sessionStore: o.sessionStore } : {}),
      ...(o.skills !== undefined ? { skills: o.skills } : {}),
      ...(o.agents !== undefined ? { agents: o.agents } : {}),
      ...(o.mcpServers !== undefined ? { mcpServers: o.mcpServers } : {}),
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
  const logger = o.logger;
  const logSession = (msg: unknown): void => { logSessionEvent(logger, msg); };
  try {
    for await (const msg of q) {
      logSession(msg);
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

/** Which message types carry tool-call intent that analysis cares about. */
function toolNameOf(content: unknown): string | null {
  if (typeof content !== "object" || content === null) return null;
  const c = content as { type?: unknown; name?: unknown };
  return c.type === "tool_use" && typeof c.name === "string" ? c.name : null;
}

/**
 * Mirror one SDK session message into the run logger at a level decided by
 * the message type and the configured threshold:
 *
 *   result — always logged (debug): turn count, duration, cost.
 *   assistant tool_use — debug: tool name; trace: full content blocks.
 *   user tool_result — debug: status only (no payload); trace: full blocks.
 *   everything else — trace only.
 *
 * tool_result payloads (file contents, command output) are intentionally NOT
 * written at debug level — they can be large and sensitive; the full session
 * transcript is available separately via sessionStore at trace level.
 */
export function logSessionEvent(logger: Logger | undefined, msg: unknown): void {
  if (logger === undefined) return;
  if (typeof msg !== "object" || msg === null) return;
  const m = msg as { type?: unknown; session_id?: unknown };
  if (typeof m.type !== "string") return;
  const sessionId = typeof m.session_id === "string" ? m.session_id : undefined;
  const details: Record<string, unknown> = { session_id: sessionId };

  if (m.type === "result") {
    const r = m as { num_turns?: unknown; duration_ms?: unknown; total_cost_usd?: unknown; is_error?: unknown };
    logger.debug("agent session result", {
      ...details,
      num_turns: typeof r.num_turns === "number" ? r.num_turns : undefined,
      duration_ms: typeof r.duration_ms === "number" ? r.duration_ms : undefined,
      total_cost_usd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
      is_error: typeof r.is_error === "boolean" ? r.is_error : undefined,
    });
    return;
  }

  if (m.type === "assistant") {
    const a = m as { message?: unknown; subagent_type?: unknown };
    const content = typeof a.message === "object" && a.message !== null
      ? (a.message as { content?: unknown }).content
      : undefined;
    const blocks = Array.isArray(content) ? content : [];
    const toolNames = blocks
      .map((b) => toolNameOf(b))
      .filter((name): name is string => name !== null);
    const textBlocks = blocks.filter(
      (b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
    ).length;
    const hasThinking = blocks.some(
      (b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "thinking",
    );
    if (logger.level === "trace") {
      logger.trace("assistant message", {
        ...details,
        subagent_type: typeof a.subagent_type === "string" ? a.subagent_type : undefined,
        content: blocks,
      });
    } else {
      logger.debug("assistant message", {
        ...details,
        subagent_type: typeof a.subagent_type === "string" ? a.subagent_type : undefined,
        tool_names: toolNames,
        text_block_count: textBlocks,
        has_thinking: hasThinking,
      });
    }
    return;
  }

  if (m.type === "user") {
    const u = m as { message?: unknown; tool_use_result?: unknown; subagent_type?: unknown };
    const toolUseResult = u.tool_use_result;
    const failed = typeof toolUseResult === "object" && toolUseResult !== null
      && (toolUseResult as { is_error?: unknown }).is_error === true;
    if (logger.level === "trace") {
      logger.trace("user message", {
        ...details,
        subagent_type: typeof u.subagent_type === "string" ? u.subagent_type : undefined,
        message: u.message,
        tool_use_result: u.tool_use_result,
      });
    } else {
      logger.debug("user message", {
        ...details,
        subagent_type: typeof u.subagent_type === "string" ? u.subagent_type : undefined,
        has_tool_result: u.tool_use_result !== undefined,
        tool_result_error: failed,
      });
    }
    return;
  }

  if (logger.level === "trace") {
    logger.trace(`session message ${m.type}`, details);
  }
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
  // Prefer the literal glob prefix as the effective search root: Claude Code
  // sends Glob with an absolute repo-root path plus a pattern (e.g.
  // path=<root> pattern=src/**). Matching the bare root against readableGlobs
  // would deny every scoped search even when the pattern targets a readable
  // subtree. When the pattern prefix is readable and cannot reach forbidden
  // trees, allow; otherwise fall back to the path-root checks below.
  const filter = toolName === "Glob" ? pattern : fileGlob;
  const prefix = literalGlobPrefix(filter.replaceAll("\\", "/"));
  if (prefix.length > 0) {
    if (matchesScope(prefix, forbiddenGlobs)) {
      return { allowed: false, reason: `search pattern is forbidden: ${prefix}` };
    }
    if (matchesScope(prefix, readableGlobs) && !maySearchForbidden(prefix, forbiddenGlobs)) {
      return { allowed: true, reason: null };
    }
  }
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
