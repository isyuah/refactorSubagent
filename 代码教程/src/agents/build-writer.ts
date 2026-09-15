/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/agents/build-writer.ts —— build-writer 子代理的"出生证明"
 *
 * 【这个文件是干什么的】
 *   导出 buildWriterDefinition()：一个 SDK 的 AgentDefinition（子代理定义），
 *   被 workflow-session.ts 注入 test-writer 主会话的 `agents` 选项。test-writer
 *   需要新构建时就派这个子代理去"写 BuildWorkflow 源码"。
 *
 * 【安全模型（本文件最重要的一段）】
 *   build-writer 没有 Write/Edit/Bash 工具。它唯一的"写路径"是宿主侧的
 *   dep-registry MCP 服务器（generateBuildWorkflow 工具）：源码先被宿主校验
 *   （source-policy），再由宿主落盘到 runs/ 目录——子代理永远碰不到仓库本身。
 *
 * 【MCP 可见性规则（改版踩过坑后写死的）】
 *   AgentDefinition 给了显式 `tools` 列表就不会继承父会话的 MCP 工具！
 *   所以子代理必须：① 在 tools 里点名 mcp__dep-registry__* 工具；
 *   ② 用 mcpServers 按名字引用父会话的 in-process server（SDK 会桥接）。
 *
 * 【汇报契约】生成完成后，子代理的最后一条消息必须报告 workflow id +
 * 每个产物路径及用途——test-writer 就靠这份汇报得知产物路径并写进自己的
 * 源码（宿主零产物知识，这是 B 方案"产物通知"的解法）。
 *
 * 【本文件是教程注释版】原文件 src/agents/build-writer.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

// AgentDefinition 现在直接用 SDK 的类型（不再本地自定义 interface——改版前的本地版已删）。
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { BUILD_WORKFLOW_SYSTEM } from "./prompts.js";   // 写作规范复用 prompts.ts 的大段系统提示词

/**
 * build-writer — AgentDefinition for the subagent that authors
 * workflow-driven BuildWorkflow sources on request of the test-writer.
 *
 * Security model: the build-writer has NO Write/Edit/Bash tools. Its only
 * write path is the host-side dep-registry MCP server (generateBuildWorkflow),
 * which validates the produced source before materializing it under the run
 * directory — the writer can never touch the repository itself.
 *
 * MCP visibility: an AgentDefinition with an explicit `tools` list does NOT
 * inherit the parent session's MCP tools. The writer must name its MCP tools
 * in `tools` AND declare the server in `mcpServers` (the SDK bridges the
 * parent's in-process server to the subagent by name).
 *
 * Reporting contract: after generating, the writer's final message must tell
 * the caller what was produced — the workflow id, and every artifact path the
 * build will create with its purpose — so the test-writer can reference those
 * paths (the host does not inject artifact locations).
 */

// ── WRITING_RULES：怎么写、用什么工具写、失败了怎么办 ─────────────────────
// 要点：① 只能经 generateBuildWorkflow 产出源码；② 参数 { name, description,
// content }，content 是完整 TS 模块；③ 宿主校验失败会返回错误 → 修了再交（loop）。
const WRITING_RULES = `You write workflow-driven BuildWorkflow TypeScript sources.

Write via the generateBuildWorkflow MCP tool — you have no file-write tools.
The tool's exact name in this session is mcp__dep-registry__generateBuildWorkflow
(it may also appear without the prefix in tool descriptions). Call it with:
  { name, description, content }
where content is the COMPLETE TypeScript module. The host validates it before
saving and returns the assigned workflow_id on success, or the validation error
on failure — fix the content and call generateBuildWorkflow again until it
succeeds.

Tool availability in this session:
  - Read / Glob / Grep — inspect the repository (CMakeLists.txt, cmake/, src/,
    include/, tests/) to write a correct build.
  - mcp__dep-registry__generateBuildWorkflow — materialize your produced source.
  - mcp__dep-registry__inspectWorkflow — check whether a suitable build already
    exists before writing a new one (prefer reuse).
You cannot write files, run shell commands, or edit the repository.`;

