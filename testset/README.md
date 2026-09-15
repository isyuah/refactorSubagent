# testset — libuv 能力评估测试集

套件定义（`suite.json`）、并行执行器（`run.ts` + `runner/`）、任务简报（`tasks/`）、
校准语料（`parts/`）、oracle 作者副本（`oracle/`）与**基线材料**（`baseline/`）。

用法文档在 [`../docs/testset/`](../docs/testset/)：

- [`README.md`](../docs/testset/README.md) — 测试集总览、目录结构、维护约定
- [`03-suite-and-runner.md`](../docs/testset/03-suite-and-runner.md) — 执行器手册 + §10 实测记录（判据 10/10、T1–T6、writer、e2e、缓存与并发）
- [`02-testset-requirements.md`](../docs/testset/02-testset-requirements.md) — 期望声明模型与判定规则
- [`01-refactor-targets.md`](../docs/testset/01-refactor-targets.md) — 可重构点与覆盖缺口
- [`04-rubric.md`](../docs/testset/04-rubric.md) — 裁判给分标准

```bash
bun testset/run.ts --list                                    # 选择器：25 用例 / 5 类被测对象
bun testset/run.ts --self-test                               # 执行器自检（合成用例）
bun testset/run.ts --subject judgement --tag offline         # 离线判据自测，不调模型
bun testset/run.ts --subject judgement --tag offline --build-cache --concurrency 2
bun testset/run.ts --subject writer --rubric-cmd "claude -p" # 写判据能力 + 裁判
bun testset/run.ts --reevaluate runs/<批>                    # 改期望后用已存结果重判（零模型成本）
```

## 三样东西不进版本

| 路径 | 为什么 | 怎么回来 |
|---|---|---|
| `../libuv/` | 钉死的基线检出（含 15 个 overlay 提交的完整历史） | 见 [`baseline/README.md`](baseline/README.md)：上游 `libuv/libuv@1cfa32f` (v1.52.1) + `baseline/overlay/` |
| `../runs/` | 每次运行的证据（139MB 级） | 重跑即可生成；历史批次是当时的记录，不必重建 |
| `.cache/` | 热构建槽位（133MB 级，`--build-cache` 用） | 删掉后第一批会重新冷构建（同一批 6m18s vs 3m55s） |
