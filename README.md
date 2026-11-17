# refactorSubagent

行为保持型 C 重构 harness：AI 在一次性 worktree 里改代码，宿主负责建构建/测试 workflow、
在 baseline 与 candidate 两侧执行并逐位置比较声明，只有行为一致才 ACCEPTED。

项目现状、架构与路线见 [`PROJECT_STATUS.md`](PROJECT_STATUS.md)。

## 目录

```text
refactorSubagent/
├─ src/                     harness 本体（状态机、阶段、能力代理、配置）
├─ shared/                  宿主与测试集共用的进程生命周期管理
├─ scripts/cli.ts           命令行入口（run / tests / preflight / workflow / limits / config）
├─ tests/                   harness 单元与离线 e2e 测试（bun test）
├─ docs/                    设计文档（stage-flow、limits、roadmap…）
│  └─ testset/              测试集文档（见下）
├─ testset/                 测试集：用例目录 + 共享资源 + 执行器（见 testset/README.md）
├─ libuv/                   源材料检出（不进版本，由用例的 prepare 脚本浅克隆使用）
├─ runs/                    每次运行的证据（不进版本，含每例的环境目录）
└─ half-week-report/        阶段性汇报页面
```

`libuv/`、`runs/` 都在 `.gitignore` 里：前者可由用例的 prepare 脚本从上游 tag 重建，
后者是当次运行的证据（含每例约 100MB 级的环境目录），随时可删。

## 快速开始（harness 本身）

```bash
bun install
bun run check                              # 类型检查 + 工程测试 + 执行器自检
bun run test:offline                        # 当前平台适用的离线用例，缺工具/配方会失败
bun run scripts/cli.ts preflight           # 探测主机与项目
bun run scripts/cli.ts run <repo> --task "<重构任务>" --session s1
bun run scripts/cli.ts limits <repo>       # 当前生效的超时/资源阈值及其来源
```

## 终端工作台与启动配置

交互终端默认使用 **OpenTUI**。测试准备、测试审阅和普通 `run` 共用一套工作台：
顶部切换分区，左侧选择项目，右侧独立滚动详情，底部显示可聚焦的操作按钮与当前状态。
支持键盘、鼠标、终端缩放和多行文本输入，Windows 与 Linux 使用同一份界面代码。
OpenTUI 的原生渲染层使用 Zig；使用本项目时由 Bun 安装对应平台的预编译包，无需另装 Zig。
项目 CI 使用 Bun 1.3.14；请先执行 `bun install`，不要在 Windows 和 Linux 间共用 `node_modules`。

```bash
# 无参数：选择全流程重构、准备测试或打开已有方案
bun scripts/cli.ts

# 缺少任务时进入配置向导；完整参数则直接开始
bun scripts/cli.ts run <repo>
bun scripts/cli.ts run <repo> --task "提取重复参数检查，保持行为不变"

# 即使已经有任务，也先编辑完整设置
bun scripts/cli.ts run <repo> --task "提取重复参数检查" --configure

# 强制普通文字；JSON、CI、重定向场景默认也使用普通模式
bun scripts/cli.ts run <repo> --task "..." --ui plain
```

配置向导可编辑仓库与任务、测试来源（AI、指定脚本或已保存方案）、候选分支来源、
重构来源（AI、补丁或已有候选）、多个构建、模型、全部现有限制、反馈次数、恢复会话、
结果/工作目录、注入文件和额外配置文件。准备测试与审阅只展示各自使用的设置。
恢复运行时保留原会话的流程输入，不提供替换验证方案的选项。

修改默认仅对本次有效。**保存项目默认**会先展示 `.refactor/pipeline.json` 和 `limits.json` 的真实差异，
确认后写入；不保存当前任务、会话名称或反馈次数。**导出启动命令**会在选定目录生成独立的配置快照与
`command.txt`，命令包含本次输入及配置路径，可从当前系统的终端复用。

