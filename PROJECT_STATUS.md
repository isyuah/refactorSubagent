# Behavior-Preserving Refactoring Agent：项目现状与后续路线

> 文档日期：2026-11-27（§1–§11 为当前状态；历史实现细节可从 git 历史找回）
>
> 当前定位：面向 C 代码的行为保持型重构原型。闭环已在 Windows + MinGW + Claude Agent SDK 环境完成真实端到端验证（含首个 `ACCEPTED`）；已补齐 Windows/Linux 工程检查与 CI 配置，并统一进程超时、取消和回收。验证结论见 §8，平台级宿主隔离仍待实现。

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

**关于修改边界的决策**：早期版本用 `ScopeManifest`（可编辑文件白名单）+ `PreToolUse` hook + R4 patch 范围校验来约束模型。该机制已**整体删除**，原因有二：

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
根据源码与 Preflight 事实交付代码，实际编译和测试由宿主随后执行（见 §6）。
refactor agent 仍可在一次性 worktree 之外编译检查自己的修改。
工具列表不是文件系统隔离：Write/Edit 及 refactor 的 shell 仍可触及用户权限可达的路径。
宿主继续重新测量 diff（§5.2）、固定验证材料并重跑权威 workflow；真正的隔离仍待平台层（§9.1）。
`git push` 通过 deny 规则挡住（实测有效），其余风险依靠一次性环境与完整性检查降低。

## 2. 当前技术栈与验证环境

### 2.1 项目运行时

- TypeScript / Bun
- TypeScript 5.7.3：宿主、脚本、工程测试和测试集执行器的严格类型检查
- Zod：Artifact 与配置的运行时 Schema 校验
- `@anthropic-ai/claude-agent-sdk` 0.3.259：驱动 Claude Code
- `@opentui/core` 0.9.2：OpenTUI 终端工作台
- `diff` 9.0.0：行级差异显示
- pino：运行日志
- Git：worktree 隔离与候选 patch 管理
- GCC / MinGW：当前 C 构建后端

```json
{
  "@anthropic-ai/claude-agent-sdk": "0.3.259",
  "@opentui/core": "0.9.2",
  "diff": "9.0.0",
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
CI 矩阵为 Ubuntu 24.04 / Windows Server 2022，固定 Bun 1.3.14。

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
│  ├─ observation-trace.ts       调用级行为观测
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
│  ├─ exam-precheck.ts           重构前的考卷彩排（原版 HEAD 的临时 worktree）
│  ├─ stage-flow.ts              阶段契约 + 组合器（AI 与预置阶段共用）
│  ├─ stage-presets.ts           无 AI 预置阶段（预置 workflow / 补丁 / 既有分支）
│  ├─ e2e-log.ts                 结构化运行日志（JSONL + state.json）
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
└─ resume-verification.ts        从持久化产物续跑验证段

shared/
├─ owned-process.ts              进程组 / Job 的所有权、回收与宿主退出处理
└─ windows-process-host.ts        进入 Job 后启动目标、经 IPC 回报实际退出结果

testset/                         用例材料、平台探测、CLI 执行与判定
tests/                           56 个测试文件（验证证据见 §8）
examples/trim-app/               C 基线项目 + safe/broken 变体
```

> 补注：上表为摘要，未逐文件展开；`src/cli/tui/`（OpenTUI 工作台）、`src/runtime/feedback/`、
> `src/runtime/stage-resume.ts`、`src/agents/verification-*.ts`、`workflow-repair.ts` 等也是当前目录的一部分。

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
├─ stage-checkpoints.json        workflows / refactor 完成后的可复用事实（恢复用）
└─ artifacts/
   ├─ <artifact-kind>.json       每个 Artifact 一个文件
   ├─ failure-report.json        中止时的失败阶段、分类与原因
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

生产流程有三类主角色，另有按失败类型启动的反馈修复会话；工具集**逐条显式列出**（SDK 中省略列表 = 继承全部内置工具，含
Bash/WebFetch，因此 `DriverOptions.allowedTools` 是必填参数，漏传会编译失败）。
两个编写角色暂时无 Bash，refactor 保留 Bash；`Bash(git push:*)` 对所有会话 deny。

