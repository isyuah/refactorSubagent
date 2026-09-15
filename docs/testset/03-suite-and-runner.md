# 测试套件与并行执行器（suite / runner）

> 面向读者：要跑评估、要加用例、要看结果的人。
> 术语：**判据**（英文标识一律用 `judgement`）指判定行为是否保持的那套东西——`refactor-task/workflows/{build,test}-workflow.ts` + harness 的比较引擎；
> **裁判**（标识用 `rubric`）指给"模型写出的判据"打分的外部评分者（测试侧工具，不在 harness 里）。两者在代码里不再共用同一个词：判据=`judgement`，裁判=`rubric`。

> 相关文档：`01-refactor-targets.md`（重构目标）、`02-testset-requirements.md`（判据需求与实测）、`04-rubric.md`（裁判评分标准）。

## 1. 为什么需要这一层

到目前为止的评估都是"一次一个"：手工敲一条 `run` 命令、手工看一条结论。要回答"哪个模型/哪份配置更好"就必须能**一次跑一批、选择性地跑、并排看结果**，而且不同性质的东西不能用同一种判法：

| 被测对象 | 在测什么 | 评价方法 | 为什么不能统一 |
|---|---|---|---|
| `judgement` | 判据本体会不会判卷 | 程序化：状态 + **失配声明归因** | 只看 ACCEPT/REJECT 无法区分"判对了"和"恰好判对了" |
| `refactor` | 模型改代码的能力 | 程序化：状态 + 声明一致性 | 判据已冻结，判据本身不是被测对象 |
| `writer` | 模型写 build/test workflow 的能力 | 程序化（注入已知好坏补丁）+ **裁判 rubric** | "判据有没有牙齿"能程序化，"写得是否完整/可维护"不能 |
| `e2e` | 端到端闭环 | 程序化 + 裁判评述 | 判定来自模型自己写的判据，必须有人看它写了什么 |
| `corpus` | 测试语料本身能不能用 | strict：逐条必须通过；calibrate：只做稳定分类 | 时序/环境敏感的用例不该被"一次跑必须过"误杀 |

这正是 §"不同测试用不同评价方法"的落地：**评价方法是 suite 里每个用例的字段**（`expect.method`），不是全局设置。

## 2. 文件布局

```text
testset/
├─ suite.json            用例矩阵（25 个用例）：driver、任务、阶段来源、期望
├─ tasks/                任务文本（t1-strtok … t6-version），喂给 run --task
├─ parts/                语料"部分"定义：pure(14) / loop(19) / thread(22) / util(10)
├─ pipeline/*.json       手工示例配置（M1a / M1b / T3 的复现命令用）
├─ oracle/               oracle 源（作者副本）
└─ runner/
   ├─ suite.ts           用例模型、选择、阶段来源物化
   ├─ drivers.ts         pipeline 驱动（clone + harness CLI）与 upstream-part 驱动
   ├─ evaluate.ts        评价方法实现（verdict / attribution / part）
   ├─ rubric.ts          裁判（rubric scorer）：生成 prompt、调用外部命令、解析打分（测试侧，非 harness）
   ├─ exec.ts            进程执行（超时 + 进程树终止）
   ├─ display.ts         实时表格与结束汇总
   └─ util.ts            JSON/路径/时间/终端
```

`suite.json` 里的 `stages` 与 harness 的 `--pipeline-file` 是**同一种格式**，runner 会把它物化成 `runs/…/<case>/pipeline.json`；`"workflows": "judgement"` 是 suite 头部 `presets.judgement` 的引用（预置判据 workflow 的 id/入口只写一处）。

## 3. 用例矩阵

