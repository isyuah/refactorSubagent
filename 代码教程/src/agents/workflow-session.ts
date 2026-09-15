/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/agents/workflow-session.ts —— B 方案的中枢：test-writer 主会话编排
 *
 * 【这个文件是干什么的】
 *   开一个 test-writer 主 agent 会话，让它自主完成两件事再收工：
 *   ① 调 declareDependency 声明"我的测试依赖哪些 build"（必须显式调用，空集也要）；
 *   ② 把 TestWorkflow 源码写到宿主指定的唯一可写文件。
 *   过程中它可以：查库（inspectWorkflow）、派 build-writer 子代理生成新 build
 *   （generateBuildWorkflow）、读写自己的文件。会话结束后宿主校验产出，
 *   不合格就由上层决定 loop（resume 重开）或 abort——本文件只跑一轮。
 *
 * 【会话配置一览（都在 runWorkflowSession 里拼装）】
 *   systemPrompt = TEST_WORKFLOW_SYSTEM；工具 = 读+写+Edit+Task（派子代理）；
 *   extraAllowedTools = mcp__dep-registry__* 三个工具（MCP 工具必须显式放行）；
 *   agents = { build-writer }；mcpServers = { dep-registry }；
 *   skills = ["workflow-spec:workflow-spec"]；editableFiles = 只有 test 源文件。
 *
 * 【在整个项目里的位置】
 *   上游：workflow-agent-pipeline.ts 的 WORKFLOW_SESSION 阶段（含 loop 重试）；
 *   下游：产出 DeclaredBuildSet + test 源文件 → 宿主按声明执行构建 → 测试。
 *
 * 【本文件是教程注释版】原文件 src/agents/workflow-session.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { buildWriterDefinition } from "./build-writer.js";
import { LocalDependencyRegistry } from "./dep-registry.js";
import { createDependencyMcpServer } from "./dep-registry-server.js";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { runAgent, type DriverRun } from "./driver.js";
import { TEST_WORKFLOW_SYSTEM } from "./prompts.js";
import type { Logger } from "../runtime/log.js";

/**
 * workflow-session — orchestrates a test-writer Claude session that produces
 * a TestWorkflow source and a dependency declaration set.
 *
 * The test-writer can:
 *   - inspectWorkflow: list persisted library + run-local build workflows,
 *   - declareDependency: declare which builds this test depends on (full set,
 *     empty = none),
 *   - spawn the build-writer subagent to author a new BuildWorkflow via
 *     generateBuildWorkflow when the library has no suitable build.
 *
 * The host drives execution AFTER the session: resolve every declared build,
 * run them (baseline/candidate), then run the produced test workflow.
 */

// ── WorkflowSessionOptions：调用方给的输入 ───────────────────────────────
export interface WorkflowSessionOptions {
  /** Absolute repo root (source under test). */
  readonly repoDir: string;            // 被测仓库的绝对路径
  /** Absolute session root where run-local artifacts live. */
  readonly sessionRoot: string;        // 会话根（AI 生成的 workflow 落在 runs/{session}/ 下）
  readonly sessionId: string;
  /** Natural-language task describing what behavior to verify. */
  readonly task: string;               // 任务描述（会原样出现在会话提示词里）
  /** Absolute path where the produced TestWorkflow source must be written. */
  readonly testEntry: string;          // test 源码必须写到的绝对路径（也是唯一可写文件）
  readonly host: HostPreflight;        // 程序实测的主机事实
  readonly project: ProjectDetection;  // 项目探测事实
  /** Host deadline for the whole session. */
  readonly timeoutMs?: number;
  /** Max agent turns. */
  readonly maxTurns?: number;
  /** Repo-relative globs the test-writer may read. Defaults to source view. */
  readonly readableGlobs?: readonly string[];
  /** Repo-relative hard denials (defaults: repo internals/tests). */
  readonly forbiddenGlobs?: readonly string[];
  /** Injected capabilities seam for tests; defaults to runAgent. */
  // ↑ 依赖注入缝：单测传一个假的 runner，不用真开 Claude 会话。
  readonly runAgentFn?: (options: WorkflowSessionAgentOptions) => Promise<DriverRun>;
  /** Run-scoped logger for session-level events (mirrored to driver). */
  readonly logger?: Logger;
  /** Mirror the full AI session transcript to this store. */
  readonly sessionStore?: SessionStore;
  /** When false, skip PreToolUse scope enforcement (free tool access). */
  readonly enforceScope?: boolean;     // ★ 新增开关：false = 会话内跳过范围拦截（e2e 过渡用）
}

