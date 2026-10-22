# 验证方案交接与执行

test-writer 先委托 verification-scout 调查目标行为、依赖和验证范围，取得宿主接受的报告，
再决定最终方案并编写用例。调查方法由 scout 自己的精简 skill 提供，writer 不重复完整探索。
Preflight 字段的含义见 `workflow-api.md` 的 `facts.host` / `facts.project`；验证范围按源码行为和已有覆盖选择。
没有独立 Analyze 阶段。

| 选定方案 | 实现指导 | 必须证明 |
|---|---|---|
| `reuse-existing` | 相关测试及构建目标；按需读 `cmake.md` / `ctest.md` | 两侧都确实发现并执行了相关测试 |
| `library-consumer` | 读 `library-consumer.md` | 消费者链接/加载当前侧重新构建的真实库 |
| `source-harness` | 读 `source-harness.md` | 两侧编译各自的真实模块，辅助代码不复制实现 |

test-writer 按报告设计具体用例和替身代码。build-writer 负责确认构建可行性，交付产物及完整使用说明：
路径、参数/标准输入/输出协议，或库的公开调用、链接加载与初始化清理，或测试选择与结果读取。
scout 报告和配方列表都不替代这份说明。

## 交付与执行

1. 接收 scout 报告，检查关键未知项是否解决，再设计输入、观测与辅助代码。
2. 向 build-writer 提供选定方案、报告、覆盖范围、依赖和辅助源码内容。
   如编写消费者前需要库用法，先请求咨询，得到使用要求后完成消费者，再请求最终构建；
   咨询期间不登记半成品。已有配方复用也需建立准确的使用说明。编译探测只能在仓库外 scratch 目录。
3. build-writer 调用 `generateBuildWorkflow({name, description, content, materials})`。
   `materials` 为 `[{path, content}]`，仅允许 `build/verification/` 下的文本输入。
   所有辅助 `.c`、头文件、数据与包装 `CMakeLists.txt` 都要登记，不能依赖 scratch 遗留文件。
4. 宿主计算输入哈希并固定声明；在候选提交后向 baseline/candidate 分发相同内容。
   BuildWorkflow 在每侧编译/准备；TestWorkflow 只运行、读取产物并 `ctx.expect`。
5. 每侧先检查有效执行：命令正常结束、错误属于明确预期、相关测试实际运行、有行为观测。
   崩溃、超时、加载失败或零测试必须 throw。正常测试要求退出码 0；负向用例独立检查预期错误。
6. 最终报告说明选择理由、覆盖的行为和未覆盖的集成范围。

构建暴露具体阻碍时可以定向请 scout 补查，重新选择范围并提交完整更新报告。
这种调整限于 workflows 编写阶段；进入正式验证后使用已固定的测试与材料，不能因候选失败而弱化它们。

辅助材料不进入重构补丁，不覆盖受控文件，执行期间不能修改。
编译产物必须使用不同路径，例如输入 `build/verification/probe.c`、产物 `build/verification/probe.exe`。
含任务专属材料的构建本轮保持 run-local；不要假设它会进入通用配方库。

宿主检查两侧 workflow 哈希、输入哈希、提交和受控源码，并记录真实 process/fs 观测；
启动失败、超时、输出截断和空观测不能接受。这不是 OS 沙箱，也不能证明测试覆盖了所有行为。
