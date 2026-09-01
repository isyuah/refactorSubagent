# Behavior-Preserving Refactoring Agent：项目现状与后续路线

> 文档日期：2026-08-25
>
> 当前定位：面向 C 代码的行为保持型重构原型。项目已经具备“Claude 分析与修改、程序校验与裁决”的闭环，并在 Windows + MinGW + Claude Agent SDK 环境完成真实端到端验证；尚未达到可直接适配任意 C 工程的生产级完成度。

## 1. 项目目标

本项目不是单纯让 Claude 修改代码，而是把职责拆开：

```text
Claude / LLM
  ├─ 理解 C 代码
  ├─ 分析依赖和修改范围
  ├─ 设计行为契约与测试输入
  └─ 执行受限重构

程序 Orchestrator / Runtime
  ├─ 校验 Artifact Schema
  ├─ 管理状态机和持久化
  ├─ 强制文件修改白名单
  ├─ 管理 Git worktree
  ├─ 测量主机环境
  ├─ 编译 baseline / candidate
  ├─ 捕获行为观测
  ├─ 比较新旧行为
  └─ 接受或拒绝 patch
```

核心原则：

> Claude 负责理解、设计和修改；程序负责执行、验证和最终决定。

模型不能自行把“测试失败”解释成无关问题，也不能自行把候选 patch 标记为安全。无法证明安全时，流程进入拒绝或中止状态。

## 2. 当前技术栈与验证环境

### 2.1 项目运行时

- TypeScript
- Bun
- Zod：Artifact 的运行时 Schema 校验
- `@anthropic-ai/claude-agent-sdk`：驱动 Claude Code
- Git：worktree 隔离与候选 patch 管理
- GCC / MinGW：当前 C 构建后端

当前依赖：

```json
{
  "@anthropic-ai/claude-agent-sdk": "^0.3.245",
  "zod": "^3.23.8"
}
```

### 2.2 已验证主机

- Windows 11 x64
- Bun 1.3.x
- GCC 15.2.0 / MinGW
- Git 2.53
- Claude Code CLI
- Claude Agent SDK Windows 启动入口：`claude.cmd`

项目已经处理 Windows 下的几个实际边界：

- native Claude 可执行文件与 `claude.cmd` 的启动入口差异；
- `cc` 不一定存在，实际编译器可能是 `gcc.exe`；
- gcc 输出程序通常带 `.exe`；
- `mkdir -p` 不是 `cmd.exe` 语法；
- Windows 进程 argv 不能包含 NUL 字节；
- `where.exe` 和部分工具版本命令启动缓慢，HostPreflight 不能串行依赖它们。

## 3. 代码结构