// ── REPORTING_CONTRACT：汇报契约（B 方案"产物通知"的关键一环）──────────────
// 子代理最后一条消息必须列全：workflow id + 每个产物路径（是什么/测试怎么调它）
// + 对构建环境的假设。test-writer 靠它知道产物路径（宿主不注入）。
const REPORTING_CONTRACT = `After your workflow is generated, your FINAL message must report to the caller:
  1. the assigned workflow_id,
  2. EVERY artifact path the build produces (executables, libraries) with one
     line each: path + what it is + how the test can invoke it,
  3. any assumptions about the build environment you encoded (toolchain,
     generator, build directory).
This report is how the test-writer learns what exists; be precise and complete
about artifact paths — do not omit any produced executable.`;

// ── DECISION_RULES：生成前先看清项目 ────────────────────────────────────
// 构建系统/目标/产物位置要靠 Read/Glob/Grep 实地考察；源码里用 process.run
// 真跑 configure+build，再逐个 assertFile。CMake --target 一次一个。
const DECISION_RULES = `Before generating, inspect the repository enough to know:
  - the primary build system (CMakeLists.txt / Makefile / configure),
  - the target(s) needed to produce test executables,
  - the expected artifact locations.
Drive the real build in the workflow (configure + build via context.process.run
in the source), then assert every artifact with context.validator.assertFile.
CMake --target accepts exactly ONE target per process.run call — run separate
calls per target.`;

/**
 * Build the build-writer agent definition for injection into a test-writer
 * session via `agents` option. `mcpServerName` must match the dep-registry
 * server name so the tool allowlist lines up with actual tool names.
 */
// ── buildWriterDefinition：子代理定义工厂 ───────────────────────────────
// 【参数】mcpServerName：dep-registry server 的名字（默认 "dep-registry"），
//   必须与宿主注册的 server 名一致——工具名 mcp__<server>__<tool} 是拼出来的。
// 【返回】AgentDefinition —— 交给 workflow-session.ts 的 agents 选项。
export function buildWriterDefinition(
  mcpServerName = "dep-registry",
): AgentDefinition {
  const generateTool = `mcp__${mcpServerName}__generateBuildWorkflow`;   // 模板字符串拼工具全名
  const inspectTool = `mcp__${mcpServerName}__inspectWorkflow`;
  return {
    description:
      "Writes a workflow-driven BuildWorkflow (TypeScript source) on request. " +
      "Inspects the repository and produces a validated build workflow via the " +
      `generateBuildWorkflow tool (${generateTool}). Use when a test workflow ` +
      "needs a build that does not already exist or is not suitable.",   // description 是主代理"何时派它"的依据
    tools: [
      "Read",
      "Glob",
      "Grep",
      // The agent's only write path is the host-side registry: it must be
      // able to call generateBuildWorkflow (and inspect existing builds).
      // An explicit tools list does NOT inherit parent MCP tools, so name
      // them here AND declare the server in mcpServers below.
      // ↑ ★ 显式 tools 列表不继承父会话的 MCP 工具——必须点名 + 声明 server。
      generateTool,
      inspectTool,
    ],
    // Reference the parent session's dep-registry server by name so this
    // subagent can reach the host-side registry (the SDK bridges the
    // in-process server to the subagent by server name).
    mcpServers: [mcpServerName],   // ★ 按名字引用父会话的 in-process server（SDK 负责桥接）
    prompt: [
      BUILD_WORKFLOW_SYSTEM,   // 写作规范（prompts.ts 的大段系统提示词）
      WRITING_RULES,
      DECISION_RULES,
      REPORTING_CONTRACT,
      `MCP tools available in this session: ${generateTool} and ${inspectTool}. ` +
        `Prefer ${inspectTool} to check whether a suitable build already exists ` +
        "before generating a new one.",   // 复用优先：先查库再写新的
    ].join("\n\n"),
  };
}