| 会话 | 工具（常量名） | 产物 |
|---|---|---|
| test-writer | `TEST_WRITER_AGENT_TOOLS`：Read / Glob / Grep / Write / Edit / Task；另有显式 MCP 工具 | 结构化验证计划 + TestWorkflow 源 + `declareDependency` 声明集 |
| build-writer（经 Task 派生的子 agent） | Read / Glob / Grep + MCP `generateBuildWorkflow` / `inspectWorkflow`（无 Write/Edit/Bash） | BuildWorkflow 源、固定辅助材料与预期产物使用说明（经宿主 registry 落盘） |
| refactor | `REFACTOR_AGENT_TOOLS`：Read / Write / Edit / Glob / Grep / **Bash** | candidate worktree 内的改动 |

- **反馈修复会话**（`--auto-retry`，默认 3 次）：源策略违规由 `source-repair` 会话处理，原版构建失败由 `build-repair` 会话处理；候选代码失败或行为失配继续原 refactor 会话，测试脚本错误继续原 test-writer 会话。`--exam-precheck`（默认关闭）在重构前用原版代码彩排考卷：预检失败走同一套路由（原版构建 → build-repair，脚本错误或考卷自违 → test-writer）；此时候选尚未建立，修复轮会重新建场并跑完整重构。正式验证中若全部失配都是考卷自违（原版代码不满足自身 `both-matches` 模式），路由为 `needs-diagnosis` 并直接停止，不消耗修复次数。环境、宿主或无法分类的失败直接停止。
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
| `workflows` | test-writer 会话声明构建/测试 | `presetWorkflowsStage`（用仓库里的 workflow 源）/ `testPlanWorkflowsStage`（复用已保存方案） |
| `prepare` | 新建候选分支 + 双 worktree | `existingBranchPrepareStage`（复用既有候选分支） |
| `refactor` | refactor 会话改候选区 | `patchRefactorStage` / `fixedRefactorStage` |
| `verify` | 差分构建 + 跑测试 + 判定 | 允许替换；非宿主实现的 verify 记 `verification_authoritative: false`（宿主默认实现及其包装仍为权威） |

- **宿主不变量**（阶段拿不到）：状态转移（`Orchestrator`）、候选改动集测量（阶段只返回 summary）、
  门禁顺序（存在 C 源码 / 改动非空 / 声明集非空）、worktree 清理与 run-local 提升。
- **考卷预检**（`--exam-precheck`，默认关闭，不是独立阶段）：workflows 阶段产出声明后、prepare 之前，
  在 HEAD 的 detached 临时 worktree 上注入辅助材料与 `--inject` 文件，执行全部声明的构建和一次
  测试 workflow，并检查 `both-matches` 断言是否与原版观测自洽。失败以结构化归因抛出，交给反馈路由；
  不提交验证工件、不进状态机。声明式考卷、配置的 base 与 HEAD 不一致、或 custom prepare 未声明
  base 时跳过并记日志，避免彩排错误的提交。
- writer 按源码与覆盖选择验证范围；执行检查所需工具、产物、受控源码和固定输入。
  含任务专属辅助材料的构建保留 run-local，避免推广缺少材料的配方。见 [`docs/verification-strategies.md`](docs/verification-strategies.md)。
- 阶段可 `halt(reason)` 叫停，由组合器统一 `abort`；槽位无法自行推进状态机。
- 注入痕迹落 `stage-provenance.json`（artifact）并进返回值，一次 ACCEPT 永远可回答"真判还是演的"。
- **应用层**把配置翻译成槽函数（core 不接受配置文件）：`.refactor/pipeline.json` +
  `--pipeline-file` / `--stage`，与 §7 同一套多源引擎（`config/layers.ts`）；
  入口 `bun scripts/cli.ts run <repo> --task <text>`。没配的阶段保持 AI 默认。
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
- `bun scripts/cli.ts limits <repo>` 可查看生效值与来源层。

完整用法见 [`docs/limits.md`](docs/limits.md)。

