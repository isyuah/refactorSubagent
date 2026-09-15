/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/log.ts —— pino 分级日志（长跑运行的"可观测性"底座）
 *
 * 【这个文件是干什么的】
 *   一次 agent/e2e 运行动辄十几分钟，中途挂了/卡住了，你得能回答三件事：
 *     "它走到哪一步了？" —— state.json（永远只有最新一份快照，一眼看清现状）
 *     "它是怎么走到这的？" —— run.jsonl（一行一个 JSON 事件，完整事件流）
 *     "它产出了什么？" —— artifacts/（结构化产物）+ logs/（原始文本日志）
 *   这份实现把原来的手写 JSONL 记录器换成了 **pino**（一个高性能 JSON 日志库），
 *   并引入了**级别门槛**（level gating）：
 *       trace —— 全量会话转录，含 tool_result 的具体内容（文件内容、命令输出）
 *       debug —— 会话骨架：工具名、耗时、成败状态（不含大段内容）
 *       info  —— 只有宿主级的阶段/决策/错误事件（默认档，run.jsonl 干净好读）
 *   级别用环境变量 RFR_LOG_LEVEL=trace|debug|info|warn|error 控制，默认 info。
 *   这正是教程任务 7"分级 + 保留现场"和任务 6B"logger 多 writer"的落地：
 *   run.jsonl 不再被会话载荷灌满，AI 的完整对话由 session-store.ts 单独留存。
 *   （会话消息怎么映射到级别，见 src/agents/driver.ts 的 logSessionEvent。）
 *
 * 【在整个项目里的位置】
 *   上游：src/runtime/workflow-agent-pipeline.ts —— new E2ELogger(观测根目录, sessionId)，
 *         然后把它一路传给各阶段（以及 workflow-session / driver 当 logger 用）。
 *   兼容层：src/runtime/e2e-log.ts 只是把本文件的导出 re-export 了一遍（老 import 路径不变）。
 *   下游：src/runtime/e2e-dashboard.ts 读 state.json 和 run.jsonl 推给浏览器看板；
 *         排错脚本/人直接 grep run.jsonl。
 *
 * 【先修知识】
 *   · class + implements 接口、private/readonly、参数默认值；
 *   · pino 的三个概念：logger（记录器）、destination（写到哪）、level（门槛，低于门槛的
 *     记录直接丢弃，连字符串都不拼——这就是"分级省钱"的原理）；
 *   · setInterval / clearInterval（心跳定时器）；
 *   · JSONL（一行一个 JSON）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/runtime/log.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← Node 文件 API：appendFileSync 追加（logs/ 实时生长用）、mkdirSync 建目录、writeFileSync 覆盖写
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
// ← basename 取路径最后一段（当 run_id 用）；join 拼路径
import { basename, join } from "node:path";
// ← pino 默认导出：既是一个函数（创建 logger），身上还挂着 destination / stdTimeFunctions 等工具
import pino from "pino";
// ← 只导入类型：PinoLogger 是 pino logger 实例的类型名（原来的名字 Logger 和本项目自己的接口撞名，
//   所以用 `as PinoLogger` 改名——只改类型名，不改运行时任何东西）
import type { Logger as PinoLogger } from "pino";

/**
 * Level-gated observability for long-running agent/e2e runs.
 *
 * One pino instance writes line-oriented JSON to `run.jsonl` (plus a human
 * `state.json` snapshot and an `artifacts/` tree). Level thresholds decide
 * how much AI-session detail is persisted (see the session event mapping in
 * driver.ts):
 *
 *   trace — full session transcript, including tool_result payloads
 *   debug — session skeleton: tool names, durations, result status (no payloads)
 *   info  — host-level phase/decision/error events only (no session internals)
 *
 * Default level is `info`; set RFR_LOG_LEVEL=trace|debug|info|warn|error to
 * raise verbosity. Emitted lines follow pino ({level,time,msg,...}) plus
 * host-owned fields (phase, event, details) for human/scripted readers.
 */

// ── LogLevel：六个级别，从最啰嗦到最安静 ─────────────────────────────
// 【语法】type + 字符串字面量联合：LogLevel 只能是这六个字符串之一，写错编译期就报错
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

