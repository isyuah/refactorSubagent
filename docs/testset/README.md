# libuv 测试集（仓库内目录）

判定"行为是否保持"的测试工具与期望：套件定义、并行执行器、自带用例清单、自研 oracle、任务简报。
它住在 harness 仓库里（`testset/` + `docs/testset/`），但**只用 CLI 调用 harness**（`bun scripts/cli.ts run …`），
不 import 应用源码——测试工具与产品的分层，靠调用边界而不是目录边界来保证。

仓库里只版本化"工具 + 期望"这类文本；三类大件刻意不进版本：
`libuv/`（钉死的检出，`suite.json` 里的 commit）、`runs/`（历史证据）、`testset/.cache/`（热构建槽位，见 `docs/03` §8.1），
它们的路径写在 `.gitignore` 里，需要时按 `docs/03` 的说明重新物化。

## 目录

```text
refactorSubagent/
├─ testset/                       ← 套件定义 + 执行器（本目录的代码）
├─ libuv/                         ← 钉死的基线检出（不进版本）
├─ runs/                          ← 每次运行的证据（不进版本）
├─ docs/testset/
│  ├─ README.md                   ← 本文件
├─ docs/
│  ├─ 01-refactor-targets.md      可重构点清单：每个目标的可做重构、必须保持不变的行为（实测）、覆盖缺口
│  ├─ 02-testset-requirements.md  测试集需求：构建事实、用例清单、期望声明模型、判定规则、复现命令、反例证据
│  ├─ 03-suite-and-runner.md      套件矩阵与并行执行器：被测对象、评价方法、隔离、结果、如何加用例
│  └─ 04-rubric.md                writer 档的裁判评分标准（rubric：门槛项与计分项）
├─ testset/
│  ├─ libuv-testset.json          机器可读测试集（pin、构建、14 个自带用例、6 个 oracle、排除项、mutation 证据）
│  ├─ suite.json                  可执行用例矩阵：25 个用例 × 5 类被测对象 × 各自评价方法
│  ├─ tasks/                      任务文本 t1-strtok … t6-version（喂给 harness 的 `run --task`）
│  ├─ parts/                      语料"部分"：pure(14, strict) / loop(19) / thread(22) / util(10)（calibrate）
│  ├─ runner/                     并行执行器（bun，无外部依赖）：调度、驱动、评价、裁判、显示
│  ├─ pipeline/                   手工示例配置（喂给 harness 的 `run --pipeline-file`）
│  │  ├─ m1a-accept.json          预置 workflow + 行为保持补丁 → 期望 ACCEPTED
│  │  └─ m1a-reject.json          预置 workflow + 破坏行为补丁 → 期望 REJECTED
│  └─ oracle/                     oracle 源码（工作副本；权威副本随基线提交进 libuv 仓库）
│     ├─ oracle_common.h
│     ├─ oracle_strtok.c   oracle_strscpy.c   oracle_inet.c
│     ├─ oracle_errstr.c   oracle_getters.c   oracle_version.c
│     └─ build_and_run.sh         本地便利脚本（git-bash/MSYS；harness 不需要它）
├─ libuv/                         libuv v1.52.1（--depth 1 克隆，分支 task-baseline）
│  └─ refactor-task/              ★ 随基线提交，两侧 worktree 都能看到
│     ├─ TASK.md                  当前重构任务与约束
│     ├─ PINS.json                oracle 源码 + 上游判据文件（test/**）+ 判据 workflow 的 sha256
│     ├─ libuv-testset.json       同上（仓库内副本）
│     ├─ .gitattributes           `* -text`：禁止行尾转换，保证摘要 pin 在任意 checkout 下成立
│     ├─ workflows/               判据 workflow 本体（BuildWorkflow / TestWorkflow 源）
│     ├─ patches/                 候选补丁：M1a 行为保持/破坏各一 + 5 个行为变异 + 3 个判据篡改
│     └─ oracle/                  oracle 源码（判据本体）
└─ build/                         源码外构建目录（Ninja，可删；重建 32 s）
```

## 钉死的事实