| 操作 | 方法 |
|---|---|
| 切换分区 | `1`–`9`；也可聚焦顶部导航后使用方向键 |
| 切换焦点 | `Tab` / `Shift+Tab`，底部显示当前焦点 |
| 选择、打开项目 | 列表中使用方向键，`Enter` 打开详情或编辑设置 |
| 滚动详情 | 聚焦详情后使用方向键、PageUp/PageDown 或鼠标滚轮 |
| 跟随最新输出 | “跟随最新”按钮；详情内按 End |
| 输入多行内容 | `Enter` 换行；`Tab` 移动到“提交”或“取消”按钮 |
| 返回、退出 | `Esc` 关闭弹窗或返回列表；`Q` 退出，运行中先确认取消 |
| 直接取消 | Ctrl+C，等待当前进程回收并恢复终端 |

80 列及以上显示左右分栏；60–79 列先显示列表，Enter 打开详情、Esc 返回。
窗口低于 60 列或 18 行时提示调整大小。`--ui tui` 要求交互 stdin/stderr，不能与 JSON、
`--no-interactive` 或 `--progress plain/off` 同时使用；自动模式初始化失败会退回文字模式。

全流程工作台包含：运行概览、AI 会话、验证方案、构建与测试、行为对比、文件差异、反馈历史和运行设置。
可以按会话查看 AI 回复和工具结果，按轮次、原版/候选版、构建和命令查看执行状态、输出及证据。
行为比较可选中单个检查项查看两侧值；文件差异使用 Git 的真实行级 diff。
结束后停留在结果页，退出后 stdout 留下简短结果和完整报告路径。执行顺序、反馈规则与退出码保持一致。

## 先写测试，再决定是否重构

可以先准备一套测试，在原版上试跑并查看具体场景，满意后再开始重构。验证范围与重构需求分开输入：
前者描述要保护的模块、行为和边界条件，后者描述如何改代码。

```bash
# 交互终端中自动打开工作台；省略 --scope 时进入配置向导
bun scripts/cli.ts tests prepare <repo> --scope "保护字符串复制函数的空输入、截断和容量边界"

# 再次打开保存的某个版本，可继续修改和试跑
bun scripts/cli.ts tests review <repo> --from <repo>/.refactorsa/test-plans/<id>/r1

# 在新运行中复用测试，使用现有完整流程与反馈机制
bun scripts/cli.ts run <repo> --task "合并重复的容量检查，保持行为不变" --tests <方案目录>

# 非交互方式生成、试跑并保存；stdout 是单个 JSON，进度写入 stderr
bun scripts/cli.ts tests prepare <repo> --scope "保护解析器的错误处理" --ui plain --format json --out <保存父目录> > preparation.json 2> preparation.log

# 只查看保存结果，不调用 AI、不执行构建
bun scripts/cli.ts tests review <repo> --from <方案目录> --ui plain --verbosity summary
```

审阅界面包含方案概览、测试场景、原版试跑、文件与修改、AI 会话、构建与测试、历史与设置。
选择某个场景可查看目的、输入、源码依据、关联检查项和实际观测值；辅助 C 文件单独展示，
已有文件的修改使用行级 diff。未在场景说明中关联的实际检查项会单独标出。

底部按钮提供“修改意见”“修复执行错误”“重新试跑”“保存方案”“继续重构”和“退出”。
修改意见使用多行编辑器；提交后继续原测试对话，再从固定原版提交试跑。
执行失败时可明确要求修复；构建错误交给构建角色，测试或交付错误交给测试角色。
只有方案完整且原版试跑通过后才能继续重构。继续时单独输入重构需求，再确认全流程设置。
普通退出不自动保存，也不启动重构；运行中取消会等待模型与进程回收，并保留已有材料和证据。

