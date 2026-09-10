# 声明制 e2e 验证状态记录（2026-09-03）

> 状态：**声明制主流程 e2e 未跑通**。卡在 test-writer 会话超时，根因未定位。
> 日志化改造（pino 级别化 + 完整会话镜像）**已完成**，下一步是用新日志重跑 e2e 定位耗时。

## 1. 结论先行

- 声明制（subagent-driven workflow）的**代码改造已完成并通过单测**（无 AI），但**端到端真实运行从未成功**。
- 连续 4 轮 e2e（`e2e-generated-workflow.ts`，trim-app 小项目）全部 ABORTED。
- 前 2 轮死在旧 analyze（AI 产 5 份 JSON schema）：一次结构化输出 5 次失败、一次超时。
- 第 3、4 轮在 analyze 改为纯探测后**越过 ANALYSIS，进入 WORKFLOW_SESSION**，但 **test-writer 会话 30 分钟超时**，未产出 test workflow。
- 缺真 AI 的针对性测试：workflow-session 单测用 mock runner，未验证真实模型行为。

## 2. 历轮 e2e 结果

| 轮次 | 配置 | 结果 | 失败点 | 原因 |
|---|---|---|---|---|
| e2e-1 | analyze AI 版 | ABORTED (218s) | ANALYSIS | Claude 结构化输出 5 次失败（SDK outputFormat json_schema） |
| e2e-2 | analyze AI 版 | ABORTED (819s) | ANALYSIS | Request timed out（AI 产 5 JSON 太慢） |
| e2e-3 | analyze 纯探测 | ABORTED (603s) | WORKFLOW_SESSION | test-writer 10 分钟超时；消息称"background agents still running" |
| e2e-4 | +30min 超时 | ABORTED (1819s) | WORKFLOW_SESSION | test-writer 30 分钟超时，无产出 |

## 3. 关键观察

### 3.1 analyze 纯探测改造有效
- 纯探测版（analyze.ts 重写，宿主程序化探测，不再调 AI 产 JSON）**解决了 ANALYSIS 卡死**——第 3、4 轮 ANALYSIS 11 秒完成。
- 旧 AI 版保留在 `analyze-legacy.ts`（legacy agent-pipeline 仍编译引用）。

### 3.2 test-writer 会话是唯一瓶颈
- 第 4 轮：PREFLIGHT 2ms → ANALYSIS 11s → **WORKFLOW_SESSION 08:54:53 起到 09:24:55 超时（30 分钟整）**。
- session 内 311 条日志事件**全是 heartbeat**（每 5 秒"still running"）——**无任何内部进度**：看不到 test-writer 调了哪些工具、派了几个子 agent、每轮耗时、卡在哪。

### 3.3 可观测性缺失（核心问题）
- workflow-session 内部（test-writer 的 tool_use、subagent 启停、模型轮次）**没有日志**。
- 无法判断 30 分钟花在哪：
  - test-writer 在正常多轮协作（inspect → 派 build-writer → 等 → 写文件）但每轮很慢？
  - 还是卡死循环（build-writer 反复失败重试 / 后台 agent 等待死锁 / 模型空转）？
  - 第 3 轮失败消息提到 test-writer 派了 build-writer + general-purpose 两个后台 agent "still running"——疑似**父 agent 等后台子 agent 结果但子 agent 未完成/未回传**，或 Task 工具默认 background 导致父不等待。
- 这是下一步日志化改造要回答的问题。

