# 测试套件与并行执行器（suite / runner）

> 面向读者：要跑评估、要加用例、要看结果的人。
> 术语：**判据**（英文标识一律用 `judgement`）指判定行为是否保持的那套东西——`testset/resources/workflows/judgement/` 的 workflow + harness 的比较引擎；
> **裁判**（标识用 `rubric`）指给"模型写出的判据"打分的外部评分者（测试侧工具，不在 harness 里）。两者在代码里不再共用同一个词：判据=`judgement`，裁判=`rubric`。

> 相关文档：`01-refactor-targets.md`（重构目标）、`02-testset-requirements.md`（判据需求与实测）、`04-rubric.md`（裁判评分标准）。

## 1. 为什么需要这一层

逐条手工评估只能回答单条结论；要回答"哪个模型/哪份配置更好"就必须能**一次跑一批、选择性地跑、并排看结果**，而且不同性质的东西不能用同一种判法：

| 被测对象 | 在测什么 | 评价方法 | 为什么不能统一 |
|---|---|---|---|
| `judgement` | 判据本体会不会判卷 | 程序化：状态 + **失配声明归因** | 只看 ACCEPT/REJECT 无法区分"判对了"和"恰好判对了" |
| `refactor` | 模型改代码的能力 | 程序化：状态 + 声明一致性 | 判据已冻结，判据本身不是被测对象 |
| `writer` | 模型写 build/test workflow 的能力 | 程序化（注入已知好坏补丁）+ **裁判 rubric** | "判据有没有牙齿"能程序化，"写得是否完整/可维护"不能 |
| `e2e` | 端到端闭环 | 程序化 + 裁判评述 | 判定来自模型自己写的判据，必须有人看它写了什么 |
| `corpus` | 测试语料本身能不能用 | strict：逐条必须通过；calibrate：只做稳定分类 | 时序/环境敏感的用例不该被"一次跑必须过"误杀 |