| 用例 | 驱动 | 阶段来源 | 期望 |
|---|---|---|---|
| `judgement-accept-comment` | pipeline | preset + 行为保持补丁 | ACCEPTED，0 失配 |
| `judgement-reject-strtok` | pipeline | preset + 破坏补丁 | REJECTED，必须命中 `oracle_strtok.*` |
| `judgement-mutant-strscpy` | pipeline | preset + `mutant-strscpy-n0` | REJECTED，必须命中 `oracle_strscpy.*` |
| `judgement-mutant-inet` | pipeline | preset + `mutant-inet-zero` | REJECTED，必须命中 `oracle_inet.*` |
| `judgement-mutant-getters` | pipeline | preset + `mutant-getters-udp` | REJECTED，必须命中 `oracle_getters.*` |
| `judgement-mutant-version` | pipeline | preset + `mutant-version-hex` | REJECTED，必须命中 `oracle_version.*` |
| `judgement-mutant-errstr` | pipeline | preset + `mutant-errstr-unknown` | REJECTED，必须命中 `oracle_errstr.*` |
| `judgement-tamper-tests` | pipeline | preset + `tamper-weaken-tests` | REJECTED，必须命中 `test/test-strtok.c.{digest,snapshot}` |
| `judgement-tamper-oracle` | pipeline | preset + `tamper-edit-oracle` | REJECTED，必须命中 `oracle.sources.{digest,snapshot}` |
| `judgement-tamper-drop-case` | pipeline | preset + `tamper-drop-case` | REJECTED，必须命中 `test/test-list.h.digest` + `strtok.exit` |
| `refactor-t1-strtok` … `refactor-t6-version` | pipeline | preset + **ai** | ACCEPTED，provenance = `[workflows, refactor]` |
| `writer-{good,evil}-material` | pipeline | **ai** workflows + 已知补丁 | 好补丁 ACCEPTED / 坏补丁 REJECTED（参考答案可见） |
| `writer-{good,evil}-hidden` | pipeline | **ai** workflows + 已知补丁，clone 内**删掉** `refactor-task/{workflows,oracle}` | 同上（看不见参考实现） |
| `e2e-t1-full` | pipeline | ai workflows + ai refactor | 端到端，程序化 + 裁判 |
| `corpus-pure` | upstream-part | 共享检出 + 构建 | strict：14 条逐条 exit 0 + TAP |
| `corpus-{loop,thread,util}` | upstream-part | 共享检出 + 构建 | calibrate：每条重复 N 次 → `stable-ok` / `stable-fail` / `flaky` / `error` |

`provisional: true` 的用例表示**期望值是推断的、尚未实测**（新变异体、未跑过的重构目标、writer 档）。runner 会把它标出来，不会假装它是已验证事实。

## 4. 用法

```bash
cd E:/Proj/refactorSubagent

# 看有哪些用例（按被测对象分组；--json 给机器读）
bun testset/run.ts --list

# 只跑"判据本体"这一类，离线、不调模型（约 1.7 min/例，可并发）
bun testset/run.ts --subject judgement --concurrency 3

# 精确选择 / 打标签选择 / 排除
bun testset/run.ts --only refactor-t1-strtok,refactor-t3-inet
bun testset/run.ts --tag offline
bun testset/run.ts --subject refactor --exclude unmeasured

# 先看会跑什么（不执行任何东西）
bun testset/run.ts --dry-run --subject writer

# 用已存结果重判（改期望之后，不必再花钱重跑）
bun testset/run.ts --reevaluate runs/capability-t2-t6

# 校准：不把"归因不符"当失败，而是把观测到的失配集写进 calibration.json
bun testset/run.ts --subject judgement --calibrate --out runs/calib-judgement

# 语料部分：只看某几条上游用例，重复 5 次判断稳定性
bun testset/run.ts --only corpus-loop --part-filter loop_close --repeats 5

# writer 档接裁判（裁判是测试侧工具，不是 harness 功能）
bun testset/run.ts --subject writer --rubric-cmd "claude -p" --rubric-min 0.7

# runner 自检（合成用例，不碰任何项目）
bun testset/run.ts --self-test
```

退出码：`0` 全部符合期望；`1` 有失败/错误；`2` 选择为空；`3` runner 自身异常。

## 5. 隔离与并行