测试编写阶段只读代码、交付脚本与辅助材料；编译和执行由宿主完成。
准备流程创建固定提交的原版工作目录，每次试跑从干净副本开始，避免残留产物或已删除的辅助文件影响结果；不创建候选分支，也不生成 `ACCEPTED`/`REJECTED`。
准备期间的失败先交给人查看，修复由上述操作显式触发，不自动消耗正式运行的反馈次数。
试跑通过表示这套脚本在记录的原版上成功执行；覆盖是否满足需求可结合场景、辅助代码和实际观测审阅。

默认保存到目标仓库 `.refactorsa/test-plans/<id>/r1`、`r2`……，每次保存创建新版本。
`--out` 指定保存父目录，程序在其中创建 `r<N>`。每个版本包含 `plan.json`、全部测试与构建脚本、
注册的辅助代码/mock/数据、方案与场景说明、试跑证据和日志；编译产物不打包。
整个版本目录可以复制后复用，加载时校验文件清单和哈希；源目录或准备工作目录删除后仍可使用。
准备现场另保存在 `--session-root` 下的 `.refactor/test-preparations/<session>/`，正常退出会移除其原版 worktree。

本机的 AI 对话指针独立放在目标仓库 `.refactor/test-plan-dialogues/`，不放进可移植方案。
原对话仍存在时继续该对话；移到另一台机器或对话已删除时，修改会建立新对话并提供当前方案和意见。
正式运行使用本次运行的脚本副本，重新执行两侧构建与测试；后续修复沿用现有反馈规则，不覆盖已保存版本。
`--tests` 替换测试准备阶段，不能与显式配置的其他 workflow 输入或 `--resume` 同时使用；
恢复一次已经开始的正式运行时，直接使用其 `--resume` 检查点即可。

`tests` 命令还支持 `--session`、`--session-root`、`--verbosity detailed|summary`、`--no-color` 和 `--no-interactive`。
`--ui auto` 只在 stdin/stderr 都是交互终端、非 CI、非 JSON、且终端支持控制序列时启用 TUI；
`--ui plain` 始终使用普通文本，`--ui tui` 在条件不满足时报错。
非交互 `prepare` 必须提供非空 `--scope`，交付和试跑结束后保存退出；`review --ui plain` 只读取已有方案。
默认详细模式显示 AI 正常文字和命令输出，摘要模式省略正文与正常输出。
退出码为 0 表示原版试跑通过或正常查看未运行草稿，1 表示交付/执行失败，2 表示参数错误，130 表示取消。

无需调用模型的离线演示会执行一个微型 Git 项目的构建和测试，并保存界面回放与示例方案：

```bash
bun scripts/replay-test-preparation.ts --out runs/test-preparation-demo
# 输出真实 OpenTUI 帧 review.txt、run.detailed.txt、run.summary.txt，以及报告和 test-plan/r1
```

### 直接体验：一个没有现成测试的小型 C 库

这个示例用来体验“先审阅测试，再决定是否重构”。项目只有 `text_copy` 字符串复制函数，
CMake 只构建静态库，没有现成的测试或可执行程序。它没有文件、网络等外部依赖，
适合编写小型 C 辅助程序直接调用真实实现。

在工具仓库根目录执行以下命令。准备脚本需要 Bun、Git，以及 PATH 中的 GCC、Clang 或 `cc`，
会创建并提交一个独立的示例 Git 仓库，使用真实编译器构建和试跑；**准备脚本不调用模型**。

```powershell
bun scripts/setup-test-preparation-demo.ts
```

默认目录为 `runs/test-preparation-playground/`：`repo/` 是目标项目，`plans/r1/` 是已经试跑通过的
预置测试方案，`sessions/` 保留执行证据，`experience.json` 记录路径、验证范围、重构需求和完整命令。
预置方案由仓库提供，便于立即体验界面；接下来的“从零编写”才由 AI 决定测试方式并编写代码。
重复准备不会覆盖已有目录；需要新的环境时使用 `--out runs/test-preparation-playground-2`。

在 Windows Terminal / PowerShell 等交互终端中打开审阅界面，保持输入和输出连接终端：

