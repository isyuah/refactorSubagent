/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/session-store.ts —— AI 对话全文的"黑匣子"（新会话存储）
 *
 * 【这个文件是干什么的】
 *   Claude Agent SDK 允许宿主塞一个 `sessionStore` 适配器进去：AI 子进程自己照常写它本地的
 *   会话副本，同时把每条记录（用户消息、助手消息、tool_use、tool_result、子 agent 的转录）
 *   **镜像一份**给这个适配器。本文件就是那个适配器——把镜像内容一行一行追加到本次运行的
 *   会话目录里：
 *       <sessionRoot>/sessions/<sessionId>/main.jsonl                       主会话
 *       <sessionRoot>/sessions/<sessionId>/subagents/agent-<agentId>.jsonl  子 agent（build-writer）
 *   为什么必须有它？因为 pino 日志（见 log.ts）是分级的：默认 info 级**不含**任何会话内容。
 *   一次 e2e 跑十几分钟，中途挂了，你得能回答"AI 到底调了什么工具、传了什么参数、看到了什么
 *   返回"——全文就在这里，与日志级别无关，永远落盘。这是教程任务 7"分级 + 保留现场"的落地：
 *   run.jsonl 保持干净好读，原始现场单独存一份不被稀释。
 *
 * 【在整个项目里的位置】
 *   上游：src/runtime/workflow-agent-pipeline.ts —— `new FileSessionStore(logger.runDir)`，
 *         也就是说会话转录和 run.jsonl、state.json 住在同一个运行目录里；
 *         它把这个实例传给 runWorkflowSession / runAgent，最终塞进 SDK 的 query 选项。
 *   伴生：src/agents/driver.ts 在提供 sessionStore 时会打开 `persistSession: true`（SDK 要求
 *         镜像时必须同时开本地持久化）。
 *   下游：人和排错脚本。出问题时直接用编辑器/文本工具翻这些 .jsonl。
 *
 * 【先修知识】
 *   · JSONL：一行一个 JSON 对象；追加写不用重写整个文件；
 *   · class implements 接口：SessionStore 是 SDK 定义的接口（append/load 两个方法）；
 *   · Set（集合）：用来记"已经写过的 uuid"，实现幂等去重；
 *   · JSON.stringify / JSON.parse。
 *
 * 【本文件是教程注释版】
 *   原文件：src/runtime/session-store.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← Node 同步文件 API：appendFileSync 追加、existsSync 判存在、mkdirSync 建目录、readFileSync 整读
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
// ← join 拼路径
import { join } from "node:path";
// ← 只导入类型：SessionKey（哪段会话）、SessionStore（SDK 定义的适配器接口）、
//   SessionStoreEntry（一条记录：{ type, uuid?, timestamp?, ...任意字段 } 的普通对象）
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

/**
 * Filesystem-backed SessionStore mirror.
 *
 * The Claude Agent SDK dual-writes transcripts to an external store when a
 * `sessionStore` adapter is provided (the subprocess still writes its local
 * copy). This adapter appends each mirrored transcript line under a run's
 * session directory:
 *
 *   <sessionRoot>/sessions/<sessionId>/main.jsonl
 *   <sessionRoot>/sessions/<sessionId>/subagents/agent-<agentId>.jsonl
 *
 * The full AI conversation (tool_use, tool_result payloads, subagent
 * transcripts) is preserved here regardless of the pino log level, so slow
 * runs can be analyzed without bloating run.jsonl with payload content.
 *
 * Entries are JSON-safe POJOs, one per line. `uuid` is treated as an
 * idempotency key: appends that duplicate an existing uuid are skipped so
 * SDK retries/replays cannot corrupt the transcript.
 */

// ── FileSessionStore：把 SDK 的会话镜像落成本地 JSONL 文件 ───────────
// 【作用】实现 SDK 的 SessionStore 接口（append / load 两个方法）。SDK 在会话过程中反复调
//         append 存新记录；宿主 resume 会话时可能调 load 取回历史。
// 【关系】workflow-agent-pipeline 创建它 → workflow-session → driver → SDK query。
//         ⚠️ 它只管"存得全、存得对"，不做任何裁剪或格式化——原文照抄。
export class FileSessionStore implements SessionStore {
  // ← private readonly：只有类内部能读，且构造后不可改——本次运行的会话根目录
  private readonly sessionRoot: string;

