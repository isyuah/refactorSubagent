# E2E 慢问题排查与修复主线记录（2026-09-03）

> 用途：汇报主线。背景是声明制 e2e（test-writer/build-writer 子 agent 生成 workflow）
> 完成后重跑，发现**异常慢**——简单 C 项目 + 已知很快的 DeepSeek，却跑不完。

## 1. 起点：现象与矛盾

- e2e 项目：`scripts/e2e-generated-workflow.ts` 生成的 **trim 微型 demo**（5 个源文件，
  临时目录），任务极简单。
- 模型：**DeepSeek V4 flash**，本人日常使用 **100+ token/s**，单轮请求应几秒返回。
- 现象：e2e 一次要 **20-30 分钟甚至超时**，WORKFLOW_SESSION 阶段动辄十几分钟无进展，
  早期甚至 311 条日志全是 heartbeat（无内部事件）。

**矛盾**：模型快、任务简单，为什么这么慢？如果"直接看"能分析出来，AI 早分析了——
**问题恰恰是不可观测**：workflow-session 内部（test-writer 的 tool_use、子 agent 启停、
模型轮次）完全无日志。

## 2. 第一层修复：可观测性（日志化改造）

**决策**：先让"慢"能被看见，再谈分析。做了三件事：

1. **pino 级别化日志**（`src/runtime/log.ts` 重写 E2ELogger）
   - `trace`：完整 AI 会话（含 tool_result payload）
   - `debug`：会话骨架（tool 名、轮次、耗时、结果状态，去 payload）
   - `info`：宿主阶段/决策/错误
   - 级别由 `RFR_LOG_LEVEL` 控制，e2e 用 debug 跑。
2. **SDK 会话事件透传**（driver.ts 的 `logSessionEvent`）
   - 原来 SDK query 流只取 result，**丢弃全部中间消息**——这是"311 条纯 heartbeat"
     的根因。现在每个 assistant/user/result 消息按级别写入 run.jsonl。
3. **完整会话镜像**（`FileSessionStore`，sessions/<id>/*.jsonl）
   - SDK 的 sessionStore 适配器，把完整 transcript（含子 agent）落盘，**独立于日志级别**，
     事后可逐条看 AI 说了什么、调了什么工具、每轮间隔多久。
   - eager flush：中断也能拿到完整会话。

**产出**：run.jsonl 有每轮工具调用 + 时间戳；sessions/ 有完整对话 + 子 agent transcript。
从时间戳差可精确算出**每轮模型调用的墙钟**。

## 3. 第二层：用日志定位慢点

拿到细粒度日志后，逐轮间隔分析发现：

- 子 agent（build-writer）每轮 3-7s——**模型层正常**（与个人体验一致）。
- 但 Explore 子 agent **单次执行 104 秒**，内部 228 行 transcript、90 次工具调用：
  **39 次 Glob + 30 次 Grep + 20 次 Read**，探测一个 5 文件项目。

**关键转折**：看 Explore 的 thinking 过程，发现它不是蠢，是**被我们的 scope 限制逼疯**：
- Explore 第一轮就想 `Glob **/*` 看全貌 → 被 hook 拒（"search root is outside
  Observation Scope"）——**15 次拒绝**。
- 它没有 Bash（Explore 工具集不含），Glob 又被废 → 只能 Read 猜路径。
- Read 到 readable 白名单外的路径又被拒——**8 次**。
- 被反复拒绝后陷入"猜路径"死循环：读 README.md、Makefile、src/CMakeLists.txt、
  definitely-does-not-exist-xyz.txt…全是不存在的猜测。

**结论**：慢的根因不是模型，是 **Glob/readable 白名单模型与 agent 真实用法冲突**：
- Glob 根目录递归（`**/*`，空前缀）永远走 path 根检查，根不在白名单 → 永远拒。
- readable 是"文件 glob 白名单"，模型想看目录结构/全貌必然碰壁。
- 各会话 readable 不含根目录文件（README、Makefile 等），Explore 想看全貌必然越界。

同时排除了两个外部嫌疑（有日志证据）：
- cc-switch 日志：请求几秒一个、SSE 首包秒回——代理正常。
- 你的请求列表：90-145 tok/s——模型正常。

## 4. 第三层：放开 scope，验证假设

**决策**：先放开所有工具限制（`enforceScope: false` 跳过 PreToolUse hook，含路径
归一化），跑通流程后重新收紧。改动极小：hook 回调开头一个开关，穿透到 driver。

**效果立竿见影**：
- build-writer 工具使用从"39 Glob + 30 Grep + 20 Read 猜路径"变成
  **1 Glob + 4 Read + 1 generate**。
- e2e 从"test-writer 阶段 20 分钟+ 还卡"变成 **10 分钟跑完 WORKFLOW_SESSION +
  REFACTOR + BASELINE_BUILD**，直达验证阶段。

## 5. 当前状态与最后障碍

放开后流程推进到 **BASELINE_TEST_WORKFLOW**，新错误：
`absolute executable paths are not allowed: ...worktrees/baseline/build/Debug/trim_app.exe`

根因：test-workflow 用 `ctx.workspaceRoot` 拼**绝对路径**执行 build 产物（它在 baseline/
candidate 两个 worktree 跑，只能从 ctx.workspaceRoot 定位自己），宿主 resolveProgram
却**拒绝一切绝对路径**、只收相对路径。契约不清晰——ctx 给了 workspaceRoot，模型自然拼
绝对路径。

**修复（已提交 4f6da6e）**：resolveProgram 接受 workspace 内的绝对路径，归一化为相对
路径后走原检查。测试通过。

## 6. 结论与经验

1. **"慢"的第一责任人是不可观测性**——没有细粒度日志，再快的模型也像黑盒。日志化
   改造（级别化 + 完整会话镜像）是定位一切的前提。
2. **不要急着怪模型/网络**——cc-switch 和请求列表都证明模型层正常；真正的坑在
   **宿主自己的 scope 策略**把 agent 逼进死循环。
3. **scope 白名单与 agent 真实用法冲突**是设计缺陷：Glob 根递归、目录读取是 agent
   基本操作，文件级白名单模型不支持它们。
4. **跑通优先**：先放开（enforceScope: false），验证全链，再重新设计收紧策略。

## 相关 commit

```
4f6da6e fix(capabilities): accept in-workspace absolute executable paths
b634209 feat(scope): add enforceScope switch to bypass PreToolUse hook
6c54aa7 (reverted 673bd9c) thinking 禁用 —— 回滚，DeepSeek 需要思考
b522a64 fix(prompt): forbid imports in TEST_WORKFLOW_SYSTEM
3bf3e4d fix(workflow): expose decoded stdout/stderr to workflow source
11055b9 fix(verification): allow test workflow to run declared build artifacts
461dd9e fix(refactor): raise maxTurns + steer prompt
eb45644 fix(pipeline): store test-workflow source as text
42b9bf3 fix(scope): editable write wins over forbidden
7943c0e fix(scope): allow Glob/Grep pattern targeting readable subtree
c3cd0a7 fix(session-scope): let test-writer read existing tests
c0383c1 fix(build-writer): declare dep-registry MCP server
3bb0cce fix(driver): stall watchdog for hung SDK stream
dcbda7d chore(deps): bump claude-agent-sdk to 0.3.259
```