- **每个 pipeline 用例一份独立 clone**：`git clone --no-checkout <baseline> <case>/repo` + `checkout --detach <基线 commit>` + `git config core.autocrlf false`。7 MB/份、亚秒级，所以并发不需要共享仓库、不需要加锁。
- **互不干扰的原因**：harness 会建候选分支与 worktree，那些操作全部发生在 clone 内部；`libuv/` 这份基线检出永远干净（跑完 `git -C libuv status` 仍为空）。
- **语料（corpus）用例共用一份检出**：它们不改仓库，只需要一份构建产物；构建命令与预置 BuildWorkflow 逐字相同（GCC 15 的两个 `-Wno-error` 必须带）。
- **session root 也是每例一份**：`runs/suite-…/<case>/`，因此 `log_dir`、`artifacts/`、`run.jsonl` 全部按用例分开。
- 默认**跑完删 clone**（省掉每例约 100 MB 的构建产物），产物先转移到 `<case>/`：writer 用例写出的 workflow 源会被复制到 `<case>/written/`，失败归因所需的比较结果本来就在 `<case>/.refactor/e2e/<session>/artifacts/` 里。要保留现场就加 `--keep-clones`。

## 6. 结果与证据

运行结束打印汇总表，同时落盘：

```text
runs/suite-<时间戳>/
├─ summary.json                 全部用例：状态、每条检查、观测值、rubric 评分、artifact 路径
├─ calibration.json             （--calibrate）观测到的状态与失配集，用于冻结期望
└─ <case-id>/
   ├─ pipeline.json             这一例实际用的阶段来源（= 证据的一部分）
   ├─ run-result.json           harness 摘要 + 失配声明 + 退出码 + clone/日志路径
   ├─ harness.stdout.txt / harness.stderr.txt
   ├─ rubric-prompt.md          裁判输入（rubric + 候选产物 + 隐藏参考答案）
   ├─ rubric.json               （--rubric-cmd）打分与逐条理由
   ├─ part-result.json          （corpus）逐用例分类
   ├─ written/                  （writer）模型写出的 workflow 源副本
   └─ .refactor/e2e/<session>/  harness 的全部 artifact（比较结果、两侧构建、会话日志）
```

判定的可复核入口是 `summary.json` 里每条检查的 `detail`：例如 `attribution-required: missing: oracle_inet.exit (observed 3: …)`。

## 7. 三种评价方法的判据

- **verdict**：`state` 必须等于期望；harness 退出码必须与状态一致（ACCEPTED→0，其余→1）；`injected_stages`（若声明）必须集合相等；`verification_authoritative`（若声明）必须相等；`requireFiles` 的文件必须真实存在。
  - `injected_stages` 的语义是 **"这一阶段的来源被配置改写成非默认实现"**；`mode: "ai"` 是内置默认，**不算注入**。所以：判据自测（preset + patch）= `[workflows, refactor]`；重构档（preset + ai）= `[workflows]`；writer 档（ai + patch）= `[refactor]`；e2e（ai + ai）= `[]`。这正好是每类用例"证明自己确实按设计跑"的方式（writer 档看到 `refactor` 被注入、`workflows` 没有，就说明判据确实是模型写的）。
- **verdict + attribution**（同一实现，多两条）：`failuresRequired ⊆ 实际失配集`，`failuresForbidden ∩ 实际失配集 = ∅`。`failuresExact` 只有在校准冻结之后才填；`--calibrate` 下归因不作为失败依据，只记录。
- **part**：`strict` 部分要求每条 `stable-ok`（exit 0 且 TAP 行符合期望）；`calibrate` 部分只要求分类完成且无 `error`，分类结果本身是产出。

### 7.1 裁判分默认只报告，不判死活

实测：同一份写好的判据，两次裁判调用给出 **0.83** 和 **0.71**（另一份稳定在 0.61）。LLM 评分本身有方差，若把 `--rubric-min` 默认设成 0.7，就等于让掷硬币决定用例成败。

所以默认行为是：**裁判分记录在 `rubric.json` / `summary.json` 里，不影响 pass/fail**；要把它当门槛时才显式给 `--rubric-min <score>`（此时低于阈值判失败）。比较"哪个配置写判据写得好"应该比**多次调用的中位数**，不要比单次分数。

## 8. 加一个用例

