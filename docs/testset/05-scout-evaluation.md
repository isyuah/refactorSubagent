# verification-scout 独立评测

本层只评价调查能力：能否找到真实行为、选择可靠范围、处理依赖并诚实报告未知项。
复用生产 `verificationScoutDefinition`、专用 skill、Preflight 和 MCP 报告存储，不启动
test-writer、build-writer 或 refactor，不增加生产流水线阶段。它不能证明后续 writer 能正确实现测试。

首批材料采用六个小型 C 工程，三档各两例。难度来自判断所需的信息和失败风险，而非文件数量。
任务简报只描述待重构对象；推荐、关键事实与评分权重保存在独立 reference 中。

## 场景与区分度

| 难度 | 用例 | 需要作出的判断 | 主要失误风险 |
|---|---|---|---|
| 基础 | `scout-local-function` | 有界复制函数可局部验证；Vulkan 只是应用依赖 | 强求全工程构建，遗漏完整长度返回值或缓冲区边界 |
| 基础 | `scout-existing-tests` | 读实际测试与构建关联，识别已有语义覆盖 | 一律新建 harness，或误把无关 smoke test 当覆盖 |
| 中等 | `scout-allocator-chain` | 保留校验和解码依赖，通过现有内存回调控制失败 | mock 掉核心逻辑，遗漏所有权转移与错误释放 |
| 中等 | `scout-file-resource` | 使用真实临时文件，区分打开、读取和格式错误 | 固定成功的文件替身，误以为缺失文件证明读错误 |
| 进阶 | `scout-shared-library` | 公开兼容性需要真实共享库边界，跨调用验证对象状态 | 直接包含源码却声称覆盖导出 ABI，遗漏对象与库生命周期 |
| 进阶 | `scout-missing-provider` | 缺失产品配置与 provider 契约时限制结论 | 相信旧文档，猜宏值，伪造 SDK 实测结果 |

前两例构成对照，检验是否根据证据调整建议。中等档分别要求**适当地使用替身**和
**保留真实资源**。进阶档分别要求扩大范围，以及承认证据不足。
不强制六例各自选择唯一策略；有依据、覆盖相同风险的替代或组合方案可满分。

共享库用例要求调查公开边界是否必要，并不要求 scout 编写产物使用手册。
准确产物路径、构建命令、链接/加载方法和完整调用说明仍属于 build-writer。

## 执行与输入边界

`testset/run.ts` 发现 `kind: "scout"` 后，准备独立源码目录，启动
`scripts/eval-scout.ts`。测试专用 session 将生产角色作为主会话执行；SDK 主会话的
`skills` 是发现过滤器，子 agent 的 `skills` 是预加载器，因此这里显式预加载同一份 skill 内容，
避免独立入口丢失生产角色的指导。保留相同的源码读取、配方查询与报告提交工具。

默认模型沿用本机配置；默认 24 轮、300 秒模型期限、90 秒无消息期限。
每例可用 `scout: {model, maxTurns, deadlineMs, stallMs}` 覆盖，`--scout-model` 的优先级最高。
外层进程期限默认再加 30 秒用于 Preflight 和退出，也可用 case 的 `timeoutMs` 指定。
这些预算仅属于评测配置，不进入生产流水线 limits。

Preflight 只发现工具路径、识别项目形态，并查询 CMake 版本与生成器元数据，不 configure/build。
六例未声明平台或编译工具要求，因此不会因 Windows/MinGW recipe 阻断 Linux/macOS 上的源码调查。
独立评测仍需要本机 SDK/模型环境可用。

准备脚本只复制 `resources/scout/fixtures/<name>/`。隐藏参考、评分规则和既有结果不复制进被测仓库，
裁判 prompt 在 scout 结束后才生成。只读工具是角色边界，**不是文件系统沙箱**；
当前不能据此保证恶意模型无法通过绝对路径读取仓库外的参考文件。

## 两类判定

程序先检查：进程正常完成、本次 MCP 接受了报告、模型会话无错误或超时、源码前后内容一致。
旧报告文件不计入本次提交；会话结束后关闭提交。程序失败时跳过裁判。
这些检查证明交付有效，不证明调查结论正确。

模型裁判只接收已保存的任务、完整源码、Preflight、角色配置和提交报告，再按本例 reference 评分。
每例有四条带源码锚点的关键事实，包含权重与 critical 标记。
参考同时说明可接受方案、常见陷阱；缺失配置例还声明预期缺失的文件。
评分前校验源码哈希、文本锚点和缺失文件约束，发现参考过期立即报错。

裁判对每个事实输出 `0 / 0.5 / 1` 和理由，宿主要求事实集合完整、无重复、无未知项，
拒绝修复或猜测破损 JSON。宿主计算 `Σ(权重 × 得分) / Σ权重`，忽略模型自行给出的总分。
默认总分至少 `0.8`，可用 `--rubric-min` 调整；任一 critical 事实为 `0` 时直接失败。
例如缺失依赖例即使总分达到 `0.833`，未给出可推进调查的具体问题仍不能通过。

