/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/e2e-dashboard.ts —— 让浏览器"实时看直播"的本地 HTTP 服务
 *
 * 【这个文件是干什么的】
 *   把 E2ELogger 写下的那些文件（state.json / run.jsonl / artifacts/ / logs/）通过 HTTP 暴露出来：
 *     GET /                                      看板页面（web/e2e-dashboard.html）
 *     GET /api/runs                              所有运行的列表（摘要）
 *     GET /api/runs/<runId>                      一次运行的状态 + 全部事件
 *     GET /api/runs/<runId>/events?after=N       只给第 N 条之后的事件（轮询用的"增量"接口）
 *     GET /api/runs/<runId>/stream?after=N       ★ SSE 长连接，服务器主动往外推新事件
 *     GET /api/runs/<runId>/artifacts[/<名字>]    列出 / 读取 artifact
 *     GET /api/runs/<runId>/logs[/<名字>]        列出 / 读取日志
 *   它是**只读**的：只能 GET，而且只能读 root 目录里面的东西（下面有一大堆代码在防"路径穿越"）。
 *
 * 【在整个项目里的位置】
 *   上游：scripts/e2e-dashboard.ts 调 createE2EDashboardServer() 把服务起起来
 *         （`bun run scripts/e2e-dashboard.ts`，教程 §1.7 命令表最后一行）；
 *         tests/e2e-observability.test.ts 直接用 createE2EDashboardHandler() 做单测。
 *   数据来自：src/runtime/e2e-log.ts 写的 <root>/<run-id>/ 目录（它是写侧，这里是读侧）。
 *   下游：web/e2e-dashboard.html 里的 `new EventSource("/api/runs/<id>/stream")`
 *         是本文件 SSE 接口的浏览器端对端。
 *
 * 【先修知识 / 两个必须讲清的机制】
 *   ① SSE（Server-Sent Events）是什么：
 *      普通网页要"新数据"只能不停地问（轮询）；SSE 是反过来——浏览器发一次请求，
 *      服务器**不挂断**，响应头 Content-Type: text/event-stream，然后往这条连接里
 *      一直写"事件"。每条事件的格式是纯文本：
 *          event: 事件名\n
 *          id: 序号\n
 *          data: 载荷（一行）\n
 *          \n            // ← 空行表示这条事件结束
 *      浏览器端用 EventSource 接收，按 event 名分发；连接断了它还会自动重连，
 *      并带上 Last-Event-ID 告诉服务器"我收到第几条了"。本文件用 15 秒一条
 *      ": keep-alive" 注释行防止中间设备把空闲连接掐断。
 *   ② 字节偏移增量读怎么做：
 *      run.jsonl 是"只追加"的文件，所以记住"上次读到第几个字节"，下次只读那之后的部分即可。
 *      麻烦在于：写侧可能写到一行的一半（半行 JSON 解析不了），所以还要留一个"半行暂存区"，
 *      凑齐换行符才解析。EventCursor 类就是干这个的（offset=字节位置、pending=半行、seq=序号）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/runtime/e2e-dashboard.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← 一整套 node:fs 同步文件操作：openSync/fstatSync/readSync/closeSync 是"低层"的按位置读文件
//   （readSync 可以指定"从第几个字节开始读"，这正是增量读需要的）；realpathSync 把路径解析成
//   真实绝对路径（顺带拆穿符号链接）；lstatSync 看属性但**不**跟随符号链接
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
// ← extname 取扩展名；isAbsolute 判断绝对路径；resolve 把相对路径拼成绝对路径（并消化 ../）；
//   relative 算"从 A 走到 B 的相对路径"（判断是否越界的核心）；sep 是路径分隔符
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

// ── E2EDashboardOptions：起服务时可以调的旋钮 ────────────────────────
// 【字段】root 必填：观测目录的根（里面有若干 <run-id>/ 子目录）
//         hostname/port 可选：监听地址与端口（不传就用下面的默认值）
//         staticFile 可选：首页 HTML 的路径（默认去 web/e2e-dashboard.html 找）
//         pollIntervalMs 可选：SSE 每隔多少毫秒去 run.jsonl 看一眼有没有新内容
export interface E2EDashboardOptions {
  readonly root: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly staticFile?: string;
  readonly pollIntervalMs?: number;
}

// ── RunSummary：/api/runs 列表里的一条（运行摘要） ────────────────────
export interface RunSummary {
  readonly run_id: string;
  readonly status: string;
  readonly phase: string;
  readonly updated_at: string;
  readonly elapsed_ms: number;
  readonly last_event: string;
}