同一套多源引擎（`src/config/layers.ts`）也承载阶段来源配置（§6.1）：
`~/.refactor/pipeline.json` < `<repo>/.refactor/pipeline.json` < `--pipeline-file` < `--stage`，
合并顺序与阈值完全一致；`limits` 是引擎的第一个域，`pipeline` 是第二个。

### 7.1 进程生命周期

Workflow worker、capability 工具、CTest 和测试集命令共用 `spawnOwnedProcess`：
Windows helper 先加入 kill-on-close Job，再启动真实目标；POSIX 使用独立进程组，TERM 后等待 200ms，再按需 KILL。
负责关闭内层进程组的 CLI 有独立的 4s 宽限，防止外层与内层相同的 200ms 预算产生回收竞态。
回收后的进程退出等待上限为 2s，管道排空等待上限为 1s；清理失败进入结果诊断。

broker 的 `close()` 幂等、并行回收所属工具，并取消 file/TCP readiness。
capability 请求按 id 并发处理，等待进程不会阻塞同一进程的 stop；正常返回、异常、超时和取消均关闭 broker。
没有最终 worker envelope 时，宿主已收到的 capability 事件仍保留。

`runWorkflow`、`runCTest`、测试集 `exec` 接受 `AbortSignal`；CLI、测试集和离线入口处理 SIGINT/SIGTERM，
宿主显式退出时也回收仍登记的进程。已提前取消的调用不会启动工具；CTest 超时优先于必需测试缺失的判定。

## 8. 当前验证状态

工程检查、离线判据与真实 AI 评测的当前结论如下。逐次运行的过程记录保存在 git 历史中，原始证据在 `runs/`（忽略目录），需要时可按提交找回。

| 范围 | 当前结论 | 证据 |
|---|---|---|
| 工程检查 | `bun run typecheck`、56 个测试文件、执行器自检；Windows/Linux CI 执行 `check` 与 `test:offline` | `.github/workflows/check.yml` |
| 判据本体 | 19 个离线用例，覆盖正对照、变异体、篡改与注入覆盖；不需要模型 | `testset/cases/judgement-*` |
| 重构能力 | T1–T6 与 H1–H8 均完成过实测；hard 档在冻结判据下实测 ACCEPTED | `runs/`、`testset/cases/refactor-*` |
| 真实 AI 全流程 | 7 个 Redis/依赖模拟用例首轮 3 通过 4 中止；4 个失败场景重跑 1 通过 3 中止；失败原因逐例归因，未改判 | [`12`](docs/testset/12-project-ai-results-2026-10-29.md)、[`13`](docs/testset/13-failed-cases-rerun-2026-10-29.md) |
| 其他能力档 | writer 4 例、scout 6 例、corpus 4 部分；按 subject 选择运行 | `testset/cases/`、[`docs/testset/`](docs/testset/) |

真实 AI 的通过率不是判据的通过率：失败主要发生在生成测试自身或预算/路径衔接，宿主没有把失败改判为通过。当前不声称 7 个场景都能稳定通过，也不把不同批次的通过拼成一组。

## 9. 已知限制与风险

### 9.1 权限边界依赖宿主目录，不是 OS 沙箱

删除自研 hook 后 `Write` / `Edit` 无路径约束；refactor 仍有 Bash，两个编写角色已暂时移除。
"模型只能在其工作目录里动手"这一假设**不成立**：test-writer 的 cwd 就是
目标仓库本身，refactor 的 worktree 虽在 session 目录下，也能用相对路径或绝对路径
抵达仓库与会话状态文件。当前靠的是：显式工具白名单、`git push` deny 规则、
一次性环境，以及**宿主不信任会话状态**（重新测量 diff、重跑权威 workflow、
期望差分由程序裁决）。生产环境必须叠加平台级隔离：Linux 上的 SDK sandbox /
容器、只读挂载、网络禁用、资源配额。这一项是生产环境的**前置条件**。

进程组和 Job Object 负责生命周期，尚未提供文件、网络或权限隔离。POSIX 宿主被强制终止时也不能依赖 JavaScript 退出回调完成回收。

### 9.2 行为观测范围仍不完整

