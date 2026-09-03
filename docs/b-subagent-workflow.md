# B 方案：Subagent-Driven Workflow（声明制依赖）

> 状态：**已设计**（2026-09-03 讨论定稿），尚未实现。
>
> 关联：替换 `src/workflow/resolve-workflows.ts` 的"宿主先定 build → AI 抄 id"路径；
> 保留 `src/workflow/runner.ts` / `capabilities.ts` / `build-executor.ts` / `test-executor.ts` 执行引擎。

## 0. 目标

把"宿主先定 build → 生成 prompt 塞 id → AI 照抄 → 串行 resolve"换成 **test-writer 会话为中枢，工具化声明依赖，宿主按声明执行 N≥0 个 build 再跑 test**。

移除旧 resolveWorkflows 的 chooser/selection/generate 路径（git 可找回，不保留）。

## 1. 会话拓扑

```
宿主 (agent-pipeline)
  │  query() 单会话（可 resume）
  ▼
test-writer（主 agent）
  ├─ 工具: Read/Glob/Grep/Write/Edit + Task + dep-registry MCP 工具
  │        [inspectWorkflow / declareDependency / generateBuildWorkflow]
  ├─ skills: workflow-spec
  ├─ agents 注入: build-writer（tools 省略 = 继承全部，含 dep-registry 工具）
  └─ 可派 build-writer 子 agent
```

- build-writer **无 Write/Bash**：只能经 generateBuildWorkflow 产出 workflow，宿主落盘
- test-writer Write/Edit 限自己的 test workflow 文件（editableFiles）

## 2. MCP 工具契约

server `dep-registry`（createSdkMcpServer，宿主进程内实现；工具名前缀 `mcp__dep-registry__`，实测须加入 `allowedTools` 才放行）。

### 2.1 inspectWorkflow({ kind, query })
- query = `{id}` 精确 | `{}` 列出（库 + 本次 session）
- 返回元数据 `{id, kind, status: library-verified | run-local, revision, description, producedArtifacts?, sourceSnippet?}`
- 不返回大段源码（撑爆上下文）

### 2.2 declareDependency({ buildWorkflowIds: string[] })
- **幂等覆盖**：传完整声明集；空 `[]` = 显式无依赖
- 校验每个 id 已知（库 / 本次 generate 过）→ 未知 id 返回可用清单，AI 同会话修正（loop）
- 返回当前生效声明集

### 2.3 generateBuildWorkflow({ name, description, content })
- 宿主生成稳定 id `<slug>-<sessionLocal>` → 落盘 `runs/{sessionId}/workflows/build/<id>.ts`
- 落盘前 source-policy 校验（语法/禁 import/workflowKind），失败返回错误（loop）
- 幂等 create-or-replace（同 name 覆盖同 id）
- 返回 `{workflowId, revision, lineCount, description}`，不返回路径

## 3. 宿主时序

```
WORKFLOW_GENERATION
1. 开 test-writer 会话
2. test-writer 自主: inspect → (派 build-writer → generate) → declareDependency(最终集) → Write test workflow
3. 收会话: 校验 test 文件产出 / 声明集存在 / source-policy + workflowKind

BUILD
4. 解析声明集每个 id → 库文件 or runs/{sessionId}/workflows/build/<id>.ts，缺失 fail-closed
5. 循环执行每个声明的 build（baseline/candidate 各一次）任一失败 abort；空集跳过

TEST
6. executeTestWorkflow（baseline/candidate + expect 差分）
7. 后续 REFACTOR/VERIFICATION 复用现有 pipeline
```

**不注入产物**：test workflow 自己知道产物路径（从 build-writer 汇报学来，写死 + 自己 assertFile）。宿主零产物知识。N>1 自然。

## 4. 代码改造边界

**新增**
- `src/agents/workflow-session.ts`：test-writer 会话编排（query + 注入 agents/MCP + 收声明 + 打回 loop）
- `src/agents/dep-registry-server.ts`：MCP server 三工具 + handler 校验
- `src/agents/build-writer.ts`：AgentDefinition prompt（写 workflow 规范 + 汇报契约：每个产物路径+用途）
- `runs/{sessionId}/workflows/` 目录管理
- 别名表 `alias.json`（run-local id → 库 id）

**替换/删除**
- `src/agents/test-workflow.ts` / `build-workflow.ts` 的 propose（旧生成路径）
- `resolve-workflows.ts` 的 chooser/selection/generate → 读声明 + 解析文件（保留 manifest/source-policy 校验）

**保留复用**
- executeBuildWorkflow/executeTestWorkflow/runner/capabilities/worker
- source-policy、saveTestWorkflow/registry（持久化语义调整）

## 5. 别名/持久化

```
run-local id = libuv-cmake-a1b2c3 → 声明 → 执行
curator 判定入库 → 稳定 id libuv-cmake → alias.json: {"libuv-cmake-a1b2c3": "libuv-cmake"}
test 持久化时 build 引用经 alias 映射到库 id；查询按 run-local id 查 alias → 库条目
```

## 6. 安全/边界

- test-writer 越权写：editableFiles 限 runs/（现有 hook）
- build-writer 无 Write/Bash：只能 generate，宿主落盘
- 声明集校验：未知/重复（幂等）/空未确认 → loop/fail-closed
- 生成即校验：source-policy 落盘前
- 产物存在：build workflow 内 validator.assertFile（现有）
- 任一 build 失败/声明缺失/test 缺失 → abort

## 7. 落地顺序

1. dep-registry-server（三工具 + 校验）— 可单测
2. build-writer AgentDefinition + generate 落盘 + 即时校验
3. workflow-session 编排（含 resume loop）
4. resolve 段改造
5. workflow-agent-pipeline 接线
6. curator + alias.json
7. e2e：trim-app 单 build → libuv N>1

## 8. 已实测结论（2026-09-03 spike）

- createSdkMcpServer 同进程自定义工具：模型可调用、宿主 handler 捕获参数 ✅
- subagent 可调用同套 MCP 工具、结果回传父会话 ✅（实测主 agent 派子 agent 后未重复调用）
- allowedTools 需显式放行 `mcp__<server>__<tool>`，否则 acceptEdits 拒绝 ✅
- loop：工具返回文本 → 同会话可见可修正 ✅