// ← TS 内置工具类型 Record<string, unknown>："任意对象，键是字符串、值类型未知"。
//   用来描述"解析出来的 JSON"，比 any 安全——后面每个字段都得先判类型才能用
export type JsonObject = Record<string, unknown>;

// ← 接口可以继承：DashboardEvent 在 JsonObject 的基础上多规定了一个 seq（序号）字段。
//   seq 不是文件里写的，是本文件读的时候**加上去**的（第几条事件，从 1 数起）
export interface DashboardEvent extends JsonObject {
  readonly seq: number;
}

// ── ArtifactSummary：artifacts/logs 目录里一个文件的信息 ─────────────
// 【细节】modified_at 是给人看的 ISO 字符串，mtime_ms 是毫秒数（前端排序/显示"多久之前"用）
export interface ArtifactSummary {
  readonly name: string;
  readonly size: number;
  readonly modified_at: string;
  readonly mtime_ms: number;
}

// ← 默认只监听本机回环地址（127.0.0.1）——不对外网开放，因为这里没有任何鉴权
const DEFAULT_HOSTNAME = "127.0.0.1";
// ← 端口 0 的含义是"请操作系统随便挑一个空闲端口给我"（避免端口冲突）
const DEFAULT_PORT = 0;
// ← SSE 轮询间隔：每 800 毫秒看一眼 run.jsonl 有没有新字节
const DEFAULT_POLL_INTERVAL_MS = 800;
// ← 文件/目录名的白名单正则：字母数字开头，后面只能是字母数字点下划线连字符，最长 255。
//   含斜杠、含空格、以点开头的名字统统不收——这是防路径穿越的第一道闸
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
// ← TextEncoder 把 JS 字符串编码成 UTF-8 字节（SSE 往连接里写的就是字节）
const encoder = new TextEncoder();

// ── DashboardHttpError：带 HTTP 状态码的"可控错误" ────────────────────
// 【作用】业务代码里随手 throw 它，最外层统一接住转成 JSON 响应；
//         publicMessage 是**可以给浏览器看**的文案（不会把服务器内部路径泄出去）
class DashboardHttpError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, publicMessage: string) {
    // ← super(...) 调用父类 Error 的构造函数，message 就存的是对外文案
    super(publicMessage);
    this.name = "DashboardHttpError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

// ── isRecord：判断"这东西是不是一个普通对象" ─────────────────────────
// 【细节】排除 null（typeof null 也是 "object"）和数组（数组不是我们想要的 JSON 对象）。
// 【语法】`value is JsonObject` 叫类型守卫：函数返回 true 后，TS 就把 value 当 JsonObject 用
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── isWithin：candidate 是不是真的在 root 里面 ───────────────────────
// 【原理】relative(root, candidate) 算"从 root 走到 candidate 的相对路径"：
//         如果要往上跳（../开头）或者是绝对路径，就说明 candidate 在 root 外面。
// 【⚠️ 这是本文件安全性的核心】拦截 ../..\\ 这类路径穿越攻击——
//   比如 GET /api/runs/..%2f..%2fetc/artifacts/passwd，解出来的 runId 是 ../../etc，
//   会在 name 校验那里先被拒；这层再兜一道底。
function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

// ── rejectInvalidName：名字不合法就抛 400 ───────────────────────────
// 【作用】挡住空名、.、..、含 NUL、含斜杠/反斜杠、绝对路径、以及不符合 SAFE_NAME 的所有名字。
//         kind 只是用来拼错误消息（"非法 run 名称" / "非法 artifact 名称"…）
function rejectInvalidName(name: string, kind: "run" | "artifact" | "log"): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\") ||
    isAbsolute(name) ||
    !SAFE_NAME.test(name)
  ) {
    throw new DashboardHttpError(400, `非法${kind}名称`);
  }
}

// ── decodePathname：把 URL 里的 %XX 转义还原成字符 ───────────────────
// 【细节】decodeURIComponent 遇到非法转义（比如单独一个 %）会抛错，这里接住转成 400
function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new DashboardHttpError(400, "非法 URL 路径");
  }
}

// ── readJsonObject：读一个 JSON 文件并确认它顶层是对象 ────────────────
// 【细节】先把结果标成 unknown（不信任文件内容），再用 isRecord 收窄类型
function readJsonObject(path: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("JSON root is not an object");
  return parsed;
}