/** Options handed to the underlying agent runner (narrowed for testability). */
// 传给底层 runner 的选项（收窄后的形状——便于 mock 与类型检查）。
export interface WorkflowSessionAgentOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly extraAllowedTools: readonly string[];   // ★ MCP 工具单独一栏（必须显式放行才可用）
  readonly readableGlobs: readonly string[];
  readonly forbiddenGlobs: readonly string[];
  readonly editableFiles: readonly string[];
  readonly agents: Record<string, unknown>;        // 子代理定义表
  readonly mcpServers: Record<string, unknown>;    // MCP server 注册表
  readonly skills: readonly string[];
  readonly maxTurns: number;
  readonly timeoutMs?: number;
  /** Run-scoped logger; session events are mirrored by the runner. */
  readonly logger?: Logger;
  /** Mirror the full AI session transcript to this store. */
  readonly sessionStore?: SessionStore;
  /** When false, skip PreToolUse scope enforcement (free tool access). */
  readonly enforceScope?: boolean;
}

// 会话结果：ok=false 时 failure 会说明原因（上层据此 loop 或 abort）。
export interface WorkflowSessionResult {
  readonly ok: boolean;
  /** Final assistant text. */
  readonly summary: string;                    // 会话最后的assistant文本（AI 的总结）
  /** Tool denials surfaced by the scope hook. */
  readonly denials: readonly string[];         // hook 拦下的越界记录
  /** Declared build workflow ids (final state of declareDependency). */
  readonly declaredBuilds: readonly string[];  // 最终声明集（从 registry 回读）
  /** True when the produced test workflow source exists at testEntry. */
  readonly testEntryExists: boolean;           // test 源文件真的写出来了吗
  /** Session timed out. */
  readonly timedOut: boolean;
  /** Why the session outcome is not usable (when ok is false). */
  readonly failure: string | null;
}

// test-writer 的工具清单：读 + 写 + Edit + Task（Task = 派 build-writer 子代理）。
// as const：锁成只读字面量元组。
export const TEST_WRITER_AGENT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Task",
] as const;

// 默认可读范围：构建系统文件 + 源码 + ★ 测试目录（新版放开——test-writer 和
// build-writer 必须能读现有测试，才能写出"有意义"的 workflow：CMakeLists 引用了
// 测试源码，构建也要编译它们）。
const DEFAULT_READABLE = [
  "CMakeLists.txt",
  "cmake/**",
  "config/**",
  "include/**",
  "src/**",
  // The test-writer and its build-writer subagent must read existing
  // tests to author meaningful workflows (CMakeLists references test
  // sources; the build must compile them).
  "test/**",
  "tests/**",
  "*.c",
  "*.h",
] as const;

// The test-writer must READ the project's existing tests to write meaningful
// test workflows; only repo internals and its own run artifacts stay hidden.
// Editable scope is still limited to the single test workflow file.
// ↑ 默认禁区只剩三样：baseline/.refactor/node_modules——可写范围仍然只有
//   那一个 test 源文件（editableFiles 单独控制"写"）。
const DEFAULT_FORBIDDEN = [
  "baseline/**",
  ".refactor/**",
  "node_modules/**",
] as const;