| 项 | 值 |
|---|---|
| libuv | `v1.52.1`，commit `1cfa32f`，`git clone --depth 1 --branch v1.52.1 https://github.com/libuv/libuv.git libuv` |
| 任务基线提交 | `c6154e7`（分支 `task-baseline`，内容 = v1.52.1 + `refactor-task/` + 根 `.gitattributes` + 变异语料）；harness 的 `baseSha` 取它。链：`…→ c0f65f3`（T3 运行）`→ bcfd4ec`（变异语料 + 任务简报改为调用方提供）`→ e9ec612`（同步仓内测试集清单）`→ 5e2d240`（术语拆分）`→ 7b00a02`（判据抗抖动：产物缺失先重建） |
| 主机 | Windows 11 Pro x64 / GCC 15.2 (MinGW) / CMake 4.3.1 / Ninja 1.13.2 / Debug |
| 产物 | `build/uv_run_tests_a.exe`（静态 runner）、`build/libuv.a` |

## 快速开始

```bash
cd E:/Proj/refactorSubagent

# 构建（GCC 15 必须带 -Wno-error=…，否则 src/win/util.c:630 直接报错）
cmake -S libuv -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=ON \
      "-DCMAKE_C_FLAGS=-Wno-error=incompatible-pointer-types -Wno-error=discarded-qualifiers"
cmake --build build --target uv_run_tests_a -j 8          # 实测 32 s

# 单个自带用例
build/uv_run_tests_a.exe strtok                            # -> ok 1 - strtok (exit 0, ~0.5 s)
build/uv_run_tests_a.exe --list                            # 列出全部用例名

# oracle（本地的 git-bash/MSYS 便利脚本；失败会打印逐条 FAIL）
bash testset/oracle/build_and_run.sh                       # -> oracles_failed=0
```

## 测试集组成

- **14 个自带用例**（全部纯函数、确定性、约 0.5 s/个）：`strscpy strtok utf8_decode1 utf8_decode1_overrun wtf8 idna_toascii ip4_addr ip6_pton ip6_sin6_len ip_name uname gethostname getters_setters queue_foreach_delete`。
- **6 个 oracle**（174 项检查，链接 `build/libuv.a`）：补齐自带用例层失明的行为——`strtok` 的空 token 语义、`uv_inet_ntop(AF_INET6)` 整条渲染路径与缓冲区边界、`uv_err_name/uv_strerror` 家族（上游断言点是死代码）、6 个未被调用的 getter/setter、`uv_version*`。
- 两份 mutation 实验证明这层不是装饰：见 `docs/02-testset-requirements.md` §9（自带用例全绿、oracle 抓红）。

## 与 harness 的衔接

任务仓已经就绪：把 harness 指向这个检出即可（`repoPath = E:/Proj/refactorSubagent/libuv`，`sessionRoot` 放在仓库之外）。测试侧需求（构建工作流、自驱 TestWorkflow 的步骤与期望声明、判定规则、排除项）在 `docs/02-testset-requirements.md`；harness 的期望模型是"基线 vs 候选逐位置比较 + `both-matches` 绝对断言"，两份用法都要写进 TestWorkflow。

判据 workflow 已经写好并随基线提交：`libuv/refactor-task/workflows/{build,test}-workflow.ts`（后者 98 条声明：判据文件摘要 → 6 个 oracle 编译 → 14 个自带用例 → 6 个 oracle 运行）。

### M1a：不调模型的判据自测

```bash
cd E:/Proj/refactorSubagent
TASK="行为保持型重构：只允许结构调整，行为由 refactor-task/ 下的判据冻结。"

# 行为保持补丁 → 期望 ACCEPTED / exit 0
bun run scripts/cli.ts run E:/Proj/refactorSubagent/libuv --task "$TASK" \
  --pipeline-file E:/Proj/refactorSubagent/testset/pipeline/m1a-accept.json \
  --session m1a-accept-s2 --session-root E:/Proj/refactorSubagent/runs/m1a-accept

# 破坏行为补丁（strtok 丢弃空/尾 token）→ 期望 REJECTED / exit 1
bun run scripts/cli.ts run E:/Proj/refactorSubagent/libuv --task "$TASK" \
  --pipeline-file E:/Proj/refactorSubagent/testset/pipeline/m1a-reject.json \
  --session m1a-reject-s2 --session-root E:/Proj/refactorSubagent/runs/m1a-reject
```

两次运行都只用预置阶段（`--pipeline-file` 里 `workflows.mode=preset` + `refactor.mode=patch`），不产生任何模型调用；判据是同一套宿主实现（真构建、真跑用例、逐位置比较）。运行后在 libuv 检出里清理掉 harness 建的候选分支：

