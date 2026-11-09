# Behavior-Preserving Refactoring Agent：项目现状与后续路线

> 文档日期：2026-11-04（§1–§11 为当前状态；带日期的验证记录对应各自里程碑，历史架构见文末附录）
>
> 当前定位：面向 C 代码的行为保持型重构原型。闭环已在 Windows + MinGW + Claude Agent SDK 环境完成真实端到端验证（含首个 `ACCEPTED`）；已补齐 Windows/Linux 工程检查与 CI 配置，并统一进程超时、取消和回收。验证记录见 §8.5–§8.6，平台级宿主隔离仍待实现。

## 1. 项目目标

本项目不是单纯让 Claude 修改代码，而是把职责拆开：

```text
Claude / LLM
  ├─ 理解 C 代码
  ├─ 编写可执行的 BuildWorkflow / TestWorkflow 源
  ├─ 声明依赖与期望
  └─ 在一次性 worktree 中重构

程序 Orchestrator / Runtime
  ├─ 校验 Artifact Schema
  ├─ 管理状态机和持久化
  ├─ 解析并执行 workflow（进程/文件能力代理）
  ├─ 管理 Git worktree
  ├─ 测量主机环境
  ├─ 执行 baseline / candidate 构建与测试
  ├─ 比较两侧可观测行为与声明期望
  └─ 接受或拒绝 patch
```

核心原则：

> Claude 负责理解、设计和修改；程序负责执行、验证和最终决定。

模型不能自行把"测试失败"解释成无关问题，也不能自行把候选 patch 标记为安全。无法证明安全时，流程进入拒绝或中止状态。

**关于修改边界的决策（2026-09-04 定稿）**：早期版本用 `ScopeManifest`（可编辑文件白名单）+ `PreToolUse` hook + R4 patch 范围校验来约束模型。该机制已**整体删除**（提交 `66f462e`），原因有二：

1. 宿主无法预声明"重构会改哪些文件"——真实重构会拆分文件，拆分结果只有模型知道；
2. 读侧放开后 `Grep` 与 `Read` 的内容面等价，单独拦 `Grep` 无增益。

取代它的边界是四条的组合：

```text
SDK 工具白名单（每会话显式列出）    限制能做什么
deny 规则（Bash(git push:*)）       挡住逃出本机、不可本地撤销的操作
一次性 worktree / session 目录      限制能破坏什么（agent 有 shell 后这层变薄）
baseline/candidate 行为门禁          限制能蒙混过关什么
```

**关于 Bash（当前状态）**：test-writer 与 build-writer 已暂时从各自工具列表移除 Bash，
根据源码与 Preflight 事实交付代码，实际编译和测试由宿主随后执行（§8.18）。
refactor agent 仍可在一次性 worktree 之外编译检查自己的修改。2026-09-10 曾让三个角色
都使用 shell 的方案保留为历史决策，不再描述当前编写流程。
工具列表不是文件系统隔离：Write/Edit 及 refactor 的 shell 仍可触及用户权限可达的路径。
宿主继续重新测量 diff（§5.2）、固定验证材料并重跑权威 workflow；真正的隔离仍待平台层（§9.1）。
`git push` 通过 deny 规则挡住（实测有效），其余风险依靠一次性环境与完整性检查降低。

## 2. 当前技术栈与验证环境

### 2.1 项目运行时

- TypeScript / Bun
- TypeScript 5.7.3：宿主、脚本、工程测试和测试集执行器的严格类型检查
- Zod：Artifact 与配置的运行时 Schema 校验
- `@anthropic-ai/claude-agent-sdk` 0.3.259：驱动 Claude Code
- pino：运行日志
- Git：worktree 隔离与候选 patch 管理
- GCC / MinGW：当前 C 构建后端

```json
{
  "@anthropic-ai/claude-agent-sdk": "0.3.259",
  "pino": "^10.3.1",
  "zod": "^3.23.8"
}
```

### 2.2 已验证主机

- Windows 11 x64
- Bun 1.3.x
- GCC 15.2.0 / MinGW、CMake 4.3.1、Ninja、CTest
- Git 2.53
- Claude Code CLI

新增 Linux 验证环境：WSL Ubuntu 24.04、Bun 1.3.14、GCC 13.3.0、CMake 3.28.3、Ninja 1.11.1。
CI 矩阵为 Ubuntu 24.04 / Windows Server 2022，固定 Bun 1.3.14；已触发远程任务，首轮结果与探测修复见 §8.6。

项目已经处理 Windows 下的几个实际边界：

- native Claude 可执行文件与 `claude.cmd` 的启动入口差异；
- `cc` 不一定存在，实际编译器可能是 `gcc.exe`；
- gcc 输出程序通常带 `.exe`；
- `mkdir -p` 不是 `cmd.exe` 语法；
- Windows 进程 argv 不能包含 NUL 字节；
- `where.exe` 和部分工具版本命令启动缓慢，HostPreflight 不能串行依赖它们；
- 进程树由 Windows Job Object 管理，覆盖根进程先退出、子孙仍占用管道的情况。

## 3. 代码结构

```text
src/
├─ config/
│  ├─ layers.ts                  多源配置引擎（默认 < 用户 < 项目 < 显式文件 < 标量覆盖）
│  ├─ limits.ts                  超时/资源阈值（基于 layers.ts）
│  └─ pipeline.ts                阶段来源配置：把配置翻译成阶段函数
│
├─ artifacts/                    Artifact Schema（Zod）
│  ├─ behavior-contract.ts       行为契约
│  ├─ dependency-manifest.ts     依赖与隔离策略
│  ├─ environment-spec.ts        构建环境（direct / cmake / ninja / workflow-driven）
│  ├─ host-preflight.ts          主机环境事实 Schema
│  ├─ project-detection.ts       项目构建系统探测结果
│  ├─ test-spec.ts               回归 / 差分用例
│  ├─ observation-trace.ts       邀请级行为观测
│  ├─ comparison-result.ts       通道比较结果
│  ├─ patch-record.ts            候选 patch 信息（审计用）
│  ├─ ctest-suite.ts             CTest 套件 spec/结果/失败分类/比较
│  ├─ expectation-suite.ts       自驱动期望：baseline / candidate / 比较
│  ├─ declared-build-set.ts      声明集 Resolution（单凭证承载整个声明）
│  ├─ build-workflow.ts          BuildWorkflow 输出与 Artifact 描述
│  ├─ test-workflow.ts           TestWorkflow 解析与 CTest 物化策略
│  ├─ workflow-resolution.ts     workflow 解析结果与来源 hash
│  ├─ refactor-task.ts           固定 libuv 任务定义
│  ├─ sanitizer.ts               sanitizer 能力类型（探测/注入用）
│  ├─ common.ts                  路径、hash、base64 等公共 Schema
│  └─ index.ts                   Artifact 联合导出
│
├─ orchestrator/
│  ├─ orchestrator.ts            fail-closed 状态机（唯一能推进状态者）
│  └─ store.ts                   Session / Artifact 持久化与 reopen
│
├─ runtime/
│  ├─ host-preflight.ts          程序化主机探测
│  ├─ project-detector.ts        C 项目构建系统探测
│  ├─ worktree.ts                baseline / candidate 隔离
│  ├─ ctest-runner.ts            CTest 执行与输出解析
│  ├─ ctest-comparator.ts        套件失败分类与差分比较
│  ├─ workflow-pipeline.ts       验证阶段：build → test → compare
│  ├─ verification-integrity.ts  受控源码、workflow 与固定输入的执行边界检查
│  ├─ stage-flow.ts              阶段契约 + 组合器（AI 与预置阶段共用）
│  ├─ stage-presets.ts           无 AI 预置阶段（预置 workflow / 补丁 / 既有分支）
│  ├─ e2e-log.ts                 结构化运行日志（JSONL + state.json）
│  ├─ e2e-dashboard.ts           历史 WebUI + SSE（当前废弃，不维护）
│  ├─ progress.ts                带类型的运行事件与统一报告
│  ├─ workflow-progress.ts       实际进程输出的日志与事件适配
│  ├─ session-store.ts           AI 会话转录镜像
│  ├─ fs-snapshot.ts             文件系统快照和副作用 diff
│  └─ log.ts                     pino 日志与心跳
│
├─ workflow/
│  ├─ runner.ts                  workflow 子进程运行器（含超时/终止）
│  ├─ worker.ts                  workflow 子进程入口
│  ├─ capabilities.ts            LocalCapabilityBroker（宿主侧能力实现）
│  ├─ client.ts                  worker 侧能力代理
│  ├─ capability-protocol.ts     JSONL 能力协议
│  ├─ types.ts                   Workflow / Capability 类型
│  ├─ source-policy.ts           workflow 源码静态检查
│  ├─ build-workflow.ts          BuildWorkflow 解析、校验、resolve
│  ├─ build-executor.ts          构建执行（声明式与 workflow-driven）
│  ├─ test-workflow.ts           TestWorkflow 解析、校验、resolve
│  ├─ test-executor.ts           自驱动 TestWorkflow 单侧执行
│  ├─ verification-materials.ts  辅助材料路径、内容与哈希的固定和读取
│  ├─ expectation-compare.ts     两侧期望按位置比较
│  ├─ registry.ts                BuildWorkflow 注册表（save/load/discover）
│  ├─ curator.ts                 运行期构建入库（run-local → library 提升）
│  └─ resolve-declared.ts        声明集 → workflow resolution 解析
│
├─ agents/
│  ├─ prompts.ts                 各会话系统提示词与任务提示
│  ├─ driver.ts                  Claude Agent SDK 封装（无 hook，白名单边界）
│  ├─ workflow-facts.ts          writer 共享的 Preflight 实测上下文
│  ├─ workflow-session.ts        TestWorkflow 编写会话（test-writer）
│  ├─ build-writer.ts            BuildWorkflow 编写子 agent
│  ├─ dep-registry.ts            依赖注册表（会话内声明状态）
│  ├─ dep-registry-server.ts     dep-registry 的 MCP server
│  └─ refactor.ts                Refactor Agent（candidate worktree）
│
└─ cli/
   └─ args.ts                    CLI 参数解析与 help 文本

scripts/
├─ cli.ts                        统一 CLI（preflight / workflow / config / limits）
├─ check-offline.ts              按平台筛选后的严格离线检查入口
├─ demo.ts                       状态机基础演示
├─ demo-libuv.ts                 libuv CMake 基准
├─ e2e-cmake.ts                  CMake 冒烟
├─ e2e-generated-workflow.ts     完整声明制 e2e（默认入口）
├─ resume-verification.ts        从持久化产物续跑验证段
└─ e2e-dashboard.ts              启动观测 WebUI

shared/
├─ owned-process.ts              进程组 / Job 的所有权、回收与宿主退出处理
└─ windows-process-host.ts        进入 Job 后启动目标、经 IPC 回报实际退出结果

testset/                         用例材料、平台探测、CLI 执行与判定
tests/                           32 个测试文件（验证证据见 §8.5–§8.6）
examples/trim-app/               C 基线项目 + safe/broken 变体
```

Workflow 层遵循 core / app 分离：`registry` / `build-workflow` / `test-workflow` / `runner` / `capabilities` 等是无 AI、可独立单测的模块；`stage-flow.ts` 只做编排（阶段契约 + 组合器），阶段实现可替换（AI 会话 / 预置文件），配置到阶段的翻译在 `config/pipeline.ts`。

## 4. Artifact 数据骨架

状态机接受的 16 种 Artifact：

```text
behavior-contract          dependency-manifest       environment-spec
test-spec                  observation-trace         comparison-result
patch-record               refactor-test-task        workflow-resolution
declared-build-set         ctest-baseline            ctest-candidate
ctest-comparison-result    expectation-baseline      expectation-candidate
expectation-comparison-result
```

### 4.1 BehaviorContract

定义哪些行为必须保持，以及比较方式：exit code / signal / stdout / stderr / filesystem effects，模式为 `exact` / `semantic` / `normalize` / `ignore`。`execution_time` 必须允许变化；`semantic` 必须提供 comparator id。

在声明制流程中，行为契约、依赖清单与测试用例由 session 内部决定，宿主提交语义中性的占位值——真正的门禁是 `DeclaredBuildSet` + 期望差分。

### 4.2 DependencyManifest

依赖类别：`pure` / `time` / `randomness` / `filesystem` / `env` / `network` / `stateful_external` / `concurrency`。
隔离策略：`real_isolated` / `freeze` / `seed` / `temp_sandbox` / `record_replay` / `fake` / `mock` / `reject`。

### 4.3 EnvironmentSpec

`build.kind` 支持 `direct-compiler` / `cmake` / `ninja` / `workflow-driven`。`workflow-driven` 表示构建由生成的 BuildWorkflow 在 execute 阶段自行完成（返回 `{artifacts: {逻辑名: 路径}}`），宿主校验声明的产物存在。

### 4.4 声明制三件套

- **`workflow-resolution`**：一次 workflow 解析结果（id / revision / 入口 / source hash / 来源说明）。
- **`declared-build-set`**：test-writer 会话通过 `declareDependency` 声明的整个构建依赖集，单凭证承载（id / entry / source hash / run_local），宿主按序在两侧执行。
- **`expectation-baseline` / `expectation-candidate` / `expectation-comparison-result`**：自驱动 TestWorkflow 用 `ctx.expect(name, relation, value)` 声明期望，宿主按位置配对比较。两侧 `workflow_passed` 为 schema 级 `literal(true)`——测试没跑过就无法提交。