当前覆盖 exit code、signal、stdout、stderr、文件副作用，以及 CTest 套件级结果与期望声明。尚未系统捕获网络请求、数据库变化、系统调用序列、子进程树和完整未定义行为证据。

### 9.3 sanitizer 执行链已移除

`SanitizerResult` 与执行器随 legacy 线删除；保留的 `SanitizerKind` / `SanitizerCapability` 仅用于主机能力探测（探测时会编译并链接小工程），项目构建不再注入 sanitizer flag。当前主机上 ASan/UBSan 均缺少运行库（`-lasan` / `-lubsan`），如需该层证据要重新设计为独立的验证阶段。

### 9.4 模型侧超时不可完全托管

宿主给 `ctx.process.run` 提供默认预算，但模型在 workflow 源码里显式写的 `timeoutMs` 仍然优先。提示词和 skill 示例中仍可能出现常量（如 `120000`），无法从机制上阻止模型写死。

### 9.5 恢复策略仍不完整

Session state 支持 reopen；`ABORTED` 运行可在新会话中复用仍有效的脚本与候选提交检查点，
重新检查环境并执行验证。AI 会话本身、构建缓存与临时目录的恢复尚未完整建模，
不能无损恢复正在执行的模型轮次或构建过程；恢复也不会自动重放上一次命令行参数。

### 9.6 尚未适配任意 C 工程

现有测量与项目适配器主要覆盖 CMake 与显式源文件项目。原适配器缺失已不在 Preflight 直接阻断，
writer 可选择支持的局部编译方案；这不代表 Make / MSVC solution / 自定义工程已获得完整验证。
完整性检查递归保护已初始化子模块；未使用的空 gitlink 可保留。默认 worktree 准备尚不负责初始化所需子模块，
依赖这些源码的方案需要显式准备，否则构建按实际缺失失败。
Windows 完整 libuv 官方套件受网络与文件监听环境影响；离线目标用例的通过不能替代完整官方套件验证。

## 10. 后续路线

按风险与收益排序。

1. **收紧运行边界（优先级最高）**：把 candidate worktree 移出目标仓库，或在 Linux 生产环境接入 SDK sandbox + 只读挂载 + 资源配额。这是当前架构最薄的一环。
2. **扩展项目适配面**：自定义构建脚本的局部方案与所需子模块准备；Make / MSVC 的结构化 Adapter 暂不实现（见“已放弃的方向”）。局部验证的覆盖范围仍需独立评估。
3. **补齐行为捕获**：网络录制/回放、子进程树、syscall 序列；对 C 而言未定义行为应成为显式失败类别。
4. **程序化测试输入生成**：边界整数、空/超长字符串、控制字符、非 UTF-8 字节、缺失文件与环境变量；Agent 负责领域输入，程序负责边界补齐与去重。
5. **恢复与审批**：阶段检查点恢复已实现；仍需模型轮次/构建过程的无损恢复，以及 workflow 危险能力的审批通道（见 [`docs/roadmap-approval-mode.md`](docs/roadmap-approval-mode.md)，已记录未实现）。
6. **再考虑多语言**：需先稳定 `LanguageAdapter` / `BuildAdapter` / `ObservationAdapter` / `Comparator` / `DependencyController` 抽象。第一批可考虑 C++。
7. **持续校准能力评估**：已有固定测试集、按平台探测与筛选、CLI 执行、冻结/重判和裁判接口（见 `docs/testset/`），继续积累模型与配置的可比较证据。`verify` 槽可注入，但注入的运行一律记为**非权威**。

已放弃的方向（不再推进）：

- 自研文件级权限边界（见 §1 的决策说明）；
- 固定 libuv 任务作为主线（保留为回归 fixtures）；
- Make / MSVC 的结构化 Adapter（暂不实现，允许选择可执行的局部方案，视需要再议）。

已决定：独立 Analyze 删除，只保留 Preflight 测量；验证方案交给 test-writer，
skills 指导选择，宿主双侧实际执行与完整性检查承担运行判定。实现与验证结论见 §8。

## 11. 结论

核心闭环已经跑通并产出了真实 `ACCEPTED`：

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