```powershell
bun scripts/cli.ts tests review ./runs/test-preparation-playground/repo --from ./runs/test-preparation-playground/plans/r1 --ui tui
```

建议按这个顺序体验：

1. 按 `1` 看方案：为什么选择独立辅助程序、使用了什么依赖、有哪些覆盖缺口。
2. 按 `2` 看十个具体场景：正常复制、恰好容纳、截断、容量为一、空字符串、零容量查询、空串零容量、空源指针、空目标指针和长字符串截断。
3. 按 `3` 看真实试跑结果。十个检查项分别记录状态、复制长度、原长度、输出、终止符、守卫字节及是否完全未写入。
4. 按 `4` 后在左侧选择具体文件；右侧显示构建/测试脚本或辅助 C 源码，Tab 聚焦详情后可滚动。
5. 用 Tab 聚焦“重新试跑”并按 Enter，查看实际构建；再选择“保存方案”，最后按 Q 退出。这些操作不调用模型。
6. 想修改测试时选择“修改意见”，例如输入：`补充容量为 2 的截断场景，以及无效源指针时目标缓冲区所有字节保持不变的独立检查，并同步更新场景说明。` 这会调用 AI，完成后自动试跑，可再次审阅和保存。预置示例没有历史 AI 对话，第一次修改会建立新对话。
7. 对测试满意后选择“继续重构”，输入：`合并 text_copy 中完整复制与截断复制的重复循环，保持公开接口、状态、长度、终止符、无效输入不写入和缓冲区外字节完全不变。` 程序保存当前版本后进入完整配置向导，确认启动后进行重构与两侧验证；默认会调用 AI，也可在向导中指定补丁。

也可以完全不调用模型地体验全流程 TUI。用新的目录运行准备脚本，它会额外生成一个合并重复循环的
真实 Git 补丁及对应配置；正式宿主会应用补丁，再分别编译、运行原版与候选版：

```bash
bun scripts/setup-test-preparation-demo.ts --out runs/opentui-playground
bun scripts/cli.ts run ./runs/opentui-playground/repo --task "合并重复复制循环，保持行为不变" --pipeline-file ./runs/opentui-playground/offline-pipeline.json --auto-retry 0 --ui tui
```

结束后查看“行为对比”的十个检查项和“文件差异”的实际修改，按 Q 退出。
添加 `--configure` 可先体验完整配置向导；`experience.json` 中也保存了包含绝对路径的 `runOffline` 命令。

如果想完整体验 AI 从零编写测试，在另一次运行中执行：

```powershell
bun scripts/cli.ts tests prepare ./runs/test-preparation-playground/repo --scope '保护 text_copy 的正常复制、恰好容纳、截断、容量为 0/1、空字符串和 NULL 参数；观察返回状态、copied、required、终止符、无效输入不写入和缓冲区外字节。输入遵守头文件中的 NUL 结尾与不重叠前提。' --ui tui
```

`prepare` 使用现有 SDK 模型与认证配置，先调查并交付测试，再由宿主编译、执行，最后停在审阅界面。
执行失败时可以选择“修复执行错误”；交付完整、原版试跑通过后才能“继续重构”。
修改后选择“保存方案”，方案概览会显示新版本的准确位置。以后使用该位置，而不是原来的预置 `plans/r1/`：

```powershell
bun scripts/cli.ts run ./runs/test-preparation-playground/repo --tests '<方案概览显示的保存目录>' --task '合并 text_copy 的重复复制循环，保持接口和所有行为不变'
```

`--ui tui` 会在输入或输出被重定向、CI 环境或 `TERM=dumb` 时报错。请在真实交互终端运行；
如果当前终端支持 ANSI，但环境变量误设为 `dumb`，可在该 PowerShell 会话先执行
`$env:TERM = 'xterm-256color'`。颜色仍遵循 `--no-color` 和 `NO_COLOR`；需要彩色显示时，可在当前
PowerShell 会话执行 `Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue`。
`tests review --ui plain` 只查看普通文字，不会调用 AI 或重新构建。

