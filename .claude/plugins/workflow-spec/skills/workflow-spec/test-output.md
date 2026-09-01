# TestWorkflow 精确 Schema（必读）

TestWorkflow 默认导出的函数**必须返回**下面形状之一。字段完全一致，多余字段拒绝。

## 形状 1：CTest runner（推荐，当项目有 CTest）

```ts
{
  kind: "test-workflow",            // 字面量，固定
  version: 1,
  workflow_id: string,              // 生成 prompt 给的精确 id（硬编码）
  workflow_revision: number,        // 正整数
  runner: "ctest",                  // 字面量
  build_workflow_id: string,        // 从 context.input 复制（见下）或生成 prompt 给的 build id
  build_workflow_revision: number,  // 同上
  build_dir: string,                // 构建目录（相对），如 "build"
  configuration: string,            // 如 "Debug"
  extra_args: string[],             // 附加 ctest argv（不含超时，宿主管）
  required_top_level_tests: string[],  // 必须存在的顶层 CTest 测试名（从 CMakeLists add_test 观察）
  environment: Record<string, string>
}
```

**`build_workflow_id`/`build_workflow_revision` 来源**：
- 生成 TestWorkflow 时，宿主会在 `context.input` 注入 `{ kind: "test-workflow-input", version: 1, build_workflow_id, build_workflow_revision }`
- **从 `context.input` 复制**，或硬编码生成 prompt 里给的值
- 不能自创值

**`required_top_level_tests`**：必须是从项目文件**观察到**的 `add_test(NAME ...)` 顶层测试名。用读取工具检查 CMakeLists.txt。

## 形状 2：test-spec runner（无 CTest 时的回退）

```ts
{
  kind: "test-workflow",
  version: 1,
  workflow_id: string,
  workflow_revision: number,
  runner: "test-spec",
  build_workflow_id: string,
  build_workflow_revision: number,
  test_spec: {
    kind: "test-spec",
    version: 1,
    cases: Array<{
      id: string,
      kind: "regression" | "differential",
      argv: string[],           // 禁止 NUL
      stdin: string,            // base64
      fixtures: string[],
      expect_exit_code?: number // regression 必填
    }>
  }
}
```

仅当项目**没有** CTest 套件时使用。

## 硬性校验

1. `workflow_id`/`workflow_revision` 必须等于生成 prompt 给的值
2. `build_workflow_id`/`build_workflow_revision` 必须匹配所选 BuildWorkflow
3. `runner: "ctest"` 时：`required_top_level_tests` 非空、`build_dir` 存在
4. `extra_args` 禁止 NUL
5. `runner: "test-spec"` 时：至少一个 differential case、regression 有 expect_exit_code

## 示例

```ts
export default async (ctx) => {
  const input = ctx.input as { build_workflow_id: string; build_workflow_revision: number };
  const [root] = await ctx.plan.declare([{ title: "Generate CTest workflow" }]);
  await ctx.plan.begin(root);
  try {
    return {
      kind: "test-workflow",
      version: 1,
      workflow_id: "THE_TEST_ID_FROM_PROMPT",
      workflow_revision: 1,
      runner: "ctest",
      build_workflow_id: input.build_workflow_id,
      build_workflow_revision: input.build_workflow_revision,
      build_dir: "build",
      configuration: "Debug",
      extra_args: [],
      required_top_level_tests: ["uv_test", "uv_test_a"],  // 观察自 CMakeLists add_test
      environment: {},
    };
  } finally {
    await ctx.plan.complete(root);
  }
};
```