// ← 级别的"从啰嗦到安静"的顺序表；readonly 数组：表本身不许被改
const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

// ── isLogLevel：判断一个字符串是不是合法级别 ────────────────────────
// 【语法】`value is LogLevel` 是"类型谓词"：告诉编译器"返回 true 时，value 就能当成 LogLevel 用"；
//         `(LOG_LEVELS as readonly string[])` 是类型断言——includes 需要宽类型，先放宽再判断
export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Resolve effective log level from RFR_LOG_LEVEL (default info). */

// ── resolveLogLevel：从环境变量算出本次运行的有效级别 ────────────────
// 【作用】读 RFR_LOG_LEVEL；没设/设成空串 → info；非法值 → 直接抛错（fail-closed：
//         拼错环境变量导致"以为在记 trace 其实什么都没记"比启动失败糟糕得多）
// 【参数】env 默认取 process.env（?: 表示参数可省，省了就用系统环境）
// 【返回】LogLevel；测试里可以传一个假 env 对象来验证各种取值
// 【语法】参数默认值；raw.trim().toLowerCase() 去空白 + 统一小写（" INFO " 也能认）
export function resolveLogLevel(env: Record<string, string | undefined> = process.env): LogLevel {
  const raw = env["RFR_LOG_LEVEL"];
  if (raw === undefined || raw === "") return "info";
  const normalized = raw.trim().toLowerCase();
  if (isLogLevel(normalized)) return normalized;
  throw new Error(
    `invalid RFR_LOG_LEVEL '${raw}'; expected one of ${LOG_LEVELS.join(", ")}`,
  );
}

