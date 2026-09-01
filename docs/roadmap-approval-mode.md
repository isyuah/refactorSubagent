# Roadmap：Workflow 审批模式（Approval Mode）

> 状态：**已记录，未实现**（2026-09-01 讨论，用户明确"这次先不做，比较复杂"）
>
> 关联：`docs/` 下本文件；实现时参考 `src/workflow/` 现有 capability 协议。

## 1. 目标

让 workflow 声明"某些能力调用需要人工审批"。审批模式下，超出安全范围的调用不再直接 fail-closed 拒绝，而是**挂起等待用户批准/拒绝**。

典型场景：

- 自动执行程序（CI）：与现状一样，白名单内直接放行
- 交互式程序：workflow 声明"我需要运行 `make`（不在白名单）"，用户同意后放行

## 2. 核心机制

```
workflow 源码:
  context.permissions.request({ scope: "process.make", reason: "运行 make 构建" })

→ 主进程 broker 收到 permission-request
→ 策略判定:
    ├─ allowedTools 白名单内 → 自动批准（无需人工）
    ├─ 声明了审批且环境有审批通道 → 挂起等待用户
    │    ├─ CLI 提示 / Dashboard 弹窗（SSE 推送）
    │    ├─ 批准 → 放行该 scope 的后续调用
    │    └─ 拒绝 → 该调用报错（fail-closed）
    └─ 声明了审批但环境无审批通道 → 直接报错
        "workflow requires approval for X but no approval channel is available"
```

## 3. 关键设计点（讨论已确认）

| 设计点 | 方案 |
|---|---|
| 如何声明 | workflow 源码显式 `permissions.request(...)`，或 manifest 声明式 `required_permissions: ["process.make"]`（可预检） |
| 如何传递消息 | 复用现有 JSONL 通道，加 `permission-request` envelope；worker 的请求需**挂起等待**（现有 `pending` Map 已支持等待，审批 = 主进程先问用户再响应） |
| provided workflow 声明审批但运行环境没有审批者 | **fail-closed 报错**（与 fail-closed 哲学一致） |
| 白名单语义 | `allowedTools` 白名单 = 自动批准；白名单外 + 声明审批 = 走审批 |

## 4. 与现有架构的契合度

| 现有 | 审批模式 |
|---|---|
| `WorkflowCapabilityPolicy.allowedTools` 白名单 | 白名单 = 自动批准；白名单外 + 声明审批 = 走审批 |
| broker 单一响应 | 增加"需要审批"的挂起状态 |
| fail-closed 原则 | 无审批通道时拒绝，天然契合 |
| Dashboard SSE | 审批请求可推送到 Dashboard |

## 5. 工作量预估

中（protocol + broker 状态机 + 审批 UI）。需新协议类型、broker 挂起机制、审批 UI（CLI/Dashboard）。

## 6. 未决问题（实现前需确认）

- 审批粒度：scope 级（`process.make`）还是调用级（具体命令）？
- 审批是"一次性允许"还是"会话内记住"？
- workflow 如何声明"我需要审批通道"？manifest 字段名与 Schema 演进
- 超时：用户长时间不响应，workflow 挂起多久？超时后 fail-closed 还是继续等？

## 7. 与其他 roadmap 项的关系

- 依赖 `plan 声明`（可视化）落地——审批请求的 UI 展示可复用 plan 的步骤树
- 与 `workflow-driven` 构建（L1）正交，可独立实现
