# 工作进展汇报：把 Build/Test Workflow 的编写改造成 Subagent 协作

## 一、背景与问题

我们的安全重构系统里，行为验证依赖 AI 生成两类可复用 TypeScript workflow：
- **BuildWorkflow**：驱动真实构建（CMake 等），产出可执行文件，用 `validator.assertFile` 断言产物存在（fail-closed）
- **TestWorkflow**：自驱动，在 baseline/candidate 两侧各跑一次测试，声明 expectations，由宿主差分裁决行为是否保持

**原实现的问题**（一次 libuv e2e 暴露）：
1. Test 编写者不知道 Build 的产物在哪个目录 → 它自己重新构建一份到新目录（白花 ~10 分钟，且测的是自己编的那份）
2. 宿主"先定 Build → 把 id 塞进 prompt → AI 照抄"——强制拆开两者，test 无法按需影响 build，也不能复用已验证的构建
3. Build 编写是一次性、无状态，跑完即弃，没有"通用构建入库复用"的机制

## 二、探索与权衡

我们评估了三种方向：

| 方向 | 思路 | 权衡 |
|---|---|---|
| A. 协议化交接 | build workflow 声明产物契约（`produces`），宿主执行后写 manifest 注入 test | 可控、fail-closed 保留，但"宿主解析/传递产物知识"，与现有"产物是 workflow 内部知识"的架构冲突，且 test 仍被动 |
| B. 宿主预执行 build + 缓存复用 | 写完后台预构建 baseline，产物缓存 | 收益只在"提前 catch 机械性写错"，但正式流程仍要按 baseline/candidate 各构建一次，复杂度高（后台进程生命周期），收益小 → **放弃** |
| C. **Subagent 协作（采纳）** | test-writer 会话中可派 build-writer 子 agent；build-writer 经工具产出 workflow 并向 test-writer **汇报产物路径与用法**（自然语言，AI 理解）；test-writer 用 `declareDependency` 工具**显式声明依赖集**（可空、可多个）；宿主在跑 test 前**循环执行声明的全部 build** | test 主动、产物知识由 AI 传递（test 写死路径 + 自己 assertFile，宿主零产物知识）；N 个 build 天然支持；声明 = 审计线索 |

**为什么选 C**：
- 产物知识本属于"这次任务定制"的 workflow，不该由宿主结构化管理——AI 之间的自然语言汇报（build-writer 告诉 test-writer）足够且更灵活
- test 显式声明依赖（即使空集也要 set）→ 宿主可校验、可 fail-closed、可审计，不靠解析 AI 意图
- 子 agent 机制是 Claude Code 一等公民，且我们能程序化注入 agent 定义、精确控制权限
- build-writer 不给写文件工具，只经 `generateBuildWorkflow` 工具产出（宿主落盘 + 即时校验）→ 与存储位置解耦，以后随便换存储/入库，AI 提示词不用改

**关键权衡点**：
- "先交计划再执行"（早期方案 P2/P3）被否：重构是探索性的，无法提前拿到准确 plan；安全靠事后 diff 审计 + 行为差分，不是审 AI 自报的意图
- 强制结构化汇报被否：subagent 结果回传父会话是自然的，AI 理解足够，不必 schema 化
- 中途预构建验证被否（收益小、复杂度高）

## 三、验证（已实测）

用最小 spike 验证了 C 方案的机制可行性（真实 Claude 会话）：
1. 同进程自定义工具（`createSdkMcpServer`）：模型能调用，宿主 handler 捕获参数 ✅
2. **子 agent 能调用同一套工具，结果回传父会话**（主 agent 派子 agent 后未重复调用，说明信任其结果）✅
3. 权限精确控制：`allowedTools` 放行才可用，否则被 permission 拒绝 → 宿主控制谁可调 ✅
4. loop：工具返回错误文本 → 同会话可见可修正 ✅

结论：机制全部成立，无不可行项。

## 四、最终方案

**会话拓扑**：
```
宿主 (agent-pipeline)
  │  query() 单会话（可 resume）
  ▼
test-writer（主 agent）
  ├─ 工具: Read/Glob/Grep/Write/Edit + Task + dep-registry MCP 工具
  ├─ agents 注入: build-writer（tools 继承，无 Write/Bash）
  └─ 可派 build-writer 子 agent
```

**工具集**（test-writer 专属，宿主进程内 MCP server `dep-registry`）：
- `inspectWorkflow`：查库（已验证条目 + 描述）与本次生成的 workflow
- `declareDependency({buildWorkflowIds})`：幂等声明依赖集（空 = 显式无依赖），未知 id 返回可用清单
- `generateBuildWorkflow({name, description, content})`：宿主落盘 + 即时 source-policy 校验，返回 id

**宿主时序**：
```
test-writer 会话 → 产出 test workflow + 声明集
宿主校验（文件产出？声明集存在？source-policy？）
→ 解析声明集每个 build（库 / 本次生成）→ 循环执行（baseline/candidate）
→ 执行 test workflow → expect 差分 → 后续 REFACTOR/VERIFICATION 复用现有 pipeline
```

**持久化/复用**：run 结束后 curator 判定可入库的 build → 赋稳定 id 入库，登记别名表（run-local id → 库 id）；test 持久化时 build 引用经别名映射。未来 test-writer 可直接声明库条目复用已验证构建。

**边界梳理结果**（resolve-workflows.ts，712 行）：
- 删：chooser/discover 选择编排、strategy 模板生成、旧 generateWorkflowSource 调用（约 40%）
- 留：resolveBuildWorkflow/resolveTestWorkflow 的校验与 manifest、registry 持久化、身份一致性校验、审计结构
- 改：resolveBuild/resolveTest 主函数为声明集驱动；WorkflowResolution 加 declared mode

## 五、落地计划

已产出设计文档 `docs/b-subagent-workflow.md` + 实现计划 `docs/b-subagent-workflow-plan.md`（8 步，先做不依赖 Claude 的部分，e2e 最后）：
1. dep-registry MCP server 三工具（可单测）
2. runs/ 目录与 generate 落盘
3. build-writer AgentDefinition（无 Write/Bash + 汇报契约）
4. workflow-session 编排（test-writer 会话 + resume loop）
5. resolve-workflows.ts 声明集重构
6. workflow-agent-pipeline 接线
7. curator + alias.json
8. e2e（trim-app 单 build → libuv N>1）

## 六、风险

- test-writer 不主动调工具 → prompt 强调 + 收尾强制校验打回
- build-writer 汇报缺产物路径 → 汇报契约 + e2e 发现（test assertFile 会 fail）
- resume loop 稳定性 → SDK 需实测
- N 个 build 串行执行时长 → 沿用现有宿主 timeout