```text
src/
├─ artifacts/
│  ├─ behavior-contract.ts       行为契约
│  ├─ scope-manifest.ts          修改范围 / 可读范围
│  ├─ dependency-manifest.ts    依赖与隔离策略
│  ├─ environment-spec.ts       构建环境与结构化 BuildPlan
│  ├─ host-preflight.ts          主机环境事实 Schema
│  ├─ test-spec.ts               回归测试 / 差分输入
│  ├─ observation-trace.ts       行为观测
│  ├─ comparison-result.ts       差分比较结果
│  ├─ patch-record.ts            候选 patch 信息
│  ├─ common.ts                  路径、hash、base64 等公共 Schema
│  └─ index.ts                   Artifact 联合导出
│
├─ orchestrator/
│  ├─ orchestrator.ts            fail-closed 状态机
│  └─ store.ts                   Session / Artifact 持久化
│
├─ runtime/
│  ├─ host-preflight.ts          程序化主机探测
│  ├─ builder.ts                 direct compiler / legacy shell 构建
│  ├─ worktree.ts                baseline / candidate 隔离
│  ├─ runner.ts                  测试执行与行为采集
│  ├─ fs-snapshot.ts             文件系统快照和副作用 diff
│  ├─ comparator.ts              行为通道比较
 │  ├─ pipeline.ts                普通验证流水线
 │  └─ agent-pipeline.ts          Claude 分析、重构与验证串联
 │
 ├─ workflow/
 │  ├─ resolve-workflows.ts        三源决策编排（提供/复用/生成）
 │  ├─ chooser.ts                  WorkflowChooser 决策注入接口
 │  │                             （Claude / Deterministic / AlwaysGenerate）
 │  ├─ generate-strategy.ts        WorkflowGenerationStrategy 生成策略接口
 │  │                             （CMakeFacts 内置策略）
 │  ├─ build-workflow.ts           BuildWorkflow 解析、校验、manifest
 │  ├─ test-workflow.ts            TestWorkflow 解析、校验、manifest
 │  ├─ registry.ts                 BuildWorkflow 注册表（save/load/discover）
 │  ├─ test-registry.ts            TestWorkflow 注册表
 │  ├─ runner.ts                   通用 workflow 运行器（worker spawn）
 │  ├─ capabilities.ts             LocalCapabilityBroker 能力代理
 │  ├─ client.ts                   worker 侧能力代理
 │  ├─ capability-protocol.ts      JSONL 能力协议
 │  ├─ build-executor.ts           CMake/Ninja/direct-compiler 构建执行
 │  ├─ source-policy.ts            workflow 源码沙箱检查
 │  └─ worker.ts                   workflow 子进程入口
 │
 └─ agents/
    ├─ prompts.ts                 分析 / 重构提示词
    ├─ driver.ts                  Claude SDK 封装与 PreToolUse hook
    ├─ analyze.ts                 分析 Agent
    └─ refactor.ts                受限 Refactor Agent

Workflow 层遵循 core/app 分离：

- core：`chooser.ts`（决策接口）、`generate-strategy.ts`（生成策略接口）、
  registry / build-workflow / test-workflow / runner / capabilities 全部是无
  AI、可独立单测的纯函数模块；
- app：`resolve-workflows.ts` 只做编排——收集候选 → 注入 chooser 决策 →
  按决策复用（registry 快速路径）或生成（strategy 模板 + Claude 写源）。

决策可换：`WorkflowChooser` 有 Claude / Deterministic（第一个可用候选）/
AlwaysGenerate 三种实现，CI 或无模型环境用 Deterministic 即可跑通核心链路。
生成策略可换：`WorkflowGenerationStrategy` 抽象了"如何产生 workflow 源"，
内置 CMakeFacts 策略从 CMakeLists.txt 推导，未来可替换为外部生成器。

复用快速路径：selected 分支从注册表读取持久化 output 直接构建 resolution，
不重新 spawn worker（loadBuildWorkflow/loadTestWorkflow 已校验 source hash 与
schema）。生成分支现在会自动 saveBuildWorkflow/saveTestWorkflow 入库，修复了
"AI 生成的 workflow 从不进入注册表、下次无法复用"的缺陷。

tests/
├─ state-machine.test.ts         状态机与 fail-closed 规则
├─ agents.test.ts                Agent 输出解析
├─ environment.test.ts           HostPreflight 与 argv 边界
└─ fixtures.ts                   测试 Artifact 夹具

scripts/
├─ demo.ts                       状态机基础演示
├─ demo-e2e.ts                   不依赖 Claude 的真实 C 差分演示
└─ demo-agents.ts                真实 Claude Agent 端到端演示

examples/trim-app/
├─ base/                         C 基线项目
├─ variants/safe/                行为保持的重构版本
└─ variants/broken/              故意改变行为的版本
```

## 4. Artifact 数据骨架

### 4.1 BehaviorContract

定义哪些行为必须保持，以及比较方式：

- exit code
- signal
- stdout
- stderr
- filesystem effects

比较模式：

- `exact`
- `semantic`
- `normalize`
- `ignore`

当前约束：

- `execution_time` 必须允许变化；执行时间不是行为保持目标；
- `semantic` 必须提供 comparator id；
- 文件系统语义比较使用 `fs-effects-v1`。

### 4.2 ScopeManifest

区分：

```text
Modification Scope   允许修改的文件和符号
Observation Scope    为理解行为可以读取的文件范围
Forbidden Scope      明确禁止读取或修改的范围
```

Orchestrator 会再次检查 patch 的 `changed_files` 是否全部位于 editable files 中。Refactor Agent 的 `Write` / `Edit` / `MultiEdit` / `NotebookEdit` 调用还会经过 SDK 的 `PreToolUse` hook；越界调用会被程序拒绝，而不是依赖 prompt 自律。

### 4.3 DependencyManifest

支持的依赖类别：

- pure
- time
- randomness
- filesystem
- env
- network
- stateful_external
- concurrency

支持的隔离策略：

- real_isolated
- freeze
- seed
- temp_sandbox
- record_replay
- fake
- mock
- reject

### 4.4 EnvironmentSpec 与 HostPreflight

当前推荐的构建 Artifact：

```json
{
  "kind": "environment-spec",
  "version": 1,
  "build": {
    "kind": "direct-compiler",
    "compiler": "gcc",
    "flags": [],
    "defines": {},
    "sources": ["src/main.c", "src/util.c"],
    "output": "build/app"
  },
  "determinism": {
    "frozen_time_epoch_ms": 1700000000000,
    "random_seed": 77,
    "intercept_headers": ["shim/determinism.h"]
  },
  "sandbox": {
    "run_cwd_strategy": "fresh_temp_dir"
  }
}
```

