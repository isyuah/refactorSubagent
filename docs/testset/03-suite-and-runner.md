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
├─ run.ts                执行器入口：discovery → probe → gate → prepare → harness → evaluate
├─ runner/
│  ├─ suite.ts           case.json 的 schema（zod）、发现、选择、材料校验、资源解析
│  ├─ probe.ts           主机探测（工具/版本/Ninja 生成器/gcc flag 探针）与 requires 判定
│  ├─ env.ts             环境目录分配、执行 prepare 脚本、blocked 约定
│  ├─ case-api.ts        给 prepare.ts 用的助手（cloneSource / git / blocked）
│  ├─ drivers.ts         pipeline 驱动（harness CLI）与 upstream-part 驱动
│  ├─ evaluate.ts        评价方法（verdict / attribution / rubric / part / blocked）
│  ├─ rubric.ts          裁判：生成 prompt、调用外部命令、解析打分（测试侧，非 harness）
│  ├─ exec.ts            进程执行（超时 + 进程树终止）
│  ├─ display.ts         实时表格与结束汇总
│  └─ util.ts            JSON/路径/时间/终端
├─ cases/<id>/           用例目录：case.json + prepare.ts（+ 可选本地材料）
├─ resources/            共享内容：sources / workflows / patches / judge / tasks / parts
├─ subjects.json         subject 的显示说明
└─ baseline/             基线重建材料（overlay）
```

`case.json` 的 `stages` 与 harness 的 `--pipeline-file` 是**同一种格式**；runner 把资源引用
（`{"mode":"preset","resource":"workflows/judgement"}`）展开成绝对路径后写进 `runs/…/<case>/pipeline.json`。

## 3. 用例模型

每个用例一个目录，配置放在 `case.json`（schema 见 `runner/suite.ts`）：

| 字段 | 作用 |
|---|---|
| `id` / `title` / `subject` / `tags` | 选择与显示 |
| `requires.tools` / `requires.recipe` | 依赖声明：探测不过 → **blocked**（跳过，不执行；`--strict-env` 时按失败计） |
| `prepare` | 环境脚本（默认 `prepare.ts`，`null` = 不需要）；拿一个目录，在里面准备环境 |
| `repo` | harness 该在环境目录的哪里跑（默认 `.`） |
| `task` | 任务简报路径（默认 `resources/tasks/…`，`./x` 表示用例目录内） |
| `stages` | 阶段来源：`workflows`（`ai` 或 `preset`+`resource`）、`prepare`、`refactor`（`ai` / `patch` / `none`） |
| `inject` | 验证前才注入两侧 worktree 的判据材料（`source` → worktree 内 `dest`） |
| `limits` / `timeoutMs` | 传给 harness 的会话限制与用例超时（`sessions.<stage>.model` 可给某阶段指定模型名，如跑模型矩阵） |
| `expect` | 评价方法（`verdict` / `verdict+attribution` / `verdict+rubric` / `part`）与期望值 |
| `evaluate.command` | 可选评测命令（裁判），会被 `--rubric-cmd` 覆盖 |

当前 26 个用例：

| 用例 | 驱动 | 阶段来源 | 期望 |
|---|---|---|---|
| `judgement-accept-comment` | pipeline | preset + 行为保持补丁 | ACCEPTED，0 失配 |
| `judgement-reject-strtok` | pipeline | preset + 破坏补丁 | REJECTED，必须命中 `oracle_strtok.*` |
| `judgement-mutant-{strscpy,inet,getters,version,errstr}` | pipeline | preset + 对应变异体 | REJECTED，必须命中 `oracle_<name>.*` |
| `judgement-tamper-tests` | pipeline | preset + 弱化 `test/**` 断言 | REJECTED，必须命中 `test/test-strtok.c.{digest,snapshot}` |
| `judgement-tamper-drop-case` | pipeline | preset + 从 `test-list.h` 删用例 | REJECTED，必须命中 `test/test-list.h.digest` + `strtok.exit` |
| `judgement-tamper-oracle` | pipeline | preset + 伪造 oracle 文件 | **ACCEPTED**：注入覆盖伪造件，`injection-replaced` 必须命中该路径 |
| `refactor-t1-strtok` … `refactor-t6-version` | pipeline | preset + **ai** | ACCEPTED，provenance = `[workflows]` |
| `writer-{good,evil}-{material,hidden}` | pipeline | **ai** workflows + 已知补丁 | 好补丁 ACCEPTED / 坏补丁 REJECTED（全部用例都是盲的，见 §8.2） |
| `e2e-t1-full` / `e2e-t1-blind` | pipeline | ai workflows + ai refactor | 端到端，程序化 + 裁判；两条用例现在只差任务文本与期望 |
| `corpus-pure` | upstream-part | 环境里的检出 + 构建 | strict：14 条逐条 exit 0 + TAP |
| `corpus-{loop,thread,util}` | upstream-part | 同上 | calibrate：每条重复 N 次 → `stable-ok` / `stable-fail` / `flaky` / `error` |

`provisional: true` 的用例表示**期望值是推断的、尚未实测**；runner 会在 `--list` 里标出来，不会假装它是已验证事实。

## 4. 用法

```bash
cd E:/Proj/refactorSubagent

# 看有哪些用例（按 subject 分组；--json 给机器读）
bun testset/run.ts --list

# 只跑"判据本体"这一类，离线、不调模型
bun testset/run.ts --subject judgement --concurrency 2

# 精确选择 / 打标签选择 / 排除
bun testset/run.ts --only refactor-t1-strtok,refactor-t3-inet
bun testset/run.ts --tag offline
bun testset/run.ts --subject refactor --exclude unmeasured

# 先看会跑什么（不执行任何东西）
bun testset/run.ts --dry-run --subject writer

# 换一个 test set 根（默认 testset/）、跑完删环境、blocked 当失败
bun testset/run.ts --root <dir> --drop-env --strict-env

# 复用同一个 --out（重跑上一次没跑完的用例）：默认拒绝，--force 先清掉旧结果
bun testset/run.ts --only e2e-t1-blind --out runs/e2e-blind-3 --force

# 用已存结果重判（改期望之后，不必再花钱重跑）
bun testset/run.ts --reevaluate runs/capability-t2-t6

# 用实测失配集冻结期望（写回 cases/*/case.json）
bun testset/run.ts --freeze runs/<批>

