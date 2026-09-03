# B 方案实现计划：Subagent-Driven Workflow（声明制依赖）

> 状态：**计划**（2026-09-03）。设计依据 `docs/b-subagent-workflow.md`，边界梳理自 `src/workflow/resolve-workflows.ts`（712 行全读）。
>
> 原则：每步可独立验证；先不依赖真实 Claude 的部分先做（单测可覆盖）；e2e 最后。

## 0. 改造边界结论（来自代码梳理）

- **可删（宿主"选择"路径）**：`resolveBuild`/`resolveTest` 的 chooser 分支、`buildCandidates`/`testCandidates` 的 discover 遍历、`resolveStoredBuild`/`resolveStoredTest`（chooser 用）、`generatedSelection`/`nextRevision`、strategy 模板生成 + `generateWorkflowSource` 调用、`WorkflowRequest` 的 chooser/strategy 选项。
- **必留（校验/持久化/身份）**：`resolveBuildWorkflow`（build-workflow.ts）、`resolveTestWorkflow`（test-workflow.ts，含 build 引用一致性校验）、`save/loadBuildWorkflow`、`save/loadTestWorkflow`、`buildIdentity`、`createResolution`/`WorkflowResolution`、通用工具（requestedSource/relativeEntry/displayEntry/logicalRootKind/isWithin/errorMessage）、`generatedEntry`（改指新 runs/ 目录）。
- **策略**：保留文件骨架，重写 `resolveBuild`/`resolveTest` 主函数为声明集驱动；不动 60% 既有逻辑。

## 1. 实现步骤

### 步骤 1：dep-registry MCP server（三工具）
- 新文件：`src/agents/dep-registry-server.ts`
- 用 `createSdkMcpServer` 定义 server `dep-registry`：
  - `inspectWorkflow({kind, query})` → 库条目（已验证+描述）与本次 run-local（未验证）元数据，不含大段源码
  - `declareDependency({buildWorkflowIds})` → 幂等覆盖；校验 id 已知（库/本次生成），未知返回可用清单
  - `generateBuildWorkflow({name, description, content})` → 落盘前 source-policy 校验 → 写 `runs/{sessionId}/workflows/build/<id>.ts` → 返回 `{workflowId, revision, lineCount, description}`
- 依赖：现有 `source-policy.ts`、registry（load/discover 只读部分）
- 验证：**bun test 单测**——三工具的 handler 纯逻辑（id 校验、幂等、source-policy 拒收坏 content、元数据清单正确），不依赖 Claude。仿照现有 `source-policy`/registry 测试风格。

### 步骤 2：runs/ 目录与 generate 落盘
- 新文件或并入步骤 1：session workflow 目录管理 `runs/{sessionId}/workflows/{build,test}/`
- 目录归属：本次 session 生成物；resolve 需要稳定存在到执行结束；可归档/清理
- 验证：单测——generate 幂等 create-or-replace、路径安全（id slug 化、防穿越）

### 步骤 3：build-writer AgentDefinition
- 新文件：`src/agents/build-writer.ts`
- tools 省略（继承父，含 dep-registry）；**无 Write/Bash**（只经 generate 产出）
- prompt 核心：如何写 workflow-driven BuildWorkflow（复用 BUILD_WORKFLOW_SYSTEM 规范）+ **汇报契约**——返回内容必须含：产出每个可执行/文件的路径 + 用途 + 怎么跑
- 验证：prompt 静态检查（无 Write/Bash 声明、含汇报契约关键词）；真实行为留 e2e

### 步骤 4：workflow-session.ts（test-writer 会话编排）
- 新文件：`src/agents/workflow-session.ts`
- query 单会话（resume 支持 loop）：注入 agents（build-writer）、mcpServers（dep-registry）、skills、editableFiles 限 runs/ 下 test 文件
- 收会话后校验：test workflow 文件产出？声明集记录存在（空需显式 set[]）？source-policy + workflowKind？任一缺 → 打回同会话（resume）loop
- 验证：可用 mock query 层单测编排逻辑；真实会话 e2e

### 步骤 5：resolve-workflows.ts 重构（声明集驱动）
- 改 `resolveBuild`/`resolveTest` 主函数：
  - build：输入声明集 → 逐个 `resolveBuildWorkflow`（校验/生成 manifest）→ 返回 resolutions[]
  - test：输入 test entry → `resolveTestWorkflow` → 校验其声明的 build id ∈ 宿主将执行集合
- mode 扩展：`WorkflowResolution` 加 `declared`；删 chooser/strategy/generate 分支
- 验证：现有 resolve 相关单测更新 + tsc + bun test 全量

### 步骤 6：workflow-agent-pipeline 接线
- 替换 WORKFLOW_RESOLUTION 段：调 workflow-session + 声明集 → 循环执行 build（executeBuildWorkflow baseline/candidate）→ executeTestWorkflow
- 删旧 propose/chooser 调用链
- 验证：tsc + 既有单测修复；e2e

### 步骤 7：curator + alias.json（持久化收口，可后置）
- run 结束验证通过后：curator 判定可入库 → 稳定 id → 写库 + alias.json（run-local → 库 id）
- test 持久化时 build 引用经 alias 映射
- 验证：alias 查询单测（按持久化前 id 查到库条目）

### 步骤 8：e2e
- trim-app 单 build 声明化跑通（test-writer 会话 → declareDependency → 宿主执行 → 差分）
- libuv N>1（多 build 声明 + 执行 + test 引用多产物）
- 验证：状态机 ACCEPTED + 无 AI 自 rebuild（产物来自声明 build）

## 2. 依赖关系

```
步骤1 ─→ 步骤2（目录）
步骤1+3 ─→ 步骤4（会话用 server + build-writer 定义）
步骤2+5 ─→ 步骤6（pipeline 用 session + resolve）
步骤6 ─→ 步骤7（curator 在 run 后）
步骤4+5+6 ─→ 步骤8（e2e）
```

## 3. 风险

- **test-writer 不主动调工具**：prompt 强调 + 收尾强制校验（未声明/未产出 → 打回）兜底
- **build-writer 汇报缺产物路径**：prompt 汇报契约 + e2e 验证；缺失则 test 自己 assertFile 会 fail → 可发现
- **resume loop 稳定性**：SDK resume 需实测（会话状态/工具历史）
- **多 build 执行时长**：N 个 build 串行 ×2 side，超时需宿主级 timeout 管理（沿用现有）

## 4. 验收标准

- [ ] 三工具单测通过（不依赖 Claude）
- [ ] resolve 重构后 bun test 全量绿 + tsc 过
- [ ] trim-app e2e：test-writer 声明 → 宿主执行声明 build → test 复用产物（无自 rebuild）→ ACCEPTED
- [ ] libuv e2e：N>1 声明 + 多 build 执行 + 差分裁决
- [ ] curator 入库 + alias 查询可用
