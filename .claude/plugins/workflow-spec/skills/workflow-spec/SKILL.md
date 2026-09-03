---
name: workflow-spec
# user-invocable: false — the skill cannot be triggered manually.
# The host enables it only for workflow-generation sessions via the SDK
# `skills` option; in all other sessions it is invisible to the model.
user-invocable: false
description: >-
  Mandatory specification for generating TypeScript BuildWorkflow and
  TestWorkflow modules. Read workflow-api.md, build-output.md (or
  test-output.md), and cmake.md/ctest.md when relevant BEFORE writing any
  workflow source. The host injects this skill when it asks you to author a
  workflow; do not skip it. Deviating from these specs gets your output
  rejected by the host schema validator.
---

# Workflow 规范（宿主强制注入，生成 Workflow 必读）

你正在生成 TypeScript Workflow 模块。**必须**先读本 skill 目录下的规范文档，再动手写代码。
宿主会严格校验你的输出；任何偏离本规范的字段、签名、约束都会被拒绝。

## 文档索引（按需读取）

| 文档 | 何时读 | 内容 |
|---|---|---|
| `workflow-api.md` | **总是** | WorkflowContext 完整接口、capabilities 精确签名、常见反例 |
| `build-output.md` | 生成 **BuildWorkflow** 时 | workflow-driven BuildWorkflow 规范：驱动构建 + validator 断言 |
| `test-output.md` | 生成 **TestWorkflow** 时 | 自驱动 TestWorkflow 规范：ctx.expect、产物契约 |
| `cmake.md` | 项目是 **CMake** 时 | CMake CLI 用法、`--target` 单值陷阱、MSVC Debug 路径 |
| `ctest.md` | 项目用 **CTest** 时 | CTest 用法、顶层测试名观察 |

## 生成流程

1. 读 `workflow-api.md` + 对应输出 schema 文档（+ 工具文档如相关）
2. 用允许的读取工具检查项目文件（CMakeLists.txt 等），观察真实值
3. 写 workflow 源文件到宿主指定路径
4. 返回对象必须通过宿主 schema 校验

## 硬性约束（违反即拒绝）

- 禁止 import `node:`/`bun:`/`fs`/`child_process`/`process` 等宿主 API
- 禁止 shell 命令字符串；`process.run` 的 args 是 argv 数组（无 shell）
- 禁止访问网络、git、工作区外路径
- 产物路径必须相对且在工作区内
- `plan.fail` 的 error 必须是字符串（不要传 Error 对象）
- CMake `--target` 只接受一个目标；多目标分开 `process.run`
- `facts.host` 与 `facts.project` **总是存在**，直接访问
- 必须 fail-closed：无法从测量事实/项目文件确定的东西，throw 清晰错误而非猜测
