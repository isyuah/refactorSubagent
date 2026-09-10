# Behavior-Preserving Refactoring Agent：项目现状与后续路线

> 文档日期：2026-09-10（§1–§11 为当前状态；§12 起为历史验证记录，见文末附录）
>
> 当前定位：面向 C 代码的行为保持型重构原型。闭环已在 Windows + MinGW + Claude Agent SDK 环境完成真实端到端验证（含首个 `ACCEPTED`），尚未达到可直接适配任意 C 工程的生产级完成度。

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

**关于 Bash（2026-09-10 决定）**：三个会话现在都有 shell。理由是**自验**——
refactor agent 能在一次性 worktree 里编译自己的改动，build-writer 能真跑一遍
configure/build 再据此写 workflow，而不是靠猜（"生成的 workflow 跑不起来"是
这条链历史上最主要的失败模式）。代价是"无 Bash"这层保护消失：会话能触及宿主
用户可达的任何路径。因此宿主不再信任会话留下的状态——它重新测量 diff（见
§5.2）并重跑权威 workflow；真正的隔离仍待平台层（§9.1）。`git push` 通过
deny 规则挡住（实测有效），其余破坏性命令靠"环境可弃 + 结果可重算"兜底。

## 2. 当前技术栈与验证环境

### 2.1 项目运行时

- TypeScript / Bun
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

项目已经处理 Windows 下的几个实际边界：

- native Claude 可执行文件与 `claude.cmd` 的启动入口差异；
- `cc` 不一定存在，实际编译器可能是 `gcc.exe`；
- gcc 输出程序通常带 `.exe`；
- `mkdir -p` 不是 `cmd.exe` 语法；
- Windows 进程 argv 不能包含 NUL 字节；
- `where.exe` 和部分工具版本命令启动缓慢，HostPreflight 不能串行依赖它们；
- 进程树终止使用 `taskkill /T /F`。

## 3. 代码结构

```text
src/
├─ config/
│  └─ limits.ts                  超时/资源阈值：分层配置、合并、CLI 覆盖
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
│  ├─ workflow-agent-pipeline.ts 全流程编排（会话 → 重构 → 验证）
│  ├─ e2e-log.ts                 结构化运行日志（JSONL + state.json）
│  ├─ e2e-dashboard.ts           运行观测 WebUI + SSE
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
│  ├─ expectation-compare.ts     两侧期望按位置比较
│  ├─ registry.ts                BuildWorkflow 注册表（save/load/discover）
│  ├─ curator.ts                 运行期构建入库（run-local → library 提升）
│  └─ resolve-declared.ts        声明集 → workflow resolution 解析
│
├─ agents/
│  ├─ prompts.ts                 各会话系统提示词与任务提示
│  ├─ driver.ts                  Claude Agent SDK 封装（无 hook，白名单边界）
│  ├─ analyze.ts                 宿主侧项目探测报告（无模型调用）
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
├─ demo.ts                       状态机基础演示
├─ demo-libuv.ts                 libuv CMake 基准
├─ e2e-cmake.ts                  CMake 冒烟
├─ e2e-generated-workflow.ts     完整声明制 e2e（默认入口）
├─ resume-verification.ts        从持久化产物续跑验证段
└─ e2e-dashboard.ts              启动观测 WebUI

tests/                           22 个测试文件（详见 §8）
examples/trim-app/               C 基线项目 + safe/broken 变体
```

Workflow 层遵循 core / app 分离：`registry` / `build-workflow` / `test-workflow` / `runner` / `capabilities` 等是无 AI、可独立单测的模块；`workflow-agent-pipeline.ts` 只做编排。

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

三类模型会话，工具集**逐条显式列出**（SDK 中省略列表 = 继承全部内置工具，含
Bash/WebFetch，因此 `DriverOptions.allowedTools` 是必填参数，漏传会编译失败）。
三个会话都有 Bash（见 §1 的决策说明）；`Bash(git push:*)` 对所有会话 deny。

| 会话 | 工具（常量名） | 产物 |
|---|---|---|
| test-writer | `TEST_WRITER_AGENT_TOOLS`：Read / Glob / Grep / Write / Edit / Task / **Bash** | TestWorkflow 源 + `declareDependency` 声明集 |
| build-writer（经 Task 派生的子 agent） | Read / Glob / Grep / **Bash** + MCP `generateBuildWorkflow` / `inspectWorkflow`（无 Write/Edit） | BuildWorkflow 源（经宿主 registry 落盘） |
| refactor | `REFACTOR_AGENT_TOOLS`：Read / Write / Edit / Glob / Grep / **Bash** | candidate worktree 内的改动 |