// ── readTextIfPresent：文件存在才读，不存在返回空串 ──────────────────
// 【为什么】run 刚创建时 run.jsonl 可能还没写出来，前端不该因此看到 500
function readTextIfPresent(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

// ── parseEvents：把 run.jsonl 的文本变成带序号的事件数组 ──────────────
// 【参数】text 文件内容（或其中一段）；startSeq 序号起点（增量读时接着上次数）。
// 【⚠️ 容错核心】逐行 JSON.parse，解析失败的行直接跳过——因为写侧可能正写到半行，
//   看板不能因此挂掉。增量游标（EventCursor）会把半行留在 pending 里，下个轮询周期再试。
// 【语法】rawLine.endsWith("\r") 去掉 Windows 换行的 \r；{ ...parsed, seq } 是
//   "展开原对象再加一个字段"，生成一个新对象（不改原对象）
function parseEvents(text: string, startSeq = 0): DashboardEvent[] {
  const lines = text.split("\n");
  const events: DashboardEvent[] = [];
  let seq = startSeq;
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      seq += 1;
      events.push({ ...parsed, seq });
    } catch {
      // A writer can leave a partial line while the dashboard is polling.
      // The incremental cursor retains that line and retries it next tick.
    }
  }
  return events;
}

// ── readSuffix：从第 offset 个字节读到文件末尾 ────────────────────────
// 【作用】增量读的"读"这一半。用低层 API（open/fstat/read/close）而不是 readFileSync，
//         是因为只想读文件尾部，不想把整个几 MB 的日志再读一遍。
// 【返回】text 读到的文本；bytes 实际读到的字节数（调用方拿它推进自己的 offset 游标）。
// 【细节】start 被夹在 [0, size] 之间（Math.min/Math.max 组合），offset 超过文件大小也不崩；
//         length <= 0 说明没有新内容，直接返回空。
// 【语法】finally 保证文件句柄一定被关掉（不关会泄漏操作系统资源）
function readSuffix(path: string, offset: number): { readonly text: string; readonly bytes: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.min(Math.max(offset, 0), size);
    const length = size - start;
    if (length <= 0) return { text: "", bytes: 0 };
    // ← Buffer.alloc(length) 先按需要的字节数分配一块内存，再往里读
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, start);
    // ← 实际读到的可能比申请的少，所以用 subarray(0, bytes) 只取有内容的部分
    return { text: buffer.subarray(0, bytes).toString("utf8"), bytes };
  } finally {
    closeSync(fd);
  }
}

// ── fieldString / fieldNumber：从"不认识的 JSON"里安全取字段 ─────────
// 【作用】state.json 是磁盘上的文件，可能损坏/缺字段；这里给每个字段一个兜底默认值，
//         让接口永远返回形状正确的 JSON，而不是让前端拿到 undefined 崩掉
function fieldString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function fieldNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ── summaryFromState：把一份 state.json 压成列表里要展示的六项 ────────
// 【细节】Math.max(0, …) 防止负数（时钟回拨时 elapsed_ms 可能算出负值）
function summaryFromState(runId: string, state: JsonObject): RunSummary {
  return {
    run_id: runId,
    status: fieldString(state.status, "unknown"),
    phase: fieldString(state.phase, ""),
    updated_at: fieldString(state.updated_at, ""),
    elapsed_ms: Math.max(0, fieldNumber(state.elapsed_ms)),
    last_event: fieldString(state.last_event, ""),
  };
}