## 在具体项目中运行与查看进度

目标目录需要是已有提交的 Git 仓库，并包含 C 源文件。先提交需要作为基准的代码，
再给出具体重构任务；使用新的会话名，已有会话不会被覆盖。

```bash
# 最简启动：进入配置向导，填写任务并开始
bun scripts/cli.ts run <repo>

# 默认详细模式；省略 --session 时自动生成唯一编号
bun scripts/cli.ts run <repo> --task "提取重复的参数校验逻辑，保持行为不变"

# 摘要模式：保留阶段、验证方案、步骤结果和失败原因
bun scripts/cli.ts run <repo> --task "..." --session task-002 --verbosity summary

# 保存可直接解析的 JSON，同时把按行进度保存到另一个文件
bun scripts/cli.ts run <repo> --task "..." --session task-003 --format json --progress plain > result.json 2> progress.log

# 恢复一次 ABORTED 运行；创建新会话，重新执行环境检查和完整验证
bun scripts/cli.ts run <repo> --task "..." --resume task-001 --session task-001-retry --verbosity summary
```

| 参数 | 默认值与行为 |
|---|---|
| `--task <text>` | 重构需求；TUI 中缺项打开配置向导，普通文字模式提示输入；非交互环境必须提供 |
| `--ui auto/tui/plain` | 自动选择、强制终端工作台或普通文字；默认 auto |
| `--configure` | 启动前编辑完整设置，仅用于 TUI |
| `--session <id>` | 可选自定义编号；省略时使用时间戳与随机 UUID 生成新编号，不会覆盖已有会话 |
| `--no-interactive` | 禁止提示输入；适合脚本和 CI，缺少任务时直接以退出码 2 报错 |
| `--verbosity detailed` | 默认；显示正常 AI 文字、工具名称与目标、命令输出和完整失配结果 |
| `--verbosity summary` | 省略 AI 回复正文和正常命令输出；失败时显示输出末尾，最多列出前 10 个失配项 |
| `--progress auto` | 默认；交互终端使用 TUI，其他环境逐行输出，JSON 关闭实时展示 |
| `--progress plain` | 强制逐行实时展示，JSON 模式也可使用 |
| `--progress off` | 关闭实时展示，仍输出结束报告 |
| `--no-color` | 禁用颜色；也尊重 `NO_COLOR` 环境变量 |
| `--resume <会话编号>` | 复用指定中止会话中仍有效的阶段检查点，在新会话中重新验证 |

任务输入只在 stdin 和 stderr 都连接交互终端、未设置有效的 `CI`、且未传 `--no-interactive` 时启用。
普通文字模式下，输入需求后会列出仓库、任务与会话设置，可选 `[1] 开始运行`、`[2] 重新输入`、`[0] 取消`；直接回车取消。
任务输入时也可使用 `/cancel`、Ctrl+C 或 Ctrl+D 取消。取消发生在创建会话、调用模型或执行构建之前，退出码为 130。
提供非空 `--task` 时直接运行，不增加确认步骤；其他无效参数仍直接报错。
交互提示只写 stderr，即使 stdout 输出 JSON 也不会混入提示文字。

程序调用可显式关闭交互和颜色；下例的 stdout 始终是单个 JSON 报告，进度另存一份：

```bash
bun scripts/cli.ts run <repo> --task "..." --no-interactive --no-color --format json --progress plain > result.json 2> progress.log
```

自动生成的会话编号会显示在启动信息和结束报告中，JSON 对应 `session` 字段。
自定义 `--session` 必须使用新名字；已有名字不会被覆盖，也不会自动恢复。
恢复使用 `--resume <旧编号>`，恢复后的运行默认也会生成新的会话编号。

