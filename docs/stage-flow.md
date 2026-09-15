# 管线阶段化：阶段契约与来源配置（stage-flow）

> 状态：**已实现**（分支 `feat/stage-flow`）。
> core：`src/runtime/stage-flow.ts`（契约 + 组合器 + 默认实现）、`src/runtime/stage-presets.ts`（无 AI 的预置实现）。
> application：`src/config/pipeline.ts`（把配置翻译成阶段函数）、`src/config/layers.ts`（多源配置引擎）。
> 入口：`bun run scripts/cli.ts run <repo> --task <text> [--pipeline-file <path>] [--stage k=v]`。

## 0. 一句话

**阶段顺序和状态机是固定的；每个阶段的"输入从哪来"是可配的。**
没配就是全 AI（会话），配了就用文件（预置 workflow / 补丁 / 已有分支）。
于是可以用**真实管线**测某一段能力，而不是用单元测试复刻管线逻辑。

## 1. 阶段与契约

六个阶段按固定顺序执行，每个阶段是一个可替换的函数：

| 阶段 | 输入 | 输出 | 默认实现（AI/宿主） | 可替换 |
|---|---|---|---|---|
| `preflight` | `ctx` | `{ host, project }` | `probeHost` + `detectCProject` | ✅ |
| `analyze` | `preflight` | `{ analysis }` | `analyzeRepo`（宿主侧探测，无模型调用） | ✅ |
| `workflows` | `preflight`, `analysis` | `{ declared }`（DeclaredBuildSet + 测试 workflow 解析） | test-writer 会话 | ✅ |
| `prepare` | `preflight`, `workflows` | `{ branch, baseSha, worktrees }` | 建候选分支 + baseline/candidate 双 worktree | ✅ |
| `refactor` | `…`, `candidate` | `{ summary }` | refactor 会话 | ✅ |
| `verify` | `…`, `patch` | `WorkflowVerificationOutcome` | `runWorkflowVerification`（差分构建 + 跑测试 + 判定） | ⚠️ 允许，但会被标记**非权威** |

`ctx`（`StageContext`）是只读运行配置：仓库、任务、会话目录、`SessionStore`、logger、limits、已知环境差异模式。

## 2. core 用法（程序化）

```ts
import { runStageFlow } from "./src/runtime/stage-flow.js";
import { patchRefactorStage, presetWorkflowsStage } from "./src/runtime/stage-presets.js";

const result = await runStageFlow({
  repoPath: "/path/to/repo",
  task: "行为保持型重构",
  sessionRoot: "/path/to/repo",
  sessionId: "run-1",
  flow: {
    // 谁声明构建/测试 workflow：不跑会话，用仓库里的现成 workflow
    workflows: presetWorkflowsStage({
      builds: [{ id: "cmake-debug", entry: "tools/build-workflow.ts" }],
      testEntry: "tools/test-workflow.ts",
    }),
    // 谁改代码：不跑会话，打一个补丁
    refactor: patchRefactorStage("tools/fix.patch"),
  },
});
result.state;       // ACCEPTED / REJECTED / ABORTED
result.provenance;  // { injected: ["workflows","refactor"], verification_authoritative: true }
```

省略的槽位保持默认（AI）。可用的无 AI 预置实现：

| 构造器 | 作用 |
|---|---|
| `presetWorkflowsStage(spec)` | 用给定的 build/test workflow 源代替 test-writer 会话（走同一套宿主解析与产物形状） |
| `patchRefactorStage(file)` | 用补丁代替 refactor 会话（宿主仍自己提交并测量改动集） |
| `fixedRefactorStage(summary)` | 不改代码（配合 `prepare` 复用已有候选分支） |
| `existingBranchPrepareStage({ branch, baseSha })` | 复用已有候选分支，不新建 |

## 3. application 用法（配置）

配置项只在**应用层**：core 不认识配置文件，它只接受函数。
`<repo>/.refactor/pipeline.json`（或 `~/.refactor/pipeline.json`）：

```json
{
  "stages": {
    "workflows": {
      "mode": "preset",
      "builds": [{ "id": "cmake-debug", "entry": "tools/build-workflow.ts" }],
      "testEntry": "tools/test-workflow.ts"
    },
    "refactor": { "mode": "patch", "patchFile": "tools/fix.patch" }
  }
}
```

没写的阶段保持 AI 默认。合并顺序（`layers.ts`，与 limits 同一套引擎）：

```text
内置默认 < ~/.refactor/pipeline.json < <repo>/.refactor/pipeline.json
        < --pipeline-file <path> ... < --stage <key.path>=<value> ...
```

```bash
# 全 AI（无配置文件时）
bun run scripts/cli.ts run ./repo --task "保守重构 src/strtok.c"

# 只把 refactor 换成补丁，其余仍全 AI
bun run scripts/cli.ts run ./repo --task "..." --stage stages.refactor.mode=patch \
  --stage stages.refactor.patchFile=tools/fix.patch

# 复盘：复用已有候选分支 + 不改代码
bun run scripts/cli.ts run ./repo --task "..." \
  --stage stages.prepare.mode=reuse --stage stages.prepare.branch=refactor/task-1 \
  --stage stages.prepare.baseSha=<sha> --stage stages.refactor.mode=none
```

