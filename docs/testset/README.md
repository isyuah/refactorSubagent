# libuv 测试集（仓库内目录）

判定"行为是否保持"的测试工具与期望：用例目录、共享资源、并行执行器、执行器手册。
它住在 harness 仓库里（`testset/` + `docs/testset/`），但**只用 CLI 调用 harness**（`bun scripts/cli.ts run …`），
不 import 应用源码——测试工具与产品的分层，靠调用边界而不是目录边界来保证。

仓库里只版本化"工具 + 用例 + 资源"这类文本；三类大件刻意不进版本：
`libuv/`（源材料检出，被 `resources/sources/libuv.json` 的 pin 引用）、`runs/`（历史证据，含每例的环境目录）、
它们的路径写在 `.gitignore` 里，需要时由用例的 `prepare.ts` 自动重建。

## 目录

```text
refactorSubagent/
├─ testset/
│  ├─ run.ts                     执行器入口：discovery → probe → gate → prepare → harness → evaluate
│  ├─ runner/                    执行器实现（bun，无框架依赖）
│  │  ├─ suite.ts                case.json 的 schema、发现、选择、材料校验
│  │  ├─ probe.ts                主机探测与 recipe 校验（工具 / Ninja 生成器 / gcc flag 探针）
│  │  ├─ env.ts                  环境目录分配 + 执行 prepare 脚本（blocked 约定）
│  │  ├─ drivers.ts              pipeline / upstream-part 驱动
│  │  ├─ evaluate.ts             评价方法：verdict / attribution / rubric / part / blocked
│  │  ├─ rubric.ts               裁判（外部命令 + prompt 注入 + JSON 解析）
│  │  └─ display.ts / exec.ts / util.ts
│  ├─ cases/<id>/                用例：case.json（行为）+ prepare.ts（环境）+ 可选本地材料
│  ├─ resources/
│  │  ├─ sources/libuv.json      源与 pin（repo / ref / commit）
│  │  ├─ workflows/judgement/    预置判据 workflow（manifest.json + build/test 源）
│  │  ├─ patches/                补丁：行为保持 / 变异 / 篡改（含伪造 oracle）
│  │  ├─ judge/libuv-1.52.1/     判据材料（oracle 源），验证前注入 worktree
│  │  ├─ tasks/                  任务简报（多个用例可共用）
│  │  └─ parts/                  语料部分定义：pure / loop / thread / util
│  ├─ baseline/                  基线重建材料（overlay，见 baseline/README.md）
│  └─ subjects.json              subject 的显示说明
├─ docs/testset/
│  ├─ README.md                  本文件
│  ├─ 01-refactor-targets.md     可重构点清单与覆盖缺口
│  ├─ 02-testset-requirements.md 判据需求、期望声明模型、判定规则（含历史实测）
│  ├─ 03-suite-and-runner.md     执行器手册 + 历史实测记录
│  └─ 04-rubric.md               裁判评分标准
├─ libuv/                        源材料检出（不进版本；浅克隆 + overlay）
├─ runs/                         每次运行的证据（不进版本）
└─ build/                        手工构建目录（不进版本；执行器不需要它）
```

## 与 harness 的衔接

执行器对每个用例做五件事：探测主机 → 比对 `requires`（缺依赖则 blocked 跳过）→ 让用例的 `prepare.ts`
准备环境 → 用 `case.json` 的 `stages` 物化 `pipeline.json` 并调用 `bun scripts/cli.ts run …` →
按用例的评价方法判定。判据本体（`resources/workflows/**`）与判据材料（`resources/judge/**`）都不在
候选环境里，只有验证前才注入两侧 worktree（见 `03-suite-and-runner.md` 的 blind 一节）。

最短路径：

```bash
cd E:/Proj/refactorSubagent
bun testset/run.ts --list                                  # 26 个用例，按 subject 分组
bun testset/run.ts --self-test                             # 执行器自检（合成用例，不碰项目）
bun testset/run.ts --subject judgement --concurrency 2     # 判据本体：离线、不调模型
bun testset/run.ts --only refactor-t1-strtok --rubric-cmd "claude -p"
```

## 维护约定

- **判据材料只在 `resources/`**：`judge/**`、`workflows/**`、`patches/**`。oracle 的 sha256 被
  `resources/workflows/judgement/test-workflow.ts` 的 `ORACLE_PINS` 钉住——改 oracle 必须同步 pin，
  否则判据档用例会以"判据被改动"失败（fail-closed，设计如此）。
- **期望冻结**：`--freeze runs/<批>` 把实测失配集写回 `cases/*/case.json`，并清掉 `provisional`。
- **源 pin**：`resources/sources/libuv.json` 的 `commit` 必须与上游 tag 一致；环境由浅克隆产生，
  不含 overlay 历史（blind 的前提）。
- **不要手改 `runs/`**：它是证据；要重跑就换 `--out`。