1. 需要新补丁 → 在 scratch worktree 里改文件、`git diff` 出 patch，放进 `libuv/refactor-task/patches/`，提交进基线（记录新 SHA）。
2. 在 `testset/suite.json` 的 `cases` 里加一条：`id` / `subject` / `tags` / `task` / `stages` / `expect`。
3. `bun testset/run.ts --dry-run --only <id>` 看它要做什么；`--list` 确认选择生效。
4. 先 `--calibrate` 跑一次，用 `calibration.json` 里的观测值把 `failuresRequired` 冻成具体集合，并把 `provisional` 改成 `false`。
5. 新语料部分 → 在 `testset/parts/` 加 JSON（`policy.kind` 用 `calibrate`），跑几次确认分类稳定后再考虑升进判据（见 §9）。

## 10. 首次实测校准（2026-09-15）

`judgement-*` 10 条用例第一次真跑（离线、零模型调用、concurrency 2）。判定与**实测冻结**的失配集：

| 用例 | 候选补丁 | 判定 | 失配声明（实测，已冻结为 `failuresExact`） |
|---|---|---|---|
| `judgement-accept-comment` | 仅加注释 | ACCEPTED | 0 条 |
| `judgement-reject-strtok` | 丢弃空/尾 token | REJECTED | `oracle_strtok.exit` / `.summary` / `.stdout` |
| `judgement-mutant-strscpy` | `n==0` 返回 `UV_E2BIG` | REJECTED | **`strscpy.exit` / `.tap` / `.stdout`** + `oracle_strscpy` 三条 |
| `judgement-mutant-inet` | 单零组也被压缩 | REJECTED | `oracle_inet.exit` / `.summary` / `.stdout` |
| `judgement-mutant-getters` | UDP 队列两访问器互换字段 | REJECTED | `oracle_getters.exit` / `.summary` / `.stdout` |
| `judgement-mutant-version` | `uv_version()` 常量被改 | REJECTED | `oracle_version.exit` / `.summary` / `.stdout` |
| `judgement-mutant-errstr` | 未知码措辞被改 | REJECTED | `oracle_errstr.exit` / `.summary` / `.stdout` |
| `judgement-tamper-tests` | 弱化 `test/**` 断言 | REJECTED | `test/test-strtok.c.digest` / `.snapshot` |
| `judgement-tamper-oracle` | 改 oracle 源 | REJECTED | `oracle.sources.digest` / `.snapshot` + `oracle_strtok.stdout` |
| `judgement-tamper-drop-case` | 从 `test-list.h` 删用例 | REJECTED | `test/test-list.h.digest` / `.snapshot` + `strtok.exit` / `.tap` / `.stdout` |

两条结论（实测，不是推断）：

1. **"上游失明、oracle 兜住"被量化确认**：5 个行为变异里 4 个（inet / getters / version / errstr）上游那 42 条声明**全绿**，只有 oracle 层抓到——`docs/02` §9 的单点实验在真实管线上复现。
2. **strscpy 是例外，也是校准的价值**：我预测"只有 oracle 抓"，实测上游也抓（`n==0` 在上游用例里有覆盖，与 `docs/01` 的缺口清单一致）。若不校准，这条用例的说明会一直挂着错误声明。

`--freeze <运行目录>` 把观测值写回 `suite.json`：`provisional: false` + `failuresExact`（精确集合，此后归因漂移也会被发现）。**状态与期望不符的用例会拒绝冻结并单列出来**——`judgement-tamper-tests` 那次 ABORTED 就是这样被挡住的（读的是每例的 `run-result.json`，所以被中断的批次也能校准）。

### 10.1 一次环境抖动：判据保持 fail-closed（不改）

`judgement-tamper-tests` 首跑是 **ABORTED**：baseline 侧构建成功，5.7 s 后 test workflow 就失败，`run.jsonl` 只留下 `workflow verification aborted`。复现同一用例 → REJECTED、2 条失配（正是 `.digest` / `.snapshot`）——**判据没坏**，是本机出现过"产物在构建成功后消失"的抖动（build 阶段自己也遇到过并记在 `build-workflow.ts` 的注释里）。

处理方式是**什么都不改**：

