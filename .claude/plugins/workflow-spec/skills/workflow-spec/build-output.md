# BuildWorkflowOutput 精确 Schema（必读）

workflow 默认导出的函数**必须返回**下面这个形状的对象。字段名、类型、嵌套**完全一致**，多余字段会被拒绝。

## 完整形状

```ts
{
  kind: "build-workflow-output",        // 字面量，固定
  version: 1,                           // 字面量，固定
  workflow_id: string,                  // 生成 prompt 给的精确 id（硬编码，禁止从 context 读）
  workflow_revision: number,            // 生成 prompt 给的精确 revision（正整数）
  environment: {
    kind: "environment-spec",           // 字面量，固定
    version: 1,
    build: BuildSpec,                   // 见下——4 选 1
    sanitizers: [],                     // 通常空数组
    determinism: {
      frozen_time_epoch_ms: number | null,
      random_seed: number | null,
      intercept_headers: []             // 通常空数组
    },
    sandbox: {
      run_cwd_strategy: "fresh_temp_dir"   // 字面量，固定
    }
  },
  artifact: {
    kind: "executable" | "library" | "test-suite" | "service" | "custom",
    version: 1,
    workflow_id: string,                // 必须等于顶层 workflow_id！
    workflow_revision: number,          // 必须等于顶层 workflow_revision！
    paths: Record<string, string>,      // 逻辑名 → 相对路径（至少 1 个）
    metadata: Record<string, unknown>   // 可选
  }
}
```

## BuildSpec（environment.build，4 选 1）

### 1. `direct-compiler`（单文件直接编译）

```ts
{
  kind: "direct-compiler",
  compiler: string,        // 测量的编译器名（如 "gcc"）
  flags: string[],         // 编译 flags
  defines: Record<string, string>,
  sources: string[],       // 相对路径源文件（至少 1）
  output: string           // 相对产物路径
}
```

仅用于 `project.adapter === "direct-compiler"` 的项目。

### 2. `cmake`（声明式 CMake）

```ts
{
  kind: "cmake",
  source_dir: string,       // 默认 "."
  build_dir: string,        // 默认 "build"
  generator: string | null, // null = 让 CMake 选
  target: string | null,    // null = 默认 all 目标；只能一个目标名
  configure_flags: string[],
  build_flags: string[],
  output: string            // 期望产物相对路径
}
```

**注意**：`target` 是**单个**字符串。要构建多个目标，用 `workflow-driven`（见下）分别 `process.run`。

### 3. `ninja`（声明式 Ninja）

```ts
{
  kind: "ninja",
  build_dir: string,        // 默认 "."
  target: string | null,    // null = 默认目标
  build_flags: string[],
  output: string
}
```

### 4. `workflow-driven`（函数自主驱动构建）

```ts
{
  kind: "workflow-driven"
  // 没有其他字段！构建逻辑在函数体里，用 capabilities 跑
}
```

选择 `workflow-driven` 的场景：
- 项目用 make / 自定义脚本 / 多目标套件，声明式表达不了
- 需要构建多个 target（如 `uv_run_tests` + `uv_run_tests_a`）
- 产物路径需要运行后探测（如 MSVC Debug 的 `d` 后缀）

**workflow-driven 规则**：
- 函数体里用 `context.process.run` 跑真实构建命令
- 产物路径**运行时探测**（用 `fs.readdir`/`fs.exists` 找真实产物），不要猜
- 返回的 `artifact.paths` 必须是**实际存在**的路径（宿主会校验）
- 函数必须幂等（宿主会重跑）
- 返回前若产物找不到 → throw 清晰错误（fail-closed），不要返回部分/猜测对象

## 硬性校验（宿主会做）

1. `artifact.workflow_id === workflow_id`（不一致拒绝）
2. `artifact.workflow_revision === workflow_revision`
3. `artifact.paths` 所有路径相对、工作区内、无 `..`
4. 声明式 kind：构建后宿主校验产物**存在**
5. workflow-driven：宿主重跑函数，校验函数返回的产物**存在**

## 示例（workflow-driven，多目标 CMake）

```ts
export default async (ctx) => {
  // 1. 确认 cmake 可用（host.facts 总是存在）
  if (!ctx.facts.host.tools.cmake?.available) {
    throw new Error("cmake is not available");
  }
  // 2. 声明步骤（可选但推荐）——id 自己取，全局唯一
  await ctx.plan.declare([
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

  // 5. 探测产物（用 readdir/exists 找真实路径）
  const has = async (p: string) => ctx.fs.exists(p);
  const app = (await has("build/Debug/uv_run_tests.exe")) ? "build/Debug/uv_run_tests.exe" : "build/Debug/uv_run_testsd.exe";
  const appA = (await has("build/Debug/uv_run_tests_a.exe")) ? "build/Debug/uv_run_tests_a.exe" : "build/Debug/uv_run_tests_ad.exe";

  return {
    kind: "build-workflow-output",
    version: 1,
    workflow_id: "THE_ID_FROM_PROMPT",
    workflow_revision: 1,
    environment: {
      kind: "environment-spec",
      version: 1,
      build: { kind: "workflow-driven" },
      sanitizers: [],
      determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    },
    artifact: {
      kind: "executable",
      version: 1,
      workflow_id: "THE_ID_FROM_PROMPT",
      workflow_revision: 1,
      paths: { uv_run_tests: app, uv_run_tests_a: appA },
      metadata: {},
    },
  };
};
```