文件里的键写错会被**点名拒绝**（`invalid pipeline file <path>: stages.refactor: ...`）；只写一半的 `mode`（例如 `patch` 却没有 `patchFile`）同样拒绝。
`refactor.mode=none` 配 `prepare.mode=create` 会在组装阶段就报错（新建候选区保证"没有改动"⇒ 必然 abort）。

## 4. 宿主不变量（不可替换）

阶段只能产出"流程的下一个输入"，以下事情永远由宿主做：

1. **状态转移**：所有 artifact 都经 `Orchestrator` 提交，fail-closed 判定归它；
2. **候选改动测量**：阶段只返回 `summary`，改动集由宿主 `git add/commit/diff` 量出来，阶段无法伪造；
3. **门禁顺序**：项目探测是否 ready、改动集是否非空、声明集是否非空；
4. **worktree 清理**与 run-local build 提升；
5. **判定出处可追溯**：见下。

### 判定被替换 ⇒ 标记非权威

`verify` 槽允许替换（用于测判定器本身、或构造对照），但一次运行**哪些阶段是注入的**会被记录：

- artifact：`<runDir>/artifacts/stage-provenance.json`
- 返回值：`result.provenance = { injected: [...], verification_authoritative: boolean }`
- 日志：`stage flow overrides active`

这样一次 ACCEPT 的记录永远能回答"这是真判的还是演的"。注入不是安全边界（调用方本来就能直接操作状态机），它是**可读性边界**。

## 5. 阶段可以叫停，但不能自己 abort

槽位返回 `halt(reason)`（`{ halt: true, reason }`），由组合器统一调用 `Orchestrator.abort(reason)`。
阶段拿不到 `Orchestrator`，无法自行推进或篡改状态。

**abort 的原因一定会落盘。** 原因写在会话历史的 `ABORTED` 迁移上（`Orchestrator.abort` 的唯一写入点），
组合器在 `finally` 里把它读回来写进 `run.jsonl`（`event: "abort"`）与运行快照 `state.json.abort_reason`。
这样连不经日志的 `Orchestrator.abort` 直调路径也有原因可查——以前只留一句"workflow verification aborted"，
排查得靠复现。

**源码违反策略 ⇒ 打回重写，而不是直接 abort。** 模型产出的 workflow 源码在会话结束后才被宿主校验，
一旦违反源策略（宿主 import、宿主全局），宿主会带着违规位置（文件、行、列、片段）开一个**修复会话**让写作方改，
改完重新校验；次数由 `stages.policyRepairs` 限制（默认 1，0 = 不重写）。
只有"重写能解决"的失败才走这条路（哈希不匹配、文件缺失、构建 id 解析不到仍然直接失败），
每次尝试都写日志并落 `workflow-source-repairs.json`。

**源策略只看代码。** 校验前会先把注释、字符串/模板正文、正则字面量遮成空白（长度与行号不变），
因此注释里写 `... per process.` 不再被误判；而模板插值 `${...}` 仍按代码检查。
两条判定规则（宿主 import、宿主全局）与旧版一致，但位置准确、且两条路径（`checkWorkflowSource` 与
dep-registry 的源码字符串校验）现在共用同一份实现。

## 6. 测试模式 → 配置映射

| 想测什么 | `workflows` | `prepare` | `refactor` | `verify` |
|---|---|---|---|---|
| 判据自测（完全离线，验证测试集会不会判卷） | preset | 默认 | patch | 默认（真门禁） |
| 只测重构能力 | preset | 默认 | **AI** | 默认 |
| 只测 workflow 编写 | **AI** | 默认 | patch（固定补丁） | 默认 |
| 复盘某次候选 | preset | reuse | none | 默认 |
| 端到端 | AI | 默认 | AI | 默认 |

## 7. 验证

- `tests/stage-flow.test.ts`：离线跑完整管线（真 gcc、真 git、无模型调用）
  - 行为保持补丁 → `ACCEPTED`，`comparison.overall === "consistent"`
  - 改变行为补丁 → `REJECTED`
  - 预置源缺失 → 阶段 `halt` → `ABORTED`（日志含原因，且 `state.json.abort_reason` 含同一原因）
  - 注入 `verify` → `provenance.injected` 含 `verify`、`verification_authoritative === false`，artifact 落盘
- `tests/source-policy.test.ts`：策略的边界——代码里的宿主访问被拒（含 `node:` import、裸模块、`fs/promises`、
  `require`、模板插值、`globalThis["process"]`），注释/字符串/正则里的同样文字被接受
- `tests/resolve-with-repairs.test.ts`：报出违规 → 写作方修好 → 解析通过；改不好则在预算用尽后抛错；
  预算为 0 不重写；重写解决不了的失败（文件缺失）不重写
- `tests/pipeline-config.test.ts`：默认全 AI / 单阶段替换 / 键写错被点名 / 覆盖优先级 / `none` 与 `create` 冲突 / 空 `builds` 被拒

## 8. 设计边界（刻意不做）

- **不做通用阶段注册表**：阶段集合固定（六段），只有"输入从哪来"可换。加一段流程 = 改 core，不靠配置扩展。
- **配置文件不定义函数**：配置文件只描述来源（路径、补丁、分支），函数留在 core 的 `stage-presets.ts`；想自由组合就写 TS 调 `runStageFlow`。
- **`verify` 不禁止替换**：禁不掉（调用方本就能直接操作状态机），所以改为如实记录。
- **不做阶段并行/重排**：顺序即依赖，`buildStageFlow` 只做槽位装配。