// ── jsonResponse：把对象变成 JSON 响应 ─────────────────────────────
// 【响应头】Content-Type 声明是 JSON；Cache-Control: no-store 禁止缓存（数据一直在变）；
//   X-Content-Type-Options: nosniff 禁止浏览器"猜"内容类型（安全习惯）
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ── textResponse：文本/HTML 响应（同上一组安全响应头） ────────────────
function textResponse(text: string, contentType: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ── parseAfter：解析 ?after=N（"我已经收到第 N 条，只要后面的"） ─────
// 【校验】必须是纯数字（/^\d+$/），且在安全整数范围内（2^53-1 以内），否则 400
function parseAfter(url: URL): number {
  const raw = url.searchParams.get("after");
  if (raw === null || raw === "") return 0;
  if (!/^\d+$/.test(raw)) throw new DashboardHttpError(400, "after 必须是非负整数");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new DashboardHttpError(400, "after 超出可用范围");
  return value;
}

// ── artifactContentType：.json 给 JSON 类型，其余按纯文本 ────────────
// 【为什么不让浏览器猜】防止把内容当成 HTML 执行（XSS）
function artifactContentType(name: string): string {
  return extname(name).toLowerCase() === ".json"
    ? "application/json; charset=utf-8"
    : "text/plain; charset=utf-8";
}

// ── EventCursor：一个 SSE 连接专属的"读到哪里了"游标 ─────────────────
// 【作用】把 run.jsonl 当成"只追加的日志"做增量读。三个字段：
//   offset  上次读到文件的第几个字节（下次从这里继续）
//   pending 上次读到的最后一段若不是完整一行（没有换行符结尾），就先存在这里，
//           等下次读到换行符再拼起来解析——这是"半行"问题的解法
//   seq     已发出的事件总数（保证同一连接里 seq 连续递增）
// 【关系】stream() 为每个连接 new 一个；tests/e2e-observability.test.ts 间接测它的行为。
class EventCursor {
  private offset = 0;
  private pending = "";
  private seq = 0;

  constructor(private readonly eventPath: string) {}

  // ── initial：第一次连接时把"历史事件"补齐 ───────────────────────
  // 【参数】after：浏览器说"我只有第 after 条之前的内容"（重连时用它续传）。
  // 【过程】① 整读文件；② 找最后一个换行符，换行符之前是完整行，之后可能是不完整的半行；
  //         ③ 半行先试着解析一次——能解析说明文件刚好写完整了，就把它也算进来；
  //            解析失败就当它是 pending（留给下一次轮询）；
  //         ④ 记下 offset（字节位置）和 seq（事件条数），只返回 seq > after 的事件。
  initial(after: number): DashboardEvent[] {
    if (!existsSync(this.eventPath)) return [];
    const text = readFileSync(this.eventPath, "utf8");
    const lastNewline = text.lastIndexOf("\n");
    let completeText = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
    const tail = lastNewline < 0 ? text : text.slice(lastNewline + 1);
    if (tail.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(tail);
        if (isRecord(parsed)) completeText = text;
      } catch {
        // Treat a final partial line as pending data for the next poll.
      }
    }
    const events = parseEvents(completeText);
    // ← Buffer.byteLength 算的是**字节数**不是字符数（中文一个字符占 3 个字节），
    //   必须用字节才能和下次的 statSync().size 对得上
    this.offset = Buffer.byteLength(completeText, "utf8");
    this.pending = "";
    this.seq = events.length;
    return events.filter((event) => event.seq > after);
  }

  // ── readDelta：只读"上次之后新增的那一段" ────────────────────────
  // 【过程】① 看文件现在的字节数；② 如果比记忆中的 offset 还小，说明文件被换过/截断过
  //           （比如新一轮运行重写了文件）→ 游标归零从头读；
  //         ③ 从 offset 读到文件尾，推进 offset；
  //         ④ 把新读的文本接到 pending 后面按 \n 切开：最后一段（可能是半行）留下，
  //            其余都是完整行，送去解析。
  readDelta(): DashboardEvent[] {
    if (!existsSync(this.eventPath)) return [];
    const size = statSync(this.eventPath).size;
    if (size < this.offset) {
      this.offset = 0;
      this.pending = "";
      this.seq = 0;
    }
    const suffix = readSuffix(this.eventPath, this.offset);
    this.offset += suffix.bytes;
    if (suffix.text.length === 0) return [];

    this.pending += suffix.text;
    const lines = this.pending.split("\n");
    // ← pop 取走最后一个元素（切完 \n 后的最后一段），剩下的都是完整行
    this.pending = lines.pop() ?? "";
    const parsed = parseEvents(lines.join("\n"), this.seq);
    this.seq += parsed.length;
    return parsed;
  }
}

// ── DashboardService：真正的路由与读取逻辑都在这个类里 ────────────────
class DashboardService {
  readonly root: string;         // ← 解析并 realpath 过的观测根目录（安全比较的基准）
  readonly html: string;         // ← 首页 HTML 全文（启动时一次性读进内存）
  readonly pollIntervalMs: number;

