/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/agents/dep-registry-server.ts —— 把"账本"包成 AI 能点的按钮
 *
 * 【这个文件是干什么的】
 *   上一站 dep-registry.ts 里那本账本是普通的 TypeScript 类，AI 根本"看不见"
 *   它。这个文件用 SDK 的 createSdkMcpServer 把账本的三个方法包装成 MCP 工具，
 *   塞进 Claude 会话；AI 调用工具 → SDK 回到宿主进程 → 宿主调用真正的账本方法
 *   → 把结果变成文本回给 AI。它只做"翻译"（参数进、文本出），所有判断逻辑都在
 *   dep-registry.ts —— 所以这个文件很薄，也不需要测真实 Claude。
 *
 * 【小白词典：MCP server / 工具前缀 / allowedTools】（本文件集中讲一次）
 *   - MCP server：按 MCP 协议提供"工具清单"的一端。这里用的是 SDK 的
 *     createSdkMcpServer —— 不另起进程，就在宿主进程里注册几个 handler 函数，
 *     AI 调用时原地执行（对比"stdio 型 MCP server"要真开一个子进程）。
 *   - 工具前缀：会话里工具的真实名字是 `mcp__<服务器名>__<工具名>`，比如
 *     `mcp__dep-registry__generateBuildWorkflow`。双下划线是分隔符，提示词里
 *     必须用全名，AI 才点得到。
 *   - allowedTools：⚠️ 实测结论（设计文档 §8）—— 光把 server 注入会话还不够，
 *     工具名必须再写进 allowedTools 白名单，否则 SDK 的 acceptEdits 权限模式
 *     会把它拒掉。这一步在 workflow-session.ts 里做（extraAllowedTools）。
 *
 * 【关系图（谁调谁）】
 *   workflow-session.ts
 *     ├─ new LocalDependencyRegistry()            ← 真正的账本（dep-registry.ts）
 *     ├─ createDependencyMcpServer({ registry })  ← 本文件，把账本包成 server
 *     │     └─ 塞进 query 的 mcpServers 选项，名字 "dep-registry"
 *     │           ├─ inspectWorkflow      → registry.inspect()
 *     │           ├─ declareDependency    → registry.declare()
 *     │           └─ generateBuildWorkflow→ registry.generate()
 *     └─ test-writer（主 agent）/ build-writer（子代理）在会话里调用这三个工具
 *
 * 【在 B 方案时序里的位置】WORKFLOW_GENERATION 阶段；BUILD / TEST 阶段不再有它
 *   （那时宿主直接读 registry，不再走 AI 工具）。
 *
 * 【先修知识】src/agents/dep-registry.ts（账本本体）；src/agents/driver.ts 的
 *   【小白词典】（query / 会话 / 工具）；Zod 的基本用法（本文件有一处）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/agents/dep-registry-server.ts（代码与本文件逐字一致，仅多中文注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"; // ← SDK 提供的"进程内 MCP server"工厂 + 它的返回类型（`type` 表示只导入类型）
import { z } from "zod"; // ← Zod：参数校验库。`z.object({...})` 定义"参数长什么样"，.parse() 像海关安检：不合格就抛错
import type {
  DependencyRegistry,
  InspectQuery,
} from "./dep-registry.js"; // ← 账本的接口 + 查询参数类型（只导入类型，运行时不存在）

/**
 * dep-registry MCP server binding. Exposes the host-side dependency registry
 * (inspect/declare/generate) as tools the test-writer session can call.
 *
 * The heavy logic lives in dep-registry.ts (unit-tested without Claude); this
 * file only adapts tool arguments/results to the MCP surface.
 */
// ↑ 原注释：dep-registry 的 MCP server 绑定层。把宿主侧依赖登记簿的
//   inspect/declare/generate 暴露成 test-writer 会话可调用的工具。
//   重量级逻辑都在 dep-registry.ts（不依赖 Claude 即可单测）；本文件只负责
//   把工具参数/结果适配到 MCP 接口上。