进度与 TUI 始终写入 **stderr**，结束报告写入 **stdout**。普通文字模式保留事件历史并在底部刷新当前阶段、
总耗时、阶段耗时和无实际活动的时间；非交互终端每 10 秒输出状态。心跳与工具存活消息不会重置活动时间。
阶段不显示推测的进度百分比；声明比较的数量称为“检查项”，不代表测试用例数。

终端会给标题和标签着色，AI 长段正文、文件路径、命令内容和进程输出正文保留默认色：

| 信息 | 颜色 |
|---|---|
| 阶段标题、报告分节 | 蓝色加粗 |
| AI 角色与回复标题 | 紫色；会话短编号弱化显示 |
| 工具动作、验证方式、配置字段名 | 青色 |
| 完成、通过、`ACCEPTED`、一致数 | 绿色 |
| 警告、取消、`ABORTED`、覆盖缺口 | 黄色 |
| 失败、`REJECTED`、失配、比较错误 | 红色；零失配与零错误不突出 |
| 原版／候选版标签 | 蓝色／紫色 |

实时信息和结束报告分别按 stderr、stdout 是否连接交互终端决定配色；重定向到文件时保持纯文本。
`--no-color`、`NO_COLOR`（包括空值）或 `TERM=dumb` 均关闭颜色，JSON 与落盘报告不会混入展示用 ANSI。
stderr 输出流标签使用黄色，是否失败以实际执行结果为准。

普通文字模式下，读取、写入、修改、查找文件及搜索内容只在收到结果后显示一条记录，包含目标、完成或失败及耗时。
本地构建方案查询、依赖登记、方案保存和验证方案提交也按此规则展示；
例如 `mcp__dep-registry__generateBuildWorkflow` 显示为“保存构建方案”，实际构建仍在验证阶段执行。
子任务、命令及未知工具保留开始和结束记录；未知 MCP 名称缩短为 `服务名/工具名`。
等待期间状态行显示最近的工具动作及其余活动数量；中断或结束时仍无结果的调用会明确标为“未收到完成结果”。

可先用模拟 SDK 消息预览两种显示模式，无需目标项目、凭据、模型调用或编译：

```bash
bun scripts/replay-cli-progress.ts --verbosity detailed
bun scripts/replay-cli-progress.ts --verbosity summary
# 导出两种模式的 ANSI、纯文本和 HTML 预览到忽略目录
bun scripts/replay-cli-progress.ts --out runs/cli-progress/color-examples
```

启动信息包括实际配置及来源、模型与限制、主机工具、基准提交、候选分支和工作目录。
验证方案提交后展示采用的验证方式、理由、覆盖行为、真实依赖、模拟依赖和覆盖缺口。
构建和测试显示原版/候选版、构建编号、真实执行命令、工作目录及耗时。
`RFR_LOG_LEVEL` 控制落盘日志的级别，与 `--verbosity` 独立；显示正常 AI 回复无需启用 trace。
界面不显示模型内部思考、完整工具参数、写入文件内容、环境变量或能力协议。

结束报告保留 `ACCEPTED`、`REJECTED`、`ABORTED` 及其原因，列出各阶段耗时、全部构建的两侧结果、
未执行部分、比较统计、完整重构说明、改动文件和提交。详细模式展示所有失配项及两侧观测值，
每个大值最多预览 1,024 个字符，完整值保存在证据文件中。
SDK 提供时展示会话轮数、用量和费用；缺失时不估算，子会话费用不重复计入合计。

恢复运行会显示来源会话和复用阶段；复用阶段的耗时只包含本次加载、重新校验或测量，
不会计入上次 AI 执行耗时。检查点无效的阶段按本次配置重新运行，验证始终重新执行。
恢复时仍需传入所需的 `--session-root`、`--worktree-root`、`--pipeline-file`、`--stage`、`--inject` 等参数，
不会自动恢复上一次命令行。有效检查点优先于本次阶段配置，只有未复用的阶段使用本次配置。
只有 `ABORTED` 会话可恢复；运行成功、拒绝和中止的既有记录不会被改写。