```bash
cd E:/Proj/refactorSubagent/libuv && git worktree prune
git branch --format='%(refname:short)' | grep -E '^(refactor/|refactor-session/)' | xargs -r git branch -D
```

**实测结果（2026-09-14 本机，各约 1.7 min）**

| 运行 | 候选补丁 | 状态 | 比较 |
|---|---|---|---|
| `m1a-accept-s2` | `m1a-accept.patch`（`src/strtok.c` 加一行注释） | **ACCEPTED**（exit 0） | 98/98 声明一致，两侧 build pass |
| `m1a-reject-s2` | `m1a-reject.patch`（M1：丢弃空/尾 token） | **REJECTED**（exit 1） | 95/98，仅 `oracle_strtok.exit/.summary/.stdout` 失配 |

reject 运行里 **14 个自带用例（42 条声明）全绿**（`ok 1 - strtok`，exit 0），oracle 逐条抓出 7 处行为变化：`empty-token-between`、`trailing-separator`、`leading-separator`、`all-separators`、`empty-input`、`runs-and-edges`、`mutate-second-token` —— `docs/02` §9 记录的"上游失明、oracle 抓住"在真实管线（`runStageFlow`）上复现。

日志与 artifact：`runs/m1a-accept/.refactor/e2e/m1a-accept-s2/`、`runs/m1a-reject/.refactor/e2e/m1a-reject-s2/`（各含 98 条声明的比较结果、两侧 build 产物记录、prompt/会话日志目录）。

### M1b：判据冻结，只让 AI 重构

同一套预置判据，只把 `refactor` 槽换回 AI 会话（任务 = `TASK.md` 的 T1）：

```bash
TASK=$(cat E:/Proj/refactorSubagent/testset/tasks/t1-strtok.task.txt)
bun run scripts/cli.ts run E:/Proj/refactorSubagent/libuv --task "$TASK" \
  --pipeline-file E:/Proj/refactorSubagent/testset/pipeline/m1b-strtok-ai.json \
  --session m1b-strtok-s1 --session-root E:/Proj/refactorSubagent/runs/m1b-strtok \
  --limit sessions.refactor.deadlineMs=1800000 --limit sessions.refactor.maxTurns=60
```

**实测（2026-09-14）**：**ACCEPTED**，98/98 声明一致，两侧 build pass，`changed_files=["src/strtok.c"]`。
墙钟 249 s：准备 6.9 s → **refactor 会话 56.7 s** → 两侧构建 56.6 / 90.0 s → 两侧测试 16.0 / 21.1 s。
候选做出的是真重构：抽出 `static int uv__strtok_is_sep(char, const char*)` 谓词、把两条赋值分支合成三元式、`tmp == NULL` 早退提前、循环体平坦化——全部落在 `TASK.md` 的允许清单内，判据（含 21 项 `uv__strtok` oracle 检查）逐条一致。完整 diff 见 `docs/02` §12.2。

### 加难：T3 `src/inet.c`（判据不动）

任务简报换成 T3（298 行、4 个 `static` 内部函数 + 2 个公开入口；48 项 `oracle_inet` 检查 + 4 个自带用例），**判据仍是同一份 `test-workflow.ts`，同 98 条声明**：

```bash
TASK=$(cat E:/Proj/refactorSubagent/testset/tasks/t3-inet.task.txt)
bun run scripts/cli.ts run E:/Proj/refactorSubagent/libuv --task "$TASK" \
  --pipeline-file E:/Proj/refactorSubagent/testset/pipeline/m1b2-inet-ai.json \
  --session m1b2-inet-s1 --session-root E:/Proj/refactorSubagent/runs/m1b2-inet \
  --limit sessions.refactor.deadlineMs=2400000 --limit sessions.refactor.maxTurns=80
```

**实测（2026-09-14）**：**ACCEPTED**，98/98 一致，`changed_files=["src/inet.c"]`，**124 增 / 56 删**。
墙钟 244 s：准备 6.2 s → **refactor 会话 134.5 s**（T1 是 56.7 s）→ 两侧构建 40.1 / 39.2 s → 两侧测试 11.6 / 11.8 s。
候选抽出 4 个 `static` 辅助（`inet_ntop_finish` 统一两处 ENOSPC 尾巴、`inet_words_from_bytes`、`inet_find_best_run` + `struct inet_run`、`inet_pton6_emit`），并拉平 `inet_pton4` 状态机；两处边界（`best.len < 2` 单零组不压缩、`len > size` 含结尾 NUL）都保住。见 `docs/02` §12.4。

