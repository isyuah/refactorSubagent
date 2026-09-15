/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/agents/driver.ts —— 全项目唯一调用 Claude Agent SDK 的地方
 *
 * 【这个文件是干什么的】
 *   runAgent() 是"打给 Claude 的总机"：所有 AI 会话（test-writer、refactor、
 *   analyze-legacy…）都从这里出发。它负责三件安全相关的事：
 *   1) 工具白名单：决定会话能看见/自动放行哪些工具（tools/allowedTools/
 *      extraAllowedTools）；
 *   2) PreToolUse hook：模型每次读/搜/写文件，先过 checkToolScope() 审路径，
 *      越界当场 deny 并记入 denials（fail-closed，不靠提示词自觉）；
 *   3) 超时与"卡死看门狗"：总超时到点掐断；N 毫秒没有任何 SDK 消息也掐断
 *      （stall guard，防止 SDK 的 CLI 子进程死了宿主干等）。
 *
 * 【B 方案新增能力（都在 DriverOptions）】
 *   - skills / agents / mcpServers：子代理、MCP server、skill 的注入通道
 *     （workflow-session 用它们装出 test-writer 会话）；
 *   - extraAllowedTools：MCP 工具（mcp__server__tool）必须显式放行；
 *   - sessionStore：把完整会话记录镜像到宿主自己的存储（eager 刷新）；
 *   - enforceScope：false = 跳过范围拦截（e2e 过渡期开关）。
 *
 * 【小白词典】SDK / query / 会话 / turn / hook：SDK 是官方库，本质是"用程序
 *   驱动一个 Claude Code 命令行进程"；query() 一次 = 发起一次会话，返回可迭代
 *   对象，用 for await 一条条收消息；一个 turn = 模型+工具的一轮；hook = 工具
 *   真正执行前的程序化拦截点。
 *
 * 【本文件是教程注释版】原文件 src/agents/driver.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  query,
  type AgentDefinition,      // 子代理定义类型（build-writer 用的就是它）
  type McpServerConfig,
  type Options,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";

/** Tool-owned plugin dir (workflow-spec skill). Relative to this source. */
// 工具自带的 skill 插件目录（workflow-spec）。import.meta.dir = 本文件所在目录。
const TOOL_PLUGIN_DIR = resolve(import.meta.dir, "..", "..", ".claude", "plugins", "workflow-spec");
import { matchGlob } from "../artifacts/scope-manifest.js";
import type { Logger } from "../runtime/log.js";

// createRequire：在 ESM 里拿到"require 能力"，唯一用途是解析可选的平台包路径。
const moduleRequire = createRequire(import.meta.url);

/**
 * AgentDriver — thin wrapper over the Claude Agent SDK.
 *
 * Enforcement model (fail-closed, NOT prompt-based):
 *   - tools + allowedTools define the model's available and auto-allowed tools;
 *   - PreToolUse hook validates every read/search/write path;
 *   - denied operations are surfaced in the run result for audit and gating.
 */

// 两类工具集合：只读 vs 写入（hook 分类处理）。
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Conservative source/configuration view used before a manifest exists. */
// 默认可读：构建系统文件 + 源码头文件（manifest 缺席时的保守视野）。
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
// 默认禁区：测试/基线/生成物/依赖（AI 不许偷看测试来"抄答案"）。
export const DEFAULT_AGENT_FORBIDDEN_GLOBS = [
  "test/**",
  "tests/**",
  "baseline/**",
  ".refactor/**",
  "node_modules/**",
] as const;

// 一次会话运行的结果。
export interface DriverRun {
  /** Final assistant text (empty on error). */
  result: string;                       // 会话最后的文本（出错为空）
  /** Native SDK structured output, when outputFormat was requested. */
  structuredOutput?: unknown;           // json_schema 模式下的结构化输出
  isError: boolean;
  /** True when the host deadline closed the SDK query. */
  timedOut: boolean;                    // 超时/卡死被掐断（不算异常抛出，由调用方决策）
  /** Tool calls denied by the scope hook — surfaced for audit trails. */
  denials: string[];                    // hook 拦下的越界记录（审计用）
}

