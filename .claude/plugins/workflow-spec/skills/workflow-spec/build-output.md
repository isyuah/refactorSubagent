# BuildWorkflow 产物规范（必读）

workflow 默认导出的函数**驱动构建本身，不返回产物对象**。构建步骤用 capabilities 执行，
产物用 `context.validator` **断言存在**。函数正常返回（void）即视为构建成功——断言失败会 throw 并使 workflow 失败（fail-closed）。

## 源码结构（workflow-driven，唯一模式）

```ts
export const workflowKind = "workflow-driven";   // 必须！宿主据此识别模式

export default async (ctx: WorkflowContext) => {
  // 1. 驱动真实构建（process.run / adapters）
  // 2. 断言每个产物存在（validator.assertFile）
};
```

**规则**：
- `export const workflowKind = "workflow-driven"` 必须出现在源码**顶层**（宿主静态检测）
- 函数**不返回任何对象**（void）。不要返回 BuildWorkflowOutput、不要声明 artifact.paths
- 产物存在性由 `validator.assertFile` 断言——断言失败 → throw → workflow 失败
- 函数必须**幂等**（宿主会重跑；configure 重复执行应是无害的）
- 产物路径可以是**运行时探测**的结果（MSVC Debug 的 `d` 后缀等），探测后断言真实路径

## validator API

```ts
await ctx.validator.assertFile(path, description?);   // 文件存在（相对工作区）
await ctx.validator.assertDir(path, description?);    // 目录存在
await ctx.validator.assertAbsent(path, description?); // 路径不存在
```

- `path` 相对工作区根，禁止 `..`、禁止绝对路径
- 断言失败抛错：`assertion failed: expected file '...' (path)`
- 每个产物都必须断言（漏断言 = 宿主无法知道它存在）

## workflow-driven 适用场景

- 项目用 make / 自定义脚本 / 多目标套件，声明式表达不了
- 需要构建多个 target（如 `uv_run_tests` + `uv_run_tests_a`）
- 产物路径需要运行后探测（如 MSVC Debug 的 `d` 后缀）

## 硬性校验（宿主会做）

1. 源码有 `workflowKind = "workflow-driven"`（否则按声明式处理）
2. 函数执行成功（无 throw）→ 视为 pass；throw → failed
3. 能力策略：process/fs/validator 都受 policy 约束（不允许写的地方断言也失败）
4. 产物存在性由函数内断言保证——宿主不再事后查 artifact.paths

## 示例（workflow-driven，多目标 CMake）

```ts
export const workflowKind = "workflow-driven";

export default async (ctx) => {
  // 1. 确认 cmake 可用（facts 总是存在）
  if (!ctx.facts.host.tools.cmake?.available) {
    throw new Error("cmake is not available");
  }
  // 2. 声明阶段级步骤（3-6 个，不要每命令一个）
  const [build] = await ctx.plan.declare([
    { id: "build", title: "Build", children: [
      { id: "build.configure", title: "Configure" },
      { id: "build.compile", title: "Compile" },
    ]},
  ]);
  await ctx.plan.begin("build");
  try {
    // 3. configure
    await ctx.plan.begin("build.configure");
    const cfg = await ctx.process.run({
      program: "cmake",
      args: ["-S", ".", "-B", "build", "-DBUILD_TESTING=ON"],
      timeoutMs: 120000,
    });
    if (cfg.status !== "exited" || cfg.exitCode !== 0) throw new Error("configure failed");
    await ctx.plan.complete("build.configure");

    // 4. 每个 target 单独 build（CMake --target 只能一个！）
    await ctx.plan.begin("build.compile");
    for (const target of ["uv_run_tests", "uv_run_tests_a"]) {
      const b = await ctx.process.run({
        program: "cmake",
        args: ["--build", "build", "--config", "Debug", "--target", target],
        timeoutMs: 600000,
      });
      if (b.status !== "exited" || b.exitCode !== 0) throw new Error(`build ${target} failed`);
    }
    await ctx.plan.complete("build.compile");
    await ctx.plan.complete("build");
  } catch (err) {
    await ctx.plan.fail("build", err instanceof Error ? err.message : String(err));  // 传字符串！
    throw err;
  }

  // 5. 断言产物存在（探测真实路径后断言，不猜）
  const has = async (p: string) => ctx.fs.exists(p);
  const app = (await has("build/Debug/uv_run_tests.exe")) ? "build/Debug/uv_run_tests.exe" : "build/Debug/uv_run_testsd.exe";
  const appA = (await has("build/Debug/uv_run_tests_a.exe")) ? "build/Debug/uv_run_tests_a.exe" : "build/Debug/uv_run_tests_ad.exe";
  await ctx.validator.assertFile(app, "shared test runner");
  await ctx.validator.assertFile(appA, "static test runner");
};
```
