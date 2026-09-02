# TestWorkflow 自驱动规范（必读）

TestWorkflow 是一个**自驱动**工作流：默认导出的函数**自己运行测试并声明期望**。
宿主在 baseline 和 candidate 两个 worktree **各执行一次**同一份源码，然后按顺序配对
`ctx.expect` 声明并比较两侧观测值。

## 源码结构

```ts
export const workflowKind = "test-workflow-driven";   // 必须！宿主据此识别

export default async (ctx: WorkflowContext) => {
  // 1. 跑测试（process.run / adapters.ctest.run）
  // 2. ctx.expect(...) 声明期望（观测当前侧的值）
  // 3. 正常返回即完成（void）
};
```

## 执行模型（重要）

- 宿主在 **baseline 目录**执行一次，再在 **candidate 目录**执行一次
- **两侧跑的是同一份源码**，你**无法知道自己是哪一侧**——不要分支、不要探测侧
- 每次执行收集你 `ctx.expect` 声明的（name, relation, value）
- 宿主**按位置配对**两侧声明（第 1 个对第 1 个，依此类推），用 relation 比较

## ctx.expect API

```ts
ctx.expect("name", value);                      // relation = "equal"（默认）：两侧值必须相等
ctx.expect("name", "not-equal", value);         // 两侧值必须不同
ctx.expect("name", "baseline-greater", value);  // baseline 侧值 > candidate 侧值
ctx.expect("name", "baseline-less", value);     // baseline 侧值 < candidate 侧值
ctx.expect("name", "both-matches", value, "^regex$"); // 每侧各自匹配正则
```

**关键规则**：
- value 是**当前侧观测到的值**（exitCode、计数、解码后的输出等）——你永远不知道另一侧的值
- **两次数量的声明必须一致、顺序必须确定**（按位置配对！）
- 不要在**无序数据**循环里 expect；不要在 expect 前因环境不同而提前 return/throw
- 一次执行失败（throw）→ 该侧失败 → 整体失败（fail-closed）

## 跑测试的能力

| 能力 | 用法 | 说明 |
|---|---|---|
| process.run | `{ program, args, cwd?, timeoutMs? }` | program 必须是 host.tools 里 available 的工具名或工作区相对可执行路径 |
| adapters.ctest.run | `{ buildDir, configuration?, args?, timeoutMs? }` | 跑 CTest（封装 process.run ctest） |
| validator.assertFile | `(path, description?)` | 断言产物/文件存在（失败 throw） |
| plan | `declare/begin/complete/fail` | 阶段步骤（可选，少量） |

**process.run 返回值**：
```ts
{
  status: "exited" | "timeout" | "output_limit" | "spawn_error" | "stopped",
  exitCode: number | null,
  stdoutBase64: string,   // base64！要解码：Buffer.from(x, "base64").toString("utf8")
  stderrBase64: string,
  durationMs: number,
  error: string | null
}
```

## 典型形状（CTest 项目）

```ts
export const workflowKind = "test-workflow-driven";

export default async (ctx) => {
  const suite = await ctx.process.run({
    program: "ctest",
    args: ["--test-dir", "build", "-C", "Debug", "--output-on-failure"],
    timeoutMs: 120000,
  });
  // 退出码两侧应一致（0 = ctest 全过）
  ctx.expect("ctest-exit", suite.exitCode);
  const out = Buffer.from(suite.stdoutBase64, "base64").toString("utf8");
  // 输出内容两侧应一致
  ctx.expect("ctest-summary", out.replace(/[0-9]+%/g, "N%"));
  // 或只声明存在性（UUID/时间等易变内容：先归一化再 expect）
  ctx.expect("ctest-has-failures", /tests failed|failed out of/.test(out));
};
```

## 反例

```ts
// 错误：返回声明式对象（旧契约）
return { kind: "test-workflow", runner: "ctest", ... };

// 错误：尝试探测自己是哪一侧
if (process.env.SIDE === "baseline") { ... }

// 错误：在 expect 前提前 return（两侧声明数不一致）
if (x) return;   // baseline 多跑一个 expect，candidate 少跑一个

// 错误：expect 值含易变内容且不做归一化（UUID/时间戳导致误报不一致）
ctx.expect("stdout", rawStdout);   // → 应 expect 归一化后的值

// 错误：传 Error 对象给 plan.fail
plan.fail(id, new Error("boom"));  // → plan.fail(id, "boom")
```