### 4.5 CTest 套件三件套

`ctest-baseline` / `ctest-candidate` / `ctest-comparison-result`：宿主执行真实 CTest，记录顶层测试、失败集合与逐条失败分类（`environment` / `preexisting_behavior` / `unknown`）。比较结果的所有字段由程序从持久化的 baseline/candidate 证据**重算**，模型提交值只用于比对。

### 4.6 HostPreflight 与 ProjectDetection

两者都不作为状态机 Artifact 提交，而是 session 审计产物：

```text
.refactor/sessions/<session-id>/artifacts/host-preflight.json
.refactor/sessions/<session-id>/artifacts/project-detection.json
```

这样可以区分「模型声明的环境」「程序测量的主机事实」「程序最终执行的构建」。

默认 Preflight 仅发现工具路径、识别 C 源码/构建标记并查询 CMake 版本与生成器元数据，不创建临时工程或编译。
新项目检测状态为 `detected` / `no-c-sources`，与宿主工具解耦；旧状态只兼容读取历史审计。
生成器是否可用及真实项目的构建条件由 build-writer 与所选 workflow 确认。

## 5. 状态机

`Orchestrator` 是唯一允许推进状态的组件。两条合法路径共享同一套 fail-closed 规则：

```text
INIT
  ↓ behavior-contract
CONTRACT_READY
  ↓ dependency-manifest
DEPENDENCY_READY
  ↓ test-spec
TESTS_READY
  ├─ ↓ environment-spec ─────────────────────→ ENV_READY
  └─ ↓ declared-build-set / workflow-resolution[build]
        BUILD_WORKFLOW_READY
          ↓ workflow-resolution[test]
            TEST_WORKFLOW_READY
              ↓ environment-spec
                ENV_READY
                  ↓ observation-trace | ctest-baseline | expectation-baseline
                    BASELINE_READY
                      ↓ patch-record
                        PATCH_CREATED
                          ↓ observation-trace | ctest-candidate | expectation-candidate
                            VERIFICATION_RUNNING
                              ↓ comparison-result | ctest-comparison-result
                                / expectation-comparison-result
                                  ACCEPTED | REJECTED
```

任何非终态都可以转为 `ABORTED`，终态不可变。

### 5.1 Fail-closed 规则

| 规则 | 内容 |
|---|---|
| R1 | 只能提交当前状态期望的 Artifact，禁止跳阶段或乱序 |
| R2 | Artifact 必须先通过 Zod Schema（在检查 kind 与语义之前） |
| R3 | baseline 失败必须逐条解释。CTest 路径：每条失败都要有分类，`unknown` 或"有分类无对应失败"都阻断。legacy 路径：只接受 `preexisting_behavior` / `environment`，且 `preexisting_behavior` 必须在 candidate 侧原样复现 |
| R5 | candidate 必须覆盖 baseline 的用例集（legacy，集合漂移即拒绝）/ 顶层测试非空（CTest） |
| R6 | 比较结论由程序从持久化证据重算后决定 `ACCEPTED` / `REJECTED` |
| R7 | 终态不可变 |

> R4（patch 范围校验）已随 `ScopeManifest` 一起删除。`patch-record.changed_files` 保留为审计字段。

### 5.2 Session 持久化

```text
.refactor/sessions/<session-id>/
├─ state.json                    当前状态 + 完整 transition history
├─ limits.json                   本次运行实际生效的阈值与来源层
└─ artifacts/
   ├─ <artifact-kind>.json       每个 Artifact 一个文件
   ├─ observation-trace.<build>.json
   └─ workflow-resolution.<build|test>.json
```

`SessionStore.open` 支持中断后 reopen。它可以区分四类失败：文件不存在、JSON 不可读、schema 不匹配，以及**由更早版本写入（引用了已删除的状态）**——后者会点名具体状态而不是笼统报 corrupt。

### 5.3 候选 patch 的测量

refactor 阶段结束后，宿主**不读会话的自述**，而是自己测量改动（`commitCandidateChanges`）：

1. `git add -A` 暂存工作区；
2. `git diff --cached --name-only <baseSha>` —— 相对 **base commit** 的完整变更集，**为空才判定"没有改动"并中止**；
3. 只有在相对 HEAD 仍有未提交内容时，才追加一个宿主 commit。

第 2 步是关键：会话有 shell 之后，"工作区是否干净"不再等于"有没有改动"——agent
可能自己 commit（旧逻辑会把这种情况误判成"没有改动"并中止整轮）。同理，agent
留在 worktree 里的构建产物会进入这次测量，因此提示词要求探测性构建放在
worktree 之外。

## 6. Agent 层

生产流程有三类模型角色，工具集**逐条显式列出**（SDK 中省略列表 = 继承全部内置工具，含
Bash/WebFetch，因此 `DriverOptions.allowedTools` 是必填参数，漏传会编译失败）。
两个编写角色暂时无 Bash，refactor 保留 Bash；`Bash(git push:*)` 对所有会话 deny。

| 会话 | 工具（常量名） | 产物 |
|---|---|---|
| test-writer | `TEST_WRITER_AGENT_TOOLS`：Read / Glob / Grep / Write / Edit / Task；另有显式 MCP 工具 | 结构化验证计划 + TestWorkflow 源 + `declareDependency` 声明集 |
| build-writer（经 Task 派生的子 agent） | Read / Glob / Grep + MCP `generateBuildWorkflow` / `inspectWorkflow`（无 Write/Edit/Bash） | BuildWorkflow 源、固定辅助材料与预期产物使用说明（经宿主 registry 落盘） |
| refactor | `REFACTOR_AGENT_TOOLS`：Read / Write / Edit / Glob / Grep / **Bash** | candidate worktree 内的改动 |

- **test-writer** 在同一会话中先按 `verification-planning` skill 调查源码、选择验证方式并调用 `submitVerificationAnalysis`，再加载实现规范、编写测试和辅助代码。宿主要求本次成功提交计划，原子保存到运行目录的 `workflows/verification-analysis.json`；会话结束后关闭提交。源码证据、测量与推断分开，推荐 mock 时需说明接入点、模拟行为和覆盖损失。结构检查不证明计划内容正确。构建依赖通过 `dep-registry` MCP server 声明。
- **build-writer** 是 test-writer 经 `Task` 派生的子 agent，其 workflow 与辅助材料经宿主 `generateBuildWorkflow` 落盘；交付准确产物路径及预期调用、链接加载和生命周期说明，实际构建由宿主执行。子 agent 的显式工具列表不继承父会话的 MCP 工具，因此需按名声明。
- **独立调查评测** 复用同一套调查提示词和计划提交机制，保留历史 scout 命令与场景名；生产流程不再创建 scout 子角色。
- **refactor 的 shell 约定**（写进提示词）：探测性构建放在仓库/worktree 之外，因为遗留产物会进入 patch；不要执行 git 变更命令——宿主拥有 staging/commit/branch，agent 自己 commit 虽然被兼容（见 §5.2），但 reset/checkout 可能毁掉其工作。
- **refactor** 在候选 worktree 中运行，**重构范围不设限**——由 baseline/candidate 双跑 workflow 的行为门禁兜底；`git add` / `git commit` 由宿主执行。
- **Preflight** 保留宿主/项目测量，实测事实直接注入 test-writer 与 build-writer；独立 Analyze 已删除。test-writer 决定方案，build-writer 编写构建和产物使用说明并提交辅助输入。宿主固定后向两侧分发，执行期事实继续通过 `ctx.facts` 提供。

Windows 下 Driver 优先使用 `CLAUDE_CODE_EXECUTABLE`，否则查找 `%APPDATA%\npm\claude.cmd`。

会话预算（deadline / stall / maxTurns）由 §7 的配置系统统一给出。

### 6.1 阶段化管线（stage-flow）

流程固定五段：`preflight → workflows → prepare → refactor → verify`。
每段是一个**可替换的类型化函数槽**；不替换就是上面那套 AI/宿主实现：

| 槽 | 默认实现 | 无 AI 预置（`stage-presets.ts`） |
|---|---|---|
| `preflight` | 主机探测 + 项目探测，直接传递测量事实 | — |
| `workflows` | test-writer 会话声明构建/测试 | `presetWorkflowsStage`（用仓库里的 workflow 源） |
| `prepare` | 新建候选分支 + 双 worktree | `existingBranchPrepareStage`（复用既有候选分支） |
| `refactor` | refactor 会话改候选区 | `patchRefactorStage` / `fixedRefactorStage` |
| `verify` | 差分构建 + 跑测试 + 判定 | 允许替换，但记 `verification_authoritative: false` |

- **宿主不变量**（阶段拿不到）：状态转移（`Orchestrator`）、候选改动集测量（阶段只返回 summary）、
  门禁顺序（存在 C 源码 / 改动非空 / 声明集非空）、worktree 清理与 run-local 提升。
- writer 按源码与覆盖选择验证范围；执行检查所需工具、产物、受控源码和固定输入。
  含任务专属辅助材料的构建保留 run-local，避免推广缺少材料的配方。见 [`docs/verification-strategies.md`](docs/verification-strategies.md)。
- 阶段可 `halt(reason)` 叫停，由组合器统一 `abort`；槽位无法自行推进状态机。
- 注入痕迹落 `stage-provenance.json`（artifact）并进返回值，一次 ACCEPT 永远可回答"真判还是演的"。
- **应用层**把配置翻译成槽函数（core 不接受配置文件）：`.refactor/pipeline.json` +
  `--pipeline-file` / `--stage`，与 §7 同一套多源引擎（`config/layers.ts`）；
  入口 `refactor-subagent run <repo> --task <text>`。没配的阶段保持 AI 默认。
- 用途：按阶段测能力（只测重构 / 只测 workflow 编写 / 离线判据自测），见
  [`docs/stage-flow.md`](docs/stage-flow.md)。

## 7. 超时与资源阈值配置

阈值集中在 `src/config/limits.ts`，按层合并：

```text
内置默认  <  ~/.refactor/limits.json  <  <repo>/.refactor/limits.json
        <  --limits-file <path>  <  --limit key.path=value
```

**时间预算默认全部不限**（`null`）。理由：为小项目调出的 deadline 在大项目上就是误杀，且失败表现是笼统的 `timeout`，看不出被杀的是哪一层。需要护栏的项目显式开启。

- 结构上限（并发进程数、输出/文件字节数、就绪探测、host 探测）保留默认值；
- SDK 死流看门狗（`stallMs`）保留默认且不建议关闭——它检测的是"SDK 子进程被杀"，不是"项目跑得慢"；
- 每次运行把生效的 `limits.json`（含来源层）写进 session 目录，并打一行摘要日志；
- `refactor-subagent limits <repo>` 可查看生效值与来源层。

完整用法见 [`docs/limits.md`](docs/limits.md)。

同一套多源引擎（`src/config/layers.ts`）也承载阶段来源配置（§6.1）：
`~/.refactor/pipeline.json` < `<repo>/.refactor/pipeline.json` < `--pipeline-file` < `--stage`，
合并顺序与阈值完全一致；`limits` 是引擎的第一个域，`pipeline` 是第二个。

### 7.1 进程生命周期（2026-10-14）

Workflow worker、capability 工具、CTest 和测试集命令共用 `spawnOwnedProcess`：
Windows helper 先加入 kill-on-close Job，再启动真实目标；POSIX 使用独立进程组，TERM 后等待 200ms，再按需 KILL。
负责关闭内层进程组的 CLI 有独立的 4s 宽限，防止外层与内层相同的 200ms 预算产生回收竞态。
回收后的进程退出等待上限为 2s，管道排空等待上限为 1s；清理失败进入结果诊断。

broker 的 `close()` 幂等、并行回收所属工具，并取消 file/TCP readiness。
capability 请求按 id 并发处理，等待进程不会阻塞同一进程的 stop；正常返回、异常、超时和取消均关闭 broker。
没有最终 worker envelope 时，宿主已收到的 capability 事件仍保留。

`runWorkflow`、`runCTest`、测试集 `exec` 接受 `AbortSignal`；CLI、测试集和离线入口处理 SIGINT/SIGTERM，
宿主显式退出时也回收仍登记的进程。已提前取消的调用不会启动工具；CTest 超时优先于必需测试缺失的判定。

## 8. 已执行验证

本节记录**当前架构**下各里程碑的证据；2026-10-14 的结果见 §8.5–§8.6，§8.1–§8.4 不视作本轮验证。历史架构见文末附录。

### 8.1 工程检查（2026-09-10）

```text
bunx tsc --noEmit     → pass
bun test              → 121 pass / 0 fail（22 files，329 expect）
```

```bash
bun test
```

覆盖范围：状态机（legacy 与 expectation 两条路径）、Artifact schema、limits 分层配置与校验、BuildWorkflow / TestWorkflow 解析与注册表、capability 文件/进程/工具边界与超时、CTest 输出解析、声明集解析、依赖注册表与 MCP server、会话编排、E2E 观测 Logger/Dashboard/SSE。

> `tests/refactor-task.test.ts` 中依赖真实 libuv checkout 的用例在目录缺失时自动跳过。

### 8.2 配置系统实测

```bash
bun run scripts/cli.ts limits <repo> --format json
```

已验证：项目层覆盖用户层（逐字段）、`--limit` 覆盖文件、`--limits-file` 叠加、`null` 抬升生效、拼错的键报错并列出可用键、配置文件里的未知字段报错并点名文件。

