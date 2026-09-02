# Workflow API 精确规范（必读）

## 类型来源（重要）

**不要自己声明 interface**。宿主在 workflow 文件同目录写入 `types.d.ts`，包含所有精确类型。
使用 type-only import 引用：

```ts
import type { WorkflowContext, ProcessResult } from "./types";
```

- type-only import 在运行时被擦除，worker 注入真实对象——安全
- 需要类型的地方（函数参数、变量注解）都用 `./types` 里的
- **禁止** `import type` 之外的任何 import（不能 import 值）

默认导出的函数接收一个 `WorkflowContext`。以下是它的**完整接口**——每个字段的类型、必填性、作用。

## WorkflowContext

```ts
interface WorkflowContext {
  apiVersion: 1;                        // 固定为 1
  workspaceRoot: string;                // 工作区绝对路径（只读，不要硬编码进产物）
  input: unknown;                       // 宿主注入的输入对象
  facts: {
    host: HostPreflight;                // 宿主测量事实（见下）——总是存在
    project: ProjectDetection;          // 项目探测结果（见下）——总是存在
  };
  // capabilities（见下）——通过它们做所有 IO，禁止直接 import
  fs: WorkflowFilesystem;
  process: WorkflowProcess;
  tools: WorkflowTools;
  adapters: WorkflowAdapters;
  validator: WorkflowValidator;
  plan: WorkflowPlanApi;
  expect: WorkflowExpectApi;
}
```

## facts.host（HostPreflight，总是存在）

```ts
{
  platform: "win32" | "linux" | "darwin";   // 当前平台
  arch: string;                              // 如 "x64"
  executable_suffix: string;                 // win32 是 ".exe"，否则 ""
  shell: string;                             // 检测到的 shell
  tools: Record<string, {                    // 工具探测结果
    available: boolean;                      // 是否在 PATH 上（唯一事实来源）
    path: string | null;                     // 绝对路径（available=true 时非 null）
    version: string | null;
  }>;
  cmake: {                                   // cmake 详细探测
    version: string | null;
    generators: string[];                    // 可用生成器
    default_generator: string | null;
    c_compiler: string | null;
    configure_probe: "pass" | "fail" | "not-run";
    build_probe: "pass" | "fail" | "not-run";
  };
}
```

**规则**：工具可用性**只能**看 `host.tools[name].available`。不要假设工具存在。

## facts.project（ProjectDetection，总是存在）

```ts
{
  kind: "project-detection";
  version: 1;
  repo_root: string;
  language: string;                         // 如 "c"
  build_systems: string[];                  // 如 ["cmake"]
  primary_build_system: string | null;      // 如 "cmake"
  markers: string[];                        // 如 ["CMakeLists.txt"]
  source_files: string[];
  adapter: "direct-compiler" | "cmake" | "ninja" | null;
  status: "ready" | "needs-adapter" | "unsupported";
  reason: string;
}
```

**规则**：`facts.project` 和 `facts.host` **总是存在**。如果 workflow 需要它们，直接访问，不要做存在性检查后抛"missing facts"。

## capabilities

### fs（WorkflowFilesystem）

| 方法 | 签名 | 作用 |
|---|---|---|
| readFile | `(path, encoding?: "utf8"\|"base64") => Promise<string>` | 读文件（工作区内） |
| writeFile | `(path, content, encoding?: "utf8"\|"base64") => Promise<void>` | 写文件（工作区内，受策略限制） |
| mkdir | `(path) => Promise<void>` | 建目录（递归） |
| exists | `(path) => Promise<boolean>` | 检查存在 |
| readdir | `(path) => Promise<string[]>` | 列目录（仅名字） |
| snapshot | `(path?) => Promise<Record<string, string>>` | 目录哈希快照 |
| diff | `(path, before) => Promise<FsEffect[]>` | 对比快照差异 |

**路径规则**：所有路径相对工作区根，禁止 `..` 逃逸，禁止绝对路径。

### process（WorkflowProcess）

```ts
// 运行一次性命令（最常用）
run(spec: {
  program: string;          // 测量的工具名（如 "cmake"）或工作区相对可执行路径
  args?: string[];          // argv 数组——无 shell，禁止 "&&" "|" 等
  cwd?: string;             // 相对工作区，默认 "."
  stdinBase64?: string;
  env?: Record<string, string>;   // 只能覆盖允许的键
  timeoutMs?: number;       // 宿主默认 60s
  maxOutputBytes?: number;
}): Promise<{
  status: "exited" | "timeout" | "output_limit" | "spawn_error" | "stopped";
  exitCode: number | null;   // 用 status==="exited" && exitCode===0 判断成功
  signal: string | null;
  stdoutBase64: string;      // base64 编码的 stdout
  stderrBase64: string;
  durationMs: number;
  error: string | null;
}>;

// 长进程（服务）模式
start(spec: {...same, ready?: {kind:"none"|"tcp"|"file", ...}}) => Promise<{id: string}>;
wait(handle, timeoutMs?) => Promise<ProcessResult>;
stop(handle) => Promise<ProcessResult>;
```

