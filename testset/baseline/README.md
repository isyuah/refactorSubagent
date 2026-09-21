# baseline — libuv 源检出（克隆源）

判定"行为是否保持"需要一棵**固定不动**的源树。2026-09-17 的重设计之后，用例的环境由自己的
`prepare.ts` 从**上游 tag** 直接浅克隆产生（见 `runner/case-api.ts` 的 `cloneSource`），
不再需要 overlay：判据材料（oracle、补丁、判据 workflow）都在 `testset/resources/` 里，
在候选提交之后、验证之前才注入 worktree（`docs/testset/03-suite-and-runner.md` §8.2）。

| 项 | 值 |
|---|---|
| 源 | `https://github.com/libuv/libuv` 标签 `v1.52.1`，提交 `1cfa32ff59c076ffb6ed735bbc8c18361558661f` |
| pin 写在 | `testset/resources/sources/libuv.json`（`repo` / `ref` / `commit`） |
| 环境得到什么 | 只有那一个上游提交（`--depth 1 --single-branch`），既没有 overlay 历史，也没有判据材料 |

## 重建检出（本目录不版本化检出本身）

本地检出是**可选**的：`cloneSource` 在本机没有 `<repo>/libuv` 时，会用 pin 里的 `remote`
（上游 GitHub）直接浅克隆，所以新机器什么都不用准备。想加速/离线可以自己放一份：

```bash
git clone --depth 1 --branch v1.52.1 https://github.com/libuv/libuv.git libuv
```

判定的可信度来自 `resources/sources/libuv.json` 的 `commit` 与 `resources/` 里的材料摘要，
与本地这份检出无关。

维护约定（改判据材料之后要做的固定动作）见 [`../docs/testset/README.md`](../docs/testset/README.md)。