export interface DriverOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  /** Repo-relative globs the agent may read/search. Empty means deny all scoped tools. */
  readableGlobs?: string[];      // 可读 glob；空数组 = 全部拒绝（默认全关）
  /** Repo-relative hard denials checked before readableGlobs. */
  forbiddenGlobs?: string[];     // 禁区（优先级高于可读）
  /** Repo-relative files/globs the agent may rewrite. */
  editableFiles?: string[];      // 可写白名单
  maxTurns?: number;
  /** Host deadline for the SDK query. Omitted means no deadline. */
  timeoutMs?: number;            // 总超时；不传 = 无上限（⚠️ 有挂死风险）
  /** Treat N ms without any SDK message as a dead stream and abort (default 180s). */
  stallTimeoutMs?: number;       // ★ 新增：卡死看门狗阈值（默认 180 秒无消息 = 流已死）
  /** Run-scoped logger; session events are mirrored at trace/debug level. */
  logger?: Logger;               // B 方案：pino 日志（按级别门控镜像会话事件）
  /**
   * Mirror the full AI session transcript to this store. The SDK still writes
   * the local copy; this adapter receives a secondary durable copy so the host
   * can inspect exact tool calls/results even at info level. Overrides the
   * CLI's session dir via CLAUDE_CONFIG_DIR when provided.
   */
  sessionStore?: SessionStore;   // ★ 新增：完整会话记录的宿主侧镜像
  /**
   * When false, the PreToolUse scope hook is skipped entirely: the agent may
   * Read/Glob/Grep/Write freely (no readable/forbidden/editable checks, no
   * path normalization). Used to get a flow running end-to-end before the
   * scoping model is tightened again. Defaults to true (enforced).
   */
  enforceScope?: boolean;        // ★ 新增：范围拦截总开关（默认开启）
  /** Override Claude Code executable; defaults to the bundled SDK binary on Windows. */
  executable?: string;           // 可手动指定 claude 可执行文件
  outputFormat?: Options["outputFormat"];   // SDK 原生 json_schema（analyze-legacy 用）
  /** Skills to enable for this session (plugin:skill names). When omitted,
   *  no skills are visible to the model — skills only load when listed here,
   *  giving the host exact control over when a skill's full content loads. */
  skills?: string[];             // ★ skill 可见性开关：列了名才可见
  /** Programmatically defined subagents (Agent tool) visible in this session. */
  agents?: Record<string, AgentDefinition>;   // ★ 子代理定义表（build-writer）
  /** In-process MCP servers exposed as tools (mcp__<name>__<tool>). */
  mcpServers?: Record<string, McpServerConfig>;   // ★ 进程内 MCP server
  /** Extra tool names to auto-allow (e.g. mcp__server__tool). */
  extraAllowedTools?: string[];  // ★ 追加自动放行（MCP 工具全名放这里）
}

// 范围检查结果：allowed + 拒绝理由。
export interface ScopeCheck {
  readonly allowed: boolean;
  readonly reason: string | null;
}

