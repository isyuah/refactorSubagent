# testset — libuv 能力评估测试集

一个用例 = 一个目录（`cases/<id>/case.json` + `prepare.ts`），共享内容（workflow 源、补丁、判据材料、
源 pin、任务简报、语料）放在 `resources/` 里按名字引用。执行器（`run.ts` + `runner/`）负责：
探测主机 → 比对用例声明的依赖（不满足就跳过）→ 给每个用例分配环境目录并执行它自己的 prepare 脚本 →
按配置里的阶段跑 harness → 评测 → 汇总。

产物与判据材料分离：**候选 agent 看不到判据**。环境是从上游 tag 浅克隆出来的干净树，oracle 一类材料
只存在 `resources/judge/`，在候选提交之后、验证之前才由 harness 注入到两侧 worktree。

用法文档在 [`../docs/testset/`](../docs/testset/)：

- [`README.md`](../docs/testset/README.md) — 总览与维护约定
- [`03-suite-and-runner.md`](../docs/testset/03-suite-and-runner.md) — 执行器手册（选择/校准/冻结/重判/裁判）
- [`02-testset-requirements.md`](../docs/testset/02-testset-requirements.md) — 判据需求与判定规则
- [`01-refactor-targets.md`](../docs/testset/01-refactor-targets.md) — 可重构点与覆盖缺口
- [`04-rubric.md`](../docs/testset/04-rubric.md) — 裁判给分标准

```bash
cd <repo-root>

bun testset/run.ts --list                                   # 26 个用例（扫描 cases/*/case.json）
bun testset/run.ts --self-test                              # 执行器自检（合成用例，不碰项目）
bun testset/run.ts --subject judgement --concurrency 2      # 判据本体：离线、不调模型
bun testset/run.ts --only judgement-accept-comment          # 单个用例
bun testset/run.ts --dry-run --subject writer               # 只看会做什么
bun testset/run.ts --reevaluate runs/<批>                   # 用已存结果重判（零模型成本）
bun testset/run.ts --freeze runs/<批>                       # 用实测失配集冻结 case.json 的期望
```

## 目录

```text
testset/
├─ run.ts                执行器入口（discovery → probe → gate → prepare → harness → evaluate）
├─ runner/               执行器实现（bun，无框架依赖）
│  ├─ suite.ts           case.json 的解析与发现（zod schema）+ 选择器
│  ├─ probe.ts           主机探测与 recipe 校验（工具/版本/编译探针）
│  ├─ env.ts             环境目录分配 + 执行 prepare 脚本（含 blocked 约定）
│  ├─ drivers.ts         pipeline / upstream-part 两种驱动
│  ├─ evaluate.ts        评价方法（verdict / attribution / rubric / part）
│  ├─ rubric.ts          裁判：生成 prompt、调用外部命令、解析打分
│  ├─ display.ts         实时表格与结束汇总
│  └─ exec.ts / util.ts  进程执行（超时+树终止）/ 小工具
├─ cases/<id>/           用例：case.json（行为）+ prepare.ts（环境）+ 可选本地材料
├─ resources/
│  ├─ sources/           源与 pin（libuv.json：上游 tag + commit + remote 兜底）
│  ├─ workflows/         预置 workflow 资源（judgement/manifest.json + build/test 源）
│  ├─ patches/           候选补丁（行为保持 / 变异 / 篡改）
│  ├─ judge/             判据材料（oracle 源），验证前注入 worktree
│  ├─ tasks/             任务简报
│  └─ parts/             语料部分定义（pure/loop/thread/util）
└─ baseline/             基线重建材料（overlay；见 baseline/README.md）
```

`../libuv/`（源检出，浅克隆）、`../runs/`（每次运行的证据，含每例的 `env/`）都不进版本。

## 用例模型

```jsonc
// cases/refactor-t1-strtok/case.json
{
  "id": "refactor-t1-strtok",
  "title": "AI 重构 strtok（判据冻结，只换 refactor 槽）",
  "subject": "refactor",
  "tags": ["ai", "refactor", "t1", "measured"],
  "kind": "pipeline",
  "requires": { "tools": ["git", "cmake", "ninja", "gcc"], "recipe": "win-mingw-ninja-debug" },
  "prepare": "prepare.ts",                       // 相对用例目录；null = 不需要环境
  "repo": ".",                                   // 环境目录里 harness 该在哪儿跑
  "task": "resources/tasks/t1-strtok.task.txt",  // 相对 testset 根，"./x" 表示用例目录内
  "stages": {
    "workflows": { "mode": "preset", "resource": "workflows/judgement" },
    "refactor": { "mode": "ai" }
  },
  "inject": [                                    // 验证前才进 worktree 的判据材料
    { "source": "resources/judge/libuv-1.52.1/oracle", "dest": "refactor-task/oracle" }
  ],
  "limits": { "sessions.refactor.deadlineMs": 2400000 },
  "timeoutMs": 3600000,
  "expect": { "method": "verdict", "state": "ACCEPTED", "injectedStages": ["workflows"], "authoritative": true },
  "evaluate": { "command": "claude -p" }         // 可选；--rubric-cmd 覆盖它
}
```

