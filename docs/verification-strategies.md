# 验证方式与辅助材料

Preflight 负责发现宿主工具路径、查询 CMake 元数据和识别 C 项目，不编译临时工程。
工具路径和项目状态不代表构建已通过，真实构建由宿主执行所选 workflow 后确认。
test-writer 在同一会话内调查行为和依赖，再选择并实现相关测试、库消费者或局部源码 harness。
build-writer 负责 BuildWorkflow 和预期产物使用说明，test-writer 负责具体用例、辅助代码和 TestWorkflow。
独立 Analyze 与固定的 scout 子会话均已移除，源码调查保留为 workflows 编写的第一步。

## 同一会话内调查与编写

`verificationPlanningPrompt` 和 `workflow-spec:verification-planning` skill 提供调查步骤、完成条件与计划规范。
test-writer 先理解源码并提交计划，保留已读内容，再加载工作流实现文档并编写测试。
生产只注册 build-writer 子角色；test-writer 继续使用现有会话预算，不增加顶层阶段。
两个角色编写期间只读取源码、交付代码与说明，不提前编译、运行程序或模拟执行工作流。
目前在各自的工具列表中暂时移除 Bash；以后恢复只需调整角色工具列表，通用执行器仍支持 shell。
所交付工作流里的编译、执行、退出状态和产物断言仍由宿主执行。

报告包括被测行为、首选方案和依据、依赖处置、覆盖限制与未知项。依赖区分编译条件、内部逻辑、资源和外部能力；
建议替身时必须交代接入点、模拟行为、保留的真实实现和损失的集成覆盖。源码确认、Preflight 测量和推断分别标记。
范围按语义覆盖和可靠性优先选择，独立模块不需要等到完整构建昂贵才选择局部验证。

test-writer 查询配方并根据源码判断现有产物/测试是否能充分观察目标行为；行为、依赖和覆盖限制明确后就提交。
所选方案的构建检查由 build-writer 写入流程，未选方案的环境未知项不阻塞推荐；关键源码契约缺失时仍保留 `undetermined`。
尚未实际构建不等于源码契约缺失。
生产会话与独立评测均使用宿主所加载 plugin 内的绝对 skill 路径，文档引用从同一目录解析。
行为、证据、依赖和未知项各自集中表达；没有现成库目标不构成否定库消费者的理由。
重要行为和错误路径需在具体测试中落实，实质覆盖缺口在最终总结中说明。

通过 `submitVerificationAnalysis` 提交，宿主校验结构并原子保存到：
`<repo>/.refactor/runs/<sessionId>/workflows/verification-analysis.json`。
自动编写会话要求本次成功提交，旧报告文件不能代替；结束、超时或异常退出后关闭提交。
报告仅为建议，不注册构建或共享材料，不参与两侧行为比较。预置 workflows 直接绕过 AI 会话及这项要求。

test-writer 决定最终方案；产物形态、准确路径及可观察入口的使用说明由 build-writer 提供。
消费者需要先知道库/运行器接口时，先咨询 build-writer，再由 writer 写辅助代码，最后登记完整构建代码与材料。
咨询不登记半成品。配方列表不等于使用说明，复用时也需确认参数/标准输入/输出协议、公开函数与链接加载/生命周期，
或测试选择和结果读取等实际所需信息。

工具链、SDK 和配置的运行时检查由 build-writer 编写；影响覆盖判断的源码依赖、行为或隔离契约疑问由
test-writer 定向补查，方案变化时提交完整替换计划。产物说明区分源码推导、已有事实和待执行检查，不宣称提前实测成功。
正式验证使用固定后的测试与材料，不能为了让候选通过而更换替身或弱化测试。
宿主的结构/提交检查不证明报告内容真实，也不证明策略选择正确；真实 AI 调查质量需要单独验收。

## 源码与测试材料的关系

| 位置 | 受控源码 | 辅助输入与产物 |
|---|---|---|
| 原仓库 | 保留现有源码与用户改动 | 只保存运行目录里的 workflow 和材料记录 |
| baseline worktree | 基线提交的源码 | 固定辅助输入 + 针对基线真实实现构建的产物 |
| candidate worktree | 已提交的重构源码 | 同一辅助输入 + 针对候选真实实现构建的产物 |

测试用的 `.c`、数据或包装构建文件属于辅助输入，不属于重构。
例如 DLL 的消费者程序，或编译真实 `src/module.c` 的独立入口，都能在不改原源码与根构建文件的情况下运行。
辅助输入禁止复制被测试实现、链接另一侧的旧二进制或按侧调整逻辑。

## 最小交付接口

复用现有 registry 工具：

