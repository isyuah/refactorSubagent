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
└─ agents/
   ├─ prompts.ts                 分析 / 重构提示词
   ├─ driver.ts                  Claude SDK 封装与 PreToolUse hook
   ├─ analyze.ts                 分析 Agent
   └─ refactor.ts                受限 Refactor Agent

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
42 pass
0 fail
93 expect() calls
Ran 42 tests across 9 files.
```

覆盖内容包括状态机、Agent、主机环境、C 项目构建/CTest/sanitizer/Ninja、CLI/Workflow Foundation、BuildWorkflow 注册表与 executor，以及 Capability Context 文件/进程/工具能力。
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
4. 为 Workflow Agent 编写指导 skill；
5. 分析 libuv 并生成测试任务；
6. 选择一个任务运行完整真实流程，根据证据优化系统；
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
