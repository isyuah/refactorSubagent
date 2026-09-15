# 超时与资源阈值配置（limits）

> 状态：**已实现**（提交 `7ee9901`）。用途：任何需要调超时/资源上限的人，不用读代码。
> 实现：`src/config/limits.ts`。相关设计取舍见本文末「设计边界」。

## 0. 一句话

**时间预算默认全部不限**；要限制就写到配置文件或用命令行覆盖，一处生效、全链路读取。

为什么默认不限：为小项目调出来的 deadline 在大项目上就是误杀，而且失败表现是笼统的
`timeout`，看不出被杀的是哪一层、当时预算多少。所以默认放行，由需要护栏的项目自己开。

## 1. 快速开始

什么都不做即可：

```bash
bun run scripts/e2e-generated-workflow.ts --root <e2e-root> --session <id>
```

跑的就是内置默认值（时间预算 `null` = 不限，资源上限保留保守默认）。

## 2. 三种覆盖方式

### 2.1 项目级：`<目标仓库>/.refactor/limits.json`

只写要改的字段，其余继承。例如一个大项目：

```json
{
  "stages": { "buildMs": 900000, "ctestMs": 1800000 },
  "sessions": { "refactor": { "deadlineMs": 3600000 } },
  "resources": { "build": { "maxProcesses": 16 } }
}
```

与已有的 `.refactor/`（sessions、runs、e2e）同目录，跟着项目走。

### 2.2 用户级：`~/.refactor/limits.json`

同形状，对本机所有项目生效，被项目层逐字段覆盖。适合「这台机器慢，统一给 build 一点底气」。

### 2.3 命令行：临时覆盖，不落文件

两个 flag **所有命令都认**，可重复，后者压前者：

```bash
# 单值覆盖；null = 取消限制
bun run scripts/cli.ts workflow run wf.ts --limit stages.buildMs=900000
bun run scripts/cli.ts workflow run wf.ts --limit stages.ctestMs=null

# 额外配置层（例如题目集共享的 profile）
bun run scripts/e2e-generated-workflow.ts --root R --session s1 \
  --limits-file ./profiles/redis.json \
  --limit sessions.refactor.deadlineMs=7200000
```

`--limit k=v` 与 `--limit=k=v` 等价；`--limits-file a.json --limits-file b.json` 按序叠加。
`--limits-file` 的相对路径按**当前工作目录**解析（不是目标仓库），跨目录调用时写绝对路径更稳。

## 3. 优先级与合并语义

```
内置默认  <  ~/.refactor/limits.json  <  <repo>/.refactor/limits.json
        <  --limits-file <path>  <  --limit key.path=value
```

逐字段深度合并（不是整对象替换）：上层只写 `stages.buildMs`，不会清掉下层的 `sessions.*`。

- **缺失 = 继承**下层。
- **`null` = 显式抬升**：上层写 `null` 覆盖下层的数字，表示这一项不要限制。
- 配置文件里的 `null` 只能用于时间预算；资源上限（进程数/字节数）写 `null` 会被拒绝。

## 4. 键速查

| 键 | 含义 | 默认 |
|---|---|---|
| `sessions.testWriter.deadlineMs` | test-writer 会话总预算 | `null` |
| `sessions.refactor.deadlineMs` | refactor 会话总预算 | `null` |
| `sessions.*.stallMs` | 多久没收到任何 SDK 消息判定流死 | `180000` |
| `sessions.*.maxTurns` | 最大对话轮次 | 48 / 80 |
| `stages.buildMs` | 单次 BuildWorkflow 在某棵 worktree 上执行 | `null` |
| `stages.ctestMs` | 单次完整 CTest 套件 | `null` |
| `stages.testWorkflowMs` | 单侧自驱动 TestWorkflow 运行 | `null` |
| `stages.policyRepairs` | 产出的 workflow 源码违反源策略时，允许的打回重写次数（0 = 直接判失败） | `1` |
| `commands.processMs` | 模型没写 `timeoutMs` 时 `ctx.process.run` 的默认 | `null` |
| `commands.readyMs` | 文件 / TCP 就绪探测 | `10000` |
| `resources.build.maxProcesses` | 构建侧并发子进程上限 | `4` |
| `resources.build.maxOutputBytes` | 构建侧单进程输出上限 | `16 MiB` |
| `resources.build.maxFileBytes` | 构建侧单文件读写上限 | `64 MiB` |
| `resources.test.*` | 测试侧同上三项 | `4` / `32 MiB` / `64 MiB` |
| `probes.hostMs` | host 探测每条命令超时（含 CMake 冒烟） | `30000` |

