# 重构任务：libuv v1.52.1（行为保持型）

本目录是**任务基线**的一部分，随基线提交进入仓库，baseline / candidate 两侧 worktree 都会看到它。

## 任务简报从哪来

**具体的任务简报由调用方通过 harness 的 `--task` 传入**，不写在本文件里：同一份基线要能跑多个目标（T1 `src/strtok.c`、T2 `src/strscpy.c`、T3 `src/inet.c`、T4 `src/uv-common.c` 错误字符串岛、T5 `src/uv-data-getter-setters.c`、T6 `src/version.c`）。当前可用的任务文本在任务仓的 `testset/tasks/*.task.txt`，候选目标与"必须保持不变的行为"清单在 `docs/01-refactor-targets.md`。

本文件只规定**对所有目标都成立的约束与验收方式**。

## 允许的重构形态

- 在目标文件内部：抽取 `static` 辅助函数、合并重复分支、拉平状态机、为分支命名、去冗余局部变量与重复条件、调整语句顺序（须保持语义）。

## 不允许

- 改变任何可观测行为（返回值、错误码、缓冲区写入规则、字符串措辞、迭代器推进等）；
- 修改 `include/**`（ABI）、`test/**`（判据本体）、`refactor-task/**`（判据本体与任务定义）；
- 改公开符号的名字/签名/链接属性；把目标函数移出所在 `.c` 文件或改成 `static`（多个自带用例直接 `#include` 源码文件）；
- 为了"顺手修 bug"而修改既有怪行为——本测试集钉住的若干怪行为（`uv__strtok` 的空 token 语义、`uv_strerror(0)` 的措辞、IPv6 单个零组不压缩、`uv_inet_ntop` 的 `size >= strlen+1` 规则）都是**行为保持的一部分**。

## 验证方式（宿主执行，不受候选影响）

1. 构建：CMake/Ninja Debug，`BUILD_TESTING=ON`，目标 `uv_run_tests_a`；产物 `build/uv_run_tests_a.exe`、`build/libuv.a`。
2. 自带用例：`build/uv_run_tests_a.exe <case>`，每个用例一个进程；退出码 0 通过、3 断言失败、7 跳过（本清单不允许跳过）、255 未知用例。
3. oracle：编译并运行 `refactor-task/oracle/oracle_*.c`（链接 `build/libuv.a`），每个 oracle 以 `<name>-oracle: total_failures=N` 汇总。
4. 判定：两侧（baseline / candidate）的用例退出码、TAP 行、oracle 逐行输出必须逐字一致，且退出码/汇总必须命中绝对断言（`both-matches`）；判据材料（`test/**`、`refactor-task/oracle/**`）的摘要被钉住，候选改动它们会被判 REJECT。

## 历史

- **T1 `src/strtok.c`**：ACCEPTED（AI 重构会话，98/98 声明一致），见任务仓 `docs/02-testset-requirements.md` §12.2。
- **T3 `src/inet.c`**：ACCEPTED（AI 重构会话，98/98，124 增 / 56 删），见 §12.4。

## 背景资料

- `docs/01-refactor-targets.md` / `docs/02-testset-requirements.md` / `docs/03-suite-and-runner.md`（任务仓 `E:/Proj/libuv-refactor-tasks`）给出候选目标、判据需求、任务文本与批量执行方式。
- `libuv-testset.json` 是同一份测试集的机器可读版本（用例清单、oracle 清单、期望模型、排除项、变异语料）。
