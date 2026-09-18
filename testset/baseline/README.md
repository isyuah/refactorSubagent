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

```bash
cd E:/Proj/refactorSubagent
git clone --depth 1 --branch v1.52.1 https://github.com/libuv/libuv.git libuv
```

检出只是"本地克隆源"，用例的 prepare 脚本按 `resources/sources/libuv.json` 的 pin 从它浅克隆。
把检出换成一个新的上游克隆不影响判定——判定依赖的是 pin 的提交内容与 `resources/` 里的材料摘要。

维护约定（改判据材料之后要做的固定动作）见 [`../docs/testset/README.md`](../docs/testset/README.md)。