# 校准：不把"归因不符"当失败，而是把观测到的失配集写进 calibration.json
bun testset/run.ts --subject judgement --calibrate --out runs/calib-judgement

# 语料部分：只看某几条上游用例，重复 5 次判断稳定性
bun testset/run.ts --only corpus-loop --part-filter loop_close --repeats 5

# writer 档接裁判（裁判是测试侧工具，不是 harness 功能）
bun testset/run.ts --subject writer --rubric-cmd "claude -p" --rubric-min 0.7

# 执行器自检（合成用例，不碰任何项目）
bun testset/run.ts --self-test
```

退出码：`0` 全部符合期望（blocked 不算失败）；`1` 有失败/错误；`2` 选择为空或材料缺失；`3` runner 自身异常。

## 5. 隔离与并行

- **每例一份环境**：`runs/<批>/<case>/env/`，每次运行前清空重建；用例的 prepare 脚本在里面把环境准备好
  （libuv 用例 = 从上游 tag 浅克隆，6.9 MB）。harness 的 worktree、构建产物、`.refactor/` 全在该目录内。
- **每例一份 session root**：`runs/<批>/<case>/session/`，`run.jsonl`、`artifacts/`、模型会话记录按用例分开。
- **并发是 worker 池**：默认 `cpu/4`（上限 4），`--concurrency` 覆盖。每例构建内部已经 `-j8`，
  16 线程机器上实测 2 个并发槽位最稳（并发越高冷构建互相挤压越严重）。
- **没有共享可变状态**：源材料只被读取（每次浅克隆），`libuv/` 检出不被触碰；用例之间不共享目录。
- **磁盘**：每例环境约 100 MB 级（检出 + 构建产物），默认保留作证据，`--drop-env` 可关。

## 6. 结果与证据

运行结束打印汇总表，同时落盘：

```text
runs/suite-<时间戳>/
├─ summary.json                 全部用例：状态、每条检查、观测值、probe 事实、rubric 评分、artifact 路径
├─ calibration.json             （--calibrate）观测到的状态与失配集，用于冻结期望
└─ <case-id>/
   ├─ prepare.json              环境准备结果（blocked 原因、exit code、耗时）
   ├─ prepare.stdout.txt / prepare.stderr.txt
   ├─ pipeline.json             这一例实际用的阶段来源（绝对路径 = 证据的一部分）
   ├─ run-result.json           harness 摘要 + 失配声明 + 退出码 + 环境/日志路径
   ├─ harness.stdout.txt / harness.stderr.txt
   ├─ rubric-prompt.md          裁判输入（rubric + 候选产物 + 隐藏参考答案）
   ├─ rubric.json               （--rubric-cmd）打分与逐条理由
   ├─ part-result.json          （corpus）逐用例分类
   ├─ env/                      环境目录（源检出 + 构建产物；--drop-env 时不保留）
   └─ session/.refactor/e2e/<session>/  harness 的全部 artifact（比较结果、两侧构建、会话日志、
                                 injections.json、run.jsonl）