- **test-writer** 通过 `dep-registry` MCP server 声明构建依赖，生成的 workflow 源必须通过 `workflow-spec` 技能约定的接口。
- **build-writer** 是 test-writer 经 `Task` 派生的子 agent，其 workflow 源码只能经宿主的 `generateBuildWorkflow` 落盘（它没有 `Write`/`Edit`）；Bash 让它能先在 scratch 目录真跑一遍构建，据实测结果而非推断来写 workflow。子 agent 的显式工具列表不继承父会话的 MCP 工具，因此需按名声明。
- **有 shell 后的两条约定**（写进提示词）：探测性构建要放在仓库/worktree 之外，因为留在里面的东西会进入 patch；不要执行 git 变更命令——宿主拥有 staging/commit/branch，agent 自己 commit 虽然被宿主兼容（见 §5.2），但 reset/checkout 只会毁掉自己的工作。
- **refactor** 在候选 worktree 中运行，**重构范围不设限**——由 baseline/candidate 双跑 workflow 的行为门禁兜底；`git add` / `git commit` 由宿主执行。
- **analyze** 现在是宿主侧的纯文本探测（`analyzeRepo`），**不产生模型调用**。其报告只写入运行目录（`analysis-report.txt`），**不注入任何会话**：模型在编写 workflow 时拿不到实测主机事实，只能通过 `inspectWorkflow` 的候选分类间接感知；实测事实在 workflow **执行期**经 `ctx.facts` 提供给生成的代码。该阶段当前存在冗余（报告与已单独保存的 `host-preflight.json` / `project-detection.json` 重复），去留见 §10。

Windows 下 Driver 优先使用 `CLAUDE_CODE_EXECUTABLE`，否则查找 `%APPDATA%\npm\claude.cmd`。

会话预算（deadline / stall / maxTurns）由 §7 的配置系统统一给出。

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

## 8. 已执行验证

本节只记录**当前架构**下的证据；历史架构的验证记录见文末附录。

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

## 9. 已知限制与风险

### 9.1 权限边界依赖宿主目录，不是 OS 沙箱

删除自研 hook 后 `Write` / `Edit` 无路径约束；2026-09-10 起三个会话还都有 Bash，
因此"模型只能在其工作目录里动手"这一假设**不再成立**：test-writer 的 cwd 就是
目标仓库本身，refactor 的 worktree 虽在 session 目录下，也能用相对路径或绝对路径
抵达仓库与会话状态文件。当前靠的是：显式工具白名单、`git push` deny 规则、
一次性环境，以及**宿主不信任会话状态**（重新测量 diff、重跑权威 workflow、
期望差分由程序裁决）。生产环境必须叠加平台级隔离：Linux 上的 SDK sandbox /
容器、只读挂载、网络禁用、资源配额。这一项在本轮改动后从"建议"升级为**前置条件**。

### 9.2 行为观测范围仍不完整

当前覆盖 exit code、signal、stdout、stderr、文件副作用，以及 CTest 套件级结果与期望声明。尚未系统捕获网络请求、数据库变化、系统调用序列、子进程树和完整未定义行为证据。

### 9.3 sanitizer 执行链已移除

`SanitizerResult` 与执行器随 legacy 线删除；保留的 `SanitizerKind` / `SanitizerCapability` 仅用于主机能力探测与编译 flag 注入。当前主机上 ASan/UBSan 均缺少运行库（`-lasan` / `-lubsan`），如需该层证据要重新设计为独立的验证阶段。

### 9.4 模型侧超时不可完全托管

宿主给 `ctx.process.run` 提供默认预算并设上限，但模型在 workflow 源码里显式写的 `timeoutMs` 仍然优先。提示词已不再提供可照抄的数字示例，但无法从机制上阻止模型写死常量。

### 9.5 恢复策略仍不完整

Session state 支持 reopen；AI 会话本身、构建缓存与临时目录的恢复尚未完整建模。中断后可以恢复状态，但未必能无损恢复正在执行的模型轮次或构建过程。

### 9.6 尚未适配任意 C 工程

稳定路径是 CMake 与显式源文件项目；Make / MSVC solution / 自定义构建脚本主要依赖探测结果阻断。完整 libuv 官方套件在当前 Windows 主机上受网络与文件监听环境影响保持非绿色。

## 10. 后续路线

按风险与收益排序。

1. **收紧运行边界（优先级最高）**：把 candidate worktree 移出目标仓库，或在 Linux 生产环境接入 SDK sandbox + 只读挂载 + 资源配额。这是当前架构最薄的一环。
2. **扩展项目适配面**：Make / MSVC / 自定义构建脚本的结构化支持（当前以探测阻断为主）。
3. **补齐行为捕获**：网络录制/回放、子进程树、syscall 序列；对 C 而言未定义行为应成为显式失败类别。
4. **程序化测试输入生成**：边界整数、空/超长字符串、控制字符、非 UTF-8 字节、缺失文件与环境变量；Agent 负责领域输入，程序负责边界补齐与去重。
5. **恢复与审批**：模型轮次/构建过程的无损恢复；workflow 危险能力的审批通道（见 [`docs/roadmap-approval-mode.md`](docs/roadmap-approval-mode.md)，已记录未实现）。
6. **再考虑多语言**：需先稳定 `LanguageAdapter` / `BuildAdapter` / `ObservationAdapter` / `Comparator` / `DependencyController` 抽象。第一批可考虑 C++。

已放弃的方向（不再推进）：

- 自研文件级权限边界（见 §1 的决策说明）；
- 固定 libuv 任务作为主线（保留为回归 fixtures）；
- Make / MSVC 的结构化 Adapter（改为探测阻断，视需要再议）。

待决（尚未定稿）：

- **Analyze 阶段的去留**。当前它是纯装饰：报告只落盘、无任何消费者，且与已单独保存的 `host-preflight.json` / `project-detection.json` 重复，其中 `scanSourceFiles` 兜底分支在管线中不可达（`status === "ready"` 已保证 `source_files` 非空）。三个选项：删除该阶段 / 把实测事实真正注入 test-writer 提示词 / 仅保留为审计产物。见 §6 的说明。

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