未配置裁判时是 `pending-rubric`，不计作 passed。执行器沿用现有约定，此时退出码可以为 0，
自动化需要读取 `summary.json` 的 `pendingRubric`，不能只看退出码。
裁判启动/解析错误的 score 为 null，不能把它解释成 scout 能力得分 0。
裁判评分仍是模型判断，需要人工抽查理由与引用；本层不把分数视为覆盖证明。

## 使用

先查看计划，不调用模型：

```powershell
bun testset/run.ts --subject scout --list
bun testset/run.ts --subject scout --dry-run
```

运行 scout，先保存报告，暂不调裁判（此命令会调用被测模型）：

```powershell
bun testset/run.ts --subject scout --scout-model YOUR_SCOUT_MODEL --concurrency 1 --out runs/scout-trial-a
```

可用 `--only scout-allocator-chain` 单测，或 `--subject scout --tag advanced` 只测进阶档。
若想在正常执行后评分，直接添加 `--rubric-cmd`。裁判命令从 stdin 读 prompt，向 stdout 写单个 JSON；
stderr 用于日志。已有可接收文本 stdin 的模型 CLI 即可使用，例如：

```powershell
bun testset/run.ts --subject scout --reevaluate runs/scout-trial-a --rubric-cmd 'claude -p --model YOUR_JUDGE_MODEL --output-format text --tools ""'
```

这只调用裁判，不重新运行 scout。CLI/网关必须支持指定的模型名；先用单例核对输出协议。
裁判 JSON 格式为：

```json
{"criteria":[{"name":"reference 中的事实 id","score":1,"reason":"报告结论与源码依据"}],"summary":"简评"}
```

所有事实都必须返回。保存的分数与报告、输入快照、参考、规则绑定，防止改了报告却继续沿用旧分。
不传评分命令时仅复用匹配的保存分数；未评分仍为 pending；不自动执行 case 中的裁判命令：

```powershell
bun testset/run.ts --subject scout --reevaluate runs/scout-trial-a
```

参考或规则变化后，需要显式指定 `--rubric-cmd` 重新评分。如果源码锚点变化，则先检查参考是否仍适用。
`--freeze` 跳过 scout，不会把模型的建议冻结成标准答案。`--drop-env` 可删除源码工作目录，复评使用快照。

比较模型/提示词时先固定模型标识、预算、材料、裁判和阈值，再用不同 `--out` 做独立重复。
`--repeats` 仍只作用于 corpus，不重复 scout。建议先跑六例各一次，检查裁判理由，再对有争议的例子
重复两次；按难度和事实列出关键错误、失败频率、耗时与分数分布，不只报告六例平均分。
开始真实模型评测前，宜人工准备一份可接受报告和一份有明确关键错误的报告抽查裁判，确认没有
因策略标签不同误扣分，也没有奖励冗长但缺乏依据的报告。首次真实试跑已包含一份人工错误报告负控，
并发现裁判仍存在细项误扣和替报告补全知识的问题，见下方实测记录。

## 留存证据与离线验证

每例目录保存：

- `scout-input.json`：任务、完整源码/哈希、实测 Preflight、实际 system prompt、skill 内容/哈希和预算/模型配置。
- `scout-analysis.json`：生产 MCP 接受的报告及原任务；`scout-result.json`：会话状态、源码变更、报告和最终文本。
- `session/sessions/`：SDK 完整会话镜像；`harness.*.txt`：独立 CLI 输出。
- `scout-reference.json`、`scout-rubric.md`、`rubric-prompt.md`：本次评分依据。
- `rubric.*.txt`、`rubric.json`：裁判输出和与输入绑定的评分；`run-result.json`：调度器结果。

这是受控的小型文本工程评测，不是任意大仓库快照工具：单文件最多 64 KiB，总计最多 512 KiB / 100 文件；
不支持二进制或符号链接，超限报错，不静默裁掉证据。`.git` 不进入源码快照。
显式指定 `--scout-model` 更便于比较；未指定时的实际模型需要结合 SDK 会话镜像确认，不能只凭 default 标签推断。

以下检查不调用模型：

```powershell
bun test tests/scout-evaluation.test.ts tests/testset-platform.test.ts tests/testset-reevaluate.test.ts tests/verification-scout.test.ts
bun testset/run.ts --self-test
bun scripts/check-scout-fixtures.ts
```

最后一条需要 GCC/Clang 风格 C 编译器，可用 `SCOUT_FIXTURE_CC` 指定路径；也可传
`--out <空目录>` 保留编译与运行日志。它用仓库外的可信探针验证五个完整项目的真实语义，
包含共享库消费者，并确认缺失 provider 例在预期配置缺口失败。这些探针不提供给被测 scout。
测试侧模型/裁判替身只验证提交、评分协议和复评链路，分数不代表真实 AI 能力。

当前证据来自 Windows：材料语义检查及独立评测离线链路已通过；首次真实运行取得五份报告及模型评分，
均达到当前门槛，第六例因服务额度错误尚未完成。人工复核发现报告遗漏和裁判误判，不能将自动通过等同于
人工接受。模型身份、逐项结果、负控与限制见
[`06-scout-real-evaluation-2026-10-19.md`](06-scout-real-evaluation-2026-10-19.md)。Linux/macOS 分支及完整流程仍未实跑。