```

判定的可复核入口是 `summary.json` 里每条检查的 `detail`：例如 `attribution-required: missing: oracle_inet.exit (observed 3: …)`。

## 7. 三种评价方法的判据

- **verdict**：`state` 必须等于期望；harness 退出码必须与状态一致（ACCEPTED→0，其余→1）；`injected_stages`（若声明）必须集合相等；`verification_authoritative`（若声明）必须相等；`requireFiles` 的文件必须真实存在（先按 session root 解析，其次按环境仓库）。
  - `injected_stages` 的语义是 **"这一阶段的来源被配置改写成非默认实现"**；`mode: "ai"` 是内置默认，**不算注入**。所以：判据自测（preset + patch）= `[workflows, refactor]`；重构档（preset + ai）= `[workflows]`；writer 档（ai + patch）= `[refactor]`；e2e（ai + ai）= `[]`。这正好是每类用例"证明自己确实按设计跑"的方式（writer 档看到 `refactor` 被注入、`workflows` 没有，就说明判据确实是模型写的）。
- **verdict + attribution**（同一实现，多两条）：`failuresRequired ⊆ 实际失配集`，`failuresForbidden ∩ 实际失配集 = ∅`。`failuresExact` 只有在校准冻结之后才填；`--calibrate` 下归因不作为失败依据，只记录。
- **injection-replaced**（声明了 `expect.replacedFiles` 时）：验证前注入时发现目标位置已有不同内容的文件 → 必须与声明的集合完全一致（这是"篡改被中和"的证据，见 §8.2）。
- **part**：`strict` 部分要求每条 `stable-ok`（exit 0 且 TAP 行符合期望）；`calibrate` 部分只要求分类完成且无 `error`，分类结果本身是产出。
- **blocked**：`requires` 不满足（或缺 prepare）→ 该用例不执行，`summary.json` 里 `status=blocked` 且带原因；默认不影响整批退出码，`--strict-env` 时才按失败计。全部选中用例都 blocked 时退出码 2。

### 7.1 裁判分默认只报告，不判死活

实测：同一份写好的判据，两次裁判调用给出 **0.83** 和 **0.71**（另一份稳定在 0.61）。LLM 评分本身有方差，若把 `--rubric-min` 默认设成 0.7，就等于让掷硬币决定用例成败。

所以默认行为是：**裁判分记录在 `rubric.stdout.txt` / `summary.json` 里，不影响 pass/fail**；要把它当门槛时才显式给 `--rubric-min <score>`（此时低于阈值判失败）。比较"哪个配置写判据写得好"应该比**多次调用的中位数**，不要比单次分数。

裁判 prompt 里带一节 `## Programmatic evidence`：宿主已执行的判定与比较结果（声明对数、`equal`/`both-matches` 直方图、失配清单），本用例钉住的候选改动则附上补丁全文；e2e 这类没钉补丁的用例会显式写明"这些证据不能用来评牙齿/覆盖"。裁判因此不必只靠读源码猜"判据到底抓没抓住"。

## 8. 加一个用例