**规则**：
- 判断成功：`result.status === "exited" && result.exitCode === 0`，不要只看 exitCode
- stdout/stderr 是 **base64**，需要时自己解码
- program 必须是 `host.tools` 里 available 的工具名，或工作区相对路径

### tools（WorkflowTools）

```ts
available(name: string): Promise<boolean>;   // 工具是否可用
list(): Promise<{name: string; path: string}[]>;  // 列出可用工具
```

### adapters（WorkflowAdapters，便捷封装）

```ts
adapters.cmake.configure({ sourceDir?, buildDir, generator?, flags? });
adapters.cmake.build({ buildDir, target?, flags? });
adapters.ninja.build({ buildDir?, target?, flags? });
adapters.ctest.run({ buildDir, configuration?, args?, timeoutMs? });
adapters.compiler.compile({ compiler?, args, cwd?, timeoutMs? });
```

这些只是 `process.run` 的封装。需要精细控制（多目标等）时直接用 `process.run`。

### validator（WorkflowValidator，产物断言）

```ts
assertFile(path: string, description?: string): Promise<void>;   // 断言文件存在，否则 throw
assertDir(path: string, description?: string): Promise<void>;    // 断言目录存在
assertAbsent(path: string, description?: string): Promise<void>; // 断言路径不存在
```

**规则**：
- **构建类 workflow 必须用它断言每个产物存在**（如 `assertFile("build/Debug/app.exe", "test runner")`）
- 断言失败 → throw → workflow 失败（fail-closed）
- 这是**替代旧返回值 artifact 声明**的方式：**不需要返回产物清单**，函数正常返回即视为成功（断言已保证）

示例：
```ts
await validator.assertFile("build/Debug/uv_run_tests.exe", "shared test runner");
await validator.assertFile("build/Debug/uv_run_tests_a.exe", "static test runner");
```

### expect（WorkflowExpectApi，双侧声明比较——仅自驱动 TestWorkflow）

宿主在 baseline 和 candidate **各执行一次**同一份 TestWorkflow，按**位置配对**两侧的 expect 声明并比较：

```ts
ctx.expect("name", value);                      // 两侧值相等（默认 equal）
ctx.expect("name", "not-equal", value);         // 两侧值不同
ctx.expect("name", "baseline-greater", value);  // baseline 侧 > candidate 侧
ctx.expect("name", "baseline-less", value);     // baseline 侧 < candidate 侧
ctx.expect("name", "both-matches", value, "^regex$");  // 每侧各自匹配正则
```

**规则**：
- value 是**当前侧**观测值；你永远不知道另一侧的值
- 两侧声明**数量一致、顺序确定**（按位置配对）——不要在无序循环里 expect、不要在 expect 前因环境分支提前返回
- 不一致 → 验证失败（fail-closed）
- Build workflow 不要用 expect（它是单次执行）

### plan（WorkflowPlanApi，可观测步骤）

```ts
declare(steps: Array<{
  id?: string;                // 可选！全局唯一的文字 id（推荐给，如 "configure"）；不给则宿主自动分配
  title: string;              // 必填
  description?: string;
  children?: Array<{ id?: string; title: string; description?: string; children?: ... }>;  // 可嵌套
}>): Promise<string[]>;       // 返回 id（根 id 按树顺序）；给了 id 就返回它，没给返回宿主的自动 id

begin(id: string): Promise<void>;    // 标记开始（必须 pending 状态）
complete(id: string): Promise<void>; // 标记完成（必须 running）
fail(id: string, error: string): Promise<void>;  // 标记失败（error 必须是 string！）
```

**规则**：
- **id 推荐由你（workflow 作者）提供**，必须是**全局唯一**的文字 id（跨整个树、含子步骤）；不提供时宿主自动分配（`p1`/`父id.序号`）
- `declare` 返回实际生效的 id——直接用它标记，不要拼接、不要猜
- `fail` 的 error **必须是字符串**——传 Error 对象会被拒绝（宿主会 String() 化，但不要依赖）
- 步骤数保持少量（几十个以内）

示例：
```ts
const [build, test] = await plan.declare([
  { id: "build", title: "Build", children: [
    { id: "build.configure", title: "Configure" },
    { id: "build.compile", title: "Compile" },
  ]},
  { id: "test", title: "Test" },
]);
await plan.begin("build");
await plan.begin("build.configure");
await plan.complete("build.configure");
await plan.complete("build");
await plan.begin("test");
await plan.complete("test");
```

## 反例（这些写法会被拒绝）

```ts
// 错误：直接访问宿主 API
import { execSync } from "child_process";

// 错误：shell 字符串
process.run({ program: "make && make install" });

// 错误：stdout 当字符串用（实际是 base64）
const out = result.stdoutBase64;
if (out.includes("error")) ...

// 错误：plan.fail 传 Error
plan.fail(id, new Error("boom"));   // → 应传 plan.fail(id, "boom")

// 错误：假设工具存在
process.run({ program: "make" });   // → 应先 tools.available("make") 或查 host.tools

// 错误：访问不存在的 facts 字段
context.facts.project.target  // → ProjectDetection 没有 target 字段
```