证据默认保存在 `<repo>/.refactor/e2e/<session>/`，也可用 `--session-root <目录>` 改变存放根目录：

- `artifacts/run-summary.json`：清理完成后定稿的统一报告，与 CLI JSON 的 `report` 字段相同。
- `artifacts/failure-report.json`：中止时的失败阶段、分类、组件、原因及可重试标记；统一报告的 `failure` 同步保存该信息。
- `logs/`：构建、测试与 CTest 的原始进程输出；具体失败信息也保存在对应执行结果 JSON 中。
- `artifacts/expectation-*.json` 或 `ctest-*.json`：两侧完整观测与比较证据。
- `run.jsonl`、`state.json`、`sessions/`：运行事件、状态与 SDK 会话记录。

`--format json` 保留既有顶层字段并追加 `report`，测试集原有读取方式继续有效。
恢复信息保留在顶层 `resumed_from` 与 `report.resume`，复用成功的阶段在 `stage_timings` 中标为 `reused`。
提前失败只报告已获得的信息。收到中断后停止状态刷新、回收所属进程并保留已有证据；
强制中断时最终报告可能尚未生成。若清理或产物推广失败，报告单独记录 `finalization_error`，
保留实际验证结论，同时以失败退出。

候选改动保存在输出的分支和提交中，**不会自动合并回原分支**；`ACCEPTED` 表示本次验证范围内通过。
可以先按报告里的 `git diff` 命令审查差异，再自行决定如何集成。网页看板目前废弃，普通运行以 CLI 为准。

## 失败反馈与恢复

`run` 默认最多自动修复 3 次（首轮执行不计入）。用 `--auto-retry N` 调整总次数，
`--auto-retry 0` 关闭自动修复。行为不一致或候选代码执行失败时，继续原重构对话；
测试脚本自身出错时，继续原测试编写对话；原版构建失败时，启动一个构建修复会话。
环境缺失、宿主错误或原因无法分类时停止，并保留当前结果和证据。

每轮沿用当前完整方案：修好构建 A 后再修 B，A 的修复会保留；测试修复交付的新脚本、
构建和辅助材料也会用于后续轮次。旧原版观测仅在基准提交、构建脚本、测试脚本和全部
辅助材料均匹配时复用。重新登记相同内容导致编号变化，不视为修复取得进展。

中止后可以从检查点恢复，使用新的会话编号保存这次执行记录：

```bash
bun run scripts/cli.ts run <repo> --task "<同一重构任务>" --resume <中止的会话编号> --session continued --auto-retry 3
```

恢复会继承同一次运行已经消耗的修复次数与原 AI 对话。例如已用 2 次，指定
`--auto-retry 3` 后还可修复 1 次；指定 `0` 则执行一次恢复，不再自动修复。修复开始前就记录次数，
中途中断也不会返还。后续各轮均可作为恢复入口，仍归属同一次运行。
状态和当前方案保存在 `<session-root>/.refactor/feedback/<首次会话编号>/`，
各轮证据仍保存在自己的 `e2e/<会话编号>/` 下。

CLI 会显示每轮执行的结果、失败原因、自动修复次数与剩余次数，并说明修复对象：

- 候选代码：继续原重构对话，保留当前构建与测试方案；原版观测可复用时会明确显示“复用”，否则两侧重新执行。
- 测试脚本：继续原测试编写对话，保留候选代码；修复后重新校验方案，按当前执行流程重新构建、测试两侧并比较。
- 构建方案：新建构建修复会话，保留候选代码和测试脚本；保存方案后重新构建、测试两侧并比较。

底部状态行显示当前轮次、已用修复次数和正在进行的操作。详细模式继续显示修复过程中的 AI 正文、工具活动与命令输出；
摘要模式显示原因、执行范围和结果。遇到次数用尽、连续没有进展、缺少原对话、环境问题等情况，直接显示停止原因。
跨轮总计时保持连续；恢复运行时总计时从本次启动开始，修复次数继承原运行。