1. **建目录**：`testset/cases/<id>/case.json` + `prepare.ts`（libuv 用例直接抄现成的一样：`cloneSource("libuv", { into: envDir() })`）。
2. **要新补丁**：在 scratch 检出里改文件、`git diff > testset/resources/patches/<name>.patch`，并在 `case.json` 里 `stages.refactor = {"mode":"patch","patchFile":"resources/patches/<name>.patch"}`（`git apply --check` 必须先过，工作区行尾是 LF）。
3. **要新材料**：放进 `resources/`（judge 材料放 `resources/judge/<项目>/` 并在 `inject` 里声明目标位置）。
4. **声明依赖**：`requires.tools` + `requires.recipe`（本机 recipe：`win-mingw-ninja-debug`）；缺依赖时用例应当是 blocked 而不是红。
5. **跑一次校准**：`--dry-run --only <id>` 看计划 → `--only <id> --calibrate --out runs/x` → `--freeze runs/x` 把实测失配集冻进 `case.json`（状态与期望不符时会被拒改并单列）。
6. **语料**：在 `resources/parts/` 加 JSON（`policy.kind` 用 `calibrate`），跑几次确认分类稳定后再考虑升进判据（见 §9）。

### 8.2 blind：判据材料不进环境，验证前才注入

这套测试集的默认可见性是 **"候选只看到准备好的环境"**：

- 环境由用例的 prepare 脚本从 `resources/sources/libuv.json` 的 pin **浅克隆**而来：只有上游 tag 那一个提交，
  **不含 overlay 历史**，也没有 `refactor-task/**`（oracle、补丁、判据 workflow、PINS 都不在里面）。
  本机有 `../libuv` 就地取；没有（新克隆的仓库）就用 pin 里的 `remote` 从上游 GitHub 拉，所以换机器不需要
  预置 `libuv/`。
- 判据 workflow 源与 oracle 都住在 `resources/`，通过 `case.json` 的 `inject` 声明目标位置（如
  `refactor-task/oracle`）。harness 在**候选提交之后、验证之前**把它们拷进 baseline / candidate
  两侧 worktree（`--inject <src>=<dest>`），并把逐文件 sha256 与"目标位置原本是否已有不同文件"
  记进 `<session>/artifacts/injections.json`。
- 因此：候选无法读到判据，也无法改写判据；即使它伪造一份同名文件放在注入目标位置，
  注入会覆盖它（`injection-replaced` 证据），判据本身仍是宿主提供的那一份。
- **输出目录不复用**：一次运行结束后，用例目录（`runs/<批>/<用例>/`）里会留下**裁判材料**
  （`rubric-prompt.md` 含 rubric 正文与隐藏参考要点）。它就在环境目录隔壁，而会话有 shell、
  会往上翻——所以 runner 默认拒绝在已有旧结果的目录上重跑（中止并提示 `--force`）；
  `--force` 只删 runner 自己写的文件，目录里出现异物时仍然拒绝。这条是 2026-09-18 实测踩出来的
  （见 §10.6）。
- **ai 档的已知例外**：`workflows: ai` 时写出的 build/test workflow 落在**环境仓库内**
  （`<env>/.refactor/runs/<session>/workflows/**`），同一个工作区里随后启动的重构会话能读到它；
  `preset` + 验证前注入的档则读不到（注入发生在候选提交之后）。两个档的可见性目前并不一致。
- 边界要说清：会话有 shell，所以"看不见"是**工作区级的卫生**，不是安全边界（平台级隔离仍未做，
  见 `PROJECT_STATUS.md` §9.1）。它挡住的是"顺手读到/顺手改掉"，不是"蓄意在磁盘上翻找"。

## 10. 首次实测校准（2026-09-15）

> **历史记录（旧执行器）**：以下各节的命令与路径属于重设计之前的执行器（`suite.json` + 每例 clone +
> `--build-cache`）。判定结论、失配集合与耗时数字仍是当次真实测量，保留作为证据；新执行器的对应做法见 §2–§8。

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

### 10.6 盲测 e2e（`e2e-t1-blind`，2026-09-17 新增）

`e2e-t1-full` 虽然叫端到端，但用例 clone 里**参考判据与 oracle 都在**（`clone.remove` 为空），模型可以照抄；
同时它的 `expect` 只写了 `method: "verdict+rubric"`、**没有 `rubric`/`reference` 字段**，所以裁判 prompt 的 `## Rubric` 段是 `(none)`、也没有参考实现清单——
0.40 / 0.70 那两个分数是在**没有评分标准**的情况下打出来的，与 writer 档（0.77–0.96）不可比。

本轮两处改动：