  constructor(options: E2EDashboardOptions) {
    // ← resolve 把传入路径变成绝对路径（也顺手消化了 ./ 和 ../）
    const root = resolve(options.root);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`E2E root is not a directory: ${root}`);
    }
    // ← realpathSync 解析出真实路径：如果 root 本身是个符号链接，这里就把它还原，
    //   之后的 isWithin 比较才不会被"软链指向别处"骗过
    this.root = realpathSync(root);
    // ← import.meta.dir 是 Bun 提供的"当前源码文件所在目录"，从这里相对定位到 web/ 静态页
    this.html = readFileSync(
      options.staticFile ?? join(import.meta.dir, "..", "..", "web", "e2e-dashboard.html"),
      "utf8",
    );
    // ← 下限 200ms：防止有人传 0 或负数把 CPU 打满
    this.pollIntervalMs = Math.max(200, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  }

  // ── handle：每个 HTTP 请求都从这里进（相当于路由器） ───────────────
  // 【路由表】见文件头注释。实现思路：把 /api/runs/<id>/artifacts/<name> 按 / 切成段，
  //   然后逐段判断长度和内容。
  // 【安全】只许 GET；非法路径 400；不存在 404；内部错误 500 且不泄内部细节。
  handle(request: Request): Response {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    try {
      // ← new URL(request.url) 把完整 URL 解析成对象（pathname、searchParams 都好取）
      const url = new URL(request.url);
      const path = decodePathname(url.pathname);
      if (path === "/") return textResponse(this.html, "text/html; charset=utf-8");
      if (!path.startsWith("/")) throw new DashboardHttpError(400, "非法 URL 路径");

      // ← slice(1) 去掉开头的 /，再按 / 切成段
      const segments = path.slice(1).split("/");
      // ← 出现空段（比如 // 或结尾的 /）一律拒绝——不给穿越留缝
      if (segments.some((segment) => segment.length === 0)) {
        throw new DashboardHttpError(400, "非法 URL 路径");
      }
      if (segments.length === 2 && segments[0] === "api" && segments[1] === "runs") {
        return jsonResponse(this.listRuns());
      }
      if (segments[0] !== "api" || segments[1] !== "runs") {
        throw new DashboardHttpError(404, "资源不存在");
      }

      const runId = segments[2];
      if (runId === undefined) throw new DashboardHttpError(404, "资源不存在");
      rejectInvalidName(runId, "run");

      if (segments.length === 3) return jsonResponse(this.readRun(runId));
      const resource = segments[3];
      if (resource === "events" && segments.length === 4) {
        return jsonResponse(this.readEvents(runId, parseAfter(url)));
      }
      if (resource === "stream" && segments.length === 4) {
        return this.stream(request, runId, parseAfter(url));
      }
      if (resource === "artifacts" && segments.length === 4) {
        return jsonResponse(this.listArtifacts(runId));
      }
      if (resource === "artifacts" && segments.length === 5) {
        const name = segments[4];
        if (name === undefined) throw new DashboardHttpError(404, "资源不存在");
        rejectInvalidName(name, "artifact");
        return this.readArtifact(runId, name);
      }
      if (resource === "logs" && segments.length === 4) {
        return jsonResponse(this.listLogs(runId));
      }
      if (resource === "logs" && segments.length === 5) {
        const name = segments[4];
        if (name === undefined) throw new DashboardHttpError(404, "资源不存在");
        rejectInvalidName(name, "log");
        return this.readLog(runId, name);
      }
      throw new DashboardHttpError(404, "资源不存在");
    } catch (cause) {
      // ← 自己抛的 DashboardHttpError 是"预期内错误"，直接把状态码和文案还给浏览器
      if (cause instanceof DashboardHttpError) {
        return jsonResponse({ error: cause.publicMessage }, cause.status);
      }
      // ← 意外错误：服务端打日志（给开发者看），对外只说一句模糊的话（不给攻击者线索）
      console.error("E2E dashboard request failed", cause);
      return jsonResponse({ error: "读取观测数据失败" }, 500);
    }
  }

  // ── pathInsideRoot：拼出候选路径并确认它没逃出 root ─────────────────
  // 【两道检查】① resolve 之后必须还在 root 里（防 ../）；
  //            ② 如果文件真的存在，再用 realpathSync 解析一次——因为**符号链接**可以
  //              指到 root 外面，第①步看不出来。
  // 【参数】requireExisting：true 时文件不存在要报 404，false 时允许"还没写出来"
  private pathInsideRoot(parts: readonly string[], requireExisting = false): string {
    const candidate = resolve(this.root, ...parts);
    if (!isWithin(this.root, candidate)) {
      throw new DashboardHttpError(400, "拒绝访问 root 外路径");
    }
    if (!existsSync(candidate)) {
      if (requireExisting) throw new DashboardHttpError(404, "资源不存在");
      return candidate;
    }
    try {
      const real = realpathSync(candidate);
      if (!isWithin(this.root, real)) {
        throw new DashboardHttpError(400, "拒绝访问 root 外路径");
      }
    } catch (cause) {
      if (cause instanceof DashboardHttpError) throw cause;
      if (requireExisting) throw new DashboardHttpError(404, "资源不存在");
    }
    return candidate;
  }

  // ── runDirectory：验证"这个 runId 真的是一个合法的 run 目录" ────────
  // 【验证清单】目录存在、是目录（不是文件）、不是符号链接、
  //            里面的 state.json 存在、是普通文件、也不是符号链接。
  // 【为什么这么严】runId 来自 URL，任何一步放松都可能被用来读服务器上的其他文件
  private runDirectory(runId: string): string {
    rejectInvalidName(runId, "run");
    const runDir = this.pathInsideRoot([runId], true);
    let info;
    try {
      info = lstatSync(runDir);       // ← lstat：不跟随符号链接，看到的就是"链接本身"
    } catch {
      throw new DashboardHttpError(404, "run 不存在");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new DashboardHttpError(404, "run 不存在");
    }
    const statePath = this.pathInsideRoot([runId, "state.json"], true);
    let stateInfo;
    try {
      stateInfo = lstatSync(statePath);
    } catch {
      throw new DashboardHttpError(404, "run 不存在");
    }
    if (!stateInfo.isFile() || stateInfo.isSymbolicLink()) {
      throw new DashboardHttpError(404, "run 不存在");
    }
    return runDir;
  }


  // ── readState：读 state.json（所有接口都要先过 runDirectory 这道门） ──
  private readState(runId: string): JsonObject {
    try {
      this.runDirectory(runId);
      return readJsonObject(this.pathInsideRoot([runId, "state.json"], true));
    } catch (cause) {
      if (cause instanceof DashboardHttpError) throw cause;
      throw new DashboardHttpError(500, "state.json 无法读取");
    }
  }

  // ── readRun：状态 + 全部事件（前端第一次进入某个 run 时用） ─────────
  private readRun(runId: string): { readonly state: JsonObject; readonly events: DashboardEvent[] } {
    return { state: this.readState(runId), events: this.readAllEvents(runId) };
  }

  // ── eventPath：拿到这个 run 的 run.jsonl 路径（同样先验证） ─────────
  private eventPath(runId: string): string {
    this.runDirectory(runId);
    return this.pathInsideRoot([runId, "run.jsonl"]);
  }

  // ── readAllEvents：把 run.jsonl 整个解析一遍 ─────────────────────
  // 【⚠️ 性能点（教程任务 8.2 第 8 条）】非流式的 /events 每次都全量重读 + 全量重解析，
  //   文件大了会浪费 CPU；stream 接口用 EventCursor 增量读就是为了避开这一点
  private readAllEvents(runId: string): DashboardEvent[] {
    const path = this.eventPath(runId);
    if (!existsSync(path)) return [];
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) return [];
      return parseEvents(readTextIfPresent(path));
    } catch {
      return [];
    }
  }

  // ── readEvents：轮询版增量接口 ───────────────────────────────────
  // 【说明】它其实是"全量重读 + 客户端侧过滤"，next_seq 告诉前端下次带 ?after= 多少。
  //   真正省力的是 /stream（SSE），这个接口给不支持 SSE 的场景兜底
  private readEvents(runId: string, after: number): { readonly events: DashboardEvent[]; readonly next_seq: number } {
    const events = this.readAllEvents(runId);
    // ← at(-1) 取数组最后一个元素（TS/ES2022 语法）；没有元素时用 ?? 兜底成 0
    return { events: events.filter((event) => event.seq > after), next_seq: events.at(-1)?.seq ?? 0 };
  }

  // ── listRuns：把 root 下每个"长得像 run 的目录"都读一遍摘要 ────────
  // 【参数】readdirSync(root, { withFileTypes: true }) 返回 Dirent 数组，
  //   能直接知道每一项是目录还是文件、是不是符号链接，不用再 stat 一次。
  // 【容错】没有 state.json（或读不出来）的目录不算 run，直接跳过。
  // 【排序】最新更新的在前（updated_at 字符串可以直接字典序比较，因为 ISO 格式是有序的）；
  //   时间相同再按 run_id 排，保证顺序稳定
  private listRuns(): RunSummary[] {
    const summaries: RunSummary[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_NAME.test(entry.name)) continue;
      try {
        summaries.push(summaryFromState(entry.name, this.readState(entry.name)));
      } catch {
        // A directory without a readable state.json is not an observable run.
      }
    }
    summaries.sort((a, b) => {
      const byTime = b.updated_at.localeCompare(a.updated_at);
      return byTime !== 0 ? byTime : a.run_id.localeCompare(b.run_id);
    });
    return summaries;
  }

  // ── artifactDirectory：验证 artifacts 目录合法（存在才行） ─────────
  private artifactDirectory(runId: string): string | null {
    this.runDirectory(runId);
    const path = this.pathInsideRoot([runId, "artifacts"]);
    if (!existsSync(path)) return null;
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
      return path;
    } catch {
      return null;
    }
  }

  // ── listDirectoryFiles：列出 artifacts 或 logs 目录里的文件 ─────────
  // 【过滤】只收普通文件（跳过子目录、符号链接、名字不合规的）。
  // 【容错】单文件 stat 失败（比如正好被删了）只跳过那一个，不影响整个列表。
  // 【排序】按名字字典序，输出稳定
  private listDirectoryFiles(runId: string, directoryName: "artifacts" | "logs"): ArtifactSummary[] {
    this.runDirectory(runId);
    const directory = this.pathInsideRoot([runId, directoryName]);
    if (!existsSync(directory)) return [];
    let info;
    try {
      info = lstatSync(directory);
    } catch {
      return [];
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return [];

    const files: ArtifactSummary[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !SAFE_NAME.test(entry.name)) continue;
      try {
        const path = this.pathInsideRoot([runId, directoryName, entry.name], true);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        files.push({
          name: entry.name,
          size: stat.size,
          modified_at: stat.mtime.toISOString(),
          mtime_ms: stat.mtimeMs,
        });
      } catch {
        // Ignore files that disappear or fail the root containment check mid-list.
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
  }

  // ── listArtifacts / listLogs：两个目录的列表接口 ─────────────────
  private listArtifacts(runId: string): ArtifactSummary[] {
    // Keep this explicit so an absent artifacts directory still validates runId.
    // ← 先单独调一次校验：即使 artifacts 目录不存在，runId 的合法性检查也不能省
    this.artifactDirectory(runId);
    return this.listDirectoryFiles(runId, "artifacts");
  }

  private listLogs(runId: string): ArtifactSummary[] {
    return this.listDirectoryFiles(runId, "logs");
  }

  // ── regularChild：验证"run 目录下的某个具体文件"可读 ───────────────
  // 【返回】该文件的绝对路径（readArtifact/readLog 拿去读内容）
  private regularChild(runId: string, directoryName: "artifacts" | "logs", name: string): string {
    rejectInvalidName(name, directoryName === "artifacts" ? "artifact" : "log");
    this.runDirectory(runId);
    const path = this.pathInsideRoot([runId, directoryName, name], true);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      throw new DashboardHttpError(404, "文件不存在");
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new DashboardHttpError(404, "文件不存在");
    return path;
  }

  // ── readArtifact / readLog：把文件内容当文本返回 ─────────────────
  private readArtifact(runId: string, name: string): Response {
    const path = this.regularChild(runId, "artifacts", name);
    try {
      return textResponse(readFileSync(path, "utf8"), artifactContentType(name));
    } catch {
      throw new DashboardHttpError(404, "Artifact 不存在");
    }
  }

  private readLog(runId: string, name: string): Response {
    const path = this.regularChild(runId, "logs", name);
    try {
      return textResponse(readFileSync(path, "utf8"), "text/plain; charset=utf-8");
    } catch {
      throw new DashboardHttpError(404, "日志不存在");
    }
  }

  // ── stream：SSE 长连接（本文件最精巧的一段） ──────────────────────
  // 【参数】request 原始请求（要用它的 signal 感知浏览器断开）；runId；after 起始序号。
  // 【返回】一个 Response，body 是 ReadableStream——浏览器看来就是一条一直有数据流出的连接。
  // 【整体流程】
  //   ① 先把当前 state.json 作为第一帧 "state" 事件推出去（前端立刻有东西可画）；
  //   ② 再把 run.jsonl 里的历史事件（seq > after）一次性补发；
  //   ③ 每 pollIntervalMs（默认 800ms）tick 一次：增量读新事件逐条发；
  //      state.json 内容有变化才发（比较序列化后的字符串，避免每 800ms 白推一遍）；
  //   ④ 每 15 秒发一行 ": keep-alive"（以冒号开头是 SSE 的注释行，浏览器忽略，
  //      但能让中间的代理/防火墙知道这条连接还活着）；
  //   ⑤ 浏览器关页面 / 请求被取消 → cancel 或 abort → close() 清掉两个定时器并关闭流。
  // 【语法】ReadableStream 的 start(controller) 在流创建时被调用一次，
  //   controller.enqueue(...) 就是"往连接里写一段字节"；闭包变量（controller/pollTimer/lastState）
  //   在 start 和 tick/close 之间共享——这就是为什么它们要定义在外层函数里。
  private stream(request: Request, runId: string, after: number): Response {
    this.runDirectory(runId);
    const eventPath = this.pathInsideRoot([runId, "run.jsonl"]);
    const cursor = new EventCursor(eventPath);
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastState = "";

    // ← close：幂等的清理函数（closed 标志保证重复调用也没事）
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      pollTimer = null;
      heartbeatTimer = null;
      if (controller !== null) {
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      }
    };

    // ← send：把一条 SSE 事件写进连接。
    //   格式是 "event: 名字\n[id: N\ndata: 载荷\n\n"。
    //   data 必须是单行，所以把载荷里的换行替换成字面量 "\n"（JSON 字符串本身不含裸换行，
    //   这里是双保险）。
    //   enqueue 失败（客户端断开）就直接 close。
    const send = (eventName: string, payload: unknown, id?: number): void => {
      if (closed || controller === null) return;
      const idLine = id === undefined ? "" : `id: ${id}\n`;
      const data = JSON.stringify(payload).replace(/\n/g, "\\n");
      try {
        controller.enqueue(encoder.encode(`event: ${eventName}\n${idLine}data: ${data}\n\n`));
      } catch {
        close();
      }
    };

    // ← tick：一次轮询 = 推新事件 + 推（可能变化的）状态
    const tick = (): void => {
      if (closed) return;
      try {
        // ← 增量读：只有新增的那几行会被解析
        for (const event of cursor.readDelta()) send("event", event, event.seq);
        const state = this.readState(runId);
        const serialized = JSON.stringify(state);
        if (serialized !== lastState) {
          lastState = serialized;
          send("state", state);
        }
      } catch {
        // Keep the stream alive while state.json is being replaced by a writer.
        // ← 写侧正在覆盖 state.json 的那一瞬间可能读到半截内容：不要断流，等下个周期再试
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
        try {
          const state = this.readState(runId);
          lastState = JSON.stringify(state);
          send("state", state);                                        // ① 第一帧状态
          for (const event of cursor.initial(after)) send("event", event, event.seq);   // ② 历史事件
          pollTimer = setInterval(tick, this.pollIntervalMs);          // ③ 周期轮询
          heartbeatTimer = setInterval(() => {
            if (!closed) {
              try {
                controller?.enqueue(encoder.encode(": keep-alive\n\n"));   // ④ 保活注释行
              } catch {
                close();
              }
            }
          }, 15_000);
        } catch {
          send("error", { message: "run 状态暂时不可用" });
          close();
        }
      },
      cancel: () => close(),      // ⑤ 浏览器主动断开时被调用
    });
    // ← request.signal 是标准的 AbortSignal：客户端断开时它会被触发，{ once: true } 表示只监听一次
    request.signal.addEventListener("abort", close, { once: true });

    return new Response(stream, {
      headers: {
        // ← 这一行是 SSE 的"身份证"；no-transform 禁止代理压缩/改写流
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // ← X-Accel-Buffering: no 是给 Nginx 看的：别把流攒够一批再转发，来一条发一条
        "X-Accel-Buffering": "no",
      },
    });
  }
}