// ── 三个 Zod schema：给三个工具各配一张"参数说明书" ─────────────────────
// 【作用】① SDK 会拿它生成给 AI 看的参数说明；② handler 里再用 .parse() 真正
//   校验一次（不信任模型给的东西，fail-closed）。
// 【语法】z.enum([...]) 只许这几个值；z.string().min(1) 至少 1 个字符；
//   .optional() 可以不传；.default("") 不传时按空串处理；z.array(...) 数组。
const InspectInput = z.object({
  kind: z.enum(["build", "test"]),
  id: z.string().min(1).optional(), // ← 可选：传了就精确查这一个 id
});

const DeclareInput = z.object({
  buildWorkflowIds: z.array(z.string().min(1)), // ← 完整依赖集（可为空数组 = 显式无依赖）
});

const GenerateInput = z.object({
  name: z.string().min(1).max(128), // ← 短名：1~128 字符（宿主还要再 slug 化）
  description: z.string().max(1024).optional().default(""), // ← 描述可省，默认空串
  content: z.string().min(1), // ← 完整 TypeScript 源码，不许空
});

// ── DependencyMcpServerOptions：创建 server 时要给的东西 ────────────────
export interface DependencyMcpServerOptions {
  readonly registry: DependencyRegistry; // ← 那本账本（只依赖接口，不依赖具体类）
  readonly serverName?: string; // ← 服务器名（决定工具前缀），默认 "dep-registry"
}

/**
 * Build an MCP server exposing the dependency registry to a Claude Code
 * session. Returns the SDK in-process server instance; the caller passes it
 * into query options under `mcpServers`.
 *
 * Tool names in the session are `mcp__<serverName>__<tool>` and must be listed
 * in `allowedTools` to be auto-allowed (verified by spike).
 */
