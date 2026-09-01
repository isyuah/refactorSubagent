# Workflow 规范（AI 生成 Workflow 必读）

> 你正在生成 TypeScript Workflow 模块。**必须**先读本目录的必读文档，**按需**读工具文档。
> 宿主会严格校验你的输出；任何偏离本规范的字段、签名、约束都会被拒绝。

## 文档索引

| 文档 | 必读/按需 | 内容 |
|---|---|---|
| `workflow-api.md` | **必读** | WorkflowContext 完整接口、capabilities 精确签名 |
| `build-output.md` | **必读** | BuildWorkflowOutput 完整 schema（精确字段） |
| `test-output.md` | **必读** | TestWorkflow 完整 schema |
| `cmake.md` | 按需 | CMake CLI 用法（configure/build/target 约束） |
| `ctest.md` | 按需 | CTest 用法（运行/输出解析） |

## 生成流程

1. 读 `workflow-api.md`、`build-output.md`（或 `test-output.md`）
2. 用允许的读取工具检查项目文件（CMakeLists.txt 等）
3. 写 workflow 源文件到宿主指定路径
4. 返回对象必须通过宿主 schema 校验

## 硬性约束（违反即拒绝）

- 禁止 import `node:`/`bun:`/`fs`/`child_process`/`process` 等宿主 API
- 禁止 shell 命令字符串；`process.run` 的 args 是 argv 数组（无 shell）
- 禁止访问网络、git、工作区外路径
- 产物路径必须相对且在工作区内
- 必须 fail-closed：无法从测量事实/项目文件确定的东西，throw 清晰错误而非猜测
