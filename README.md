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
├─ testset/                 测试集：用例目录 + 共享资源 + 执行器（见 testset/README.md）
├─ libuv/                   源材料检出（不进版本，由用例的 prepare 脚本浅克隆使用）
├─ runs/                    每次运行的证据（不进版本，含每例的环境目录）
└─ half-week-report/        阶段性汇报页面
```

`libuv/`、`runs/` 都在 `.gitignore` 里：前者可由用例的 prepare 脚本从上游 tag 重建，
后者是当次运行的证据（含每例约 100MB 级的环境目录），随时可删。

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
| [`docs/testset/03-suite-and-runner.md`](docs/testset/03-suite-and-runner.md) | 执行器手册：用例模型、探测/跳过、blind 注入、选择/校准/冻结/重判/裁判，§10 起为历史实测 |
| [`docs/testset/02-testset-requirements.md`](docs/testset/02-testset-requirements.md) | 构建事实、用例清单、期望声明模型、判定规则、复现命令 |
| [`docs/testset/01-refactor-targets.md`](docs/testset/01-refactor-targets.md) | 可重构点清单与覆盖缺口（T1–T7） |
| [`docs/testset/04-rubric.md`](docs/testset/04-rubric.md) | 裁判（rubric）怎么给分 |

最短路径：

```bash
bun testset/run.ts --list                                  # 26 个用例，按 subject 分组
bun testset/run.ts --self-test                             # 执行器自检（合成用例，不碰项目）
bun testset/run.ts --subject judgement --tag offline       # 离线判据自测（不调模型）
bun testset/run.ts --only e2e-t1-full --rubric-cmd "<命令>" # 端到端 + 裁判
```

每个用例一个目录（`cases/<id>/case.json` + `prepare.ts`），共享材料放 `resources/`；
用例声明依赖，缺依赖的用例会被跳过（blocked）而不是把整批跑红；环境一律按用例自己准备，
判据材料在验证前才注入 worktree（候选看不到）。

测试集只用 CLI 调用 harness（`bun scripts/cli.ts run …`），不 import 应用源码。
