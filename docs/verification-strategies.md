# 验证方式与辅助材料

Preflight 负责发现宿主工具路径、查询 CMake 元数据和识别 C 项目，不编译临时工程。
工具路径和项目状态不代表构建已通过，真实构建由 build-writer 和所选 workflow 确认。
test-writer 先委托 `verification-scout` 调查行为和依赖，
再决定复用相关测试、构建库消费者，或编译局部源码 harness。build-writer 负责实测构建与产物使用说明，
test-writer 负责具体用例、辅助代码和 TestWorkflow。独立 Analyze 已移除；scout 位于 workflows 阶段内部。

## 调查与写作的交接

scout 使用独立的 `workflow-spec:verification-scout` skill，仅有 Read/Glob/Grep、配方查询和报告提交工具，
不加载 Workflow API 编写规范，没有 shell、源码写入或进一步派生 agent 的工具。
它共用 test-writer 会话的取消/超时，最多 24 轮，前台返回后 writer 才继续。

报告包括被测行为、首选方案和依据、依赖处置、覆盖限制与未知项。依赖区分编译条件、内部逻辑、资源和外部能力；
建议替身时必须交代接入点、模拟行为、保留的真实实现和损失的集成覆盖。源码确认、Preflight 测量和推断分别标记。
范围按语义覆盖和可靠性优先选择，独立模块不需要等到完整构建昂贵才选择局部验证。

通过 `submitVerificationAnalysis` 提交，宿主校验结构并原子保存到：
`<repo>/.refactor/runs/<sessionId>/workflows/verification-analysis.json`。
自动编写会话要求本次成功提交，旧报告文件不能代替；结束、超时或异常退出后关闭提交。
报告仅为建议，不注册构建或共享材料，不参与两侧行为比较。预置 workflows 直接绕过 AI 会话及这项要求。

test-writer 仍决定最终方案；产物形态、准确路径及可观察入口的使用说明由 build-writer 提供。
消费者需要先知道库/运行器接口时，先咨询 build-writer，再由 writer 写辅助代码，最后请求实测并登记完整构建。
咨询不登记半成品。配方列表不等于使用说明，复用时也需确认参数/标准输入/输出协议、公开函数与链接加载/生命周期，
或测试选择和结果读取等实际所需信息。

构建暴露具体阻碍时可以请 scout 定向补查并提交完整替换报告；调整限于 workflows 编写阶段。
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
运行证据包含 `verification-materials.json`、两侧构建结果、两侧 `test-workflow-run.json` 和观测比较结果。
声明多项构建时，每侧分别保存 `<side>-build-<声明序号>-<声明 ID>.json`，避免默认 workflow ID 或文件名规范化导致结果覆盖。

## 实际边界

scout 的独立能力评测见 [分级场景、评分与运行说明](testset/05-scout-evaluation.md)。
它直接复用调查角色，单独评估结论，不代替 writer 组合测试或完整双侧执行验收。

局部 harness 证明选定模块和输入的行为；库消费者证明选定 API 的行为。它们不会自动证明完整工程的构建与集成。
源码与哈希检查发生在执行边界，不能阻止原生命令运行期间短暂改写再还原，也不能保护所有宿主路径。
这些是完整性检查，平台级 OS 隔离仍需单独实现。能力调用记录本身不能证明执行的是本次修改的实现，
也不能证明覆盖了所有相关行为；这些仍需评估 writer 的选择和真实项目验收。