## 5. 查看当前生效值

```bash
bun run scripts/cli.ts limits                  # 当前目录
bun run scripts/cli.ts limits /path/to/repo
bun run scripts/cli.ts limits /path/to/repo --format json
```

输出会列出**每一层的来源路径**与最终值，用来回答「到底是谁把这个值调成 180s」：

```
repo: E:\work\redis-refactor
layer: E:\work\redis-refactor\.refactor\limits.json
absent: C:\Users\Yu\.refactor\limits.json
{
  "version": 1,
  "sessions": { "testWriter": { "deadlineMs": null, "stallMs": 180000, ... }, ... },
  ...
}
```

`layer:` 是实际参与合并的文件（按合并顺序），`absent:` 是查过但不存在的层——
「文件放对了地方却写着 `absent`」通常意味着路径或文件名写错了。

## 6. 三条会咬人的约定

1. **拼错即报错，不静默继承。** 这是刻意的——否则「我明明改了却没生效」最难查。

   ```
   $ ... --limit stages.builMs=1
   Error: unknown limit override 'stages.builMs' (expected one of: buildMs, ctestMs, testWorkflowMs)

   $ # 配置文件里写错
   Error: invalid limits file <path>: stages: Unrecognized key(s) in object: 'build'
   ```

2. **`null` 是抬升，不是删除。** JSON 里写 `"ctestMs": null`，命令行写 `--limit stages.ctestMs=null`。

3. **事后可查。** 每次运行会把生效的 `limits.json`（含来源层与缺失路径）写进 session 目录，
   并打一行摘要日志：

   ```
   limits resolved: sessions: testWriter=none; refactor=3600000ms;
   stages: build=900000ms ctest=none testWorkflow=none; commands: process=none
   ```

   `session 目录里的 limits.json` = **本次实际生效的**；`cli limits` = **下一次将要生效的**。

## 7. 大项目配方（例：redis 规模）

放一份 profile，随任务集传阅/版本化，而不是散落改代码：

```json
{
  "stages": { "buildMs": 1800000, "ctestMs": 3600000, "testWorkflowMs": 3600000 },
  "sessions": {
    "testWriter": { "deadlineMs": 3600000 },
    "refactor": { "deadlineMs": 3600000 }
  },
  "resources": { "build": { "maxProcesses": 16, "maxOutputBytes": 67108864 } },
  "commands": { "processMs": 1800000 }
}
```

```bash
bun run scripts/e2e-generated-workflow.ts --root R --session redis-1 \
  --limits-file ./profiles/redis.json
```

调试期想彻底放行，再叠一层 `--limit stages.ctestMs=null`。

## 8. 设计边界（哪些不该在这里配）

- **SDK 死流看门狗 `stallMs` 保留默认且不建议关**。它检测的是「SDK 子进程被杀了」，
  不是「项目跑得慢」——关掉它，进程被杀时宿主会一直干等。
- **就绪探测 `readyMs` 保持短**。它等的是 socket/文件出现，不是等工作完成。
- **`timeoutMs` 写在 workflow 源码里仍然优先**。宿主给的是默认值，模型显式写的单次预算仍然生效；
  但提示词里已不再给模型可照抄的示例数字，避免配置被抄死的常量盖过。
- **结构上限（进程数/字节数）默认非 `null`**。它们不是时间预算，放开会导致失控，需要时显式调大。

## 9. 实现位置（改代码时看这里）

| 文件 | 角色 |
|---|---|
| `src/config/layers.ts` | 多源引擎：层路径、深合并、`key.path=value` 覆盖、来源记账 |
| `src/config/limits.ts` | limits 域：schema、默认值、`--limit` 值解析、`extractLimitArgs` |
| `src/config/pipeline.ts` | 阶段来源域（同引擎的第二域），见 [`stage-flow.md`](stage-flow.md) |
| `src/runtime/stage-flow.ts` | 运行开始时解析并写入 `limits.json` + 日志 |
| `src/runtime/workflow-pipeline.ts` | stages 预算与两份 policy 的资源上限来源 |
| `src/workflow/capabilities.ts` | `processTimeoutMs` / `readyTimeoutMs` 落到子进程与探测 |
| `src/agents/{driver,refactor,workflow-session}.ts` | 会话预算（deadline / stall / maxTurns） |
| `src/runtime/ctest-runner.ts`、`src/workflow/runner.ts` | 套件与 workflow 总预算（`null` 即不设定时器） |

叶子层**不再有** `?? 60_000` 之类的兜底：`undefined` 一律表示「不限」，
遗漏接线会由 `tsc` 报出来（参数是必填的）。