`direct-compiler` 由程序生成真实 compiler path 和 argv，并用 `shell: false` 执行。

旧 session 仍兼容：

- `shell-command`；
- 里程碑 3 之前的 legacy build shape。

旧格式只作为兼容 fallback，不是新流程首选。

`HostPreflight` 不直接作为状态机 Artifact 提交，而是作为 session 审计产物单独保存：

```text
.refactor/sessions/<session-id>/artifacts/host-preflight.json
```

它记录程序实际测量到的主机事实，例如：

- Windows / x64；
- `cmd.exe`；
- `.exe` 后缀；
- `gcc` 可用及其绝对路径；
- `cc` 不可用；
- cmake / ninja / bash / wsl 是否在 PATH 中。

这样可以区分：

```text
模型提出的 EnvironmentSpec
程序测量的 HostPreflight
程序最终执行的 BuildPlan
```

### 4.5 TestSpec

每个 C 测试用例包括：

- id；
- regression / differential；
- argv；
- stdin base64；
- fixture files；
- regression expected exit code。

特别约束：

- argv 中禁止 NUL，因为 Windows `CreateProcess` 和 Node `spawn` 无法传递 NUL；
- stdin 仍允许任意 base64 二进制内容；
- 至少包含一个 differential case；
- regression case 必须提供期望退出码。

### 4.6 ObservationTrace

每个用例采集：

- exit code；
- signal；
- stdout；
- stderr；
- filesystem effects；
- duration；
- observed / fail / error。

文件系统副作用通过运行前后快照计算：

```text
create
modify
delete
```

文件内容使用 SHA-256。

### 4.7 ComparisonResult

比较结果按用例记录：

- case id；
- 总体 match / mismatch；
- 各行为通道 verdict；
- 诊断详情。

最终 `overall` 由 Schema transform 派生：

```text
consistent   → ACCEPTED
inconsistent → REJECTED
```

模型无权直接提交 ACCEPTED。

## 5. 状态机现状

当前状态流：

```text
INIT
  ↓ behavior-contract
CONTRACT_READY
  ↓ scope-manifest
SCOPE_READY
  ↓ dependency-manifest
DEPENDENCY_READY
  ↓ test-spec
TESTS_READY
  ↓ environment-spec
ENV_READY
  ↓ baseline observation
BASELINE_READY
  ↓ patch-record
PATCH_CREATED
  ↓ candidate observation
VERIFICATION_RUNNING
  ↓ comparison-result
ACCEPTED / REJECTED
```

任何非终态都可以转为 `ABORTED`，终态不可变。

### 5.1 Fail-closed 规则

| 规则 | 内容 |
|---|---|
| R1 | 只能提交当前状态期望的 Artifact，禁止跳阶段或乱序 |
| R2 | Artifact 必须通过 Zod Schema |
| R3 | baseline 失败必须有可解释分类；unknown 或 scope-related 失败阻断流程 |
| R4 | patch 只能修改 ScopeManifest 的 editable files |
| R5 | candidate trace 的 case id 集合必须和 baseline 完全一致 |
| R6 | comparison-result 决定 ACCEPTED / REJECTED |
| R7 | 终态不可变 |

### 5.2 Session 持久化

每个 session 保存：

```text
.refactor/sessions/<session-id>/
├─ state.json
└─ artifacts/
   ├─ behavior-contract.json
   ├─ scope-manifest.json
   ├─ dependency-manifest.json
   ├─ test-spec.json
   ├─ environment-spec.json
   ├─ host-preflight.json
   ├─ observation-trace.baseline.json
   ├─ observation-trace.candidate.json
   ├─ patch-record.json
   └─ comparison-result.json
```

状态文件记录当前状态和完整 transition history，支持中断后 reopen。

## 6. Agent 层现状

### 6.1 Analyze Agent

Analyze Agent：

- 只拥有 `Read` / `Glob` / `Grep`；
- 不允许修改项目；
- 接收程序测量的 HostPreflight；
- 使用 SDK 原生 `outputFormat: json_schema`；
- 程序优先读取 `structured_output`；
- 每个提案最终仍经过 Zod Schema；
- Schema 校验失败会带错误重试一次。

它负责提出 BehaviorContract、ScopeManifest、DependencyManifest、TestSpec 和 EnvironmentSpec。

### 6.2 Refactor Agent

Refactor Agent：

- 在 candidate worktree 中运行；
- 不允许执行 git；
- 只开放读取、搜索和编辑工具；
- 编辑路径由 PreToolUse hook 强制检查；
- 程序负责 `git add` / `git commit`；
- 程序负责后续编译、运行和接受/拒绝。

### 6.3 Windows SDK 启动入口