1. 判据侧 `assertFile` 抛错是**正确的 fail-closed**：产物缺失就不该判卷。若在判据里"缺了就重建"，构建阶段真的没产出产物也会被悄悄修好再判过——那是 **fail-open**。
2. 产物是 **build 阶段**的产出，守卫属于那一层（`build-workflow.ts` 已有幂等重建与断言）；判据阶段只判卷，不修东西。
3. 这台机器上的抖动不该写进被 pin 的判据本体——它的摘要是证据链的一部分。

曾短暂加过"判据内重建"又撤销（基线 `7b00a02` → 撤销提交 `5262632`），`test-workflow.ts` 摘要回到 `738664b0…`。证据链说明：`runs/verify-judgement`（10/10）跑在 `7b00a02` 上，唯一差异是那段已撤销的守卫，98 条声明与期望未变；`runs/calib-*` 跑在 `5e2d240` 上。

真正该修的是 harness 侧的**诊断缺失**（与机器无关）：`orch.abort(reason)` 的原因没有落进 `run.jsonl` / `state.json`，abort 现场只剩一句无原因的 `workflow verification aborted`，排查只能靠复现。

### 10.3 重构目标 T2 / T4 / T5 / T6：首批实测

判据一字未改（98 条声明），只把 `refactor` 槽换回 AI 会话（4 个目标，`--concurrency 2`，墙钟 9m35s）：

| 用例 | 判定 | 失配 | 改动文件 | 墙钟 | 候选做了什么 |
|---|---|---|---|---|---|
| `refactor-t2-strscpy` | ACCEPTED | 0 | `src/strscpy.c` | 3m20s | 抽出 `static uv__strscpy_truncated(d, n)`，合并 `n==0` 早退与截断收尾 |
| `refactor-t4-errstr` | ACCEPTED | 0 | `src/uv-common.c` | 5m05s | 把四个近似重复的宏展开合并成一个查找辅助 + `snprintf` 兜底 |
| `refactor-t5-getters` | ACCEPTED | 0 | `src/uv-data-getter-setters.c` | 6m12s | 类型名 `switch` 改表驱动，24 个 `UV_EXTERN` 访问器签名不变 |
| `refactor-t6-version`（控制任务） | ACCEPTED | 0 | `src/version.c` | 3m32s | 重排 `UV_STRINGIFY` 辅助宏，版本常量未动 |

两侧构建均 pass。到这一轮为止，**T1–T6 六个目标全部 ACCEPTED**，同一套判据、零失配。

一个教训（值得写下来，因为踩了两次）：`expect.injectedStages` 我一开始写成"配置里出现过的阶段"，于是四个重构档全被判"失败"——实际语义是 **非默认实现才算注入**，`mode:"ai"` 是默认因而不计。runner 把"期望与观测不符"直接暴露出来，而不是悄悄放过，这正是它该做的；修期望之后用 `--reevaluate` 重判已有结果（零模型成本），4/4 通过。

### 10.4 writer 档（M2）：首批实测

5 个用例（`--concurrency 2`，墙钟 51m，含裁判调用）：

| 用例 | 程序化判定 | 实测 | 裁判分（advisory） |
|---|---|---|---|
| `writer-good-material` | 好补丁必须 ACCEPTED | **ACCEPTED**，0 失配 | 0.78 → 补全材料后 **0.77** |
| `writer-evil-material` | 坏补丁必须 REJECTED | **REJECTED**，失配 `oracle_inet.{exit,summary,transcript}` | 0.88 → **0.95** |
| `writer-good-hidden` | 好补丁必须 ACCEPTED（隐藏参考实现与 oracle） | **ACCEPTED**，0 失配 | 0.91 → **0.94** |
| `writer-evil-hidden` | 坏补丁必须 REJECTED（同上隐藏） | **REJECTED**，14 条失配 | 0.86 → **0.96** |
| `e2e-t1-full` | 端到端 ACCEPTED | 首测 **ABORTED**（宿主误判，见下）→ 重测 **ACCEPTED** | 0.40 → **0.70** |