// ── SESSION_PROMPT：test-writer 的会话提示词（本文件的核心）────────────────
// 结构：任务 → 两个交付物（声明集 + test 源文件）→ 会话工作流（查库→决定复用/新写
// →声明→写文件）→ 失败处理（不许猜）→ 收尾校验提醒。
const SESSION_PROMPT = (
  task: string,
  testEntry: string,
  editableRel: string,
): string => `You are the TestWorkflow writer for a behavior-preserving C refactoring system.

Task under test:
${task}

You must produce TWO deliverables before the session ends:
  1. A dependency declaration — call declareDependency with the COMPLETE set
     of build workflow ids your test depends on. ALWAYS call it, even with an
     empty array [] (meaning: no build needed). The host executes every
     declared build (baseline and candidate) BEFORE running your test workflow,
     so declare every build whose artifacts your test references. Missing or
     malformed declarations fail the session.
     // ↑ 声明必须显式且完整：空集也要显式声明 []（"不需要 build"也是信息）。
  2. A self-driven TestWorkflow TypeScript module, written to exactly:
       ${testEntry}
     (repo-relative editable path: ${editableRel})

Workflow of the session:
  1. Call inspectWorkflow (kind: "build") to see what build workflows exist:
     library entries (status library-verified/library-draft, with descriptions)
     and entries generated earlier this run (status run-local).
  2. Decide: reuse a suitable library build, or author a new one.
     - Reuse: use its id in declareDependency.
     - New: spawn the build-writer subagent via the Task tool. IMPORTANT: run it
       in the FOREGROUND (run_in_background: false) and WAIT for its result
       before doing anything else — spawn one agent, collect its report, then
       continue. Never fire background agents and finish without their results;
       the session is not complete until the build exists and you have its
       artifact paths. The build-writer writes the BuildWorkflow source through
       the host (generateBuildWorkflow) and reports the assigned workflow_id
       plus EVERY artifact path the build produces and how to invoke each.
     // ↑ ★ 前台等待规则：派子代理必须阻塞等结果，禁止"后台派了就收工"——
     //   这是针对实测踩坑（后台派发后不收集结果）写死的纪律。
  3. Call declareDependency with the final complete set.
  4. Write the test workflow file. Your test workflow:
     - MUST NOT rebuild anything — the host already built every declared build
       in this worktree before your function runs. Reference the artifact paths
       the build-writer reported (or that you know from the repo) directly and
       assert them with context.validator.assertFile — if an artifact is
       missing, fail (do NOT fall back to building it yourself).
     // ↑ "宿主零产物知识"的另一面：产物路径由 build-writer 汇报给 test-writer，
     //   test 直接引用并自己断言；产物缺失就 fail，绝不自己偷偷重建。
     - Runs once per worktree (baseline, then candidate) with the SAME source;
       you cannot tell which side you are on. Declare expectations with
       ctx.expect(...) — same declarations, same order, on both runs.

If the build-writer reports a failure or the generated workflow is rejected,
do not guess: either fall back to an existing library build (declare its id) or
stop and explain what is missing in your final message — the host will fail the
session rather than run a broken test.

The host validates your test workflow file and your declaration after the
session; both must be complete before you finish.`;

/**
 * Run a test-writer session. Returns the session outcome; the caller decides
 * whether to loop (missing declaration/file) or abort.
 */