1. **新用例 `e2e-t1-blind`**：`clone.remove: ["refactor-task"]` + `commit: true`，即整个判据材料层（workflows / oracle / PINS / 补丁 / 简报）在会话开始前被删除并提交；任务只有 `tasks/e2e-blind.task.txt`。判据、构建流程、重构全部由模型自建，`expect.rubric` 指向 04-rubric.md 与 `../libuv/refactor-task/workflows`（对裁判可见、对候选不可见）。`--dry-run` 会打印 `hide refactor-task`。
2. **补上 `e2e-t1-full` 的 `expect.rubric`**：同一份标准 + 同一份参考，使它的分数今后可与 writer 档并列。

首跑记录（2026-09-17，`runs/suite-2026-09-17T13-15-39`）：用例材料检查、隐藏、管线启动均正常
（clone 的 HEAD 是 `suite: hide refactor-task (writer capability case)`，工作树内确无 `refactor-task/`），
但会话在 `WORKFLOW_SESSION` 阶段被模型服务方挡住而 ABORTED：

```text
"abort_reason": "Claude Code returned an error result: API Error: 400 You have insufficient credits to make this request. …"
```

耗时 8m13s，`declared_builds: []`、两侧构建与比较均未发生（fail-closed，没有伪造成通过）。
`expect.provisional` 保持 `true`——**这条用例目前仍未实测**；账户恢复额度后按下面的命令补跑并 `--freeze`：

```bash
bun testset/run.ts --only e2e-t1-blind --rubric-cmd "claude -p"
bun testset/run.ts --freeze runs/<该批次>        # 观测值写回 suite.json（provisional → false）
```

**补跑记录（2026-09-18，`runs/e2e-blind-3`）**：额度恢复后重跑，**通过**——`ACCEPTED`、0 失配、两侧构建
pass/pass、`verification_authoritative=true`、`injected_stages=[]`（判据确实由模型自建）。用例墙钟 19.5 min：
判据会话 12m24s、重构 3m18s、验证 72.5s、裁判 2m33s。产物是 1 个 build workflow + 32 条声明的 test workflow
（`--list` 清单 477 条 + FNV-1a 指纹、未知用例负控制 exit 255、逐用例 exit 与精确 `ok` 行）。

裁判 `claude -p` 给 **0.63**：牙齿 0.55 / 覆盖 0.35（任务点名的**空 token 家族**——相邻、前导/尾随、`...`→四空 token、
空串→一个空 token——完全没覆盖）/ 自锁 0.50（没 snapshot `test/**`，掏空断言不会被发现）；不误杀 0.85、
成对与差分 0.80、工程效率 0.85、可读性 0.90。期望已冻结（`provisional: false`）。

写判据的会话**全程盲**（transcript 里 `rubric|oracle|refactor-task` 零命中），所以 0.63 是有效的盲测分数；
但这次运行所在目录被上一次失败尝试污染过：重构会话读到了上一次遗留的 `rubric-prompt.md`（14 KB，含 rubric
正文与隐藏参考摘要）。因此现在 runner 拒绝复用脏输出目录——**"盲"是目录卫生问题，必须由工具强制，而不是靠人记得**。

---

## 8.1 吞吐：`--build-cache` 与并发（历史）

> `--build-cache` 槽位复用已随重设计移除（它与"每例自己准备环境"冲突）。当前并发模型见 §5；
> 下面的测量仍然说明瓶颈在哪：编译占单例耗时的大头（113s/158s），并发槽位不是越多越好。

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

`resources/parts/*.json` 是**备选语料**，不等于判据。当前判据（`resources/workflows/judgement/test-workflow.ts`，
98 条声明）只用 14 条纯函数用例 + 6 个 oracle。把 loop/thread/util 里的条目升进判据要满足：

1. `calibrate` 在多轮运行里对每条都给出 `stable-ok`，且输出与 `PINS.json` 的期望一致；
2. 该条目的耗时与失败模式可解释（例如线程用例不能因为机器负载高就 flaky）；
3. 增加声明后同步更新 `PINS.json`、`testset/libuv-testset.json`，并重跑一次 `judgement-*` 用例确认判据本身仍自洽。

在那之前，它们以 `corpus-*` 用例的形式存在：跑起来、看得见分类，但不参与任何 ACCEPT/REJECT 判定。