// ── runAgent：总机本体 ─────────────────────────────────────────────────
// 【流程】装配 hooks → query() → 迭代收消息（带 stall 看门狗）→ 汇总结果。
export async function runAgent(o: DriverOptions): Promise<DriverRun> {
  const denials: string[] = [];
  const readable = o.readableGlobs ?? [];
  const forbidden = o.forbiddenGlobs ?? [];
  const editable = o.editableFiles ?? [];
  const timeoutMs = normalizeTimeout(o.timeoutMs);

  // PreToolUse hook：七种文件类工具在真正执行前先过这里。
  const hooks: Options["hooks"] = {
    PreToolUse: [
      {
        matcher: "Read|Glob|Grep|Write|Edit|MultiEdit|NotebookEdit",
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            if (o.enforceScope === false) return {}; // scope enforcement off
            // ★ enforceScope=false 时直接放行（不做任何检查、不归一化路径）。
            const check = checkToolScope(
              input.tool_name,
              input.tool_input,
              o.cwd,
              readable,
              forbidden,
              editable,
            );
            if (check.allowed) {
              // 放行 = 顺手把路径归一化到 agent cwd（模型给的是相对/半截路径也能跑对）。
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
            denials.push(`${input.tool_name}: ${reason}`);   // 留痕：审计与 gate 都靠它
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,          // 当场拒绝
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
  // MCP 工具要追加进 allowedTools（不显式放行就会被 acceptEdits 拒绝——实测结论）。
  const combinedAllowed = o.extraAllowedTools !== undefined && o.extraAllowedTools.length > 0
    ? [...(o.allowedTools ?? []), ...o.extraAllowedTools]
    : o.allowedTools;
  const q = query({
    prompt: o.prompt,
    options: {
      cwd: o.cwd,
      tools: combinedAllowed,
      allowedTools: combinedAllowed,        // 白名单 = 可用 + 自动批准
      permissionMode: "acceptEdits",
      settingSources: ["user"],             // 只读用户级配置（项目级配置不可信）
      plugins: [{ type: "local", path: TOOL_PLUGIN_DIR }],
      settings: { disableAllHooks: true },  // 关配置文件里的钩子；程序注入的 hooks 不受影响
      // The SDK requires local persistence when mirroring to a sessionStore.
      persistSession: o.sessionStore !== undefined,   // ★ 要镜像会话就必须开持久化
      // eager: flush every transcript frame so an interrupted run (host kill,
      // timeout abort) still leaves the full conversation on disk for analysis.
      sessionStoreFlush: o.sessionStore !== undefined ? ("eager" as const) : undefined,
      // ↑ eager：每一帧都刷盘——进程被杀/超时中断也能留下完整对话供分析。
      ...(o.sessionStore !== undefined ? { sessionStore: o.sessionStore } : {}),
      ...(o.skills !== undefined ? { skills: o.skills } : {}),      // 不传 = 模型看不见任何 skill
      ...(o.agents !== undefined ? { agents: o.agents } : {}),      // 子代理注入
      ...(o.mcpServers !== undefined ? { mcpServers: o.mcpServers } : {}),   // MCP 注入
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
      abortController.abort();   // 总超时：中断 + 关闭
      q.close();
    }, timeoutMs);
  }
  const logger = o.logger;
  const logSession = (msg: unknown): void => { logSessionEvent(logger, msg); };
  // Stall guard: the SDK can hang with no message when its CLI subprocess dies
  // (observed under a model proxy). Treat N seconds without ANY message as a
  // dead stream, abort, and report a stall instead of waiting for timeoutMs.
  // ★ 卡死看门狗：SDK 的 CLI 子进程死掉时会"永远不来消息"。默认 180 秒无任何
  //   消息就判定流已死——不等总超时，立刻 abort。
  const stallMs = o.stallTimeoutMs ?? 180_000;
  let stalled = false;
  // Stall watchdog: a single timer, reset on every message. If it ever fires,
  // the stream produced nothing for stallMs — abort instead of hanging until
  // the overall timeout (observed when the SDK's CLI subprocess dies under a
  // model proxy while the host keeps waiting on the query stream).
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let stallReject: ((error: Error) => void) | null = null;
  const armStall = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallReject?.(new Error(`Claude agent stream stalled: no message for ${stallMs}ms`));
    }, stallMs);
  };
  // 用一个永不 resolve 的 Promise 制造"可触发的拒绝"——和迭代器 race。
  const stallPromise = new Promise<never>((_, reject) => { stallReject = reject; });
  try {
    const iterator = q[Symbol.asyncIterator]();   // 手动拿异步迭代器（为了能和 stallPromise race）
    armStall();
    while (true) {
      const next = await Promise.race([iterator.next(), stallPromise]);   // 消息 or 卡死，谁先来算谁
      armStall();    // 每收到一条消息就重置看门狗
      if (next.done) break;
      const msg = next.value;
      logSession(msg);   // 镜像到 logger（按级别门控）
      if (msg.type === "result") {
        isError = msg.is_error;
        if ("result" in msg) result = msg.result;
        if ("structured_output" in msg) structuredOutput = msg.structured_output;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("stream stalled")) {
      stalled = true;               // 看门狗触发：算作超时类，不算异常
      timedOut = true;
      abortController.abort();
      q.close();
    } else if (!timedOut) {
      throw error;                  // 其他异常照常上抛（超时导致的 abort 不抛）
    }
  } finally {
    clearTimeout(stallTimer);
    q.close();
    clearTimeout(timer);
  }
  if (timedOut) {
    // 超时/卡死：把原因追加到 result 里返回（不 throw——调用方自己决定怎么办）。
    const reason = stalled
      ? `Claude agent stream stalled (no message for ${stallMs}ms); CLI subprocess likely died`
      : `Claude agent timed out after ${String(timeoutMs)}ms`;
    result = result.length === 0 ? reason : `${result}\n${reason}`;
    isError = true;
  }
  return { result, structuredOutput, isError, timedOut, denials };
}

// 超时参数校验：必须是正的有限数（防御性编程——错误配置立刻暴露）。
function normalizeTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("agent timeout must be a positive finite number");
  }
  return Math.max(1, Math.floor(timeoutMs));
}