三轮同一判据的对照：

| 运行 | 任务 | 候选来源 | 判定 | 声明 |
|---|---|---|---|---|
| `m1a-reject-s2` | T1 | 手工破坏补丁 | **REJECTED** | 95/98（仅 `oracle_strtok.*`） |
| `m1b-strtok-s1` | T1 | AI 会话（57 s） | **ACCEPTED** | 98/98 |
| `m1b2-inet-s1` | T3 | AI 会话（134 s） | **ACCEPTED** | 98/98 |

## 测试套件与并行执行器

手工一条条敲命令只能回答"这一次过没过"。要把评估变成可比较的数据，用测试集自带的套件与执行器（细节见 `docs/03-suite-and-runner.md`）：

```bash
cd E:/Proj/refactorSubagent
bun testset/run.ts --list                     # 25 个用例，按被测对象分组
bun testset/run.ts --subject judgement --concurrency 3   # 判据本体：离线、不调模型
bun testset/run.ts --tag offline --calibrate  # 只跑离线的，并把观测到的失配集落盘
bun testset/run.ts --dry-run --subject writer # 只看 writer 档会做什么
```

要点：

- **五类被测对象、各自评价方法**：`judgement` 判据本体（程序化 + 失配归因）、`refactor` 重构（程序化）、`writer` 写判据（程序化 + 裁判 rubric）、`e2e` 端到端（程序化 + 裁判评述）、`corpus` 语料（strict / calibrate 分类）。
- **每个用例一份独立 clone + 独立 session root**：并发不需要共享仓库，`libuv/` 这份基线检出始终干净。
- **变异语料**：`mutant-*` 是"看起来合理、实际改行为"的补丁（strscpy n==0、inet 单零组、UDP 队列字段互换、版本常量、错误码措辞），`tamper-*` 是"动判据本身"的补丁（弱化断言、改 oracle、删用例）——它们必须被 REJECTED，且**失配声明的名单**要命中预期。
- **语料部分**：`parts/pure` 是当前判据用的 14 条（strict）；`loop/thread/util` 是 51 条候选（calibrate，重复 3 次给稳定分类），跑稳之后才谈升进判据。
- 新用例只加 `suite.json` 一条 + 需要的话在基线里加一个补丁；`provisional: true` 明确标出"期望值尚未实测"。

## 维护约定

- `testset/oracle/` 是作者副本，**权威副本是 `libuv/refactor-task/oracle/`**（它随基线提交、被 `PINS.json` 摘要锁定）。改动后同步：

```bash
cp testset/oracle/oracle_*.c testset/oracle/oracle_common.h libuv/refactor-task/oracle/
cd libuv && sha256sum refactor-task/oracle/* | sed 's|refactor-task/oracle/||'   # 更新 PINS.json
git add refactor-task && git -c user.email=task@local -c user.name=task commit -m "task baseline: <change>"
```

- 改了 oracle 就必须同步 `PINS.json` 与 `testset/libuv-testset.json` 的 `checks_ok`/`pins`，否则 TestWorkflow 的摘要断言会把下一次运行判成 REJECT。
- 不要为了"顺手修 bug"改动被测行为的判据：本测试集钉住的若干怪行为（空 token、`uv_strerror(0)` 的措辞、单零组不压缩、`size >= len+1`）都是行为保持的一部分。
- **改了基线就要同步 SHA**：新增/修改 `refactor-task/**` 后提交进 `task-baseline`，把新 SHA 写进 `README.md`、`testset/suite.json` 的 `baseline.commit`、`testset/libuv-testset.json` 的 `task_baseline`（`runs/` 里的历史运行记录不追改，它们是当次 SHA 的证据）。
- **行尾必须无转换**：仓库根 `.gitattributes` 已写 `* -text`，检出内部再用 `git config core.autocrlf false`（本检出已设）。摘要 pin 与候选补丁都按字节算，CRLF/LF 混用会让 pin 全表失配——M1a 首轮演练就是这么抓到一版"在 CRLF 工作区上算出来的 `test/**` 摘要"的。