// ── Logger：宿主各处都认的"日志接口"（本项目的，不是 pino 的）────────
// 【作用】把级别门槛暴露出来（level 字段），调用方可以据此决定"要不要准备大块内容"——
//         例如 driver.ts：trace 级才把完整 content 塞进去，否则只塞工具名。
//         这样"被丢弃的记录"连构造成本都省了。
// 【语法】interface 里写方法签名（参数 + 返回类型，没有函数体）= 谁实现它谁负责填实现；
//         details?: Record<string, unknown> —— 可选的附加数据，键是字符串、值类型不限
export interface Logger {
  /** Effective threshold; callers use it to decide payload verbosity. */
  readonly level: LogLevel;
  trace(message: string, details?: Record<string, unknown>): void;
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

// ── E2EState：state.json 的形状（v2）────────────────────────────────
// 【字段】kind/version 是"这是哪种文件、第几版"的自描述标记（读侧先看这个再解析）；
//         run_id 就是运行目录名；status 状态、phase 当前阶段、elapsed_ms 已耗时（毫秒）、
//         last_event 最后一条事件的 message（看板用它显示"现在在干嘛"）
export interface E2EState {
  readonly kind: "e2e-state";
  readonly version: 2;
  readonly run_id: string;
  readonly status: string;
  readonly phase: string;
  readonly started_at: string;
  readonly updated_at: string;
  readonly elapsed_ms: number;
  readonly last_event: string;
}

/**
 * A run-scoped pino logger writing durable JSONL plus a state snapshot.
 *
 * Keeps the historical E2ELogger surface (phase/artifact/logFile/output/
 * command/startHeartbeat/finish) so existing call sites keep working while
 * the backing store moves to pino.
 */

// ── E2ELogger：一个运行目录对应一个实例（本文件主类）─────────────────
// 【作用】所有阶段/命令/输出都调它的方法；它负责"分级 + 落盘 + 刷新快照"三件事。
// 【关系】workflow-agent-pipeline 创建并传递它；dashboard 读它写的文件。
//         实现 Logger 接口（trace/debug/info/warn/error 五个方法 + level），
//         所以能直接塞给 driver/workflow-session 当 logger 用。
export class E2ELogger implements Logger {
  // ← 公开只读：外部（如 workflow-pipeline）可以直接拿来拼文件名
  readonly runDir: string;
  readonly artifactsDir: string;
  readonly logsDir: string;
  // ← 有效级别；Logger 接口要求的字段
  readonly level: LogLevel;
  // ← 以下私有：pino 记录器实例、state.json 路径、运行开始时间（毫秒时间戳）
  private readonly pino: PinoLogger;
  private readonly statePath: string;
  private readonly startedAt = Date.now();
  // ← 三个"当前状态"字段：终态、当前阶段、最后一条事件（persistState 要用）
  private status = "running";
  private phaseName = "INIT";
  private lastEvent = "run started";
  // ← 心跳定时器句柄；ReturnType<typeof setInterval> = "setInterval 返回什么就用什么类型"，
  //   不用背具体 Timer 类型名；null 表示当前没开心跳
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── constructor：建目录 + 配好 pino + 写第一份 state.json ───────────
  // 【参数】root 观测根目录；runId 运行 id（同时就是子目录名）；
  //         level 第三个参数有默认值 resolveLogLevel()——不传就按环境变量/默认 info 算
  // 【效果】构造完磁盘上就有 <root>/<runId>/{artifacts,logs}/、run.jsonl、state.json。
  //         就算 1 秒后崩溃，也留下"确实开始跑过"的证据
  constructor(root: string, runId: string, level: LogLevel = resolveLogLevel()) {
    this.level = level;
    this.runDir = join(root, runId);
    this.artifactsDir = join(this.runDir, "artifacts");
    this.logsDir = join(this.runDir, "logs");
    this.statePath = join(this.runDir, "state.json");
    // ← recursive: true 一路建齐父目录，目录已存在也不报错
    mkdirSync(this.artifactsDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    // ← 建一个"目的地"：写到 run.jsonl。sync: true 表示同步刷盘——每条都立刻落盘，
    //   程序崩了也不丢事件（代价是慢一点，但对"保留现场"来说值得）
    const destination = pino.destination({ dest: join(this.runDir, "run.jsonl"), sync: true });
    this.pino = pino(
      {
        // ← 门槛：低于它的记录直接被 pino 丢掉（连对象都不构造）
        level,
        // ← base：每行都自动附上的公共字段——这样 grep run_id 就能把同一行归到某次运行
        base: { run_id: runId },
        // ← 时间戳格式：ISO 8601 字符串（人能读、能排序）
        timestamp: pino.stdTimeFunctions.isoTime,
        // ← formatters.level：pino 默认把 level 写成数字，这里改成字符串标签（"info"/"error"）
        formatters: { level: (label) => ({ level: label }) },
      },
      destination,
    );
    // ← 开跑第一份快照：status=running / phase=INIT
    this.persistState();
  }

  // ── phase：切换阶段（PREFLIGHT → ANALYSIS → …）─────────────────────
  // 【语法】message = `${phase} started` 参数默认值：不传就自动生成这句
  phase(phase: string, message = `${phase} started`): void {
    this.phaseName = phase;
    this.emit("info", "phase", message);
  }

  // ── info / warn / error / trace / debug：Logger 接口的五个级别方法 ──
  // 【注意】第二参 event 是宿主自己定义的"事件种类"，和级别是两回事：
  //         progress（普通进展）/ error（出错）/ command（执行了什么命令）…
  info(message: string, details?: Record<string, unknown>): void {
    this.emit("info", "progress", message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.emit("warn", "progress", message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.emit("error", "error", message, details);
  }

  trace(message: string, details?: Record<string, unknown>): void {
    this.emit("trace", "progress", message, details);
  }

  debug(message: string, details?: Record<string, unknown>): void {
    this.emit("debug", "progress", message, details);
  }

  // ── command：记录"执行了什么命令"（排错时定位"到底是哪一步慢/挂了"）──
  command(message: string, details?: Record<string, unknown>): void {
    this.emit("info", "command", message, details);
  }

  // ── output：接住子进程吐出来的一块输出 ─────────────────────────────
  // 【细节】先把 Windows 的 CRLF（\r\n）统一成 LF（\n），免得一行断成两截；
  //         空块直接忽略；⚠️ stderr 记成 warn 级 + event=output —— 这是"失败归因"
  //         的第一手材料：run 结束后 grep level=warn 的 output 行，往往第一眼就看到原因
  output(stream: "stdout" | "stderr", chunk: string): void {
    const text = chunk.replace(/\r\n/g, "\n");
    if (text.length === 0) return;
    this.emit(stream === "stderr" ? "warn" : "info", "output", text, { stream });
  }

  // ── artifact：把一个结构化产物存进 artifacts/ 并记一条事件 ─────────
  // 【参数】name 文件名（如 "declared-build-set.json"）；value 任意可 JSON 化的对象
  // 【返回】写到的路径，方便调用方继续用
  // 【细节】JSON.stringify(value, null, 2) 的第 3 参是缩进空格数 → 人能直接读
  artifact(name: string, value: unknown): string {
    const path = join(this.artifactsDir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    this.emit("info", "artifact", `saved artifact ${name}`, { path });
    return path;
  }

  // ── logFile：整体覆盖写一个文本日志（build/ctest 的原始输出）────────
  logFile(name: string, content: string): string {
    const path = join(this.logsDir, name);
    writeFileSync(path, content, "utf8");
    return path;
  }

  // ── appendLogFile：往尾部追加（输出是一块一块到的，就一块一块接）────
  appendLogFile(name: string, content: string): string {
    const path = join(this.logsDir, name);
    appendFileSync(path, content, "utf8");
    return path;
  }

  // ── startHeartbeat：开始发心跳 ─────────────────────────────────────
  // 【作用】长套件一跑几分钟，"最后一条事件"会一直不动，分不清是卡死还是正常跑着。
  //         心跳每 intervalMs（默认 10 秒，10_000 里的下划线是数字分隔符，方便读）
  //         写一条 "XXX still running"，证明进程活着
  startHeartbeat(intervalMs = 10_000): void {
    // ← 先停掉旧的，避免重复开定时器导致心跳翻倍
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.emit("info", "heartbeat", `${this.phaseName} still running`);
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── finish：给整次运行盖棺定论 ─────────────────────────────────────
  // 【参数】status 终态（accepted / rejected / aborted…）
  // 【细节】aborted / rejected 记成 error 级——事后只看 error 行就能定位"为什么没通过"，
  //         这也是失败归因链路的出口
  finish(status: string, message: string): void {
    this.stopHeartbeat();
    this.status = status;
    const level: LogLevel = status === "aborted" || status === "rejected" ? "error" : "info";
    this.emit(level, "decision", message);
  }

  // ── close：收尾（目前只是停心跳，避免进程退出被定时器拖着）──────────
  close(): void {
    this.stopHeartbeat();
  }

  // ── emit：所有写事件的必经之路（私有方法，本文件的心脏）─────────────
  // 【作用】① 拼出宿主自有字段 { event, phase, ...details }；② 按级别调 pino 对应方法
  //         （低于门槛的会被 pino 静默丢弃）；③ 更新 lastEvent；④ 刷新 state.json
  // 【语法】{ event, phase: this.phaseName, ...details } 里的 ... 是展开运算符：
  //         把 details 的键值对平铺进这个对象（undefined 时不传 details 就没有多余字段）；
  //         switch…case 里每行 `…; break;` 是"命中即执行并跳出"
  // ⚠️ 性能点：每条事件都同步刷一次 run.jsonl，并且**全量重写**整个 state.json。
  //    输出块/心跳来得密集时，state.json 会被反复序列化+覆盖写——教程任务 6B 提的
  //    "state.json 节流"就是指这里以后可以按时间/条数批量刷
  private emit(
    level: LogLevel,
    event: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const obj = { event, phase: this.phaseName, ...details };
    switch (level) {
      case "trace": this.pino.trace(obj, message); break;
      case "debug": this.pino.debug(obj, message); break;
      case "info": this.pino.info(obj, message); break;
      case "warn": this.pino.warn(obj, message); break;
      case "error": this.pino.error(obj, message); break;
      case "fatal": this.pino.fatal(obj, message); break;
    }
    this.lastEvent = message;
    this.persistState();
  }

  // ── persistState：把当前状态快照整体覆盖写进 state.json ─────────────
  // 【细节】run_id 用 basename(runDir) 取目录名而不是存传入的 runId，保证两者永远一致；
  //         started_at/updated_at 用 ISO 字符串；elapsed_ms 是毫秒
  private persistState(): void {
    const state: E2EState = {
      kind: "e2e-state",
      version: 2,
      run_id: basename(this.runDir),
      status: this.status,
      phase: this.phaseName,
      started_at: new Date(this.startedAt).toISOString(),
      updated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startedAt,
      last_event: this.lastEvent,
    };
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