/** Which message types carry tool-call intent that analysis cares about. */
// 从消息内容块里抠"工具名"（type === "tool_use" 的块才有 name）。
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
// ── logSessionEvent：把 SDK 消息按级别镜像进 pino 日志 ────────────────────
// 设计：debug 只记"发生了什么"（工具名/状态），trace 才记完整内容——
// 文件内容、命令输出这类大而敏感的 payload 默认不落盘。
export function logSessionEvent(logger: Logger | undefined, msg: unknown): void {
  if (logger === undefined) return;
  if (typeof msg !== "object" || msg === null) return;
  const m = msg as { type?: unknown; session_id?: unknown };
  if (typeof m.type !== "string") return;
  const sessionId = typeof m.session_id === "string" ? m.session_id : undefined;
  const details: Record<string, unknown> = { session_id: sessionId };

  if (m.type === "result") {
    // result 消息：轮次数/耗时/成本/是否出错（debug 级）。
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
    // assistant 消息：trace 记全文；debug 只记用了哪些工具/几个文本块/是否带思考。
    const a = m as { message?: unknown; subagent_type?: unknown };
    const content = typeof a.message === "object" && a.message !== null
      ? (a.message as { content?: unknown }).content
      : undefined;
    const blocks = Array.isArray(content) ? content : [];
    const toolNames = blocks
      .map((b) => toolNameOf(b))
      .filter((name): name is string => name !== null);   // 类型谓词：过滤后只剩 string
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
    // user 消息（工具结果回传）：debug 只记有没有结果/是否失败，不记 payload。
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
// ── checkToolScope：范围检查核心（hook 的判断逻辑）─────────────────────────
// 【规则】写入类：必须在 editable 白名单内（★ editable 显式授权优先于宽泛禁区——
//         否则 test-writer 写不进 .refactor/** 下的交付物）；读取类：不在禁区
//         且在可读范围内；搜索类：额外防"搜索根可能覆盖禁区"（宁可错杀）。
export function checkToolScope(
  toolName: string,
  rawInput: unknown,
  root: string,
  readableGlobs: readonly string[] = [],
  forbiddenGlobs: readonly string[] = [],
  editableFiles: readonly string[] = [],
): ScopeCheck {
  if (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName)) {
    return { allowed: true, reason: null };   // 非文件类工具（Task/MCP…）不在本 hook 管辖
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
    // Explicit editable authorization wins over broad forbidden globs: the
    // host hands the agent its exact deliverable path (e.g. a run-local test
    // workflow under .refactor/runs/<session>/), which is simultaneously
    // inside a ".refactor/**" catch-all denial. A path that matches an
    // editable entry is authorized by construction.
    // ↑ ★ 优先级：editable（宿主显式授权）> forbidden（宽泛禁令）。
    if (matchesScope(resolved.path, editableFiles)) {
      return { allowed: true, reason: null };
    }
    if (matchesScope(resolved.path, forbiddenGlobs)) {
      return { allowed: false, reason: `path is forbidden: ${resolved.path}` };
    }
    return { allowed: false, reason: `path is outside Modification Scope: ${resolved.path}` };
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

  // —— Glob / Grep：搜索类要额外小心（hook 看不到搜索结果，只能保守判断）——
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
  // ↑ ★ 新版：优先用 glob 的"字面前缀"当有效搜索根（path=<root> pattern=src/**
  //   这种调用，光看 path 会把一切搜索都误杀）。
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
// ── normalizeToolInput：放行前的路径归一化（把相对路径钉到 agent cwd）───────
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
    return { ...input, [field]: resolve(root, path) };   // 计算属性名：改写 file_path/notebook_path
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

// 输入归一：不是普通对象就当空对象（防御模型给奇怪形状）。
function recordInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// 推导"有效搜索根"：显式给了 path 就用它；否则用 glob 的字面前缀（如 src/** → src）。
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

// ── relativeAgentPath：路径安检（穿越 + 软链接逃逸）───────────────────────
// 两道防线：① 相对化后是否逃出 root（../）；② 从路径逐级向上用 lstat/realpath
// 检查符号链接的真实指向是否逃出 root（经典软链接偷换攻击）。
function relativeAgentPath(filePath: string, root: string): ScopeCheck & { readonly path: string } {
  const base = resolve(root);
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath);
  const rel = relative(base, absolute).split(sep).join("/");   // 统一成正斜杠
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return { allowed: false, path: rel, reason: `path escapes agent cwd: ${filePath}` };
  }

  let current = absolute;
  while (true) {
    try {
      const info = lstatSync(current);   // lstat：不跟随软链接本身
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
      // 路径尚不存在（ENOENT）：向上走一级继续查父目录的软链接。
      const parent = dirname(current);
      if (parent === current) break;   // 到根了
      current = parent;
    }
  }
  return { allowed: true, path: rel.length === 0 ? "." : rel, reason: null };
}

// glob 匹配（matchGlob）+ 对 "dir/**" 的"目录本身也算"特判。
function matchesScope(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => {
    const normalized = glob.replaceAll("\\", "/");
    const base = normalized.endsWith("/**") ? normalized.slice(0, -3) : null;
    return matchGlob(path, [normalized]) || (base !== null && (path === base || path.startsWith(`${base}/`)));
  });
}