Windows 下 Driver 会优先使用 `CLAUDE_CODE_EXECUTABLE`，若未设置则查找 `%APPDATA%\\npm\\claude.cmd`。这是因为 SDK 默认 native executable 与命令行 `claude.cmd` 在当前环境的行为不同；该差异已通过最小 SDK 请求验证。

## 7. 已执行验证

以下验证已经实际执行过，不是静态推断。

### 7.1 TypeScript 类型检查

命令：

```bash
bunx tsc --noEmit
```

结果：通过。

### 7.2 自动化测试

命令：

```bash
bun test
```

最新结果：

```text
52 pass
0 fail
153 expect() calls
Ran 52 tests across 13 files.
```

覆盖内容包括状态机、Agent、主机环境、C 项目构建/CTest/sanitizer/Ninja、CLI/Workflow Foundation、BuildWorkflow 注册表与 executor、Capability Context 文件/进程/工具能力，以及 E2E 观测 Logger/Dashboard/SSE。
- 状态机合法路径到 ACCEPTED；
- R1 越级/乱序拒绝；
- R2 非法 Artifact 拒绝；
- R3 未分类 baseline failure 阻断；
- preexisting behavior failure 分类后可继续；
- R4 patch 越过 editable scope 拒绝；
- R5 candidate 缺失 baseline case 拒绝；
- R6 不一致比较进入 REJECTED；
- R7 终态不可变；
- session reopen 后从持久化状态继续；
- Agent JSON 解析和失败处理；
- HostPreflight 工具映射、懒加载 sanitizer 探针和 argv NUL 边界；
- DirectCompilerAdapter / CMakeAdapter / NinjaAdapter 构建计划及门禁；
- sanitizer unsupported、诊断分类和 baseline/candidate 结果隔离；
- CTest Not Run、TAP 内层失败及 shared/static target 归属解析；
- CLI 参数、JSON 输入、错误码、Workflow timeout 和源策略拒绝；
- BuildWorkflow identity/path/source-hash 校验、注册表保存/加载和候选 stale 分类；
- Capability Context 的 brokered 文件读写、路径/符号链接边界、工具白名单、无 shell 进程、短命句柄、超时和输出上限；
- 通用 BuildWorkflow executor 的 CMake configure/build、多配置 artifact 查找、Broker 事件和缺失 artifact fail-closed；
- libuv 固定 workflow 声明的 CMake build 计划。

本阶段 libuv 长流程实测另见 12.4；CTest 环境失败不会被普通 TypeScript 测试计数掩盖。

### 7.7 Capability Context

已实现：

- Workflow Worker 与主进程 Broker 之间的 JSONL 双向 capability 协议；
- `context.fs`：受 readable/writable globs 和单文件大小上限控制的读写、目录创建、存在性、snapshot/diff；
- `context.process`：无 shell argv 执行、测量工具解析、工作区 executable、stdin、环境键白名单、进程数/超时/输出上限和进程树清理；
- `context.tools`：只报告 HostPreflight 已测量且策略允许的工具；
- `context.adapters`：CMake、Ninja、CTest、compiler 便捷接口，统一走 process capability；
- capability 调用事件随 Workflow 结果持久化返回，失败事件不会被吞掉。

这仍是主进程 Broker 的策略边界，不宣称是 OS 级沙箱；任意用户项目的完整隔离仍需平台沙箱、网络禁用、磁盘配额和更细的资源控制。

### 7.8 BuildWorkflow Agent Guidance

已实现：

- `BUILD_WORKFLOW_SYSTEM`：限定 Claude 只提出结构化 BuildWorkflow，不执行构建、不写文件、不访问主机 API；
- `buildWorkflowPrompt()`：注入 workflow identity、HostPreflight、ProjectDetection 和任务上下文；
- `proposeBuildWorkflow()`：只读 `Read/Glob/Grep` 工具、结构化 JSON 输出、`BuildWorkflowOutput` 程序校验、最多一次 schema 修正重试；
- guidance 明确禁止 shell command、绝对路径、未测工具、平台后缀和猜测式 fallback；
- Agent Guidance 测试覆盖 fail-closed 规则和事实上下文绑定。

### 7.9 libuv RefactorTestTask

已实现：

- `RefactorTestTask` Artifact：固定项目/版本、BuildWorkflow identity、CTest suite、baseline 摘要、失败分类、候选文件和差分测试计划；
- `createLibuvRefactorTask()`：从真实 checkout 证据生成任务，不扫描不到的测试或猜测覆盖；
- 首批候选：`src/strscpy.c`、`src/strtok.c`、`src/version.c`；
- `strscpy`/`strtok` 由 `test/test-strscpy.c`、`test/test-strtok.c` 官方测试覆盖；
- `version.c` 在 v1.52.1 checkout 中没有专门 `test-version.c`，标记为 `dedicated-harness-required`；
- 6 个首批 case：strscpy 零长度/精确填充/截断，strtok 空分隔符/多分隔符，version 公共值；
- 失败 baseline 必须有显式分类，环境失败仍保留为阻断证据，不会自动忽略。