```ts
generateBuildWorkflow({
  name: "module-probe",
  description: "compile a probe against the real module",
  content: "/* complete workflow-driven TypeScript source */",
  materials: [
    { path: "build/verification/probe.c", content: "/* auxiliary C entry */" },
  ],
});
```

材料为 UTF-8 文本。路径限定在 `build/verification/`，拒绝绝对路径、`..`、Windows 特殊路径、
同路径内容冲突、大小写冲突和文件/目录冲突。分发前检查受控文件碰撞、符号链接/junction 与硬链接。
输入和编译输出必须使用不同路径。

宿主把源码与哈希存入 `<build-entry>.materials.json`，解析声明时读取并固定到内存；
`DeclaredBuildSet.builds[].materials` 保存 `{path, sha256}`，声明哈希包含 workflow 与输入哈希。
预置 workflow 可使用同样的 sidecar 格式，不需要模型调用。
登记期间使用未完成标记；写入失败或进程中断时，该配方不能复用，重新生成完整交付后才恢复可用。

```json
{
  "version": 1,
  "materials": [
    { "path": "build/verification/probe.c", "content": "...", "sha256": "<actual SHA-256>" }
  ]
}
```

含任务专属材料的构建暂不推广到通用配方库；运行目录保留完整交付，不创建缺材料的库条目。

## 执行与判定

1. writer 完成声明后，创建 baseline/candidate；只有 candidate 接受重构。
2. 宿主提交并测量 candidate patch，再分发固定辅助输入和可信盲测材料。
3. baseline 执行全部声明的构建，再执行 TestWorkflow；有效后 candidate 执行相同步骤。
4. 每次执行前后核对 workflow 哈希、提交、Git 索引、受控文件字节和输入哈希，最终判定前再检查。
5. 两侧 workflow 执行成功、能力代理记录了实际进程运行或文件读取，且至少有一个观测，才比较 `ctx.expect`；
   一致为 ACCEPTED，行为失配为 REJECTED，执行或完整性失败为 ABORTED。

正常用例先要求 `status === "exited" && exitCode === 0`，负向用例明确检查预期错误。
宿主从能力代理记录进程状态，直接拒绝启动失败、超时、输出截断等无效执行，不依赖 writer 是否检查了状态。
发现零测试、崩溃或加载失败也应在 workflow 中失败，不能只比较两侧相同的错误值。
运行证据包含 `verification-materials.json`、两侧构建结果、每侧各自的 `<side>-test-workflow-run.json` 和观测比较结果。
声明多项构建时，每侧分别保存 `<side>-build-<声明序号>-<声明 ID>.json`，避免默认 workflow ID 或文件名规范化导致结果覆盖。

当前自动修复覆盖工作流源码策略违规和验证失败：源策略违规在编写阶段打回写作方重写；验证失败由 `--auto-retry`
交给对应会话（基线构建失败交 build-writer，候选构建失败、候选程序崩溃或行为失配继续 refactor 会话，测试脚本错误继续
test-writer 会话），环境类、宿主类和无法分类的失败保留诊断并中止。
可选 `--exam-precheck` 在重构前用原版代码彩排：原版构建失败走 build-writer，脚本错误或 `both-matches`
期望值与原版事实矛盾走 test-writer；此时没有候选提交，修复轮重新建场并跑完整重构。
正式验证中若全部失配都是考卷自违（原版不满足考卷自己的 `both-matches` 模式），说明修代码无法消除，
程序按 `needs-diagnosis` 停止，不消耗修复次数。
编写阶段不为弥补这条反馈路径而提前执行。所有修订由宿主明确发起并重新固定材料，候选代码失败不会触发测试重写或弱化测试。

## 实际边界

调查能力的独立评测见 [分级场景、评分与运行说明](testset/05-scout-evaluation.md)。
它复用生产会话的调查提示词和指导文档，在计划被接受后结束；仅开放读取和报告提交工具。
现有 scout 命令、场景 ID 与证据文件名保留，便于历史对比；生产不再创建同名子角色。
该评测不包含测试实现的上下文负担，不代替完整编写和双侧执行验收。
真实 writer 的局部源码组合验证与固定错误补丁结果见 [writer 组合验证](testset/07-writer-integration.md)。

局部 harness 证明选定模块和输入的行为；库消费者证明选定 API 的行为。它们不会自动证明完整工程的构建与集成。
源码与哈希检查发生在执行边界，不能阻止原生命令运行期间短暂改写再还原，也不能保护所有宿主路径。
这些是完整性检查，平台级 OS 隔离仍需单独实现。能力调用记录本身不能证明执行的是本次修改的实现，
也不能证明覆盖了所有相关行为；这些仍需评估 writer 的选择和真实项目验收。