结束报告增加各轮结果、耗时和报告路径；构建修复会话的耗时单独列出。阶段耗时及构建、测试明细属于最后一轮，
总耗时包含本次启动后的所有轮次和修复。每轮原始报告保存为 `artifacts/round-summary.json`，本次调用的完整报告保存到
启动时结果目录下的 `artifacts/run-summary.json`；JSON 的 `report.feedback` 提供同样的信息。
原 AI 对话记录目录与反馈状态目录也会列出，便于恢复或排查。JSON 和报告文件继续保持无颜色控制符。

## 测试集（把能力评估跑成分数）

用法、套件设计、校准与实测记录都在 [`docs/testset/`](docs/testset/)：

| 文档 | 内容 |
|---|---|
| [`docs/testset/README.md`](docs/testset/README.md) | 测试集是什么、目录结构、快速开始、维护约定 |
| [`docs/testset/03-suite-and-runner.md`](docs/testset/03-suite-and-runner.md) | 执行器手册：用例模型、探测/跳过、blind 注入、选择/校准/冻结/重判/裁判，§10 起为历史实测 |
| [`docs/testset/02-testset-requirements.md`](docs/testset/02-testset-requirements.md) | 构建事实、用例清单、期望声明模型、判定规则、复现命令 |
| [`docs/testset/01-refactor-targets.md`](docs/testset/01-refactor-targets.md) | 可重构点清单与覆盖缺口（T1–T7） |
| [`docs/testset/04-rubric.md`](docs/testset/04-rubric.md) | 裁判（rubric）怎么给分 |

最短路径：

```bash
bun testset/run.ts --list                                  # 45 个用例，按 subject 分组
bun testset/run.ts --self-test                             # 执行器自检（合成用例，不碰项目）
bun testset/run.ts --subject judgement --tag offline       # 离线判据自测（不调模型）
bun testset/run.ts --only e2e-t1-full --rubric-cmd "<命令>" # 端到端 + 裁判
```

每个用例一个目录（`cases/<id>/case.json` + `prepare.ts`），共享材料放 `resources/`；
用例声明依赖，缺依赖的用例会被跳过（blocked）而不是把整批跑红；环境一律按用例自己准备，
判据材料在验证前才注入 worktree（候选看不到）。

测试集只用 CLI 调用 harness（`bun scripts/cli.ts run …`），不 import 应用源码。

`bun run typecheck` 单独检查宿主、脚本、测试和 testset 执行器；动态 workflow 材料由宿主的源码策略与运行验证检查。
Windows/Linux CI 执行 `check` 和 `test:offline`，只按用例声明跳过不适用平台，其余环境缺失一律失败。
离线证据默认写入较短的 `runs/c-<随机值>/`，也可指定 `--out <新目录>`；CI 使用临时目录以避免 MinGW 长路径问题。

## 进程回收与取消

Workflow worker、capability 工具、CTest 和测试集命令共用进程管理：Windows 使用带 kill-on-close 的 Job Object，
POSIX 使用独立进程组，工具先发送 TERM，200ms 后仍未退出则发送 KILL。
负责回收内层进程组的 CLI 有 4s 关闭预算，避免外层先杀掉 CLI 而留下内层工具。
正常结束、异常、超时和取消都会回收所属子孙进程，并在输出管道排空后返回；退出和排空等待各有独立上限，清理失败会保留诊断。

`runWorkflow`、`runCTest` 和测试集 `exec` 支持 `signal: AbortSignal`；取消前已收到的 capability 事件仍保留在 workflow 结果中。
CLI、测试集和离线检查入口处理 SIGINT/SIGTERM，宿主显式退出时也会清理已登记的进程。
这些机制负责进程生命周期，平台隔离仍是后续独立工作。