**程序化半场 4/4 通过**，包括最难的 hidden 档：模型在看不见参考实现与 oracle 的条件下自己写了 build/test workflow，覆盖 `uv_inet_ntop` 的单零组不压缩（first / middle / last）、缓冲区恰好装下、以及 `size-20` 被拒，每条还额外声明了一个 `.stable` 孪生项做稳定性检查；它抓到了注入的 inet 变异（14 条失配），且没有误杀同一文件上的注释级改动。

`e2e-t1-full` 的 ABORTED **曾经被我判成"能力发现"，是错的**。复核现场（`run.jsonl` 最后三行 + 会话产物）后确认：宿主策略正则把源码里的一句注释
`// Layer C — the behaviour oracles, per process.` 当成 `process.` 访问，于是拒绝了一份**本来合法**的 test workflow，运行在构建前 abort。
也就是说这条链上翻车的不是模型，而是**宿主校验器**——真 import 一行都没有（`written/.../test-workflow.ts` 里全文无 `import`）。

修法（已提交到 harness，`8dc2156`）：
1. **校验前先做词法遮蔽**：注释、字符串/模板正文、正则字面量替换成等长空白，模板插值 `${...}` 仍按代码检查；
   import 判定改为"说明符必须开在词法看到的字面量位置"，因此注释/字符串里的同样文字不会再命中（位置、行号、列号一并报出）；
2. **违规不再是终局**：宿主带着"文件 + 行 + 列 + 片段"开一次**修复会话**让写作方改（`stages.policyRepairs`，默认 1 次），改完重新校验；
   只有重写能修好的失败才走这条路，哈希不匹配/文件缺失照样直接失败；
3. **abort 的原因一定落盘**：`run.jsonl` 多一条 `event: "abort"`，运行快照多一个 `state.json.abort_reason`
   （原因是会话历史里 `ABORTED` 迁移上的那条 note，所以连不经日志的直调路径也有记录）。

复核证据：把**当次 abort 的那份产物**重新喂给修好的校验器 → `ok: true`（改前会被拒）；`bun test` 153 pass / 0 fail（新增 16 条：策略边界 12、修复循环 4）。

裁判分的方差在同一批里也能看到（0.94 vs 0.78、0.91 vs 0.86），所以 §7.1 的结论成立：分数是参考区间，不是判生死阈值。

裁判输出之外，材料本身也修了一处缺口：`writerArtifacts()` 找候选 build workflow 的目录写错了（找 `.refactor/workflows/build-workflows`，
真实落盘在 `<…>/runs/<session>/workflows/build/*.ts`），于是裁判看到的永远是 `(none persisted)`。
`e2e-t1-full` 那次裁判给 0.40 并把"build workflow 缺失"列为阻断性缺陷——**那是工具没喂给它**，不是候选的问题；
`writer-*` 四例的分数同样建立在不完整材料上。已修（复核：历史产物里两条 build workflow 都能被找到），
重判走 `--reevaluate`（不重跑管线）：四例重判后 0.77 / 0.95 / 0.94 / 0.96（程序化判定不变，仍 4/4）——补上材料之后，坏补丁的两例分数明显上升（0.88→0.95、0.86→0.96），说明旧分数被"看不见 build workflow"压低了。

裁判输出的健壮性也补了三层：严格 JSON → 修复（转义内层引号/裸换行、去尾逗号）→ 字段抢救（括号不匹配时用正则捞 `score`/`criteria`/`summary`），并在 detail 里标注解析质量（`how=json|repaired|salvaged`）。这一批四个用例的输出三种情况都出现过。

### 10.5 e2e 重测：修好校验器之后通过

同一用例 `e2e-t1-full`，在源策略修好、`writerArtifacts()` 修好之后重跑（`runs/e2e-t1-fixed`，`--concurrency 1`）：

| 项 | 结果 |
|---|---|
| 程序化判定 | **ACCEPTED**（`comparison.overall = consistent`，`mismatches = 0`，`comparisonErrors = []`） |
| 两侧构建 | baseline / candidate 均 `pass` |
| 模型自写的判据 | 9 条声明（build workflow + test workflow 都由模型从零写） |
| 管线耗时 | 10m10s（测试写手会话 7m40s + 重构会话 1m + 验证 1m22s），含裁判 11m44s |
| 裁判分（advisory） | 0.70（同一材料上次只有 0.40，因为工具没把 build workflow 喂给裁判） |