### 3.4 已做的修复（均未验证有效）
- analyze 改纯探测（有效，见 3.1）
- test-writer forbidden 放宽（可读 test/**，之前被 sandbox 挡）
- SESSION_PROMPT 加"前台等待子 agent、不要后台派发后结束"指引
- e2e workflowTimeoutMs 600s → 1800s

## 4. 已知但未做的事（按用户指示停在此处）

- [x] 日志化改造：workflow-session/test-writer 内部事件（tool_use、subagent、耗时）入日志（已完成，见本节末"日志化改造记录"）
- [ ] 查证"简单 e2e 为何 30 分钟跑不完"（test-writer 到底在做什么）
- [ ] 真 AI 冒烟测试（只跑 workflow-session 一次验证产出，不跑全链）
- [ ] 修复后重跑 e2e 看后续错误
- [ ] analyze 正式方案设计（当前纯探测 + 宿主默认制品是临时方案，默认制品 `defaultContract/defaultDeps/defaultTests` 仅用于过状态机门禁，非正式版）

## 5. 相关 commit

```
48dfbd8 test(e2e): raise workflow session timeout to 30min for subagent round trips
7b13c94 fix: test-writer reads existing tests; session prompt forces foreground subagent waits
07902c7 feat: host-side probe analysis (no model round trip) for declared-mode flow; legacy analyze isolated
```

## 6. 复现方式

```bash
bun run scripts/e2e-generated-workflow.ts --session <任意id>
# 预期：30 分钟后 ABORTED，日志见 session-root/.refactor/e2e/<id>/run.jsonl
# 观察点：WORKFLOW_SESSION 阶段只有 heartbeat，无内部事件
```

---

## 7. 日志化改造记录（2026-09-03）

### 背景
旧 `E2ELogger` 是自定义 JSONL（`event/level/elapsed_ms/details` schema），只被
dashboard 消费；`runAgent` 的事件流只取 `result`，丢弃全部中间 SDK 消息，导致
WORKFLOW_SESSION 阶段 311 条事件全是 heartbeat——看不到 test-writer 内部。
dashboard 确认不是产品部分，其 schema 不再是契约。

### 改动
- **pino 接入**（`package.json` + `src/runtime/log.ts`）：`E2ELogger` 改为 pino 包装，
  写 `run.jsonl`（pino 行格式 `{level,time,run_id,event,phase,msg,...}`）+ `state.json`(version 2)。
  级别默认 `info`，`RFR_LOG_LEVEL=trace|debug|info|warn|error` 覆盖（`resolveLogLevel`）。
  `e2e-log.ts` 保留为转发入口，调用点零改动。
- **级别语义**（用户定义）：
  - `trace` — 全量 AI 会话（含 tool_result payload）
  - `debug` — 会话骨架：tool 名、轮次、耗时、结果状态（去 payload）
  - `info` — 不保存会话内部，只记阶段/决策/错误
- **会话事件透传**（`src/agents/driver.ts`）：`runAgent` 遍历 SDK query 流时对每个
  `assistant`/`user`/`result` 消息调 `logSessionEvent(logger, msg)` 按级别写入。
- **完整会话镜像**（`src/runtime/session-store.ts` 新增 `FileSessionStore`）：
  SDK `sessionStore` 适配器，把完整 transcript 落盘到
  `<runDir>/sessions/<sessionId>/main.jsonl`（子 agent 在 `subagents/` 子路径），
  独立于 pino 级别、按 uuid 去重。这样"看具体会话内容"不依赖开 trace。
- **接线**：`workflow-agent-pipeline` 建 `FileSessionStore(logger.runDir)`，传给
  `runDeclaredResolution`→`runWorkflowSession`→driver；`runRefactor` 也接
  logger/sessionStore。

### 验证
- `bun test`：122 pass（唯一失败是预存在的 libuv 测试数据缺失，与本次无关）。
- 冒烟（模拟 SDK 消息，无真 AI）：
  - info 级：run.jsonl 无任何 session 内部行。
  - debug 级：assistant 消息带 `tool_names`、`text_block_count`、`num_turns`、
    `duration_ms`；user 消息带 `has_tool_result`/`tool_result_error`，**无 payload**。
  - trace 级：tool_use input 与 tool_result 内容全量写入。
  - sessionStore：完整消息落盘，重复 uuid 跳过。
### 宿主侧边界计时（2026-09-03，方案1）

在 `workflow-agent-pipeline.ts` 给每个宿主阶段加 `timed`/`timedAsync` 包装
（仅成功时记 `<what> completed` + `duration_ms`），覆盖：

| 阶段 | 记录点 | 说明 |
|---|---|---|
| host probe | `host probe completed` | 11 工具探测 + CMake 冒烟耗时 |
| project detection | `project detection completed` | — |
| host-side analysis probe | `host-side analysis probe completed` | 纯探测耗时 |
| test-writer session | `test-writer session wall time` | 整段墙钟(配合 heartbeat 与 result.duration_ms) |
| branch + worktree | `branch + worktree creation completed` | git branch + 双 worktree add |
| refactor agent | `refactor agent session completed` | 整个 refactor 会话墙钟 |
| workflow verification | started/completed 对 | 全部 build + ctest 两侧总耗时 |
| worktree cleanup | `worktree cleanup completed` | finally 清理耗时 |

原先 `probeHost`/worktree/cleanup 完全黑盒（preflight 实测 10.7s 看不到内部分解），
现在 run.jsonl 的 `duration_ms` 可逐段定位"慢在哪"。

### 下一步（未做）
- [ ] 用新日志重跑 e2e（`RFR_LOG_LEVEL=debug` + 读 sessions/ 下的完整会话）定位
      test-writer 30 分钟花在哪。