### 7.10 Real Run：strscpy baseline/candidate

已完成：

- 完整 candidate CTest 通过可观察会话运行 415.38 秒，输出持续显示 477 个内部用例进度，最终 `uv_test` 与 `uv_test_a` 均完成；
- candidate CTest 最终为 `0% tests passed, 2 tests failed out of 2`，失败集中在 `udp_connect6`、`udp_dual_stack`、`udp_multicast_join6`、`udp_options6` 等 Windows IPv6/UDP 环境敏感用例；
- shared/static 两个目标中的 `strscpy`、`strtok` 均为 `ok`，未出现候选修改相关失败；
- CTest parser 现在保留内层失败所属顶层 target、断言输出和 timeout 信息，能够支持后续环境分类；
- 完整 CTest 不是绿色验收证据，但已完成真实执行、可观察进度和 fail-closed 结果记录。

### 7.3 不依赖 Claude 的真实 C 差分验证

命令：

```bash
bun run scripts/demo-e2e.ts
```

脚本会建立临时 Git C 项目、创建 baseline/safe/broken 分支，使用真实 gcc 构建并对 baseline/candidate 执行相同输入，比较 stdout、退出码和文件副作用。

最新结果：

```text
behavior-preserving refactor → ACCEPTED
behavior-changing refactor   → REJECTED
```

验证使用了 `direct-compiler` BuildPlan，而不是旧的自由 shell command。

### 7.4 真实 Claude Agent 端到端验证

命令：

```bash
bun run scripts/demo-agents.ts
```

真实执行链：

```text
probeHost()
  → Claude Analyze Agent
  → Artifact Schema 校验
  → candidate worktree
  → Claude Refactor Agent
  → PreToolUse scope hook
  → 程序 git commit
  → gcc baseline/candidate 构建
  → 差分运行
  → comparison-result
  → ACCEPTED
```

实际最终状态：

```text
INIT → CONTRACT_READY → SCOPE_READY → DEPENDENCY_READY
→ TESTS_READY → ENV_READY → BASELINE_READY → PATCH_CREATED
→ VERIFICATION_RUNNING → ACCEPTED
```

## 8.1 本次构建基础设施增量

已新增：

- `ProjectDetection`：记录 C 源文件、构建标记、主构建系统、Adapter 和状态；
- `detectCProject()`：识别 CMake、Ninja、Make、MSVC solution/project，以及无构建标记的直接 C 源项目；
- `BuildAdapter`：统一 `plan()` 和 `build()` 接口；
- `DirectCompilerAdapter`：基于 HostPreflight 生成无 shell 的程序和 argv；
- `CMakeAdapter`：生成 configure + build 两步无 shell 计划，兼容 Visual Studio 多配置输出；
- `NinjaAdapter`：执行结构化 `ninja -C <build_dir> [target]` 计划，并对无法证明可注入的 sanitizer/determinism flags fail-closed；
- `SessionStore.projectDetection()`：保存项目探测结果供恢复和审计；
- AgentPipeline：在 Analyze Agent 之前完成 HostPreflight + ProjectDetection，并将两者注入上下文；
- `CTestSuiteSpec` / `CTestSuiteResult` 与 CTest Runner：保存套件级输出、超时、Not Run、TAP 内层失败和目标归属；
- `SanitizerResult`：保存 sanitizer 能力、逐用例诊断、unsupported/build/runtime/timeout 分类，以及 baseline/candidate 独立结果。

当前 Adapter 状态：

| 构建系统 | 探测 | 执行 Adapter |
|---|---:|---:|
| direct C sources | 已实现 | DirectCompilerAdapter |
| CMake | 已实现 | CMakeAdapter |
| Ninja | 已实现 | 待实现 |
| Make | 已实现 | 待实现 |
| MSVC `.sln` / `.vcxproj` | 已实现 | 待实现 |

探测到 CMake、Ninja、Make 或 MSVC 时，系统会结合 HostPreflight 判断：工具可用且 Adapter 已实现才返回 `ready`；否则返回 `needs-adapter`，不会静默把项目当作一组 `.c` 文件直接编译。

## 8. 已知限制与风险

### 8.1 C 构建系统覆盖仍然有限

当前稳定路径包括显式源文件 + `direct-compiler` 和 CMake + `CMakeAdapter`。Ninja、Make、MSVC solution 以及自定义构建脚本仍主要依靠探测结果阻断或 legacy fallback，尚未实现对应的结构化执行 Adapter。