行为实测：默认（不限）下 3 秒命令正常完成；`--limit probes.hostMs=1` 使 CMake 探测 `ETIMEDOUT` 并如实记为 `version: null`；策略 `processTimeoutMs=1000` 下 3 秒命令被判 `timeout` 且进程树被终止。

### 8.3 声明制全链 e2e（首个 ACCEPTED，2026-09-03）

复用 e2e-fix-18 产物续跑验证段（`scripts/resume-verification.ts`）：

```text
baseline build: pass
candidate build: pass
期望对比：10/10 consistent（ctest 退出码、trim_behavior、CLI 输出等）
状态：ACCEPTED（声明制全链首次）
```

排查该 e2e 早期极慢问题的过程与结论见 [`docs/e2e-slow-investigation.md`](docs/e2e-slow-investigation.md)。

### 8.4 阶段化管线与来源配置（2026-09-14）

```text
bunx tsc --noEmit     → pass
bun test              → 137 pass / 0 fail（25 files，377 expect）
```

新增离线端到端测试 `tests/stage-flow.test.ts`（真 gcc、真 git、**无模型调用**）：

```text
预置 workflow + 行为保持补丁   → ACCEPTED（比较 consistent，两侧 build pass）
预置 workflow + 改行为补丁     → REJECTED（比较 inconsistent）
预置源缺失                     → 阶段 halt → ABORTED（run.jsonl 含原因）
注入 verify                    → provenance.injected=["workflows","refactor","verify"]，authoritative=false
```

应用层实测（`refactor-subagent run` + `--pipeline-file`）：

```text
state=ACCEPTED   comparison=consistent   exit 0
state=REJECTED   comparison=inconsistent exit 1
injected_stages=["workflows","refactor"] verification_authoritative=true
```

同批修掉一个 fail-open 缺陷：`ctx.expect(name, value)` 的**字符串值**被类型嗅探吞掉
（`src/workflow/client.ts` 把第二个字符串参数当 relation，value 变 `undefined`，两侧
`undefined` 恒等 ⇒ 行为不同也判 consistent）。改为按**参数个数**判定，`tests/stage-flow.test.ts`
的 REJECTED 用例即回归证据（修复前该用例为 ACCEPTED）。同时给自驱动路径的
`WorkflowVerificationOutcome` 补上 `expectationComparison`，判定结果不再只存在于 artifact 里。

### 8.5 工程检查、CI 与进程回收（2026-10-14）

第一批已提交为 `b7078ef`：恢复严格类型检查，提供 `check` / `test:offline`，
保存重判所需的注入替换证据，并新增 Windows/Linux CI 与证据上传。
第二批统一进程生命周期，新增 12 项真实进程回归，覆盖宿主退出、成功/异常回收、超时、取消 readiness、嵌套 CLI 取消、
并发 wait/stop、父进程退出后子孙占用管道，以及 stdin/环境/实际退出码的传递。

| 环境 | `bun run check` | 严格离线检查 |
|---|---|---|
| Windows 11 | 类型检查、180 pass / 0 fail、执行器自检通过 | 23 pass / 0 fail |
| WSL Ubuntu 24.04 | 类型检查、180 pass / 0 fail、执行器自检通过 | 19 pass / 0 fail，4 个平台跳过 |

工程证据：`runs/check-20261014-final2-win.txt`、`runs/check-20261014-final2-linux.txt`；Linux 验证前已逐文件确认关键运行源码与 Windows 一致。
Windows 离线证据：`runs/w3/summary.json`、`runs/offline-20261014-final-win.txt`。H4 存在一条非阻断的冻结归因标签差异，功能判定仍为 REJECTED。
Linux 离线证据：`runs/offline-20261014-final-linux.txt`、`runs/offline-20261014-final-linux-summary.json`；完整环境保存在 WSL 缓存的 `runs/l3/`。H4/H7 有两条非阻断归因差异，功能判定均为 REJECTED，未修改冻结期望或判据。
Windows 离线运行之后补上了 POSIX 嵌套 CLI 的关闭宽限；Windows Job 路径未改变，两端最新工程检查及嵌套取消回归均已通过。
原始嵌套超时复现修复前留下存活工具，修复后 `toolStillAlive=false`；证据为 `runs/nested-timeout-fixed-20261014-linux.txt`。
本轮本地检查未调用收费模型；以上为本地证据，远程结果与后续探测修复见 §8.6。

### 8.6 GitHub 首轮 CI 与默认 Ninja 探测修复（2026-10-14）