// ── runWorkflowSession：跑一轮 test-writer 会话 ─────────────────────────
// 【流程】拼装 registry/MCP/agents/提示词 → runAgent 一轮 → 收尾校验
//        （源文件在？显式声明过？）→ 返回结果对象（调用方决定 loop/abort）。
export async function runWorkflowSession(
  options: WorkflowSessionOptions,
): Promise<WorkflowSessionResult> {
  const repoDir = options.repoDir;
  const relativeTestEntry = relative(repoDir, options.testEntry).split("\\").join("/");   // 绝对路径→仓库相对（统一正斜杠）
  const registry = new LocalDependencyRegistry({
    workspaceRoot: repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    host: options.host,
    project: options.project,
  });
  const mcpServer = createDependencyMcpServer({ registry });   // 把 registry 包成 MCP server
  const serverName = "dep-registry";
  const mcpToolPrefix = `mcp__${serverName}__`;
  const mcpTools = [
    `${mcpToolPrefix}inspectWorkflow`,
    `${mcpToolPrefix}declareDependency`,
    `${mcpToolPrefix}generateBuildWorkflow`,
  ];   // ★ MCP 工具必须以全名放进 extraAllowedTools 才会被 SDK 放行（实测结论）

  const agents: Record<string, unknown> = {
    "build-writer": buildWriterDefinition(serverName),   // 注入子代理定义（名字 = Task 工具里的代理名）
  };
  const prompt = SESSION_PROMPT(options.task, options.testEntry, relativeTestEntry);

  // runner 可注入（测试用假 runner）；生产走 defaultRunAgent → driver.runAgent。
  const runner = options.runAgentFn ?? defaultRunAgent;
  const run = await runner({
    cwd: repoDir,
    prompt,
    systemPrompt: TEST_WORKFLOW_SYSTEM,
    allowedTools: [...TEST_WRITER_AGENT_TOOLS],
    extraAllowedTools: mcpTools,
    readableGlobs: [...(options.readableGlobs ?? DEFAULT_READABLE)],
    forbiddenGlobs: [...(options.forbiddenGlobs ?? DEFAULT_FORBIDDEN)],
    editableFiles: [relativeTestEntry],      // ★ 可写只有 test 源文件这一个
    agents,
    mcpServers: { [serverName]: mcpServer }, // 计算属性名：{ "dep-registry": server }
    skills: ["workflow-spec:workflow-spec"], // 强制加载 workflow 规范 skill（仅此会话可见）
    maxTurns: options.maxTurns ?? 48,
    timeoutMs: options.timeoutMs,
    logger: options.logger,
    sessionStore: options.sessionStore,
    enforceScope: options.enforceScope,
  });

  // ── 收尾校验：产出文件 + 显式声明，缺一不可 ─────────────────────────────
  const testEntryExists = existsSync(options.testEntry);
  const declaredBuilds = await registry.currentDeclared();     // 最终声明集（registry 是唯一事实源）
  const declaredExplicitly = await registry.declaredExplicitly();   // 是否"显式调用过"declareDependency
  let failure: string | null = null;
  if (run.isError && run.result.length === 0) {
    failure = "test-writer session failed without output";
  } else if (run.timedOut) {
    failure = "test-writer session timed out";
  } else if (!testEntryExists) {
    failure = `test-writer did not produce ${relativeTestEntry}`;
  } else if (!declaredExplicitly) {
    failure =
      "test-writer finished without calling declareDependency; it must declare " +
      "the full dependency set (empty allowed only via an explicit declareDependency([]))";
  }

  return {
    ok: failure === null,
    summary: run.result,
    denials: run.denials,
    declaredBuilds,
    testEntryExists,
    timedOut: run.timedOut,
    failure,
  };
}

// 默认 runner：把收窄的选项透传给 driver.runAgent（as never：绕过 Record 的宽类型检查）。
async function defaultRunAgent(
  o: WorkflowSessionAgentOptions,
): Promise<DriverRun> {
  return runAgent({
    cwd: o.cwd,
    prompt: o.prompt,
    systemPrompt: o.systemPrompt,
    allowedTools: [...o.allowedTools],
    extraAllowedTools: [...o.extraAllowedTools],
    readableGlobs: [...o.readableGlobs],
    forbiddenGlobs: [...o.forbiddenGlobs],
    editableFiles: [...o.editableFiles],
    agents: o.agents as never,
    mcpServers: o.mcpServers as never,
    skills: [...o.skills],
    maxTurns: o.maxTurns,
    timeoutMs: o.timeoutMs,
    logger: o.logger,
    sessionStore: o.sessionStore,
    enforceScope: o.enforceScope,
  });
}