// ↑ 原注释：构造一个把依赖登记簿暴露给 Claude Code 会话的 MCP server。
//   返回 SDK 的进程内 server 实例；调用方把它放进 query 选项的 `mcpServers` 里。
//   会话中的工具名是 `mcp__<serverName>__<tool>`，必须列进 `allowedTools`
//   才会被自动放行（spike 已实测验证）。
// ── createDependencyMcpServer：本文件唯一的导出函数 ─────────────────────
// 【作用】把账本包成 3 个工具，返回可直接塞进 query({options:{mcpServers}})
//   的对象。
// 【参数】options.registry —— 账本实例；options.serverName —— 服务器名。
// 【返回】McpSdkServerConfigWithInstance —— SDK 定义的"进程内 server 配置"，
//   workflow-session.ts 原样放进 mcpServers: { "dep-registry": 返回值 }。
// 【关系】workflow-session.ts 调用；AI 在会话里点工具 → 走到这里注册的 handler
//   → 调 registry 的方法 → 文本结果回给 AI。
export function createDependencyMcpServer(
  options: DependencyMcpServerOptions,
): McpSdkServerConfigWithInstance {
  const registry = options.registry; // ← 拎出来，下面三个 handler 都要用（闭包：函数记住外面的变量）
  const name = options.serverName ?? "dep-registry"; // ← `??` 空值合并：没传就用默认名。⚠️ build-writer.ts 的提示词是按这个名字拼工具全名的，改名要两头一起改

  return createSdkMcpServer({
    name,
    version: "1.0.0",
    instructions: // ← 给 AI 的"使用说明书"：会话一开始就能看到，讲清三个工具各干嘛、怎么配合
      "Dependency registry for workflow-driven verification. " +
      "inspectWorkflow lists available build workflows (persisted library or " +
      "created this run); declareDependency declares which build workflows the " +
      "test workflow depends on (call with the full set, empty for none); " +
      "generateBuildWorkflow materializes a new workflow-driven BuildWorkflow.",
    tools: [ // ← 工具清单：每个工具 = 名字 + 描述 + 参数 schema + handler
      {
        name: "inspectWorkflow",
        description:
          "List build workflows available for dependency declaration: persisted " +
          "library entries (status library-verified or library-draft) and entries " +
          "generated this run (status run-local). Omit id to list all of a kind.",
        inputSchema: InspectInput.shape, // ← `.shape` 取出 Zod object 的字段定义（SDK 要的就是这个形状，不是整个 z.object）
        handler: async (args: Record<string, unknown>) => { // ← 真正干活的函数：args 是 AI 传来的参数（类型上不可信）
          try {
            const parsed = InspectInput.parse(args); // ← 安检：参数形状不对就抛 ZodError，落到下面的 catch
            const query: InspectQuery = {
              kind: parsed.kind,
              ...(parsed.id !== undefined ? { id: parsed.id } : {}), // ← 条件展开：id 有值才加进对象，没有就保持"字段不存在"（不能写成 id: undefined，那会和"没传"在语义上打架）
            };
            const result = await registry.inspect(query); // ← 调真账本
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], // ← 工具结果必须是文本；JSON.stringify(…, null, 2) = 缩进 2 空格的漂亮 JSON
            };
          } catch (error) {
            return {
              content: [{
                type: "text" as const,
                text: `inspectWorkflow failed: ${errorMessage(error)}`,
              }],
              isError: true, // ← 标记"这次工具调用失败了"，AI 会看到失败标记并据此改正 —— 这就是 B 方案的 loop 机制
            };
          }
        },
      },
      {
        name: "declareDependency",
        description:
          "Declare the full set of build workflow ids this test workflow depends " +
          "on (idempotent overwrite). Pass an empty array to explicitly declare no " +
          "dependency. The host executes every declared build before running the " +
          "test workflow.",
        inputSchema: DeclareInput.shape,
        handler: async (args: Record<string, unknown>) => {
          try {
            const parsed = DeclareInput.parse(args);
            const declared = await registry.declare({ buildWorkflowIds: parsed.buildWorkflowIds }); // ← 账本里会校验 id 是否已知；未知 id 在这里变成 throw
            return {
              content: [{
                type: "text" as const,
                text: `declared build dependencies: ${JSON.stringify(declared)}`, // ← 回显生效名单，AI 能确认"声明成功 + 内容对不对"
              }],
            };
          } catch (error) {
            return {
              content: [{
                type: "text" as const,
                text: `declareDependency failed: ${errorMessage(error)}`, // ← 错误文本里带着"可用 id 清单"（见 dep-registry.ts 的 declare），AI 同会话即可修正
              }],
              isError: true,
            };
          }
        },
      },
      {
        name: "generateBuildWorkflow",
        description:
          "Materialize a workflow-driven BuildWorkflow source. Provide a short " +
          "name, a description of what it builds and produces, and the complete " +
          "TypeScript source. The host validates the source before writing; on " +
          "failure no file is created and the error is returned. Returns the " +
          "assigned workflow id for use in declareDependency.",
        inputSchema: GenerateInput.shape,
        handler: async (args: Record<string, unknown>) => {
          try {
            const parsed = GenerateInput.parse(args);
            const result = await registry.generate({ // ← 账本里先跑 source-policy 安检，通过才写盘
              name: parsed.name,
              description: parsed.description,
              content: parsed.content,
            });
            return {
              content: [{
                type: "text" as const,
                text: [ // ← 成功回执拼成几行易读的文本（而不是一大坨 JSON）
                  `generated build workflow:`,
                  `  workflow_id: ${result.workflowId}`, // ← AI 要拿这个 id 去 declareDependency 报名
                  `  revision: ${String(result.revision)}`, // ← String() 把数字转成文本方便拼接
                  `  lines: ${String(result.lineCount)}`,
                  result.description.length > 0 ? `  description: ${result.description}` : "", // ← 描述为空就给个空串，下一行把它滤掉
                ].filter((line) => line.length > 0).join("\n"), // ← filter 去掉空行，join 用换行拼起来
              }],
            };
          } catch (error) {
            return {
              content: [{
                type: "text" as const,
                text: `generateBuildWorkflow failed: ${errorMessage(error)}`, // ← 安检没过：磁盘上什么都没写，AI 看到原因后改源码重交
              }],
              isError: true,
            };
          }
        },
      },
    ],
  });
}

// ── errorMessage：把 throw 出来的东西变成字符串（与 dep-registry.ts 里同款）──
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