// ── createE2EDashboardHandler：只给"处理函数"，不给服务器 ─────────────
// 【作用】返回一个 (request) => Response 的普通函数，方便 Bun.serve 之外的用法
// （单测里直接调它，不用真的占端口）。
// 【语法】箭头函数捕获了 service 变量形成闭包，所有请求共享同一个 service 实例
export function createE2EDashboardHandler(options: E2EDashboardOptions): (request: Request) => Response {
  const service = new DashboardService(options);
  return (request: Request) => service.handle(request);
}

// ── createE2EDashboardServer：起一个真正的 Bun HTTP 服务器 ────────────
// 【作用】Bun.serve({ hostname, port, fetch }) 是 Bun 内置的服务器 API：
//   每个请求都会调 fetch 函数，返回什么就回给浏览器什么。
// 【关系】scripts/e2e-dashboard.ts 调它；port 用 0 让系统挑空闲端口（脚本里会打印真实端口）。
// 【语法】返回值类型没写注解，让 TS 自动推断（Bun 的 Server 类型）
export function createE2EDashboardServer(options: E2EDashboardOptions) {
  const handler = createE2EDashboardHandler(options);
  return Bun.serve({
    hostname: options.hostname ?? DEFAULT_HOSTNAME,
    port: options.port ?? DEFAULT_PORT,
    fetch: handler,
  });
}