这正是按对象选择评价方法的落地：**评价方法是 suite 里每个用例的字段**（`expect.method`），不是全局设置。

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
└─ baseline/             基线说明（原 overlay 已废弃）
```

`case.json` 的 `stages` 与 harness 的 `--pipeline-file` 是**同一种格式**；runner 把资源引用
（`{"mode":"preset","resource":"workflows/judgement"}`）展开成绝对路径后写进 `runs/…/<case>/pipeline.json`。

## 3. 用例模型

每个用例一个目录，配置放在 `case.json`（schema 见 `runner/suite.ts`）：

| 字段 | 作用 |
|---|---|
| `id` / `title` / `subject` / `tags` | 选择与显示 |
| `requires.platforms` | 可选的平台列表（如 `["win32", "linux"]`），任意一项匹配即可；未声明或空列表不限平台 |
| `requires.tools` / `requires.recipe` | 平台匹配后仍须满足全部工具和配方；探测不过 → **blocked**（跳过，不执行；`--strict-env` 时按失败计） |
| `prepare` | 环境脚本（默认 `prepare.ts`，`null` = 不需要）；拿一个目录，在里面准备环境 |
| `repo` | harness 该在环境目录的哪里跑（默认 `.`） |
| `task` | 任务简报路径（默认 `resources/tasks/…`，`./x` 表示用例目录内） |
| `stages` | 阶段来源：`workflows`（`ai` 或 `preset`+`resource`）、`prepare`、`refactor`（`ai` / `patch` / `none`） |
| `inject` | 验证前才注入两侧 worktree 的判据材料（`source` → worktree 内 `dest`） |
| `limits` / `timeoutMs` | 传给 harness 的会话限制与用例超时（`sessions.<stage>.model` 可给某阶段指定模型名，如跑模型矩阵） |
| `expect` | 评价方法（`verdict` / `verdict+attribution` / `verdict+rubric` / `part`）与期望值 |
| `evaluate.command` | 可选评测命令（裁判），会被 `--rubric-cmd` 覆盖 |

当前 58 个用例（下表按能力分组，未逐条列出）：

| 用例 | 驱动 | 阶段来源 | 期望 |
|---|---|---|---|
| `judgement-accept-comment` | pipeline | preset + 行为保持补丁 | ACCEPTED，0 失配 |
| `judgement-accept-hard` | pipeline | `judgement-hard` + 行为保持补丁 | ACCEPTED：hard 基线和候选均通过，防止平台差异导致误拒绝 |
| `judgement-reject-strtok` | pipeline | preset + 破坏补丁 | REJECTED，必须命中 `oracle_strtok.*` |
| `judgement-mutant-{strscpy,inet,getters,version,errstr}` | pipeline | preset + 对应变异体 | REJECTED，必须命中 `oracle_<name>.*` |
| `judgement-tamper-tests` | pipeline | preset + 弱化 `test/**` 断言 | REJECTED，必须命中 `test/test-strtok.c.{digest,snapshot}` |
| `judgement-tamper-drop-case` | pipeline | preset + 从 `test-list.h` 删用例 | REJECTED，必须命中 `test/test-list.h.digest` + `strtok.exit` |
| `judgement-tamper-oracle` | pipeline | preset + 伪造 oracle 文件 | **ACCEPTED**：注入覆盖伪造件，`injection-replaced` 必须命中该路径 |
| `refactor-t1-strtok` … `refactor-t6-version` | pipeline | preset + **ai** | ACCEPTED，provenance = `[workflows]` |
| `refactor-t{2,3}-nohint` | pipeline | preset（同 T2/T3）+ **ai** | 难度对照：简报不给"必须保持"清单，实测仍 ACCEPTED |
| `refactor-h{1..7}-*` | pipeline | `workflows/judgement-hard` + **ai** | ACCEPTED（或失败 = 难度信号），判据含各自 oracle |
| `judgement-mutant-h{1..7}-*` | pipeline | `judgement-hard` + 对应变异体 | REJECTED，失配集中在 `oracle_*` |
| `judgement-accept-structural` | pipeline | `judgement-h8-structural` + 参考正解 patch | ACCEPTED：证明宿主接受"新增文件 + 改 CMakeLists"的多文件 patch |
| `refactor-h8-structural` | pipeline | `judgement-h8-structural` + **ai** | AI 自己做结构性重构，期望 ACCEPTED |
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
- **part**：`strict` 部分要求每条适用用例 `stable-ok`（exit 0 且 TAP 行符合期望）；`calibrate` 部分只要求分类完成且无 `error`，分类结果本身是产出。
  `cases` 中的字符串表示不限平台；对象形式 `{"name":"environment_creation","requires":{"platforms":["win32"]}}`
  使用同样的 OR 平台匹配规则。不适用条目及原因单独记录为 `skipped`，不参与行为分类；全部不适用时整例为 blocked。
- **blocked**：`requires` 不满足（或缺 prepare）→ 该用例不执行，`summary.json` 里 `status=blocked` 且带原因；默认不影响整批退出码，`--strict-env` 时才按失败计。全部选中用例都 blocked 时退出码 2。

### 7.1 裁判分默认只报告，不判死活

实测：同一份写好的判据，两次裁判调用给出 **0.83** 和 **0.71**（另一份稳定在 0.61）。LLM 评分本身有方差，若把 `--rubric-min` 默认设成 0.7，就等于让掷硬币决定用例成败。

所以默认行为是：**裁判分记录在 `rubric.stdout.txt` / `summary.json` 里，不影响 pass/fail**；要把它当门槛时才显式给 `--rubric-min <score>`（此时低于阈值判失败）。比较"哪个配置写判据写得好"应该比**多次调用的中位数**，不要比单次分数。

裁判 prompt 里带一节 `## Programmatic evidence`：宿主已执行的判定与比较结果（声明对数、`equal`/`both-matches` 直方图、失配清单），本用例钉住的候选改动则附上补丁全文；e2e 这类没钉补丁的用例会显式写明"这些证据不能用来评牙齿/覆盖"。裁判因此不必只靠读源码猜"判据到底抓没抓住"。

## 8. 加一个用例

1. **建目录**：`testset/cases/<id>/case.json` + `prepare.ts`（libuv 用例直接抄现成的一样：`cloneSource("libuv", { into: envDir() })`）。
2. **要新补丁**：在 scratch 检出里改文件、`git diff > testset/resources/patches/<name>.patch`，并在 `case.json` 里 `stages.refactor = {"mode":"patch","patchFile":"resources/patches/<name>.patch"}`（`git apply --check` 必须先过，工作区行尾是 LF）。
3. **要新材料**：放进 `resources/`（judge 材料放 `resources/judge/<项目>/` 并在 `inject` 里声明目标位置）。
4. **声明依赖**：可选的 `requires.platforms` + `requires.tools` + `requires.recipe`。公共 libuv 用例使用
   `libuv-ninja-debug`，按系统选择 Windows/MinGW 或 Linux/GCC；平台专属用例必须明确声明平台。
   显式配方 `win-mingw-ninja-debug` / `linux-gcc-ninja-debug` 同样可用；缺依赖时用例应当是 blocked 而不是红。
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
  `--force` 只删 runner 自己写的文件，目录里出现异物时仍然拒绝。这条由实际运行中的目录污染问题确认。
- **ai 档的已知例外**：`workflows: ai` 时写出的 build/test workflow 落在**环境仓库内**
  （`<env>/.refactor/runs/<session>/workflows/**`），同一个工作区里随后启动的重构会话能读到它；
  `preset` + 验证前注入的档则读不到（注入发生在候选提交之后）。两个档的可见性目前并不一致。
- 边界要说清：会话有 shell，所以"看不见"是**工作区级的卫生**，不是安全边界（平台级隔离仍未做，
  见 `PROJECT_STATUS.md` §9.1）。它挡住的是"顺手读到/顺手改掉"，不是"蓄意在磁盘上翻找"。

## 9. 语料部分与判据的关系

`resources/parts/*.json` 是**备选语料**，不等于判据。当前判据（`resources/workflows/judgement/test-workflow.ts`，
98 条声明）只用 14 条纯函数用例 + 6 个 oracle。把 loop/thread/util 里的条目升进判据要满足：

1. `calibrate` 在多轮运行里对每条都给出 `stable-ok`，且输出与判据 workflow 的 `UPSTREAM_PINS` 期望一致；
2. 该条目的耗时与失败模式可解释（例如线程用例不能因为机器负载高就 flaky）；
3. 增加声明后同步更新对应 workflow 的 `ORACLE_PINS` / `UPSTREAM_PINS` 与用例的 `case.json` 期望，
   并重跑一次 `judgement-*` 用例确认判据本身仍自洽。

在那之前，它们以 `corpus-*` 用例的形式存在：跑起来、看得见分类，但不参与任何 ACCEPT/REJECT 判定。

---


## 10. H 档与已知坑

### 10.1 H 档的组织方式

- 判据资源每档一个独立目录：`workflows/judgement-hard/`（H1–H7，7 个 oracle + 5 条上游用例）与
  `workflows/judgement-h8-structural/`（结构性重构，6 个 oracle + 11 条上游用例）；旧的 `workflows/judgement` 不动。
- oracle 材料在 `resources/judge/libuv-1.52.1-hard/<target>/oracle_<name>.c`，逐目标注入到
  `refactor-task/oracle-hard/<target>/`；目录快照与 sha256 进各 workflow 的 `ORACLE_PINS`，改动只影响本档用例。
- 上游观测面只用 `parts/{loop,util}.json` 里已校准 stable-ok 且**快速失败**的条目：
  `error_message`、`env_vars`、`environment_creation`、`close_order`、`loop_backend_timeout`。
  可能挂起的用例（`run_once`、`loop_close`、`walk_handles`、`timer_run_once`、`idle_check` 等）不声明，
  相关语义由 oracle 覆盖。
- 用例成对出现：`refactor-h<k>-*`（AI 档，判定能力）与 `judgement-mutant-h<k>-*`
  （离线档，0 模型成本，证明 oracle 有牙）。
- 共享判据的代价：一个变异可能同时触发别的目标的 oracle，失配集按声明归因；
  `failuresRequired` 只钉住本目标的三件套。

### 10.2 上游 runner 在 Windows 上不杀超时用例

`libuv/test/runner.c` 在 `process_wait` 返回超时后假设子进程已被杀，但 Windows 的
`test/runner-win.c` 只返回 `WAIT_TIMEOUT`，不调用 `TerminateProcess`。挂起的子进程继续持有
runner 的 stdout/stderr 句柄，宿主的 `ctx.process.run` 等的是“进程结束 + 管道关闭”，于是会一直等到用例超时。

因此 H 档不选会挂起的上游用例，改由 oracle 覆盖相应语义。`oracle_loop` / `oracle_walk` 仍依赖被测事件循环，
任意事件循环变异不保证自行退出；H6 的变异已收敛为单一回调顺序错误，避免破坏资源回收时的等待条件。