[PR #3](https://github.com/isyuah/refactorSubagent/pull/3) 已建立。[首轮 PR CI](https://github.com/isyuah/refactorSubagent/actions/runs/38525276824)
的 Ubuntu 24.04 工程检查和严格离线套件均通过；Windows Server 2022 工程检查通过，严格离线检查在配方探测阶段失败：
`cmake does not offer the Ninja generator`。

本机以 `CMAKE_GENERATOR=Ninja` 重现：CMake 的 `--help` 会将默认生成器写为 `* Ninja`，原正则只识别两个空格开头的 `Ninja`。
探测改为读取 `cmake -E capabilities` 的 JSON 生成器列表，并校验返回结构与精确的 `Ninja` 名称。
新增回归以独立进程的启动环境设置默认生成器，修复前失败、修复后通过；本机平台测试 6 pass / 0 fail，严格类型检查通过。

同一修复提交的 Ubuntu PR 任务通过，但 push 任务的 CTest 回收回归在 1s 期限结束时尚未写出工具 PID。
该回归的 Linux 测试期限调整为 5s，结果等待上限为 8s，保留超时优先级、实际工具启动和进程回收断言，并在 PID 断言失败时打印 CTest 输出。
WSL Ubuntu 24.04 的该项回归已通过（约 5.2s），严格类型检查通过；此调整仅涉及测试的时间预算。

修复提交后的完整远程结果由 [PR #3 Checks](https://github.com/isyuah/refactorSubagent/pull/3/checks) 记录。

### 8.7 暂缓待办：Windows CI 耗时优化（2026-10-14）

**任务标题**：优化 Windows 离线 CI 的重复构建与判据执行耗时。

**任务描述**：同一提交 `4950694` 的 Windows CI 总耗时为 34分04秒 / 44分32秒，Linux 为 4分02秒 / 5分38秒；差异主要集中在离线用例阶段。当前每个判据用例独立构建基线与候选，判据流程还包含多次串行编译和程序调用；Windows 适用 23 项，Linux 适用 19 项。后续分别记录环境准备、构建、判据编译和执行耗时，评估构建缓存、并行度及 push / PR 重复触发的优化收益，并保持适用用例和判定语义不变。现有证据不足以进一步确定 CPU、磁盘或文件扫描的占比。

证据：[PR CI](https://github.com/isyuah/refactorSubagent/actions/runs/38529849012)、[push CI](https://github.com/isyuah/refactorSubagent/actions/runs/38529843931)。两次运行的 Windows/Linux 四项检查均已通过。

**当前决定**：本轮测试开发告一段落，此项仅记录为暂缓待办；接下来评估 Agent 主流程的优化。

### 8.8 验证方式选择与固定辅助材料（2026-10-15）

开发分支：`codex/verification-strategies`，从 `4950694` 创建。本轮代码尚未提交、推送或合并。

实现内容：

- 删除独立 Analyze，保留五段流程；Preflight 实测宿主/项目信息直接传给 test-writer 和 build-writer。
- `workflow-spec` 按需指导复用现有测试、库消费者和局部源码 harness，由 test-writer 选择范围，build-writer 准备产物。
- `generateBuildWorkflow` 可登记 `build/verification/` 下的 UTF-8 辅助输入；宿主计算哈希、固定声明，在候选提交后向两侧分发相同内容，材料不进入重构补丁。
- 每侧针对自己的真实实现构建并运行。宿主检查进程基础设施失败、空观测、workflow/材料哈希，以及原仓库和两侧受控源码的提交、索引与当前字节。可信盲测注入的覆盖语义保留。
- 材料登记中断时拒绝复用，重新完整生成后恢复；任务专属材料保持 run-local。多构建按声明序号和 ID 分别保存执行记录。

已取得的验证证据：

| 检查 | 结果 |
|---|---|
| 最终源码的 `bun run typecheck` | 通过 |
| 最终源码的核心验证场景 | 15 项逐项通过，含真实局部模块 / DLL 双侧编译运行、接受 / 拒绝和异常中止；见下文分组说明 |
| 登记、单侧测试执行、验证方案、能力代理与会话的前序定向组 | 48 pass / 0 fail |
| 登记与仓库完整性定向组 | 24 pass / 0 fail |
| `bun testset/run.ts --self-test` | PASS；预期 pass=2 / fail=1 / blocked=2，平台阻断时未执行准备步骤 |
| 其余工程回归（28 文件） | 142 pass / 4 fail / 1 error；4 项为短预算超时，复核结果见下 |
| 候选提交相关用例单独复核 | 4 pass / 0 fail |
| CMake 执行相关用例调整准备步骤后复核 | 2 pass / 0 fail，保留原 30s 预算 |

CMake 超时已通过分段计时定位：测试先执行了约 18.4s 的完整宿主 CMake 探测，随后被测构建约 22.7s 且成功，合计超过用例的 30s 总期限。
测试现在只测量工具可用性，跳过重复的 CMake 预构建；生产构建路径与超时预算未改。候选提交的两项超时在单独复核中通过，未据此确定其最初超时原因。

最终核心回归复核中，登记 22 项、完整性 2 项，以及多构建、局部 harness / DLL 消费者的接受与拒绝、执行期源码保护共 6 个真实场景已逐项通过。
测试进程随后以 `0x40010004` 提前结束，未生成完整汇总，退出原因尚未确认。其余 9 个场景已分两组补跑，分别 4 pass / 0 fail 与 5 pass / 0 fail；
覆盖固定材料变更、编译失败、零观测、纯常量、明确预期的退出码 7、忽略进程超时、workflow 漂移、junction/symlink 逃逸和可信判据覆盖。
因此 15 个核心场景均取得了通过结果。本轮没有完整成功的 `bun run check` 单次运行，也不把重叠组的数量相加为覆盖总数。

验证边界：本轮真实编译/运行证据来自 Windows；Linux `.so` / macOS `.dylib` 分支已编码但未实跑，未调用收费模型验证真实 AI writer，也未重跑完整 libuv 离线套件。
执行边界完整性检查不能替代 OS 沙箱；是否验证到本次修改的实现与完整集成行为仍需真实项目验收。
设计说明见 [`docs/verification-strategies.md`](docs/verification-strategies.md)。

### 8.9 verification-scout 调查与 writer 交接（2026-10-19）

继续在 `codex/verification-strategies` 增量实现，尚未提交、推送或合并。

- 新增 `src/agents/verification-scout.ts`，与 build-writer 同级，由 test-writer 前台委托。
  使用独立精简 skill，只读源码、查询配方和提交报告；上限 24 轮，共用父会话的超时/取消。
- 新增 `verification-analysis.ts` 与 MCP `submitVerificationAnalysis`，校验行为、策略、依赖处置、依据和未知项。
  替身建议需要接入点、模拟行为、真实实现保留范围和覆盖损失；区分源码、Preflight 与推断。
  报告原子保存到仓库运行目录的 `workflows/verification-analysis.json`，不注册构建或验证材料。
- 自动编写会话要求本次成功提交报告，拒绝以旧文件代替；正常结束、超时和异常退出后关闭提交。
  报告路径进入会话返回值与完成日志。宿主检查提交和格式，不证明源码结论真实或策略正确。
- test-writer 决定最终策略并编写用例/辅助代码；build-writer 负责构建实测与产物完整用法。
  支持先咨询库/运行器用法、再编写辅助代码、最后登记完整构建；具体阻碍可触发定向补查。
  五段流程、固定材料与两侧执行机制保持不变，预置 workflows 不要求 scout 报告。
- 为真实 MCP 协议测试显式声明开发依赖 `@modelcontextprotocol/sdk@1.30.0`，与 SDK 已使用的版本一致；
  锁文件仅增加 workspace 开发依赖声明，没有升级解析依赖。

最终源码取得的证据：

| 检查 | 结果 |
|---|---|
| `bun run typecheck` | 通过 |
| scout、workflow-session、registry/server、build-writer 和源码完整性定向回归（6 文件） | 52 pass / 0 fail |
| `bun test tests/verification-strategies.test.ts --test-name-pattern 'local source harness:\|shared-library consumer:'` | 4 pass / 0 fail；其余 11 项未选择 |
| `git diff --check` | 通过 |

新增检查通过真实 MCP 客户端/内存传输调用工具，不使用 SDK 私有字段或模型：覆盖接受与持久化、无效更新保留有效报告、
mock 建议缺失信息、推断/未知项、写盘失败、旧文件不计作本次提交，以及结束后的提交关闭。
原生 4 场景在 Windows 真实编译局部源码及 DLL 消费者，两侧分别执行，覆盖保持行为的 ACCEPTED 与改变行为的 REJECTED。

本轮未运行完整 `bun run check`、Linux/macOS 或真实 AI 会话；不将协议/宿主测试当作模型调查质量的验收。
实现和交接说明见 [`docs/verification-strategies.md`](docs/verification-strategies.md)。

### 8.10 scout 独立评测基础设施与分级材料（2026-10-19）

在当前功能分支增量实现，未提交或推送；没有新增生产阶段。

- testset 新增 `kind: scout` / `scout+rubric`，通过独立 CLI 运行生产 scout 定义、skill 与真实 MCP 提交，
  不启动其他 writer/refactor。主会话显式预加载同一 skill，预算和模型选项仅属于评测。
- 首批六例分为基础、中等、进阶三档，覆盖局部纯函数/已有测试对照、真实依赖与分配器替身、真实文件、
  共享库 ABI/对象生命周期，以及缺失配置/provider 与旧文档冲突。源码材料与隐藏评分参考分开准备。
- 每例四项带源码锚点/权重的事实，裁判允许有依据的不同策略；宿主严格校验事实集合并计算总分。
  默认最低 0.8，critical 事实为 0 直接失败；未评分为 pending，不计 passed。
- 保存完整源码/哈希、任务、Preflight、实际角色提示、skill、配置、报告、会话镜像与评分证据。
  支持删除环境后复评；旧评分与证据绑定，变更后显式重评；不会把模型输出冻结成参考答案。

已取得 Windows 离线证据：typecheck 通过；scout 评测、平台、历史复评与生产报告提交定向回归
4 文件共 18 pass / 0 fail；执行器 self-test 通过。材料检查命令真实编译并运行五份完整工程（含 DLL 消费者），
第六份在预期的生成配置头文件缺口失败，记录为 expected-incomplete。
材料验证证据：`C:/Users/Yu/AppData/Local/Temp/rfr-scout-fixtures-Rv7XEv/summary.json`。

截至本节离线实现完成时，尚未调用真实 scout 或模型裁判，未做裁判校准、Linux/macOS 实跑、writer 组合/完整流程评测或完整 `bun run check`。
离线替身产生的评分仅验证协议，不代表模型能力。设计及命令见
[`docs/testset/05-scout-evaluation.md`](docs/testset/05-scout-evaluation.md)。

### 8.11 scout 首轮真实模型试跑与人工复核（2026-10-19）

在当前 Windows 主机调用了真实 scout 和模型裁判。请求别名分别为 `sonnet` / `opus`，
成功响应的模型字段均为 `deepseek/deepseek-v4.1-flash`，因此不构成 Sonnet/Opus 或异构模型对照。

- 六例均已尝试，取得五份有效报告及评分；五份均达到 0.8 门槛，原始均分 0.9587。
  allocator 在服务额度错误后重试成功；file-resource 两次均在读取源码前被拒绝，保持未评估。
- 五份有效报告均由真实 MCP 一次接受，源码前后一致，无超时；会话未观察到读隐藏参考、写源码或 shell 调用。
- 人工错误报告负控被判 critical 0，宿主拒绝；这一次负控不计入 scout 能力样本，也不足以证明裁判可靠。
- 人工复核发现：跳过 CMake probe 被 `needs-adapter` 表达成不可用，影响复用建议；已有测试覆盖被低估；
  allocator 缺确定失败建议；DLL 缺多对象/卸载生命周期；缺失 provider 场景误述 NULL 调用的序列更新与缺头编译行为。
  裁判存在漏判、无依据扣分及从源码替报告补充内容，原始分数未修改，不能视为人工接受。
- 原始与重试证据保存在 `runs/scout-real-20261019-a/` 和 `runs/scout-real-20261019-retry/`；
  `trial-summary.json` 合并查看各次尝试。无模型缓存复评仍如实保留服务错误和非零退出码。

本轮仅新增实测记录与本地运行证据，没有修改生产提示词/流程或评分参考，未提交或推送。
Linux/macOS、writer 组合/完整流程及完整 `bun run check` 尚未运行。
详细结果及建议见 [`docs/testset/06-scout-real-evaluation-2026-10-19.md`](docs/testset/06-scout-real-evaluation-2026-10-19.md)。

### 8.12 Preflight 仅做发现与元数据查询（2026-10-22）

针对首轮 scout 实测中将“未构建”误读为“不可用”的问题，已移除通用最小 CMake 工程探测。

- `probeHost` 默认发现工具路径，仅执行 CMake `--version` / `-E capabilities`，不创建工程或 configure/build。
  移除 `skipCMakeProbe` 和原编译结果字段；查询失败保留诊断，生成器列表仅表示 CMake 自报能力。
  显式请求的 sanitizer 能力探测继续保留，默认不执行。
- `detectCProject` 与宿主工具解耦，新结果只用 `detected` / `no-c-sources` 描述源码识别。
  主流程仍只因无 C 源码中止 Preflight，五阶段顺序保持不变。
- 真实构建由 build-writer 和所选 workflow 确认。声明式 CMake 只使用 workflow 指定的生成器，
  未指定时由 CMake 按当前环境选择，不再注入 Preflight 推导值。
- 共享模型上下文、plugin 参考和调用点已同步。历史审计状态仍可读取；原始评测快照与评分未改写。

已取得 Windows 验证：

- `bun run typecheck` 通过。
- 8 个文件的定向回归完整运行：58 pass / 0 fail，327 个断言。覆盖 Preflight 元数据与失败处理、
  CMake 默认/Ninja 构建、scout 离线评测、预置阶段接受/拒绝、局部 harness / 共享库消费者双侧执行，
  以及编译失败、超时、固定输入变更、空观测、源码保护和会话提交。
- `bun testset/run.ts --self-test` 通过，符合预期 pass=2 / fail=1 / blocked=2。
- 实际历史 `needs-adapter` 快照可由新 schema 读取；`git diff --check` 通过。

首次定向运行暴露 CMake 用例外层 30 秒期限不足以覆盖元数据查询与真实构建，现将这组测试总期限设为 90 秒；
每条构建命令的 30 秒超时保持不变。最终完整定向运行没有超时或失败。

本轮未调用真实模型，未实跑 Linux/macOS，也未重跑大型 libuv 套件；截至本节验证完成时，代码仍在当前开发分支，未提交或推送。

### 8.13 功能分支交付（2026-10-22）

按用户要求，将 §8.8–§8.12 的验证策略、固定辅助材料、scout 与独立评测、Preflight 简化归集提交，
推送目标为 `origin/codex/verification-strategies`；本次不创建 PR 或合并主分支。
临时 PR 文案和 `half-week-report/0918-weekly.html` 不属于本次功能交付，保留在本地。
提交前重新运行 `bun run typecheck` 与执行器 self-test 均通过；其余验证结果和未验证边界沿用上述各节记录。

### 8.14 完整工程检查与真实 writer 局部组合验证（2026-10-26）

当前功能基线为已推送的 `76ac2e9`（`codex/verification-strategies`）。
本轮新增 `scripts/e2e-verification-authoring.ts` 和运行说明，未改生产提示词、角色或管线。

- `bun run check` 完整通过：221 pass / 0 fail，36 文件、810 个断言，类型检查与执行器 self-test 通过。
- 通过生产 `runStageFlow` 真实调用一次 test-writer，前台委托 scout 和 build-writer。
  请求别名为 `sonnet`，三个角色响应均声明 `deepseek-v4.1-flash`，不称为 Sonnet 或异构模型测评。
- 复用局部纯函数材料，模型选择 source-harness，登记一个辅助材料；各侧分别编译真实实现。
  生成 17 个输入场景、53 项观测，等价重构两侧构建/测试有效且一致，状态为 `ACCEPTED`。
- 同一套固定验证方案识别截断返回值与 capacity=1 结尾写入两个错误补丁。
  两侧均构建成功，baseline 通过，candidate 原生程序正常退出 1、行为断言失败，状态为 `ABORTED`。
  已复核具体错误输出；不是编译/超时等基础设施失败，也不是比较阶段的 `REJECTED`。
- 零模型复跑三份补丁结果一致，workflow 与辅助材料哈希不变；未为错误补丁补写或弱化生成的测试。
  新脚本最终版本类型检查通过，支持独立控制检查和固定方案复跑，输出目录不覆盖历史证据。

完整检查证据为 `runs/check-20261026-win.txt`；真实与复跑证据为
`runs/writer-live-20261026-a/`、`runs/writer-replay-20261026-a/`。
具体命令、判定分类、源码与输出复核见 [`docs/testset/07-writer-integration.md`](docs/testset/07-writer-integration.md)。

已证明局部方案在真实 scout/writer 交接后可运行，且能挡住两个预设错误。
仍未验证共享库组合、真实 refactor 模型或本轮 Linux/macOS；生成测试存在少量调查到但未落实的边界输入，
会话也做了不必要的 Vulkan 安装搜索。这些留作后续改进，不将单个场景扩大为完整模型能力验收。
本轮改动尚未提交或推送。

### 8.15 scout 调查边界与 skill 来源修正（2026-10-27）

针对 §8.14 中重复源码调查、无关 Vulkan 安装搜索与旧 skill 混用，修改角色提示和 skill：

- test-writer 在读取项目源码前先查配方摘要、委托 scout；接受报告后按需读取接口并编写测试。
- scout 根据源码判断现有产物/测试的可观察性与覆盖缺口，追清相关依赖与关键错误路径后提交。
  所选方案的构建条件由 build-writer 实测，未选方案的环境条件不阻塞报告；关键源码契约缺失仍使用 `undetermined`。
- 工具链、SDK 和配置问题由 build-writer 处理；只把影响覆盖判断的源码疑问交回 scout。
- `workflow-skills.ts` 为 SDK 插件加载、三个角色的绝对 skill 路径及独立 scout 评测提供同一来源，
  引用文档从该 skill 目录解析；路径不可读时报告具体阻碍，不搜索其他安装副本。

本轮未修改顶层阶段或 baseline/candidate 构建、材料分发与比较逻辑。
`bun run typecheck`、四个相关测试文件（31 pass / 0 fail，165 个断言）及 `git diff --check` 通过。
新增一项交接检查：被测仓库存在旧 skill 时，三个角色仍收到当前宿主 plugin 的可读绝对路径，旧文件保持原样。
测试使用注入 runner 和本地模拟评分，没有调用真实模型；尚未验证实际调查轨迹改善或耗时收益。
本轮改动尚未提交或推送。

### 8.16 调查质量与时间真实复测（2026-10-27）

在 §8.15 修改后的实现上，请求 `sonnet` 别名，实际成功响应均声明 `deepseek-v4.1-flash`。
进行了两次独立的局部 scout/writer 组合编写，以及已有测试、分配器依赖链、缺失 provider 三个独立 scout 场景。
本次未调用 refactor 或裁判模型；独立场景的调度器状态为 `pending-rubric`，质量结论来自逐项源码与 reference 复核。

- 两次组合都在读取项目源码前委托 scout，使用宿主当前 plugin 路径，没有 SDK 安装目录搜索或搜索超时。
  但 writer 收到报告后仍重复读取 5/4 个项目文件；B 报告仍以无 library target 否定库消费者，并把不需要的 Vulkan 写进待办。
- 两次组合均选择合理的 source-harness，等价控制为 `ACCEPTED`；两个错误控制均构建成功、baseline 通过，
  candidate 在实际行为断言失败后 `ABORTED`。未进入负样本跨侧比较，不能记为 `REJECTED`。
- writer 会话分别 260.7/331.0 秒，历史同场景为 391.7 秒；scout 委托 42.7/63.0 秒，历史为 115.5 秒。
  端到端等价链路为 304.3/371.4 秒，历史为 401.8 秒；当前宿主验证 35–38 秒，历史为 7.5 秒，收益存在波动。
- 三个独立 scout 分别选择 reuse-existing、library-consumer、undetermined，源码/依赖/错误路径的关键判断合理，
  没有因停止规则而漏掉分配器失败接缝或缺失配置。其入口耗时 126.7/113.9/103.4 秒，历史成功样本约 39 秒；
  时间主要位于读完源码到报告提交之间，当前记录不能拆分模型计算、生成和服务等待，不能宣称所有场景都更快。
- 新生成测试补上零容量非 NULL 目标，但高位字节、早期 NUL、前置哨兵与字符串字面量源的覆盖在不同方案间有增有减，
  不能用控制通过或期望数量证明覆盖稳定。尚未实跑共享库、真实 refactor 模型及 Linux/macOS。

详细证据为本地 `runs/investigation-20261027-a/report.md`、输入快照、`metrics.json` 和 `source-review.json`；
原始运行见 `runs/writer-live-20261027-a/`、`runs/writer-live-20261027-b/`、`runs/scout-review-20261027-a/`。
运行期间生产提示词、skill 和执行器内容保持不变；模型进程已结束。本轮结果尚未提交或推送。

### 8.17 调查与测试编写合并（2026-10-28）

改动前已将 §8.14–§8.16 相关实现、文档和评测脚本保存为本地提交 `7248fc4`，未推送。
同机先重跑一组完整编写及三个独立调查场景，再修改实现，保留提示词与源码快照。

已实现：

- 删除生产 `verification-scout` 子角色；test-writer 在同一会话先调查、提交计划，再编写测试和辅助代码。
- 新增共用 `verificationPlanningPrompt` 与 `verification-planning` skill，明确调查完成条件、依赖处置、
  未选环境条件的停止规则，以及计划行为到实际测试的核对。
- 保留 build-writer 的实测构建与产物说明职责；两侧执行、固定材料及行为判定机制未变。
- 独立评测只执行相同调查指导，保留历史 scout CLI/场景 ID 和证据格式；不再依赖已移除的角色定义。

工程验证：首轮类型检查通过，完整测试为 221 pass / 1 fail；唯一失败是离线评测脚本的 20 秒子进程期限。
该测试改为 60 秒并增加超时输出，相关四文件复测 26 pass / 0 fail、136 个断言；执行器 self-test 通过。
生产超时配置未调整。完整测试首轮 1090 秒，不能记为完整 `bun run check` 一次通过。

真实模型对比已完成，响应声明均为 `deepseek-v4.1-flash`（请求别名 `sonnet`）：

- 当日旧版编写会话 294 秒；合并版两轮 441 / 355 秒，增加 50.1% / 20.6%。源码 Read 调用减少，
  但 shell 调用与自检增加，当前没有提速证据。
- 等价修改三轮均 `ACCEPTED`；两个错误修改均触发真实行为检查，生产状态为 `ABORTED`。
  合并 A 在 TS 工作流内断言，原生程序退出 0，汇总脚本漏分类，原始 `ok:false` 保留；复核确认错误被拦截。
- 三个独立调查场景分别从 96 / 143 / 160 秒变为 83 / 97 / 189 秒；缺失产品配置时改为保留判断，
  但仍有无关环境查询和覆盖排除依据不足的问题。未调用评分模型，结果仍为 `pending-rubric`。
- 工作流、辅助材料和受控源码哈希核对通过。仅 Windows 实测，重构使用固定补丁，没有调用真实重构模型。

完整对比及限制见 [`08-merged-authoring-comparison-2026-10-28.md`](docs/testset/08-merged-authoring-comparison-2026-10-28.md)。
输入与原始结果保存在本地 `runs/merge-comparison-20261028/` 等目录；本节随合并实现保存为本地提交，未推送。

### 8.18 编写阶段交付代码，宿主执行（2026-10-28）

按用户明确的职责边界调整两个编写角色：

- 删除 build-writer 先在临时目录试编译、运行成功再交付的要求；test-writer 同样只编写辅助 C 与 TestWorkflow。
- 编译、运行、运行时探测和断言保留在生成的 workflow 中，由宿主在后续步骤执行。
- Bash 暂时从两者各自独立的工具列表移除，未删除通用 driver 的 shell 支持，后续可以在角色列表恢复。
- 同步共用调查提示词和相关 skill，区分源码推导的产物用法与真实执行证据；尚未构建不构成源码调查的阻碍。
- 未扩展真实 C 编译错误的自动回传修复：当前此类失败记录诊断后中止，自动修复仍只覆盖工作流源码策略违规。

类型检查与六文件定向测试通过：59 pass / 0 fail、224 个断言、23.20 秒；diff 检查通过。
一次 Windows 真实模型编写完成，两角色 shell 调用均为 0，宿主首次构建成功；等价修改 `ACCEPTED`，
两个固定错误修改均触发行为断言并 `ABORTED`，自动汇总 `ok:true, complete:true`。材料与源码哈希核对通过。
编写会话 285.916 秒，较此前合并版两轮减少 35.2% / 19.4%，较分离版减少 2.8%；单样本不能证明稳定提速。
生成方案仍有 Linux/macOS 空可执行后缀被误拒绝，以及 SIZE_MAX 容量输入前提未确认的问题；没有改动已固定材料。
详细结果见 [`09-authoring-without-execution-2026-10-28.md`](docs/testset/09-authoring-without-execution-2026-10-28.md)。

### 8.19 统一可执行文件后缀指导（2026-10-28）

构建与测试主提示词统一直接拼接 `facts.host.executable_suffix`，明确 Linux/macOS 的空字符串是合法后缀，
不能通过真假或长度检查判错、用默认值替换。移除构建提示词中按平台或读取 CMakeCache 重新推导后缀的指引。
API 文档补充直接拼接示例，产物断言、构建示例和验证方式说明同步使用该字段；CMake 配置目录示例明确标注平台。

本轮仅调整提示词与文档。类型检查通过；构建角色与工作流会话两文件测试 20 pass / 0 fail、76 个断言；
diff 检查通过。未重跑真实模型或 Linux/macOS，§8.18 的原始生成材料与运行证据保持原样。

### 8.20 Redis 全流程场景可行性调查（2026-10-28）

统一后缀指导已提交为 `786f8f6`。随后检出官方 Redis 8.10.3，固定提交
`1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f`；源码与调查证据位于忽略目录 `runs/redis-feasibility-20261028/`。

- WSL Ubuntu 24.04 实际构建核心服务器/CLI，SDS 72 项通过，dict/listpack 内部入口正常执行；
  定向字符串与协议 Tcl 单元分别实际通过 179 / 27 项，构建未改变受控源码。
- 真实宿主配预写局部 C 测试与固定补丁：等价变量重命名 `ACCEPTED`，前导零与最小负整数错误各 `REJECTED`；
  三轮两侧均构建/运行成功，18 项观测，没有将基础设施失败计为错误检出。
- 真实工作流完成服务器前台启动、条件写入、保留 TTL、关闭后 AOF 重启恢复与正常回收。
- 设计六类候选：字符串参数、SET 选项、listpack、字典迁移、RESP 分片、AOF 清单；
  明确 Linux 平台、build 目录产物策略、解释器发现、零测试判定及独立可信复核的接入工作。

本轮没有真实 AI 编写、AI 重构或评分，也没有新增正式 Redis case；实验不能作为模型综合能力通过的证据。
详细依据、运行限制与推进顺序见 [`10-redis-feasibility-and-scenarios-2026-10-28.md`](docs/testset/10-redis-feasibility-and-scenarios-2026-10-28.md)。

### 8.21 Redis 与依赖模拟正式用例（2026-10-28）

新增七个标准 e2e 用例：Redis 8.10.3 的 SDS、SET、listpack、dict 迁移、RESP 分片、AOF，
以及缺失 DeviceSDK 的通信客户端合成工程。任务不预告验证方式；正常路径均由 AI 编写构建/测试并重构。
Redis 声明 Linux；通信工程支持 Windows/Linux，提供 ABI/协议和真实业务实现，由模型自行编写依赖替身。

- 测试执行器新增可选独立复核：主流程接受后提取保存的候选补丁，用固定隐藏判据在新双侧 worktree 重建；
  失败或证据缺失不能使整体评测通过。重判保留复核证据；评分输入包含辅助源码、候选补丁与复核结果。
  修复评分器参考 Markdown 文件及仓库内源码路径的兼容问题。生产 Agent、提示词与执行流程未改动。
- WSL Ubuntu 24.04 的最终 22 个固定对照全部符合预期：7 个有效重构接受、15 个错误修改拒绝，
  两侧构建及测试均有效；SET/RESP 当次上游测试实际通过 179/27 项。Windows 通信场景另有 4/4 对照成功。
  增加上游内部超时和未完成检查；较早失败实验保留，不以环境错误或超时冒充错误检出。
- 真实模型 `deepseek-v4.1-flash` 完成 Windows 通信场景：自行编写替身与 28 个场景，双侧 57 项比较一致，
  实质性提取 `transfer_exact`；独立 17 项固定检查通过。主流程约 25 分 7 秒，含独立复核等整次约 26 分 14 秒。
  原始报告阶段错误已用保存证据恢复；未调用外部质量裁判，仍为 pending-rubric。
  生成测试固定部分精确 I/O 次数与预算序列，可能误拒绝其他合理实现，已记录质量缺口。
- 独立负向实验验证：主测试漏检错误校验和并 ACCEPTED，独立判据 REJECTED，整体评测 failed。
  类型检查通过；定向工程测试 9 pass / 0 fail、40 个断言；执行器自检符合全部预期。

最终校准索引 `runs/project-evaluation-20261028/summary.json`；真实 AI 证据
`runs/ml-a/summary.reviewed.json`，原始 `summary.json` 保留。Redis 六例尚未逐例调用真实模型。
完整用例内容、对照、限制与重跑命令见 [`11-project-evaluation-cases.md`](docs/testset/11-project-evaluation-cases.md)。

### 8.22 七例真实 AI 全流程与逐阶段测量（2026-10-29）

在 WSL Ubuntu 24.04 调用真实 `deepseek-v4.1-flash`，执行六个 Redis 场景与通信依赖模拟场景；
正常阶段均为 AI 编写验证、AI 重构，无固定补丁注入。并发 2，UTC 起止时间差约 64 分 27 秒。
原始结果 **3 pass / 4 fail，0 blocked**；质量评分为独立会话的同一模型，分数供参考。

- 通信模拟、listpack、dict 完成双侧真实构建/测试并接受，固定独立复核分别 17/14/9 项通过；
  评分 0.82/0.90/0.88。通信模型自行提供 `transport_*` 替身与可控时钟，仍构建并调用真实业务库。
- SDS 与 AOF 都因生成测试自己的字节长度错误使正确原版测试失败；SET 编译成功后，
  构建脚本直接执行 `src/redis-server`，而构建阶段没有放行项目内程序（测试阶段另允许 `build/**`）；三者均 ABORTED。
  RESP 在生成阶段用尽 48 轮，未进入重构与实际运行。未修改输出或放宽判据以改判。
- 对三个有保存补丁的失败例另外执行固定诊断：SDS 15 项、SET 13 项及当次 179 项上游测试、
  AOF 12 项均通过。补证据评分为 0.80/0.40/0.62，不能替代原始失败。
  本批已生成的 6 份实际重构补丁均通过固定测试；没有证明全部生成测试可靠。
- 约 84% 的单例累计耗时在调查/生成验证；正式验证累计约 68 秒。关键缺口是原版失败后的反馈、
  明确产物执行契约、避免把环境未列工具当成不可用、减少实现细节断言与重复调查。
  评分器还会漏掉 ABORTED 场景已保存补丁，本轮通过单独补充评分保留并纠正证据，未改正式执行器。

最终证据 `runs/project-ai-20261029/summary.json`、`metrics.json`、`quality-scores.json`，
详细说明见 [`12-project-ai-results-2026-10-29.md`](docs/testset/12-project-ai-results-2026-10-29.md)。
本轮只新增报告和采集/诊断材料，未修改生产源码、提示词或正式判据；保留此前未提交用例实现，未推送远端。

后续按用户要求取消测试编写会话默认 48 轮上限：`sessions.testWriter.maxTurns=null`，
driver 不再向 SDK 传轮数上限；显式配置仍可覆盖，现有会话时间预算与无消息检测独立生效。
同步配置文档，并更正报告中本批运行当时的构建/测试执行权限区别：构建阶段的项目程序放行列表为空，
测试阶段才允许 `build/**`，文件存在断言不授予执行权限。类型检查、28 项定向测试与
`git diff --check` 通过；CLI 确认当前生效 `maxTurns=null`。未重新调用模型，历史运行结果保留。

### 8.23 工作区内相对产物路径执行（2026-10-29）

- 构建与测试阶段统一设置 `executableGlobs: ["**"]`，允许直接运行当前 worktree 内的产物，
  如 `src/redis-server`；不再要求产物位于 `build/`。底层 broker 的默认拒绝与自定义收紧能力保留。
- `program` 相对当前 worktree 根目录解析，不随进程 `cwd` 改变；根目录程序用 `./app`。
  原有词法越界、工作区外绝对路径与符号链接检查继续生效；辅助材料仍限制在 `build/verification/`。
  已同步构建/测试系统提示词与必读规范。
- 新增完整流程回归：两侧各自把真实源码与固定辅助代码编译到 `src/`，构建阶段执行冒烟检查，
  测试阶段再执行并比较观测，结果为 ACCEPTED。修复前同例因构建执行路径被拒而 ABORTED。
  另验证 `process.run/start` 对三种越界路径均拒绝，显式 `build/**` 策略仍可收紧执行范围。
- 验证：类型检查通过；Windows 四文件定向测试 **30 pass / 0 fail，163 个断言**；
  WSL Ubuntu 24.04 三项新增回归 **3 pass / 0 fail，24 个断言**，包含无 `.exe` 后缀的真实编译和双侧运行。
  未重新调用模型或重跑七例 Redis/通信评测；历史报告已注明后续修复，原始裁决保留。

### 8.24 四个失败场景的真实 AI 重跑（2026-10-29）

- 在新的 WSL 原生目录重新调用 `deepseek-v4.1-flash` 运行 SDS、SET、RESP、AOF 四例，
  不注入参考工作流或固定补丁；并发 2，日志 UTC 起止约 40 分 04 秒。此前通过的通信模拟、listpack、字典未重复调用模型。
- 正式结果 **1 passed / 3 failed，失败三例均为 ABORTED，0 blocked / 0 errored**：
  SDS 54 个输入场景、55 项比较一致，自动固定复核 15 项通过；SET 因 Bash 辅助脚本只传 3 参却读取 `$4` 中止；
  RESP 已完成生成及重构，但原版协议探针报 4 项失败，其中 ECHO 的数组参数数写成 1 而非 2 已确认，超长头无回复尚未单独定位；
  AOF 在生成阶段触发 20 分钟时间预算，没有重构补丁或实际构建、测试。
- 额外用固定流程验证本次 SET、RESP 实际补丁，两侧分别通过 13 项 + 179 项上游字符串测试、
  9 项 + 27 项上游协议测试；不改变原始主流程中止及自动复核未运行的事实。
- 原样重放上次 SET 工作流，构建阶段 `src/redis-server --version` 和 CLI 均能执行，直接确认路径规则修复；
  随后旧测试暴露 PTTL 预期 `-2`、实际 `-1` 的错误，原始记录保留。
- 单例总耗时中约 82% 用于调查和生成。已取消轮数上限，AOF 仍因时间预算中止；主要后续方向是有限反馈和控制生成范围。
  SET/RESP 初评漏收已保存补丁，补证据后均为 0.55；评分只作参考，SDS 1.00 也不代表内存安全已被完整证明。
- 详细报告：[四例重跑](docs/testset/13-failed-cases-rerun-2026-10-29.md)；证据：`runs/project-ai-rerun-20261029/`（忽略目录）。
  本次整理只新增报告和索引，未修改生成测试、生产代码、预算或正式判据；未提交或推送。

### 8.25 取消七例评测的 20 分钟会话预算（2026-10-30）

- 六个 Redis 用例与通信依赖模拟用例中，测试编写、重构两项 `deadlineMs` 均从 `1200000` 改为 `null`。
  显式取消下层配置的会话总时长限制；产品默认本已为 `null`，不修改通用执行器。
- 单例外层总超时仍为 90 分钟，无消息检测与单次构建、测试、命令预算独立生效。
  此次只改用例预算与说明，不改历史证据、不实现反馈机制，也未重新调用模型。
- 验证：通过测试集实际加载与配置解析，七例共 14 项会话预算均生效为 `null`；
  现有配置测试 **10 pass / 0 fail，29 个断言**，`git diff --check` 通过。

### 8.26 PR 交付整理与当前验证边界（2026-11-03）

- 将尚未提交的实现按运行权限与预算、项目评测与固定复核、报告与当前文档三个部分整理；
  临时 PR 正文和周报保持原样，不纳入这批提交。原始运行证据继续保留在忽略目录 `runs/`。
  前两部分分别保存为 `cb57651` 和 `00daa29`；均为本地提交，未推送远端。
- 固定补丁保留上游源码的上下文空白；仅对这批 `.patch` 设置路径级空白检查属性，
  避免把补丁语法和上游原文当作新代码的空白错误，不改校准过的补丁内容。
- 同步当前角色表和阶段说明：调查已合入 test-writer，同一会话提交计划再编写；
  两个编写角色暂时无 Bash，生产只保留 build-writer 子角色，不再创建 scout。
- 本会话已完成类型检查、四文件定向工程回归 **35 pass / 0 fail，179 个断言**、
  执行器自检和差异空白检查。整理只修正文档并提交已验证源码，没有再次调用模型，
  未重新运行完整工程套件或 Windows/Linux 全部离线用例。
- GitHub PR #3 当前仍为 OPEN，涉及跨平台、进程回收与既有测试集；本分支基于它开发。
  本次查询其 Windows/Linux 检查均为 SUCCESS，合并状态为 CLEAN；尚未执行远端合并。
  新 PR 应在其合并后比较 main，或暂以 `feat/testset-hard-targets` 为基线审阅，避免重复计算工作量。
- 反馈循环尚未实现，由后续工作负责。四例真实重跑仍为 1 通过、3 中止；
  取消会话预算之后没有重新运行 AOF，不能将它记为已解决或全部用例通过。

### 8.27 H6 错误补丁避免挂起并通过 Windows 定向验证（2026-11-03）

- PR #3 已合并；当前 PR #4 的 Windows CI 失败来自固定 H6 错误补丁：删除 backend timeout
  守卫使共享的资源回收检查超时，当前宿主正确中止流程，无法得到用例要求的 `REJECTED`。
- 将补丁收敛为只删除 `UV_RUN_DEFAULT` 首轮定时器处理，保留等待守卫。
  它仍会将回调顺序从 `TPC` 改成 `PCT`，但不再令关闭资源无限等待。
  更新用例标题和实测差异集合，保留 `REJECTED` 及 H6 oracle 三项必需差异；未修改判据或生产代码。
- Windows 本机运行 `judgement-accept-hard` 与 `judgement-mutant-h6-loop`：**2 pass / 0 fail**，
  分别为 `ACCEPTED`（0 差异）和 `REJECTED`（6 差异），两侧构建均通过，整批约 3 分 10 秒。
  共 84 次进程执行均自行退出；错误补丁的 `oracle_walk` 为 191 ms / exit 0，
  `oracle_loop` 为 160 ms / exit 1，明确报告唯一的回调顺序错误。
- 证据：`runs/h6-order-20261103-r2`。首跑 `runs/h6-order-20261103` 因基线测试程序缺失中止；
  用户说明误删情况后重新运行，未覆盖首跑记录。此次未调用模型、未重跑整套离线测试或远端 CI。

### 8.28 Linux 进程组终止确认竞态修复（2026-11-03）

- `ea2e4bc` 的两轮 Windows CI 均通过 23 项离线评测，PR 触发的 Linux 检查也通过；
  push 触发的 Linux 工程检查在 CTest 超时回收断言失败：结果已返回，测试子进程仍短暂存活。
  WSL 诊断复现了发送 `SIGKILL` 后立即返回的问题，不是 H6 补丁或僵尸进程误报。
- `shared/owned-process.ts` 在 POSIX 强制终止后增加最长 2 秒的进程组停止确认，
  Linux 按 `/proc` 中的进程组与状态排除已死亡的僵尸成员；仍有运行成员或无法检查时返回清理错误。
  直接父进程已经退出、管道已经关闭，不再被当作整个进程组停止的证据。Windows Job 路径未改。
- 新增两项 Linux 隔离回归：延迟送达强制终止信号时必须等待后代停止；阻止终止完成时必须有期限地报错。
  两项在旧实现均失败，修复后均通过；原 CTest 回收断言和 5 秒超时预算保留。
- WSL 同一诊断脚本缩短自身超时至 500 ms 连续运行 50 次：旧实现有 2 次返回时工具仍运行，
  修复后为 0 次。该诊断预算仅用于复现，不改变工程用例预算。
- Linux 定向进程/CTest 回归 **17 pass / 0 fail**；完整 `bun run check` 的类型检查、
  **227 pass / 2 skip / 0 fail（37 文件、853 断言）**与执行器自检通过，
  两项跳过均因当前 WSL 缺少 Ninja。Windows 类型检查通过，定向回归 **15 pass / 2 Linux 专用跳过 / 0 fail**。
- 证据：`runs/linux-process-reap-20261103/` 的 `regression-before.txt`、`regression-after.txt`、
  `fast-repeat-fixed.jsonl`、`lifecycle-fixed-linux.txt`、`check-fixed-linux.txt`。
  此轮未重跑大型离线套件、未调用模型或重跑远端 CI；macOS 未实跑。

### 8.29 普通 CLI 进度与结果报告（2026-11-04）

在 `codex/cli-progress` 分支补全普通 `run` 的显示，采用历史事件加底部状态行，无新增终端框架。
默认 `--verbosity detailed` 展示正常 AI 回复、工具目标、真实命令和进程输出；`summary` 显示阶段、
验证方案、执行结果与失败诊断。`--progress auto|plain|off` 和 `--no-color` 控制终端展示，
实时信息只写 stderr，结束报告只写 stdout；JSON 默认关闭实时展示。

实现边界：

- `StageFlowRequest.onProgress` 提供统一的类型化订阅；接通阶段、SDK 消息、验证方案提交、
  声明式与动态构建、测试能力代理和 CTest，CLI 无需轮询文件或匹配英文日志。
- 启动显示配置、来源、限制与 SDK 默认模型；运行显示两侧目录、阶段耗时、真实活动时间、
  各构建/步骤与验证范围。心跳不视为实际活动；普通 AI 回复与日志级别独立，内部思考和工具载荷不直接展示。
- `StageFlowResult.report` 和 `artifacts/run-summary.json` 保存清理后的统一报告，包含全部构建、
  未执行项、失配值、候选提交、改动文件和 SDK 提供的用量。保留旧 CLI JSON 顶层字段与测试集读取方式。
- 大值预览限制 1,024 字符；摘要最多显示 10 个失配。阶段耗时使用单调时钟，验证子阶段不再次加到总耗时。
  费用仅累计根会话；缺失数据不估算。清理失败保留验证结论及证据，继续以失败退出。
- 不更改构建/验证顺序、比较判据与原有成功/失败退出语义；不新增反馈循环、审批或恢复任务，不维护废弃看板。

验证状态（Windows，Bun 1.3.14）：`bun run check` 退出码 0，244 项通过、2 项仅适用 Linux 的测试跳过，
测试集执行器自检通过。新增的 17 项离线验证单独复验通过，包含 SDK 回放、终端渲染、真实小进程输出，
以及五个无模型 CLI 场景：接受、行为失配、候选构建失败、缺少产物与提前中止；
确认 stdout 可直接解析、全部构建均报告、报告与落盘一致，清理失败仍保留证据并维持失败退出。
针对性的超时、取消、CTest 超时与声明式构建验证通过；最终类型检查及 `git diff --check` 通过。
全量检查还暴露旧调查测试连续四次主机探测超过默认 5 秒的问题（独立复验耗时 6.6 秒）；
只将该测试自身的等待上限设为 60 秒，未修改程序运行预算或验证判据。
没有调用真实模型，没有运行 libuv 等大型测试集；本轮证据与两种模式的实际 CLI 输出位于 `runs/cli-progress/`。
尚未推送、创建 PR 或由用户验收。

### 8.30 CLI 成果提交与最新 main 整合（2026-11-09）

- CLI 原始成果已独立提交为 `b75250b`（`feat(cli): add live progress and durable run reports`），
  便于单独审查或回退；原有三份无关未跟踪文件保留，未加入提交。
- 整合本次 fetch 的 `origin/main`：`57b6473`，包含 PR #5 的结构化失败归因与阶段检查点恢复。
  三处文本冲突位于 CLI 入口、参数解析和阶段组合器；保留两侧功能，未改恢复规则与验证判据。
- 恢复入口转发类型化进度订阅和配置来源；终端显示恢复来源、复用阶段与本次重新校验耗时。
  统一报告增加 `failure` 与 `resume`，保留顶层 `failure` / `resumed_from`；验证仍在两侧重新执行。
- `stage_timings.status=reused` 区分复用成功和实际重新执行；失败归因与清理失败独立记录，
  不把清理错误改写为候选行为不一致。同步 README、CLI 帮助和阶段文档。
- 整合后的类型检查通过，八文件针对性回归 **56 pass / 0 fail**；完整 `bun run check` 退出码 0，
  **261 pass / 2 Linux 专用 skip / 0 fail**（42 文件，1156 个断言），测试集执行器自检通过。
  新增 CLI 恢复场景确认两侧完整重新验证、两种报告展示、单个合法 JSON、进度通道、配置和落盘报告。
  本轮只用离线夹具和 SDK 消息回放，不调用真实模型，不运行 libuv 等大型项目评测。
- 本地合并保留 CLI 原始提交和 main 历史，不推送、不创建 PR。另在忽略目录
  `runs/cli-experience-20261109/` 准备独立订单计价 C 项目、重构需求和 PowerShell 使用指南；
  原版真实构建及 16 项基础观测通过，真实 AI 全流程由用户在终端手动启动。

### 8.31 CLI 消息配色与工具活动展示（2026-11-09）

- 在 `codex/cli-progress` 增加共用终端样式层：阶段和报告标题蓝色加粗，AI 角色紫色，
  动作与字段青色，成功绿色，警告或中止黄色，失败或失配红色，原版与候选标签分别蓝色和紫色。
  AI 长段正文、路径、命令及进程输出正文保持默认色，时间和会话短编号弱化显示。
- 先净化外部控制字符再添加可信 ANSI；按可见 Unicode 字符宽度截断状态行。
  stderr 进度与 stdout 报告各自检测终端，保留 `--no-color`、`NO_COLOR`、`TERM=dumb` 与重定向时的无色行为；
  `formatRunReport` 可选颜色配置保持默认纯文本，JSON 与落盘报告不添加展示用 ANSI。
- 读取、写入、修改、查找、搜索及四种本地注册工具只在收到结果后记录一次，附安全目标、状态与实测耗时。
  按会话及调用编号关联并发；状态行显示最近动作与其他活动数量；中断或收尾仍未获得结果的调用明确标为未完成。
  子任务、命令与未知工具保留开始和结束。底层开始/结束事件、活动计时、执行流程和验证判据保持原有语义。
- 内部工具名转换为“保存构建方案”“登记构建依赖”等动作，未知 MCP 显示为 `服务名/工具名`；
  原始名称仍在事件和 SDK 记录中。安全目标仅补充已知构建方案名称、构建编号和依赖编号，不展示源码或完整参数。
- 新增 `scripts/replay-cli-progress.ts`，无需项目或凭据即可预览详细/摘要模式；
  `runs/cli-progress/color-examples/` 保存两种模式的 ANSI、纯文本、HTML 及验证日志。
  示例明确标注为模拟 SDK 消息和观测值，不代表一次真实重构通过或失败。
- 已验证：类型检查通过；四文件定向回归 **25 pass / 0 fail**（297 个断言，65.71 秒），
  覆盖配色开关、两通道独立检测、正文无染色、外部 ANSI 净化、并发/缺失/中断、窄终端 Unicode、
  正常接受、失配、构建失败、缺少产物、提前中止、清理失败、恢复运行与单个合法 JSON 的兼容性。
  未调用真实模型，未重跑大型测试集或全量 `bun run check`；未干预用户正在运行的任务，未推送、未创建 PR，尚待用户体验验收。

### 8.32 CLI 缺失任务交互与自动会话编号（2026-11-09）

- `--session` 原本即为可选参数；自动编号由单一毫秒时间戳改为时间戳加随机 UUID，
  防止同一毫秒启动的运行撞号。自定义编号继续有效，已存在的会话仍拒绝覆盖；恢复默认生成新编号。
- CLI 先完整解析其他参数，再在缺少或空白任务时补充输入。`RunCommand.task` 保持必填字符串，
  只有完成输入后才进入运行；原有 `parseCliArgs` 仍是同步的严格解析入口，不在解析器内部读取终端。
- stdin 与 stderr 同时为终端且不在 CI 时，省略 `--task` 会提示一行任务，列出仓库与任务后提供开始、
  重新输入、取消；回车默认取消。支持 `/cancel`、Ctrl+C、Ctrl+D 与输入结束，取消退出码 130；
  SIGTERM 退出码 143。输入异常按真实错误报告，结束时关闭 readline、恢复输入状态并移除临时信号监听。
- 新增 `--no-interactive`；CI、非终端输入或提示输出下缺少任务立即以退出码 2 报错。
  已提供非空 `--task` 的命令直接运行；缺少其他参数值或使用未知参数仍报错，不触发猜测或提示。
  提示发生在创建会话和模型调用之前，只写 stderr；JSON stdout 与颜色控制保持既有兼容规则。
- README 与 CLI 帮助补充最简启动、编号规则、取消行为和程序调用示例。
  定向验证 **46 pass / 0 fail**（6 文件，395 个断言，75.66 秒），类型检查通过；
  包含同一时间戳下不同编号、真实 CLI 自动编号持久化、终端模拟输入/取消、无交互报错、
  终端恢复、信号监听回收、输入异常，以及既有配色/JSON/恢复/流程验证。
  证据：`runs/cli-progress/interactive-input/`。未调用真实模型，未运行完整 `bun run check` 或大型项目评测；
  未干预用户运行，本轮成果整理为本地提交，未推送；尚待用户终端体验验收。

## 9. 已知限制与风险

### 9.1 权限边界依赖宿主目录，不是 OS 沙箱

删除自研 hook 后 `Write` / `Edit` 无路径约束；refactor 仍有 Bash，两个编写角色已按 §8.18 暂时移除。
"模型只能在其工作目录里动手"这一假设**不成立**：test-writer 的 cwd 就是
目标仓库本身，refactor 的 worktree 虽在 session 目录下，也能用相对路径或绝对路径
抵达仓库与会话状态文件。当前靠的是：显式工具白名单、`git push` deny 规则、
一次性环境，以及**宿主不信任会话状态**（重新测量 diff、重跑权威 workflow、
期望差分由程序裁决）。生产环境必须叠加平台级隔离：Linux 上的 SDK sandbox /
容器、只读挂载、网络禁用、资源配额。这一项在本轮改动后从"建议"升级为**前置条件**。

进程组和 Job Object 负责生命周期，尚未提供文件、网络或权限隔离。POSIX 宿主被强制终止时也不能依赖 JavaScript 退出回调完成回收。

### 9.2 行为观测范围仍不完整

当前覆盖 exit code、signal、stdout、stderr、文件副作用，以及 CTest 套件级结果与期望声明。尚未系统捕获网络请求、数据库变化、系统调用序列、子进程树和完整未定义行为证据。

### 9.3 sanitizer 执行链已移除

`SanitizerResult` 与执行器随 legacy 线删除；保留的 `SanitizerKind` / `SanitizerCapability` 仅用于主机能力探测与编译 flag 注入。当前主机上 ASan/UBSan 均缺少运行库（`-lasan` / `-lubsan`），如需该层证据要重新设计为独立的验证阶段。

### 9.4 模型侧超时不可完全托管

宿主给 `ctx.process.run` 提供默认预算并设上限，但模型在 workflow 源码里显式写的 `timeoutMs` 仍然优先。提示词已不再提供可照抄的数字示例，但无法从机制上阻止模型写死常量。

### 9.5 恢复策略仍不完整

Session state 支持 reopen；`ABORTED` 运行可在新会话中复用仍有效的脚本与候选提交检查点，
重新检查环境并执行验证。AI 会话本身、构建缓存与临时目录的恢复尚未完整建模，
不能无损恢复正在执行的模型轮次或构建过程；恢复也不会自动重放上一次命令行参数。

### 9.6 尚未适配任意 C 工程

现有测量与项目适配器主要覆盖 CMake 与显式源文件项目。原适配器缺失已不在 Preflight 直接阻断，
writer 可选择支持的局部编译方案；这不代表 Make / MSVC solution / 自定义工程已获得完整验证。
完整性检查递归保护已初始化子模块；未使用的空 gitlink 可保留。默认 worktree 准备尚不负责初始化所需子模块，
依赖这些源码的方案需要显式准备，否则构建按实际缺失失败。
历史 Windows 完整 libuv 官方套件运行存在网络与文件监听环境失败；本轮离线目标用例的通过不能替代完整官方套件验证。

## 10. 后续路线

按风险与收益排序。

1. **收紧运行边界（优先级最高）**：把 candidate worktree 移出目标仓库，或在 Linux 生产环境接入 SDK sandbox + 只读挂载 + 资源配额。这是当前架构最薄的一环。
2. **扩展项目适配面**：Make / MSVC / 自定义构建脚本的结构化支持，以及所需子模块的准备；局部验证的覆盖范围仍需独立评估。
3. **补齐行为捕获**：网络录制/回放、子进程树、syscall 序列；对 C 而言未定义行为应成为显式失败类别。
4. **程序化测试输入生成**：边界整数、空/超长字符串、控制字符、非 UTF-8 字节、缺失文件与环境变量；Agent 负责领域输入，程序负责边界补齐与去重。
5. **恢复与审批**：模型轮次/构建过程的无损恢复；workflow 危险能力的审批通道（见 [`docs/roadmap-approval-mode.md`](docs/roadmap-approval-mode.md)，已记录未实现）。
6. **再考虑多语言**：需先稳定 `LanguageAdapter` / `BuildAdapter` / `ObservationAdapter` / `Comparator` / `DependencyController` 抽象。第一批可考虑 C++。
7. **持续校准能力评估**：已有固定测试集、按平台探测与筛选、CLI 执行、冻结/重判和裁判接口（见 `docs/testset/`），继续积累模型与配置的可比较证据。`verify` 槽可注入，但注入的运行一律记为**非权威**。

已放弃的方向（不再推进）：

- 自研文件级权限边界（见 §1 的决策说明）；
- 固定 libuv 任务作为主线（保留为回归 fixtures）；
- Make / MSVC 的结构化 Adapter（暂不实现，允许选择可执行的局部方案，视需要再议）。

已决定（2026-10-14）：独立 Analyze 删除，只保留 Preflight 测量；验证方案交给 test-writer，
skills 指导选择，宿主双侧实际执行与完整性检查承担运行判定。实现与本轮验证记录见 §8。

## 11. 结论

核心闭环已经跑通并产出了首个真实 `ACCEPTED`：

```text
真实 Claude
  → 声明构建依赖 + 编写可执行 workflow 源
  → 程序解析并验证声明集
  → 一次性 worktree 中重构（无文件白名单，行为门禁兜底）
  → baseline / candidate 双跑同一 workflow
  → 期望差分 + 程序裁决 ACCEPTED / REJECTED
```

设计上做过的两个关键取舍：

1. **从"宿主预声明"转向"模型声明 + 程序验证"**——声明制让 workflow 由模型按项目事实编写，宿主只负责执行与裁决；
2. **从"自研权限边界"转向"工具白名单 + 一次性环境 + 行为门禁"**——承认宿主无法预知重构形态，把约束放在可验证的结果上。

下一步的短板不在闭环本身，而在**运行边界的工程化**（§9.1）与**项目适配面**（§9.6）。

---

# 附录：历史验证记录（2026-08-25 ~ 2026-09-01）

> **阅读须知**：以下章节按时间顺序保留原始记录，部分描述对应的架构**已被取代**，包括但不限于：
>
> - `ScopeManifest` / `PreToolUse` hook / R4 scope 校验 —— 已整体删除（`66f462e`）
> - `resolve-workflows.ts` / `chooser.ts` / `generate-strategy.ts` —— 已被声明制（`declareDependency` + `DeclaredBuildSet`）取代
> - `builder.ts` / `runner.ts` / `comparator.ts` / `pipeline.ts` / `agent-pipeline.ts` / `analyze-legacy.ts` 等 legacy 线 —— 已删除
> - `sanitizer-runner.ts` 与 `SanitizerResult` —— 已删除（能力探测保留）
> - 脚本 `demo-e2e.ts` / `demo-agents.ts` / `e2e-agent.ts` / `e2e-differential.ts` —— 已删除
> - `scope_denials` 指标与 `R4` 规则 —— 已删除
>
> 保留这些记录是为了留存当时的实测数据与排查过程。

## A.1 libuv 大型 CMake 基准

### A.1.1 固定测试对象

- 项目：libuv；
- 固定版本：`v1.52.1`；
- 来源：官方 GitHub 仓库 `https://github.com/libuv/libuv.git`；
- Windows 构建方式：CMake；
- 测试构建开关：`BUILD_TESTING=ON`、`LIBUV_BUILD_TESTS=ON`，关闭 benchmark 以缩短第一阶段构建。

### A.1.2 分阶段目标

1. **阶段一：CMake baseline**
   - 获取固定版本源码；
   - 识别 CMake 项目；
   - 通过通用 BuildWorkflow 执行 CMake configure；
   - 通过通用 BuildWorkflow 执行 Debug 构建；
   - 确认 shared/static 多配置输出路径和构建产物。
2. **阶段二：官方测试套件**
   - 执行 `ctest -C Debug --output-on-failure`；
   - 解析测试结果、失败日志和环境失败；
   - 增加测试套件级 timeout 与子进程清理。
   - **已完成实现与实测**：CTest Runner 已支持 shared/static 顶层 target、TAP 内层失败用例归属、Not Run 识别、超时和 Windows 进程树清理。
   - libuv `v1.52.1` Debug shared/static 构建成功；通用 BuildWorkflow 返回 configure/build 成功且 `missingArtifacts=[]`，CTest 两个顶层测试均执行，但当前 Windows 主机存在环境敏感失败，最终分类为 `test_failure`（2 个顶层 CTest 测试失败），不是 baseline 全通过。
3. **阶段三：Sanitizer 基线**
   - 按 HostPreflight 能力选择 ASan / UBSan；
   - 记录 sanitizer 构建和运行结果；
   - 将未定义行为单独分类为验证失败。
   - **已完成实现**：`sanitizer-result` 独立 Artifact、能力实测、direct-compiler/CMake flags 注入、逐用例诊断归类、unsupported/build/runtime/timeout 分级、baseline/candidate 独立持久化。
   - 当前主机显式探测结果：GCC 可用，但 `-fsanitize=address` 链接缺少 `-lasan`，`-fsanitize=undefined` 链接缺少 `-lubsan`；因此 sanitizer 阶段在本机为 **UNSUPPORTED**，流程 fail-closed，不会伪造 sanitizer pass。
4. **阶段四：受控小范围重构**
   - 先选择 `src/strscpy.c`、`src/strtok.c`、`src/version.c` 等低风险单文件；
   - 保持 ABI/API、官方测试、sanitizer 结果不变；
   - 暂不直接重构网络、线程、进程和平台核心代码。

### A.1.3 阶段一验收标准

```text
fixed libuv v1.52.1
→ ProjectDetection.primary_build_system = cmake
→ ProjectDetection.status = ready
→ CMake configure succeeds
→ Debug build succeeds
→ build/Debug/uv_run_tests.exe exists on this Windows host
```

阶段一脚本：

```bash
bun run demo:libuv
```

源码默认放在临时目录，不提交第三方源码到本仓库；也可以通过 `--source <path>` 使用已有 checkout。

阶段一已经完成；CTest 结果协议和 sanitizer 结果协议已接入运行层，但大型第三方套件的环境失败不会被自动忽略。

### A.1.4 阶段一至三实测结果

阶段一：

- 固定版本 `v1.52.1` clone 成功；
- `ProjectDetection.primary_build_system = cmake`；
- `ProjectDetection.status = ready`；
- Windows CMake 使用 Visual Studio 多配置生成器；
- shared/static 测试目标构建成功，实际产物包括 `build/Debug/uv_run_tests.exe` 和 `build/Debug/uv_run_tests_a.exe`。

阶段二：

- `ctest -C Debug --output-on-failure` 已实际执行两个顶层测试目标；
- CTest Runner 已解析 TAP 内层失败、Not Run 和目标归属；
- 当前主机结果为 **FAIL（可解释环境失败）**，失败涉及短路径文件监听、DNS 负向解析和 TCP 超时行为；不能作为“全套 baseline 通过”证据。

阶段三：

- sanitizer 能力探针、编译 flags 注入、逐用例运行和独立 Artifact 已实现；
- 当前 GCC 可用，但 `-fsanitize=address` 缺少 `-lasan`，`-fsanitize=undefined` 缺少 `-lubsan`；
- 本机 sanitizer 结果为 **UNSUPPORTED**，流程 fail-closed，未伪造 pass；获得可用 sanitizer 工具链后再执行 libuv sanitizer baseline。

大型 libuv CTest 通常需要数分钟；普通 TypeScript 类型检查和本地测试不依赖该长流程。源码仍只保存在临时目录。
### A.1.5 Ninja Adapter 实测结果

- `build.ninja` 位于常见 `build/` 目录时，项目探测仍能识别 Ninja，不会因跳过生成目录而错误回退到 direct C；
- `ProjectDetection.primary_build_system = ninja`；
- `ProjectDetection.status = ready`（当前主机 Ninja 可用）；
- 真实 Ninja C 项目构建成功，`build/app.exe` 存在；
- 验证命令：`bunx tsc --noEmit`、`bun test tests/build-infrastructure.test.ts`（5 pass）、`bun test tests/environment.test.ts`（3 pass）、`git diff --check`；
- Ninja 适配器尚未支持对已有 Ninja graph 自动注入 sanitizer 或 determinism shim，相关请求会明确失败，不会静默忽略。
### A.1.6 真实 Claude 全流程验收记录（2026-08-26）

执行入口：`bun run scripts/demo-libuv-agent.ts --source <libuv-checkout> --session libuv-agent-live-001`。

本次运行实际完成：

- Claude 分析 Artifact 通过 Host Schema 校验：`behavior-contract`、`scope-manifest`、`dependency-manifest`、`test-spec`、`environment-spec` 均已保存；声明的唯一可编辑文件为 `src/strscpy.c`。
- Refactor Agent 修改范围内运行，`scope_denials=[]`；候选 patch 仅包含 `src/strscpy.c`。
- baseline 和 candidate 的 CMake configure/build 均成功，两个构建步骤退出码均为 `0`，构建产物检查通过。
- baseline/candidate 均执行 shared 与 static 两个顶层 CTest 目标；每个版本的 CTest 退出码均为 `8`，套件状态均为 `fail`，完整测试过程均被记录。

失败分类：

- 两侧共同出现：`fs_event_watch_dir_short_path`、`getaddrinfo_fail`、`getaddrinfo_fail_sync`、`tcp_connect_timeout`；baseline 另出现 `tcp_close_while_connecting`，candidate 则在另一个顶层目标中出现该测试。
- baseline 的 11 条失败记录均被分类为 `environment`，且 `related_to_scope=false`；证据对应 Windows 短路径文件监听、DNS 负向解析和 TCP 超时/连接时序行为，不指向 `src/strscpy.c`。
- CTest 比较器发现失败集合发生顶层目标漂移：新增 `uv_test_a:tcp_close_while_connecting`，移除 `uv_test:tcp_close_while_connecting`。因此比较结果为 `inconsistent`，不是一致通过。

验收结论：

- 会话最终状态为 `REJECTED`，状态机从 `VERIFICATION_RUNNING` 转入 `REJECTED`；候选 patch 未被接受。
- 这是符合 fail-closed 规则的验收结果：构建成功和大部分测试一致不足以证明行为保持，环境敏感失败集合发生漂移时必须拒绝自动接受。
- 本次证明的是“真实 Claude → 结构化 Artifact → 受限修改 → 双 worktree 构建 → 完整 CTest → 程序化拒绝”链路可运行；不证明该 libuv patch 已安全，也不证明大型 CTest baseline 在当前 Windows 主机上全通过。
- 运行证据保存在 `.refactor/e2e/libuv-agent-live-001/` 下的 `run.jsonl`、`state.json` 和 `artifacts/`；关键 Artifact 包括 `patch-candidate.json`、`baseline-build.json`、`candidate-build.json`、`ctest-baseline.json`、`ctest-candidate.json`、`ctest-comparison-result.json`。
## A.2 收尾验证（2026-08-27）

### A.2.1 实时观测与 WebUI

- `bun test tests/e2e-observability.test.ts`：3 pass、0 fail、26 个断言；覆盖 `E2ELogger` 的 `state.json` / `run.jsonl` / Artifact / 日志持久化、Dashboard HTTP 资源接口、root containment / 非法路径拒绝，以及 SSE 首帧和 `after` 游标增量事件。
- 真实启动 `scripts/e2e-dashboard.ts` 后用浏览器检查桌面和 390px 窄屏页面：运行列表、拒绝状态和失败原因、Artifact 预览、日志预览均可用；追加事件后页面事件数由 4 增至 5，最后事件同步更新，连接状态为 `SSE 已连接`。
- 窄屏实测：`body.scrollWidth = 390`，详情栏由 sticky 变为 static，运行队列切换为 block 布局，无横向溢出。

### A.2.2 四项 targeted E2E

| 命令 | 实测结果 |
|---|---|
| `bun run e2e:cmake` | `e2e-cmake-smoke@1`；CMake configure/build 均退出码 `0`，产物存在，`status=pass` |
| `bun run e2e:differential:safe` | `expected=ACCEPTED`、`actual=ACCEPTED`；状态机走到 `VERIFICATION_RUNNING -> ACCEPTED` |
| `bun run e2e:differential:broken` | `expected=REJECTED`、`actual=REJECTED`；状态机走到 `VERIFICATION_RUNNING -> REJECTED` |
| `bun run e2e:agent` | 真实 Claude Analyze → Refactor → 程序验证完成，`state=ACCEPTED`；Hook 记录多次越界 Read/Glob/Grep 拒绝，`scope_denials` 非空，说明拒绝边界实际生效 |

四项 targeted 命令均以退出码 `0` 结束，且接受/拒绝结果与场景预期一致。

### A.2.3 完整 libuv CTest

命令：

```bash
bun run e2e:libuv -- --source C:/Users/Yu/AppData/Local/Temp/refactor-libuv-in4Ow9/libuv
```

实测结果：

- 固定 checkout 的 CMake configure/build 成功；shared/static 测试程序均生成。
- CTest 实际运行约 `363.72 sec`；`uv_test` 与 `uv_test_a` 两个顶层目标均执行完成。
- `strscpy`、`strtok` 目标用例均为 `ok`。
- 套件最终为 `0% tests passed, 2 tests failed out of 2`，退出码非零；失败集中在 Windows 环境敏感的 `fs_event_watch_dir_short_path`、`getaddrinfo_fail`、`getaddrinfo_fail_sync`、`tcp_close_while_connecting` 和 `tcp_connect_timeout`。
- 该结果符合 fail-closed 预期：完整套件失败被如实保留，未被降级为通过。首次使用 Windows 反斜杠参数的调用在进入 CTest 前因命令参数转义失败；改用正斜杠绝对路径后完成了上述真实 CTest，前者不计入套件结果。

### A.2.4 最终工程检查

```text
bunx tsc --noEmit       → pass
bun test                → 52 pass / 0 fail（13 files，153 expect()）
git diff --check         → pass
```

当前结论：实时观测闭环、四项 targeted E2E 和完整 libuv CTest 均已获得真实运行证据；小型 CMake/差分/Claude 场景符合预期，完整 libuv 官方套件受当前 Windows 网络/文件监听环境影响保持非绿色，系统继续按 fail-closed 规则拒绝将其视为安全接受。

### A.2.5 生成 TypeScript Workflow 最终闭环（r11）

- 为 Windows + CMake 场景修正了生成 BuildWorkflow 的目标策略：`target: null` 构建默认目标，确保 `trim_app` 与 CTest 所需的 `trim_test` 同时生成；主 Artifact 仍校验 `build/trim_app`。
- 为 Claude Agent SDK 的 PreToolUse Hook 增加了相对工具路径规范化：通过 Scope 校验的 `Read`、`Glob`、`Grep`、`Write` 和 `Edit` 输入统一解析到 Agent `cwd`；越界路径仍 fail-closed 拒绝。Refactor prompt 同时提供候选 worktree 的绝对可编辑路径。
- 修正 CTest 输出解析，兼容 Windows CTest 的标准 `Passed` 行；修复前的 r10 证据显示 CTest 实际通过但未被解析器观测，修复后必需测试集合正确记录为 `trim_behavior`。
- Dashboard 增加运行期间 Artifact/日志列表刷新，并保持 SSE 状态与资源读取的竞态保护。真实浏览器验收显示 r11 的 `ACCEPTED` 状态、73 条事件、16 个 Artifact、4 个日志文件；`ctest-comparison-result.json` 预览为 `overall=consistent`，`candidate-ctest.log` 预览为 `100% tests passed`。

真实运行命令：

```text
bun run scripts/e2e-generated-workflow.ts --root C:/Users/Yu/AppData/Local/Temp/refactor-generated-workflow-final --session generated-workflow-final-r11
```

实测结果：

- `generated_workflows=true`；BuildWorkflow 与 TestWorkflow 均为 generated、revision `1`，TestWorkflow runner 为 `ctest`。
- 状态机完整走过 `INIT -> CONTRACT_READY -> SCOPE_READY -> DEPENDENCY_READY -> TESTS_READY -> BUILD_WORKFLOW_READY -> TEST_WORKFLOW_READY -> ENV_READY -> BASELINE_READY -> PATCH_CREATED -> VERIFICATION_RUNNING -> ACCEPTED`。
- baseline/candidate CMake configure 和 build 均退出码 `0`，Artifact 均存在；baseline/candidate CTest 均退出码 `0`，测试总数 `1`、通过 `1`、失败 `0`、未运行 `0`，顶层测试均为 `trim_behavior`。
- CTest comparison 为 `consistent`，新增失败和消失失败均为空；候选 patch 仅修改 `src/trim.c`，scope denials 非空，说明模型越界访问仍被程序 Hook 拒绝。
- r9 已证明 CMake 默认目标修复有效但暴露了 CTest 解析边界；r10 因 Claude API `502 upstream request failed` 在 Workflow Resolution 中止；r11 在相同真实场景完成接受，r10 不计入代码失败。

本轮工程检查：

```text
bun test                  -> 57 pass / 0 fail（13 files，174 expect()）
bunx tsc --noEmit         -> pass
git diff --check           -> pass
```

 当前结论：生成 BuildWorkflow/TestWorkflow、Claude 受限重构、worktree 隔离、baseline/candidate 双版本构建、CTest 差分比较、状态机接受和 Dashboard 实时观测均已在 Windows CMake fixture 上获得真实 r11 证据。该结果证明当前原型闭环可运行，不代表已达到适配任意 C 工程的生产级完成度。

## A.3 Plan 声明与 workflow-driven 构建（2026-09-01）

### A.3.1 Workflow Plan 声明（树状步骤可视化）

workflow 可通过 `context.plan` 声明嵌套步骤树，供可视化与观测：

```ts
const [build, test] = await plan.declare([
  { title: "Build", description: "compile", children: [{ title: "Configure" }, { title: "Compile" }] },
  { title: "Test", children: [{ title: "Unit" }] },
]);
await plan.begin(build);       // 返回根 id：p1、p2
await plan.begin("p1.1");      // 子节点 id：父id.序号
await plan.complete("p1.1");
```

- **id 全局唯一**：根为 `p1`/`p2`...，子节点 `父id.序号`；`declare` 返回根 id 列表；
- **状态机校验**：begin 必须 pending、complete 必须 running、fail 必须非 completed，未声明即标记 → 报错 fail-closed；
- **协议**：复用 capability-request 通道（capability: `plan`），broker 记录状态，`runWorkflow` 返回 `plan` 树；
- 测试：`tests/workflow-plan.test.ts` 6 项（树状声明、未声明拒绝、重复 begin、缺 begin complete、fail、空 title）。

### A.3.2 workflow-driven 构建（L1 落地）

新增 `environment.build.kind: "workflow-driven"`：

- workflow 函数**在 execute 阶段重跑**，用注入 capabilities 自主驱动构建（任意次 process.run、fs 操作），返回 `{ artifacts: {逻辑名: 路径} }` 作为执行产物；
- execute 校验声明的 artifacts 存在，缺失 → fail-closed；
- 生成策略降级：`CMakeFactsGenerationStrategy.template()` 推导不出（复杂 CMake / 非 CMake）时返回 `null`，`resolve-workflows` 生成分支转 AI 自主（无模板）——**消灭了"模板 + AI 誊写"的冗余模型调用**；
- 策略能推导时，程序直接 `writeFileSync` 写模板（零模型调用）；
- 测试：`tests/workflow-driven.test.ts` 3 项（schema 解析、execute 真构建 + 产物校验、缺失产物拒绝）。

### A.3.3 单次执行与 policy（2026-09-01 完善）

- **resolve 零副作用**：`BuildWorkflowResolution.output` 对 workflow-driven 为 **null**（可空类型）。resolve 阶段**既不执行也不提取**——删除了静态提取正则（`extractLiteralOutput` 等），workflow 函数完全自由（可动态算产物、读文件决定 output）；已用测试证明 resolve 后 `build/` 与源文件均未创建；
- **execute 单次执行**：函数只在 execute 阶段跑一次（真实构建），返回完整 BuildWorkflowOutput → 校验 identity + 产物存在；
- **TestWorkflow 绑定轻量化**：`resolveTestWorkflow`/`testCandidates` 等只消费 `{workflow_id, workflow_revision}`（`BuildWorkflowIdentity`），不再依赖完整 output；workflow-driven 时用 manifest id 兜底；
- **状态机 ENV_READY**：workflow-driven 时 environment 由程序构造固定形状（`{kind:"workflow-driven"}`），不依赖 output 提取；
- **复用漏洞修复**：`resolveStoredBuild` 对 output=null（workflow-driven）的候选**重新 resolve**（重新验证来源），不再信任持久化；声明式仍走 hash 验证的快速路径；
- **policy 修复**：`workflow-pipeline.ts` 的 `executeBuild` 现在传 `entry`，且 workflow-driven 模式 `writableGlobs` 放宽到 `["**"]`（函数是可信构建逻辑），声明式模式仍为 `["build/**"]`；
- **入库**：workflow-driven 的 output 存 null（`registry.saveBuildWorkflow` 已支持），`cli.ts`/`demo-libuv.ts` 输出适配。

### A.3.4 审批模式（roadmap）

`docs/roadmap-approval-mode.md` 已记录：workflow 声明需审批的能力 → 无审批通道 fail-closed / 有通道挂起等用户批准。本次未实现，按用户要求仅记录。

### A.3.5 工程检查

```text
bunx tsc --noEmit   → pass
bun test            → 73 pass / 0 fail（16 files，230 expect()）
```
