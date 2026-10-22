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

## 构建产物（重要）

你的 test workflow 运行时，宿主**已经在你声明的每个 build 上完成了构建**
（baseline/candidate 各一次）。因此：

- **绝不要自己 rebuild**——不要 configure、不要编译、不要创建新的 build 目录。
  需要的是**运行/检查已构建的产物**。
- 产物路径来自你的会话：build-writer 汇报的路径（或你从仓库布局推断的
  常规位置）。引用这些路径前用 `ctx.validator.assertFile(path, desc)` 断言存在；
  断言失败 → throw → 本侧失败（fail-closed）。不要"发现缺了再自己编"。
- 测试目标是**跑已构建的可执行/库并观测行为**（退出码、输出、计数），
  把这些观测用 `ctx.expect` 声明。
- 产物也可以是 BuildWorkflow 新编译的辅助程序，调用当前侧真实库或模块；先读 `verification-strategies.md`
- 每侧必须有至少一个真实观测；零声明会失败。先确认执行有效，再比较值。
  超时、崩溃、加载失败、未发现相关用例必须 throw，不能只比较两个相同错误。
  负向用例要明确检查每侧的预期错误，不要求所有测试程序都返回 0。
- 宿主会检查实际 process/fs 观测与进程状态；启动失败、超时、输出截断不能通过，
  即使 workflow 忽略状态或两侧值相等也不行。

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
  stdout: string,         // 客户端已解码的 UTF-8 文本
  stderr: string,
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
  if (suite.status !== "exited" || suite.exitCode !== 0) throw new Error("CTest failed");
  const total = /tests failed out of (\d+)/.exec(suite.stdout);
  if (total === null || Number(total[1]) === 0) throw new Error("CTest ran no tests");
  ctx.expect("ctest-count", Number(total[1]));
  // 若任务需要精确观察目标行为，再运行相关消费者/harness 或检查结构化测试输出。
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

// 错误：不检查进程有效性，两侧超时都得到 null 仍可能相等
ctx.expect("exit", run.exitCode);  // → 先检查 status 与本用例预期退出码

// 错误：expect 值含易变内容且不做归一化（UUID/时间戳导致误报不一致）
ctx.expect("stdout", rawStdout);   // → 应 expect 归一化后的值

// 错误：传 Error 对象给 plan.fail
plan.fail(id, new Error("boom"));  // → plan.fail(id, "boom")
```
