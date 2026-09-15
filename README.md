# refactorSubagent

行为保持型 C 重构 harness：AI 在一次性 worktree 里改代码，宿主负责建构建/测试 workflow、
在 baseline 与 candidate 两侧执行并逐位置比较声明，只有行为一致才 ACCEPTED。

项目现状、架构与路线见 [`PROJECT_STATUS.md`](PROJECT_STATUS.md)。

## 目录

```text
refactorSubagent/
├─ src/                     harness 本体（状态机、阶段、能力代理、配置）
├─ scripts/cli.ts           命令行入口（run / preflight / workflow / limits / config）
├─ tests/                   harness 单元与离线 e2e 测试（bun test）
├─ docs/                    设计文档（stage-flow、limits、roadmap…）
│  └─ testset/              测试集文档（见下）
├─ testset/                 测试集：套件定义 + 并行执行器（见 testset/README.md）
├─ libuv/                   钉死的 libuv 基线检出（不进版本，见 testset/baseline/README.md）
├─ runs/                    每次运行的证据（不进版本）
└─ half-week-report/        阶段性汇报页面
```

`libuv/`、`runs/`、`testset/.cache/` 都在 `.gitignore` 里：前两者可重建（脚本/命令见测试集文档），
后者是热构建槽位（133MB 级），随时可删。

## 快速开始（harness 本身）

```bash
bun install
bun test                                   # harness 全量测试（离线，含真 gcc/git）
bun run scripts/cli.ts preflight           # 探测主机与项目
bun run scripts/cli.ts run <repo> --task "<重构任务>" --session s1
bun run scripts/cli.ts limits <repo>       # 当前生效的超时/资源阈值及其来源
```

## 测试集（把能力评估跑成分数）

用法、套件设计、校准与实测记录都在 [`docs/testset/`](docs/testset/)：

| 文档 | 内容 |
|---|---|
| [`docs/testset/README.md`](docs/testset/README.md) | 测试集是什么、目录结构、快速开始、维护约定 |
| [`docs/testset/03-suite-and-runner.md`](docs/testset/03-suite-and-runner.md) | 执行器手册：选择/校准/冻结/重判/裁判/缓存并发，§10 为实测结果 |
| [`docs/testset/02-testset-requirements.md`](docs/testset/02-testset-requirements.md) | 构建事实、用例清单、期望声明模型、判定规则、复现命令 |
| [`docs/testset/01-refactor-targets.md`](docs/testset/01-refactor-targets.md) | 可重构点清单与覆盖缺口（T1–T7） |
| [`docs/testset/04-rubric.md`](docs/testset/04-rubric.md) | 裁判（rubric）怎么给分 |

最短路径：

```bash
bun testset/run.ts --list                                  # 25 个用例，按被测对象分组
bun testset/run.ts --subject judgement --tag offline       # 离线判据自测（不调模型）
bun testset/run.ts --subject judgement --tag offline --build-cache   # 复用热构建，单例 2m38s → 46s
bun testset/run.ts --only e2e-t1-full --rubric-cmd "<命令>"          # 端到端 + 裁判
```

测试集只用 CLI 调用 harness（`bun scripts/cli.ts run …`），不 import 应用源码。
