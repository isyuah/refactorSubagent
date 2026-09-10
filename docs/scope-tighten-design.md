# Scope 收紧方案:目录级读写 + 按会话分配写权

> 状态:设计评审稿(未实现)。背景:b634209 全放开(`enforceScope=false`)后 e2e 跑通,
> 需要把权限收回来而不让"探索被拒→猜路径→死循环"的慢问题复发。
> 时间:2026-09-04。

> **最终裁决(2026-09-04,提交 66f462e):本方案未落地,机制被整体移除。**
> 评审中确认两点:① editable_files 要求宿主预声明"重构可改哪些文件",
> 对真实拆分型重构不可行(宿主无法预知拆成几个文件);② 读放开后 Grep 与
> Read 内容面等价,单独拦 Grep 无增益。最终决策:scope-manifest /
> checkToolScope / R4 / SCOPE_READY 全部删除,agent 边界只剩 SDK
> allowedTools 白名单(无 Bash)+ 可弃 worktree/session 目录;行为保持由
> baseline/candidate 双跑 workflow 裁决;Linux 生产可另配 SDK
> permissionMode + sandbox(原生 Windows 不支持,见正文 2.4 遗留)。
> 本文档保留作演进记录。

## 1. 为什么旧模型会死循环(根因,代码级)

`driver.ts:checkToolScope` 旧逻辑对三类工具分别判定:

- **Read**:目标路径必须 `matchesScope(readableGlobs)` —— 精确 glob 列表
- **Glob/Grep**:先取 pattern 的字面前缀,要求前缀可读且不触 forbidden
- **Write**:必须命中 `editableFiles`,否则拒

死循环机制(与 e2e-slow-investigation 记录一致):

```
AI 想了解项目 → Glob(path=<repoRoot>, pattern="**/*.c")
                → path=repoRoot 不在 readable_globs → 拒
AI 换思路 → Read("src/foo.c") 猜路径 → 不在列表 → 拒
AI 再猜 → 24+ 次拒绝 → 无进展
```

三个结构性缺陷:

1. **探索行为(读)与交付行为(写)共用一套精确白名单**。探索的本质是"我不知道有什么",
   而精确 glob 要求"先知道有什么"——语义矛盾,必然猜。
2. **拒绝信息无方向**。reason 只有 "outside Observation Scope: <path>",
   不告诉 AI 可读范围是什么 → AI 只能继续猜。
3. **forbidden 与产物目录自相矛盾**。test/build-writer 要写
   `.refactor/runs/<session>/workflows/`,而 DEFAULT_FORBIDDEN_GLOBS 含 `.refactor/**`。
   靠 42b9bf3 "editable 胜过 forbidden"补丁绕过 —— 语义已经混乱。
4. normalize(改 path 为 agent cwd 下绝对路径)与 check 分离,
   且 Glob 带 `<root>` 显式路径时 deriveSearchPath 逻辑复杂,极易误判。

## 2. 方案总览:目录级读写 + 会话级写权

回答"为什么不是读写都暂时目录级":**可以,而且读本来就是目录级的才对**。

| 层 | 旧模型 | 新模型 |
|---|---|---|
| 读(Read/Glob/Grep) | 精确文件 glob 白名单 | **repo 根内一致放开**,仅防路径逃逸 |
| 写(Write/Edit) | editable_files 全局列表 | **按会话的写目录白名单**(窄于读) |
| forbidden | 与 editable/产物冲突 | 只对**写**生效的硬拒;读方向不参与判定 |
| 拒绝反馈 | 无方向 | 带**可用范围提示**(防猜路径) |

### 2.1 读:repo 根内一致放开(Read/Glob/Grep)

- 检查器的 root 就是会话 cwd(repo 或 worktree),**根内一切可读**:
  Read 任意文件、Glob 全仓递归、Grep 全仓搜索,一律放行。
- 读方向唯一保留的检查是**逃逸**:路径穿越(`..`)、symlink 解析出 root、
  绝对路径出 root —— relativeAgentPath 精确拦截,agent 出不了会话 root。
- **读不再是慢问题的来源**:探索永不因 scope 被拒;Glob 根递归天然允许。

> 风险与对策:agent 可读整个 repo —— 对代码重构任务,repo 本来就是输入,
> 无新增敏感面(敏感信息本就不该在 demo repo 里;生产另有 secret 扫描层,
> 不在本组件职责)。这是"读宽"的明确取舍。

### 2.1a 读方向不做内容级禁区:Glob/Grep/Read 一致放开

旧 hook 对 Glob 的死结:**在执行前静态判定 pattern 的命中集是否越界是做不到的**。
Glob 语法空间无限(`**/*` 空前缀、`{a,b}/**`、`[!x]` 字符类…),hook 只能取
pattern 的字面前缀猜搜索根 —— 空前缀/复杂语法时无从判断,只能保守拒绝,
于是 Explore 的 `Glob **/*` 永远被拒、陷入猜路径死循环(见调查文档 §3)。

读宽后 Glob/Grep/Read 三者的判定统一为**搜索/目标起点 ∈ repo 根**:

1. **起点是精确路径,无语法歧义** —— pattern 由工具自己执行,命中集不预判。
2. **内容泄露面等价,禁止必须一致**:Read 返回全文、Grep 返回匹配行、Glob
   只返回路径名 —— 三者信息量不同,但 Read 已放行时单独拦 Grep 无安全增益
   只有一致性损失(agent 能 Read 就能拿到内容)。读方向不再做内容级禁区。
3. **禁区语义只留给写**:forbidden 对 Write/Edit 是硬拒;读方向 forbidden
   不生效(见 2.2)。

> 读方向唯一保留的检查是**逃逸**:路径穿越(`..`)、symlink 解析出 root、
> 绝对路径出 root —— 这些仍在 relativeAgentPath 精确拦截。root 即会话
> cwd(repo 或 worktree),agent 永远出不去。

> ~~**Bash 不在 agent 工具集内(第一道防线)**~~ —— **已被 2026-09-10 的决定取代**:
> 三个会话现在都有 Bash(动机是自验:refactor 要能编译自己的改动,build-writer
> 要能真跑一遍构建再据此写 workflow)。原判断"给 agent 加 Bash 会击穿本模型"
> 是对的,所以本模型(读方向检查 + 按会话分配写目录)不再是主要防线;取而代之
> 的是:逐条显式的工具白名单 + `Bash(git push:*)` deny 规则 + 一次性环境 +
> **宿主不信任会话状态**(重新测量 diff、重跑权威 workflow、期望差分由程序
> 裁决)。平台级隔离仍未解决,见 PROJECT_STATUS.md §9.1。

### 2.2 写:按会话分配写目录

每个 agent 会话只获得"它必须交付的目录",越权即拒:

| 会话 | 写目录(worktree/repo 相对) | 来源 |
|---|---|---|
| refactor agent(在 candidate worktree 跑) | `scope.editable_files` 的**文件父目录**(通常 `src/` 或单文件) | 任务 policy |
| test-writer(在原 repo 跑) | `.refactor/runs/<session>/workflows/test/` | 会话构造时已知 |
| build-writer(子 agent,同 session) | `.refactor/runs/<session>/workflows/build/` | 同上 |

实现:把 driver 的 `editableFiles` 概念从"文件列表"升级为
**`writableDirs`(目录前缀列表)** —— 命中 = 路径前缀匹配任一可写目录。
`.refactor/**` 从 forbidden 移除(它现在只对 refactor 会话有意义,而 refactor
在 worktree 里跑,worktree 根本不含 `.refactor` 会话目录,天然隔离)。

### 2.3 拒绝带方向(防死循环的最后一环)

`checkToolScope` 拒绝时,reason 里附上**该会话可写的目录**(而非只报"被拒"):

```
denied: path is outside this session's writable directories
writable: .refactor/runs/<session>/workflows/test/
```

AI 看到范围后要么改路径要么停止,不再瞎猜。读方向不拒(2.1),写越权有明确范围提示。

### 2.4 兼容与迁移

- `ScopeManifest` schema 保留(editable_files 仍是宿主 policy 产物,驱动 refactor
  写目录),但 driver 检查不再直接消费 readable_globs 做读白名单。
- `checkToolScope` 签名改窄:`(toolName, input, root, writableDirs, forbiddenGlobs)`,
  删除 readableGlobs 读判定路径;保留 traversal/symlink 逃逸检查(relativeAgentPath)。
- `enforceScope` 开关语义变为三级:
  - `"strict"`:目录级读写(新模型)
  - `"read-only"`:(可选)测试探索时只放读
  - `false`:全放开(现 e2e 用的临时档,保留作逃生门,默认不再使用)
- e2e 脚本默认改回 strict,作为回归。

## 3. 改动清单

1. `driver.ts`:checkToolScope 重构为「读=root 内放行(仅防逃逸)、写=writableDirs
   白名单」;删除 readableGlobs/forbiddenGlobs 的读判定路径;reason 带写范围提示
2. `refactor.ts` / `workflow-session.ts`:editableFiles → writableDirs 传参
3. `analyze.ts`:ScopeManifest 保留 editable_files(→ 会话写目录来源),readable
   推导与 forbidden 收窄不再需要(读方向不消费);产物目录不再进 forbidden
4. `workflow-agent-pipeline.ts`:enforceScope 默认 strict
5. e2e + 单测:补 checkToolScope 单测(读全放、写目录判定、逃逸拦截、拒绝提示)、
   e2e 跑 strict 全链路回归

## 4. 验证方式

- 单测:`checkToolScope` 对 Read/Glob/Grep(repo 内任意起点放行)、
  Write(写目录内放行/目录外拒)、逃逸(`..`/symlink/绝对路径出 root 拒)、
  拒绝信息含 writable 提示
- e2e:strict 模式下完整跑一遍,确认:
  (a) 探索不再有 denial(日志中 scope denial count = 0)
  (b) test/build-writer 正常写产物目录
  (c) refactor 只改 editable 文件
  (d) 全程无"猜路径"重试(单子 agent denial < 3)

## 5. 不做的事

- 不做符号级写保护(symbols 字段维持占位)
- 不做秘密扫描(属另一层)
- 不恢复逐文件读白名单(已证伪)