### 8.2 HostPreflight 与确定性探针

HostPreflight 默认只直接扫描 PATH，保证普通分析和构建路径低延迟；版本字段可能为 `null`。当 EnvironmentSpec 请求 sanitizer 时，验证阶段显式执行一次编译/链接探针，记录 ASan/UBSan 能力，不能仅凭 flag 名称推断支持。

### 8.3 确定性 shim 仍是显式配置

目前通过 `intercept_headers` 注入 C 预处理 shim，适合示例中的 `time()` / `rand()`。尚未自动识别所有非确定性来源，也未覆盖网络录制/回放、数据库 sandbox、线程调度控制、文件系统时钟和共享状态。

### 8.4 行为观测范围还不完整

当前主要覆盖 exit code、signal、stdout、stderr 和临时工作目录中的文件副作用。尚未系统捕获网络请求、数据库变化、系统调用序列、子进程树、全局共享状态以及完整未定义行为证据。

### 8.5 Comparator 还不是完整语义比较器

`exact`、文本 normalize、文件系统效果比较已经可用，但数据库语义、网络顺序、日志脱敏、时间区间等比较策略仍需独立实现和测试。

### 8.6 Agent Pipeline 的恢复策略仍需加强

Session state 已支持 reopen，但 Claude 会话本身、候选 worktree、构建缓存和临时目录的恢复策略还没有完整建模。中断后可以恢复状态，但未必可以无损恢复正在执行的模型轮次或构建过程。

### 8.7 还没有面向任意用户项目的 CLI

当前主要入口是 demo script 和 TypeScript API。尚未提供项目路径参数、任务参数、session resume、dry-run、人工审批点、JSON/human 输出模式和 CI exit code 约定。

## 9. Git 里程碑

```text
1e3b9fb feat: add measured host preflight and structured C build plans
04a9a9f fix: harden Claude agent pipeline for Windows and structured artifacts
49f3e7e feat: Claude Agent SDK integration — analyze/refactor agents, hook-enforced scope, agent pipeline (milestone 4)
9fcc112 feat: runtime layer — worktrees, gcc builder, differential runner, comparator + C e2e demo (milestone 3)
b5c2c56 feat: artifact schemas + fail-closed orchestrator state machine (milestone 1+2)
```

当前提交代表可回溯的原型里程碑链；没有推送或部署远程状态。

## 10. 接下来建议

建议按风险和收益排序，不要立即扩展多语言。

### 优先级 1：完善 C 项目构建 Adapter

建议新增统一接口：

```ts
interface BuildAdapter {
  detect(repoDir: string, host: HostPreflight): Promise<BuildDetection>;
  plan(input: BuildDetection, host: HostPreflight): Promise<BuildPlan>;
  build(plan: BuildPlan, worktreeDir: string): BuildResult;
}
```

优先实现：
1. `DirectCompilerAdapter`，已完成；
2. `CMakeAdapter`，已完成并覆盖 Visual Studio 多配置输出；
3. `NinjaAdapter`；
4. `MakeAdapter`；
5. MSVC / Visual Studio Adapter。
每个 Adapter 都应输出结构化 argv 或结构化构建步骤，避免把 shell 字符串作为主协议。

### 优先级 2：建立 C 项目探测器

探测 `CMakeLists.txt`、`Makefile`、`build.ninja`、`.sln` / `.vcxproj`、`compile_commands.json`、`configure` 和 `meson.build`。

探测结果要区分：

```text
发现了构建系统
发现了可构建目标
发现了编译器
实际构建命令可执行
```

不要把“发现文件”误当成“构建成功”。

### 优先级 3：补齐 C 行为捕获

建议逐步增加：

1. ASan / UBSan 构建和运行；
2. Windows 下的文件、进程和环境变量观测；
3. POSIX 下的 syscall / `strace` Adapter；
4. 网络录制/回放；
5. 数据库 sandbox；
6. 子进程行为捕获。

对于 C，未定义行为和内存错误应成为显式失败类别，而不是普通 stderr 差异。

### 优先级 4：完善测试输入生成

当前 TestSpec 由 Analyze Agent 提议。下一步应增加程序化输入生成：

- 边界整数；
- 空字符串和超长字符串；
- 控制字符；
- UTF-8 / 非 UTF-8 字节；
- 文件权限和缺失文件；
- 环境变量缺失；
- 随机种子变体；
- fuzz seed corpus。

Agent 负责提出领域相关输入，程序负责补齐边界输入、去重和资源限制。

### 优先级 5：把安全边界从文件扩展到工具和资源

当前最强约束是编辑路径 hook。还应增加：

