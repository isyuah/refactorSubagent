import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  query,
  type AgentDefinition,
  type McpServerConfig,
  type Options,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";

/** Tool-owned plugin dir (workflow-spec skill). Relative to this source. */
const TOOL_PLUGIN_DIR = resolve(import.meta.dir, "..", "..", ".claude", "plugins", "workflow-spec");
import type { Logger } from "../runtime/log.js";

const moduleRequire = createRequire(import.meta.url);

/**
 * AgentDriver — thin wrapper over the Claude Agent SDK.
 *
 * Tool access is bounded by the SDK allowlist (allowedTools), not by a
 * host-side scope hook: no agent session gets Bash, and every agent runs in
 * a disposable worktree/session directory, so a misbehaving agent can only
 * damage its own scratch space.
 */


export interface DriverRun {
  /** Final assistant text (empty on error). */
  result: string;
  /** Native SDK structured output, when outputFormat was requested. */
  structuredOutput?: unknown;
  isError: boolean;
  /** True when the host deadline closed the SDK query. */
  timedOut: boolean;
}

export interface DriverOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  /** Max assistant turns. Omitted/null = SDK default (unbounded). */
  maxTurns?: number | null;
  /** Host deadline for the SDK query. Omitted means no deadline. */
  timeoutMs?: number;
  /** Treat N ms without any SDK message as a dead stream and abort. null disables the watchdog. */
  stallTimeoutMs?: number | null;
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


export async function runAgent(o: DriverOptions): Promise<DriverRun> {
  const timeoutMs = normalizeTimeout(o.timeoutMs);
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
      ...(o.maxTurns !== undefined && o.maxTurns !== null ? { maxTurns: o.maxTurns } : {}),
      abortController,
      ...(o.outputFormat ? { outputFormat: o.outputFormat } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
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
  // Stall guard: the SDK can hang with no message when its CLI subprocess dies
  // (observed under a model proxy). Treat N seconds without ANY message as a
  // dead stream, abort, and report a stall instead of waiting for timeoutMs.
  const stallMs = o.stallTimeoutMs === undefined ? 180_000 : o.stallTimeoutMs;
  let stalled = false;
  // Stall watchdog: a single timer, reset on every message. If it ever fires,
  // the stream produced nothing for stallMs — abort instead of hanging until
  // the overall timeout (observed when the SDK's CLI subprocess dies under a
  // model proxy while the host keeps waiting on the query stream).
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let stallReject: ((error: Error) => void) | null = null;
  const armStall = (): void => {
    if (stallMs === null) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallReject?.(new Error(`Claude agent stream stalled: no message for ${stallMs}ms`));
    }, stallMs);
  };
  // A disabled watchdog never rejects; the race below then just awaits the stream.
  const stallPromise = stallMs === null
    ? new Promise<never>(() => {})
    : new Promise<never>((_, reject) => { stallReject = reject; });
  try {
    const iterator = q[Symbol.asyncIterator]();
    armStall();
    while (true) {
      const next = await Promise.race([iterator.next(), stallPromise]);
      armStall();
      if (next.done) break;
      const msg = next.value;
      logSession(msg);
      if (msg.type === "result") {
        isError = msg.is_error;
        if ("result" in msg) result = msg.result;
        if ("structured_output" in msg) structuredOutput = msg.structured_output;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("stream stalled")) {
      stalled = true;
      timedOut = true;
      abortController.abort();
      q.close();
    } else if (!timedOut) {
      throw error;
    }
  } finally {
    clearTimeout(stallTimer);
    q.close();
    clearTimeout(timer);
  }
  if (timedOut) {
    const reason = stalled
      ? `Claude agent stream stalled (no message for ${stallMs}ms); CLI subprocess likely died`
      : `Claude agent timed out after ${String(timeoutMs)}ms`;
    result = result.length === 0 ? reason : `${result}\n${reason}`;
    isError = true;
  }
  return { result, structuredOutput, isError, timedOut };
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


function recordInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