- **`prepare.ts` 只做一件事**：拿到一个目录（argv[2]，也是 cwd），在里面把环境准备好，不返回值。
  常用助手在 `runner/case-api.ts`（`cloneSource`、`git`、`blocked`）。
- **依赖不满足 = blocked**：`requires.tools` 缺失或 `recipe` 探针不过 → 该用例跳过（不算失败，
  汇总里单列；`--strict-env` 时按失败计）。prepare 自己也可以二次判定：写 `env/blocked.json` 或退出码 78。
- **prepare 失败 = error**：现场保留（`prepare.json` / `prepare.stdout.txt` / `prepare.stderr.txt`），
  整批退出码 1。
- **blind 是默认**：环境里只有源码与任务；`inject` 列出的材料在候选提交之后、验证之前才注入两侧
  worktree，注入清单与 sha256 落在 `session/.refactor/e2e/<session>/artifacts/injections.json`。
- **环境目录**：`runs/<批>/<用例>/env/`，每次运行前清空重建；默认保留作证据（`--drop-env` 跑完删）。
- **输出目录不复用**：用例目录里跑完会留下裁判材料（`rubric-prompt.md`），所以 runner 拒绝在已有
  旧结果的目录上重跑——提示 `--force` 才覆盖；目录里有非 runner 文件时连 `--force` 也拒绝。

## 资源模型

`stages.workflows.mode = "preset"` 时，`resource` 指向 `resources/<name>/`，其 `manifest.json`
声明 build/test workflow 的文件名与 id/revision；runner 把它们解析成绝对路径写进 `pipeline.json`，
harness 用 `entryRoot`（= testset 根）判断入口没有逃出允许的目录。`mode = "ai"` 时不引用任何资源。

## 在另一台机器上跑

前置（缺了不会崩，用例会判定 **blocked** 并跳过）：

| 需要 | 用途 | 缺了会怎样 |
|---|---|---|
| `bun` ≥ 1.3 | 跑 `run.ts` 与 harness | 跑不起来 |
| `git` | 浅克隆源（本地无检出时从 `sources/*.json` 的 `remote` 拉） | 全部 libuv 用例 error |
| `cmake` + `ninja` + `gcc`（Windows 上是 MinGW-w64） | recipe `win-mingw-ninja-debug` 探针 + 两侧构建 | 判据/重构类用例 blocked |
| 网络 | 首次克隆 libuv（≈7 MB）+ 模型网关 | 环境准备失败 / 会话失败 |
| Claude Code CLI（`claude` 在 PATH，或 `CLAUDE_CODE_EXECUTABLE` 指向兼容 CLI）+ 你的网关配置 | AI 档会话与裁判 | 只有离线用例能跑 |

```bash
bun install
bun testset/run.ts --self-test                             # 执行器自检，不碰项目
bun testset/run.ts --list                                  # 26 个用例
bun testset/run.ts --subject judgement --concurrency 2     # 离线 10 例，零模型成本（约 15 min）
bun testset/run.ts --only e2e-t1-blind --rubric-cmd "claude -p" --out runs/blind-1   # 盲测 e2e（要额度）
```

- 其它平台（Linux/macOS）现在会被判 **blocked**（`requires.recipe` 只有 Windows/MinGW 版）；
  要支持得先加一条 recipe（`runner/probe.ts`）。
- 想换某阶段用的模型/程序：`--limit sessions.<stage>.model=<名字>`；整程序则设
  `CLAUDE_CODE_EXECUTABLE=<兼容 CLI 的路径>`（见 `docs/limits.md`）。
- 结果永远落在 `--out`（默认 `runs/suite-<时间戳>/`）；已有旧结果的目录要 `--force` 才会覆盖。

## 维护约定

- **判据材料只改 `resources/`**（`judge/**`、`workflows/**`、`patches/**`）。oracle 的 sha256 被
  `resources/workflows/judgement/test-workflow.ts` 里的 `ORACLE_PINS` 钉住：改了 oracle 必须同步
  那一份 pin，否则所有判据档用例都会以"判据被改动"失败（这是设计如此，fail-closed）。
- **冻结期望**：`--freeze runs/<批>` 把实测失配集写回 `cases/*/case.json` 的 `expect.failuresExact`
  并清掉 `provisional`；状态与期望不符的用例会被拒改并单列出来。
- **裁判是外部命令**：`--rubric-cmd "<cmd>"`（用例里的 `evaluate.command` 为默认值），prompt 由
  runner 组装后通过 `RUBRIC_PROMPT_FILE` 传入；默认只记录分数，`--rubric-min` 才当门槛。
- **不要改 `libuv/`**：它只是源材料（浅克隆 + overlay）；环境由用例的 prepare 脚本从
  `resources/sources/libuv.json` 的 pin 浅克隆而来，overlay 不会进入环境。**新机器上不需要 `libuv/`**：
  本地没有检出时 `cloneSource` 用 pin 里的 `remote`（上游 GitHub tag）兜底。