- 禁止 git push / remote 修改；
- 禁止访问 scope 外路径；
- 禁止访问 secrets；
- 禁止任意网络访问；
- Bash / PowerShell 命令白名单；
- 编译和运行资源上限；
- 子进程、文件数量、磁盘空间上限。

程序化拒绝优先，prompt 说明只作为辅助。

### 优先级 6：提供真正的 CLI 和恢复能力

建议入口：

```text
refactor-subagent analyze <repo> --task "..."
refactor-subagent run <repo> --task "..."
refactor-subagent resume <session-id>
refactor-subagent inspect <session-id>
refactor-subagent approve <session-id>
refactor-subagent reject <session-id>
```

CLI 应输出当前状态、阻断原因、Artifact 路径、baseline/candidate 构建日志、差异通道和最终裁决。

### 优先级 7：再考虑多语言

多语言扩展应建立在 Runtime / Artifact 协议稳定之后。建议先抽象：

```text
LanguageAdapter
BuildAdapter
ObservationAdapter
Comparator
DependencyController
```

第一批可考虑 C++，因为它可以复用大量 C 构建和进程观测能力；随后再评估 Rust、Go、Python。不要在 C 的构建、环境、未定义行为和副作用捕获尚未稳定前扩展语言数量。

## 11. 当前结论

项目已经证明了核心闭环可行：

```text
真实 Claude
  → 结构化 Artifact
  → 程序化权限限制
  → Git worktree 隔离
  → HostPreflight
  → 结构化 C BuildPlan
  → baseline/candidate 差分运行
  → 程序裁决 ACCEPTED / REJECTED
```

下一步按以下顺序推进：

1. **已完成：** CLI、Workflow Host、BuildWorkflow 规划、manifest、BuildArtifact 和注册表；
2. **已完成：** Capability Context、Broker 权限策略、受控文件/进程能力和 C 构建便捷 Adapter；
3. **已完成：** 通用 BuildWorkflow executor，以及固定 libuv v1.52.1 CMake Debug workflow；
4. **已完成：** BuildWorkflow Agent 指导、只读提案入口和结构化输出校验；
5. **已完成：** libuv CTest 基线分析、失败分类、RefactorTestTask 和首批差分测试计划；
6. **已完成：** `strscpy.c` baseline/candidate 真实运行、目标用例对比、完整 candidate CTest 可观察执行和 parser 证据增强；完整套件保持 fail-closed；
7. 暂不继续增加 Make/MSVC 等 Adapter，Adapter 只作为 Capability 层便捷方式。

## 12. 当前临时目标：libuv 大型 CMake 基准

### 12.1 固定测试对象

- 项目：libuv；
- 固定版本：`v1.52.1`；
- 来源：官方 GitHub 仓库 `https://github.com/libuv/libuv.git`；
- Windows 构建方式：CMake；
- 测试构建开关：`BUILD_TESTING=ON`、`LIBUV_BUILD_TESTS=ON`，关闭 benchmark 以缩短第一阶段构建。

### 12.2 分阶段目标

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

### 12.3 阶段一验收标准

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

### 12.4 阶段一至三实测结果

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
### 12.5 Ninja Adapter 实测结果

- `build.ninja` 位于常见 `build/` 目录时，项目探测仍能识别 Ninja，不会因跳过生成目录而错误回退到 direct C；
- `ProjectDetection.primary_build_system = ninja`；
- `ProjectDetection.status = ready`（当前主机 Ninja 可用）；
- 真实 Ninja C 项目构建成功，`build/app.exe` 存在；
- 验证命令：`bunx tsc --noEmit`、`bun test tests/build-infrastructure.test.ts`（5 pass）、`bun test tests/environment.test.ts`（3 pass）、`git diff --check`；
- Ninja 适配器尚未支持对已有 Ninja graph 自动注入 sanitizer 或 determinism shim，相关请求会明确失败，不会静默忽略。
## 12.6 真实 Claude 全流程验收记录（2026-08-26）

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
## 13. 本次收尾验证（2026-08-27）

### 13.1 实时观测与 WebUI

- `bun test tests/e2e-observability.test.ts`：3 pass、0 fail、26 个断言；覆盖 `E2ELogger` 的 `state.json` / `run.jsonl` / Artifact / 日志持久化、Dashboard HTTP 资源接口、root containment / 非法路径拒绝，以及 SSE 首帧和 `after` 游标增量事件。
- 真实启动 `scripts/e2e-dashboard.ts` 后用浏览器检查桌面和 390px 窄屏页面：运行列表、拒绝状态和失败原因、Artifact 预览、日志预览均可用；追加事件后页面事件数由 4 增至 5，最后事件同步更新，连接状态为 `SSE 已连接`。
- 窄屏实测：`body.scrollWidth = 390`，详情栏由 sticky 变为 static，运行队列切换为 block 布局，无横向溢出。