这次运行也是三条修复的联合验证：源策略没有再误杀（写手会话产出直接通过校验），
管线走完了构建与两侧验证，`state.json.abort_reason` 一路为 `null`（没有 abort）。

---

## 8.1 吞吐：`--build-cache` 与并发

**结论先说**：判定慢的原因不是判定，而是"每条用例都把两侧各编译一遍"（单例 2m38s 里 113s 是编译）。
编译树里的绝对路径决定了它**只能原地复用**（复制 CMake 缓存到别的目录会让 cmake 找不到源码），
所以缓存的做法是"让 worktree 活着"：每条用例的 worktree 换个原地重置，而不是删掉重建。

```bash
bun testset/run.ts --subject judgement --tag offline --concurrency 4 --build-cache
```

- 每个并发槽位一个持久目录 `runs/<批>/.cache/slot-<n>`：clone 与 `worktrees/{baseline,candidate}` 都住在里面，跨用例复用；
  每条用例的**证据**（`run-result.json`、`harness.*.txt`、`pipeline.json`、`written/`）仍然写在该用例自己的目录里。
- 用例之间靠重置保证隔离：clone 回到钉住的 commit（`checkout --detach` + `reset --hard` + `clean -fd`），
  worktree 由 harness 原地重置（`reset --hard` + `clean -fd -e build`，只保留 `build/`）。
- 只对 `judgement` / `refactor` 生效：writer / e2e 的构建配方是模型写的，热树会掩盖一份坏配方。

槽位默认落在 `<suiteRoot>/.cache/slot-<n>`（`--cache-dir` 可改），**跨批次存活**：只有第一批付冷构建的钱。
槽位里的 clone 若够不到当前钉住的 commit（基线被重建/改写），会自动重新 clone，不会拿着旧对象库硬跑。

实测（同一批 10 条 judgement，`--concurrency 2`，单机 Ryzen 9 7940H）：

| 模式 | 槽位首例（冷） | 之后的用例 | 整批墙钟 |
|---|---|---|---|
| 无缓存（默认） | 2m38s | 2m38s | 13m07s |
| `--build-cache` 第一批 | 3m06s | 46s | 6m18s |
| `--build-cache` 第二批起 | —— | **46s** | **3m55s** |

分档看差异来自哪：无缓存时每条用例 113s 花在两次编译上；缓存后热构建 182ms（产物逐字节一致），
剩下的 46s 是两侧跑判据（33s）+ 探测与准备。

**并发不是越高越好**（同一批实测）：`--concurrency 4` 反而更慢（6m36s）——
每个冷构建内部已经 `-j 8`，四个槽位同时冷启动把 16 个线程挤满，四条冷例各要 5m00s。
缓存让"每条用例"变小之后，槽位数只要覆盖冷启动那一波即可：**建议 2（最多 3）**。

判据一条没松：两个批次都 10/10 通过，且**失配集合与无缓存时逐条一致**（3 / 6 / 3 / 3 / 3 / 3 / 2 / 3 / 5）——
热树没有掩盖任何一个变异体（改一个 TU 后增量重建 1.7s，产物摘要随之改变，这一点在探针里单独量过）。

## 9. 语料部分与判据的关系

`parts/*.json` 是**备选语料**，不等于判据。当前判据（`libuv/refactor-task/workflows/test-workflow.ts`，98 条声明）只用 14 条纯函数用例 + 6 个 oracle。把 loop/thread/util 里的条目升进判据要满足：

1. `calibrate` 在多轮运行里对每条都给出 `stable-ok`，且输出与 `PINS.json` 的期望一致；
2. 该条目的耗时与失败模式可解释（例如线程用例不能因为机器负载高就 flaky）；
3. 增加声明后同步更新 `PINS.json`、`testset/libuv-testset.json`，并重跑一次 `judgement-*` 用例确认判据本身仍自洽。

在那之前，它们以 `corpus-*` 用例的形式存在：跑起来、看得见分类，但不参与任何 ACCEPT/REJECT 判定。
