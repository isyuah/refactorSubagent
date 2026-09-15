# baseline — 钉死的 libuv 基线（材料副本）

判定"行为是否保持"需要一棵**固定不动**的基线树。它由两部分组成：

| 部分 | 来源 | 本目录是否含 |
|---|---|---|
| 上游 libuv | `https://github.com/libuv/libuv` 标签 `v1.52.1`，提交 `1cfa32f` | 否（公开可克隆） |
| 我们的 overlay | `refactor-task/**` 与根 `.gitattributes`，15 个提交 | 是 → [`overlay/`](overlay/) |

被钉住的检出：分支 `task-baseline`，提交 **`c6154e79c3f4669e603fd287cdb89e5795d62235`**，
overlay 的目录树 sha `368d62546034c7a9469901d2c0ff331dff599f55`（`git rev-parse c6154e7:refactor-task`）。
`testset/suite.json` 的 `baseline.commit` 就是它——所有 pipeline 用例从这个提交克隆。

## 为什么检出本身不进版本

检出是一个 git 仓库（7MB，含浅历史）。提交嵌套仓库不是 git 支持的形状，而"材料"只有 100KB：
把 overlay 与上游锚点版本化，等价信息就都在版本里了。

## 怎么重建一棵可用的检出

```bash
cd E:/Proj/refactorSubagent
git clone --depth 1 --branch v1.52.1 https://github.com/libuv/libuv.git libuv
cd libuv
cp -r ../testset/baseline/overlay/refactor-task .
cp ../testset/baseline/overlay/.gitattributes .
git add -A && git -c user.name=testset -c user.email=testset@local commit -qm "task baseline: materialized overlay"
git checkout -B task-baseline
```

重建出来的提交 **sha 与 `c6154e7` 不同**（提交时间/作者不同），所以要么：

```bash
# 用重建检出的实际 sha 跑测试集
bun testset/run.ts --baseline-commit "$(git -C libuv rev-parse HEAD)" --list
```

要么把这里当"内容等价"的证据：判定真正依赖的是**内容摘要**（`refactor-task/PINS.json` 与
inventory 里逐文件的 sha256），`--list` / 自检会校验它们，重建后的 sha 不同不影响判据是否成立。

## overlay 里有什么

```text
refactor-task/
├─ PINS.json                 上游用例与判据材料的逐文件摘要（判定的锚点）
├─ TASK.md                   任务简报（caller 提供，不再写死）
├─ workflows/                build-workflow.ts / test-workflow.ts —— 参考判据（98 条声明/侧）
├─ oracle/                   6 个自研 oracle（行为岛，上游盲区的补充）
├─ patches/                  10 个变异/篡改用例补丁（判据的牙齿）
└─ libuv-testset.json        仓内测试集清单（与 suite.json 的对应关系）
```

维护约定（改判据材料之后的固定动作）见 [`../docs/testset/README.md`](../docs/testset/README.md)。