  // ── constructor：new 的时候只记一个路径，不碰磁盘 ────────────────────
  // 【参数】sessionRoot 一般就是 E2ELogger 的 runDir（runs/…/<sessionId>/），这样
  //         "日志" 和 "会话转录" 都在同一处，归档时一起带走
  constructor(sessionRoot: string) {
    this.sessionRoot = sessionRoot;
  }

  // ── keyToPath：把 SessionKey 翻译成一个具体文件路径 ─────────────────
  // 【参数】key.sessionId 会话 id（作为目录名）；key.subpath 子 agent 的相对路径（如
  //         "subagents/agent-a1.jsonl"），没有就是主会话 → main.jsonl
  // 【返回】绝对文件路径
  // 【语法】key.subpath !== undefined ? A : B 三元表达式；join(base, ...arr) 的 ...
  //         是"展开运算符"，把按 "/" 切开的数组逐段作为参数传进去（等于建子目录层级）
  private keyToPath(key: SessionKey): string {
    const base = join(this.sessionRoot, "sessions", key.sessionId);
    const file = key.subpath !== undefined ? join(base, ...key.subpath.split("/")) : join(base, "main.jsonl");
    // Only allow the transcript under the session dir (fail closed).
    // ← ⚠️ 安检：subpath 若带 "../" 之类，拼出来的路径会跑到会话目录外——直接抛错。
    //   这是 fail-closed 的路径安全检查（子 agent 的 agentId 来自 SDK，但仍然不信任它）
    if (!file.startsWith(base)) {
      throw new Error(`refusing session path outside session dir: ${file}`);
    }
    return file;
  }

  // ── append：SDK 存新记录的入口（本文件最核心的方法）─────────────────
  // 【作用】把这一批 entries 追加进对应 jsonl。关键点有两个：
  //         ① 幂等：同一个 uuid 不写第二次（SDK 会重试/重放，不去重就会写出重复行）；
  //         ② 容错：文件末尾若有一行残缺（上次进程写到一半被打断），跳过它，不让整次读崩。
  // 【参数】key 定位哪个文件；entries 这一批要存的记录（通常是"这一轮新产生的几条"）
  // 【返回】Promise<void>（异步方法，但内部用的是同步 fs——文件小、频率低，简单可靠优先）
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const path = this.keyToPath(key);
    // ← 先确保父目录存在（第一次写 subagents/… 时目录还没有）；recursive 一路建齐
    mkdirSync(join(path, ".."), { recursive: true });
    // Read existing uuids to skip duplicate appends (idempotency).
    // ← 建一个 Set 记录"文件里已有的 uuid"
    const seen = new Set<string>();
    if (existsSync(path)) {
      // ← 把整个文件按行切开，逐行取 uuid 塞进 Set
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(line) as { uuid?: unknown };
          if (typeof parsed.uuid === "string") seen.add(parsed.uuid);
        } catch {
          // Ignore a partial trailing line from a concurrent writer.
          // ← 解析失败 = 残缺行，忽略它（不能因为一行坏的丢掉整个转录）
        }
      }
    }
    // ← filter 挑出"值得写"的记录：没有 uuid 的永远写（比如标题/标签类条目）；
    //   有 uuid 且没见过的写，并立刻登记进 Set（同批次里出现两次也只写第一次）
    const fresh = entries.filter((entry) => {
      if (typeof entry.uuid !== "string") return true; // no uuid → always append
      if (seen.has(entry.uuid)) return false;
      seen.add(entry.uuid);
      return true;
    });
    if (fresh.length > 0) {
      // ← 每条 JSON.stringify 成一行，行间用 \n 连接，最后再补一个 \n —— 标准 JSONL 追加
      appendFileSync(path, `${fresh.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    }
  }

  // ── load：把某个会话的全部记录读回来 ────────────────────────────────
  // 【返回】记录数组；文件不存在返回 null（SDK 约定 null = "这段会话从没写过"，
  //         这样 resume 时能区分"没写过"和"写过但为空"）
  // 【细节】和 append 一样容忍残缺行——读侧永远比写侧宽容，数据才不会因为一次中断全废
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const path = this.keyToPath(key);
    if (!existsSync(path)) return null;
    const entries: SessionStoreEntry[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as SessionStoreEntry);
      } catch {
        // Ignore partial lines (concurrent write).
      }
    }
    return entries;
  }
}