// 判断"从这个搜索根搜下去会不会碰到禁区"——hook 看不到搜索结果，只能按前缀保守推断。
function maySearchForbidden(searchRoot: string, forbiddenGlobs: readonly string[]): boolean {
  if (forbiddenGlobs.length === 0) return false;
  if (searchRoot === ".") return true;   // 从"."搜 = 可能碰到一切 → 一律算可能
  return forbiddenGlobs.some((glob) => {
    const prefix = literalGlobPrefix(glob.replaceAll("\\", "/"));
    if (prefix.length === 0) return true;
    return searchRoot === prefix || searchRoot.startsWith(`${prefix}/`) || prefix.startsWith(`${searchRoot}/`);
  });
}

// 取 glob 的字面前缀（第一个通配符之前的部分）：src/te* → src/te。
function literalGlobPrefix(glob: string): string {
  const wildcard = glob.search(/[?*]/);
  const prefix = wildcard < 0 ? glob : glob.slice(0, wildcard);
  return prefix.replace(/\/+$/, "");
}

// 是否包含 ".." 路径段（穿越检测，按 / 或 \ 拆段判断）。
function containsParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part === "..");
}

/** Extract the last fenced ```json block (or bare object) from agent text. */
// 兜底 JSON 解析：优先取 ```json 围栏块，退而求其次整段文本；都解析不了就抛错。
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

// ── resolveClaudeExecutable：Windows 下找 claude 可执行文件的三级链 ─────────
// ① CLAUDE_CODE_EXECUTABLE 环境变量 → ② SDK 自带的 claude.exe（可选平台包）
// → ③ %APPDATA% / %USERPROFILE% 里的 npm claude.cmd。非 Windows 交给 SDK 自找。
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