### 13.2 四项 targeted E2E

| 命令 | 实测结果 |
|---|---|
| `bun run e2e:cmake` | `e2e-cmake-smoke@1`；CMake configure/build 均退出码 `0`，产物存在，`status=pass` |
| `bun run e2e:differential:safe` | `expected=ACCEPTED`、`actual=ACCEPTED`；状态机走到 `VERIFICATION_RUNNING -> ACCEPTED` |
| `bun run e2e:differential:broken` | `expected=REJECTED`、`actual=REJECTED`；状态机走到 `VERIFICATION_RUNNING -> REJECTED` |
| `bun run e2e:agent` | 真实 Claude Analyze → Refactor → 程序验证完成，`state=ACCEPTED`；Hook 记录多次越界 Read/Glob/Grep 拒绝，`scope_denials` 非空，说明拒绝边界实际生效 |

四项 targeted 命令均以退出码 `0` 结束，且接受/拒绝结果与场景预期一致。

### 13.3 完整 libuv CTest

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

### 13.4 最终工程检查

```text
bunx tsc --noEmit       → pass
bun test                → 52 pass / 0 fail（13 files，153 expect()）
git diff --check         → pass
```

当前结论：实时观测闭环、四项 targeted E2E 和完整 libuv CTest 均已获得真实运行证据；小型 CMake/差分/Claude 场景符合预期，完整 libuv 官方套件受当前 Windows 网络/文件监听环境影响保持非绿色，系统继续按 fail-closed 规则拒绝将其视为安全接受。

### 13.5 生成 TypeScript Workflow 最终闭环（r11）

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

## 14. Plan 声明与 workflow-driven 构建（2026-09-01）

### 14.1 Workflow Plan 声明（树状步骤可视化）

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

### 14.2 workflow-driven 构建（L1 落地）

新增 `environment.build.kind: "workflow-driven"`：

- workflow 函数**在 execute 阶段重跑**，用注入 capabilities 自主驱动构建（任意次 process.run、fs 操作），返回 `{ artifacts: {逻辑名: 路径} }` 作为执行产物；
- execute 校验声明的 artifacts 存在，缺失 → fail-closed；
- 生成策略降级：`CMakeFactsGenerationStrategy.template()` 推导不出（复杂 CMake / 非 CMake）时返回 `null`，`resolve-workflows` 生成分支转 AI 自主（无模板）——**消灭了"模板 + AI 誊写"的冗余模型调用**；
- 策略能推导时，程序直接 `writeFileSync` 写模板（零模型调用）；
- 测试：`tests/workflow-driven.test.ts` 3 项（schema 解析、execute 真构建 + 产物校验、缺失产物拒绝）。

### 14.3 单次执行与 policy（2026-09-01 完善）

- **resolve 零副作用**：`BuildWorkflowResolution.output` 对 workflow-driven 为 **null**（可空类型）。resolve 阶段**既不执行也不提取**——删除了静态提取正则（`extractLiteralOutput` 等），workflow 函数完全自由（可动态算产物、读文件决定 output）；已用测试证明 resolve 后 `build/` 与源文件均未创建；
- **execute 单次执行**：函数只在 execute 阶段跑一次（真实构建），返回完整 BuildWorkflowOutput → 校验 identity + 产物存在；
- **TestWorkflow 绑定轻量化**：`resolveTestWorkflow`/`testCandidates` 等只消费 `{workflow_id, workflow_revision}`（`BuildWorkflowIdentity`），不再依赖完整 output；workflow-driven 时用 manifest id 兜底；
- **状态机 ENV_READY**：workflow-driven 时 environment 由程序构造固定形状（`{kind:"workflow-driven"}`），不依赖 output 提取；
- **复用漏洞修复**：`resolveStoredBuild` 对 output=null（workflow-driven）的候选**重新 resolve**（重新验证来源），不再信任持久化；声明式仍走 hash 验证的快速路径；
- **policy 修复**：`workflow-pipeline.ts` 的 `executeBuild` 现在传 `entry`，且 workflow-driven 模式 `writableGlobs` 放宽到 `["**"]`（函数是可信构建逻辑），声明式模式仍为 `["build/**"]`；
- **入库**：workflow-driven 的 output 存 null（`registry.saveBuildWorkflow` 已支持），`cli.ts`/`demo-libuv.ts` 输出适配。

### 14.4 审批模式（roadmap）

`docs/roadmap-approval-mode.md` 已记录：workflow 声明需审批的能力 → 无审批通道 fail-closed / 有通道挂起等用户批准。本次未实现，按用户要求仅记录。

### 14.5 工程检查

```text
bunx tsc --noEmit   → pass
bun test            → 73 pass / 0 fail（16 files，230 expect()）
```
