/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/worker.ts —— 子进程的入口（"跑 workflow 的那个人"）
 *
 * 【这个文件是干什么的】
 *   runner.ts 在主进程里 spawn 了一个 `bun run worker.ts <entry> <cwd>` 子进程，
 *   这个文件就是那个 worker.ts。它的完整人生只有四步：
 *     ① 从 stdin 读第一行 JSON（input / facts / policy）；
 *     ② 用 client.ts 造出 ctx，然后【动态 import】workflow 源码、取出默认导出的函数；
 *     ③ 调用那个函数，把 ctx 传进去；
 *     ④ 把结果（或错误）包成 workflow-result envelope 写一行到 stdout，退出。
 *   期间它同时开着一个后台循环，不停读 stdin 上宿主回过来的 capability-response，
 *   一条条喂给 client.accept() 去唤醒等待中的 Promise。
 *
 * 【两个进程、一条 JSON 管道】
 *   stdout 只许走协议（capability-request 和最终 envelope）—— 见下面那三行
 *   console 劫持。stderr 才是给人看的日志。
 *   ⚠️ 注意一个容易误会的地方：worker 自己【可以】import "node:url" 这些内置模块 ——
 *   source-policy.ts 的禁令只作用于【workflow 源码】（那个 entry 文件），
 *   worker 是宿主信任的基础设施，不是被沙箱约束的对象。
 *
 * 【在整个项目里的位置】
 *   上游：runner.ts spawn 它（build-executor.ts / test-executor.ts /
 *         build-workflow.ts / test-workflow.ts / scripts/cli.ts / 多个测试都经由 runner）。
 *   下游：client.ts（造 ctx）、capability-protocol.ts（报文）、动态加载的 workflow 源码
 *         （examples/workflows/*.ts 或 .refactorsa/ 注册表里的生成产物）。
 *
 * 【先修知识】
 *   Promise/async-await（client.ts 讲过）、顶层 await、动态 import()、
 *   异步生成器 async function*、可选链 ?.
 * 【本文件是教程注释版】
 *   原文件：src/workflow/worker.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import { pathToFileURL } from "node:url";
// ↑ node:url 的 pathToFileURL：把磁盘路径转成 file:/// 形式的 URL。
//   动态 import() 的参数必须是 URL 或相对说明符，Windows 的 "D:\\x\\y.ts" 直接传会
//   被当成协议名解析出错，所以先转成 file:///D:/x/y.ts。
import type { WorkflowContext, WorkflowFacts, WorkflowFunction } from "./types.js";
import {
  isCapabilityResponse,
  type CapabilityResponse,
  type WorkerPayload,
  type WorkerEnvelope,
} from "./capability-protocol.js";
// ↑【语法】同一个 import 里混着"值导入"（isCapabilityResponse，真函数）和
//   `type` 前缀的"纯类型导入"（编译后消失）。分开写是为了让打包器/读代码的人都清楚。
import { createWorkflowContext, type WorkflowCapabilityClient } from "./client.js";

// ── WorkflowModule：对"加载进来的模块"的最小假设──────────────────────
// 【作用】动态 import 拿到的东西类型是 unknown（TS 不知道里面有什么），
//   这里声明"它可能有 default 或 run 两个导出"。真正验证靠 isWorkflowModule。
interface WorkflowModule {
  default?: unknown;
  run?: unknown;
}

// ── 第 0 步：解析命令行参数────────────────────────────────────────
// 【语法】`const [, , entry, workspaceRoot] = Bun.argv;`
//   - Bun.argv 是命令行参数数组，等价于 Node 的 process.argv：
//     [0]=bun 可执行文件, [1]=脚本路径, [2]起才是真正的参数。
//   - 数组解构里开头两个逗号 = "跳过前两个元素"（占位但不取变量）。
//   - 所以 entry = 第 3 个参数（workflow 源码绝对路径）、workspaceRoot = 第 4 个。
const [, , entry, workspaceRoot] = Bun.argv;
if (entry === undefined || workspaceRoot === undefined) {
  process.stderr.write("workflow worker requires entry and workspace root\n");
  process.exit(2);   // ← 退出码 2 = "参数不对"，和业务失败（1）区分开
}

// Keep stdout reserved for the JSONL capability protocol and result envelope.
// ⚠️【本文件最重要的三行】把 console.log/info/warn 全部重定向到 stderr。
// 【为什么】workflow 源码里如果随手写了 console.log("xxx")，而 stdout 是 JSONL
//   协议通道，宿主按行 JSON.parse 就会炸 —— 脏行会被扔进 protocolNoise，
//   最终出现在 WorkflowRunResult.stdout 里冒充"命令输出"。
// 【语法】给 console.log 直接赋一个新函数（JS 的对象方法可以随便换），箭头函数
//   的 `...args: unknown[]` 是"剩余参数"：不管调用方传几个参数都收进 args 数组。
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

// ── 第 1 步：读 stdin 的第一行（开机 payload）──────────────────────
// 【语法】`readLines(Bun.stdin.stream())` 返回一个异步生成器（见文件底部），
//   但这里没有 for await，而是直接 `[Symbol.asyncIterator]()` 取出迭代器对象，
//   手动一行行 .next()。为什么要绕这一下？因为第一行有特殊用途（payload），
//   【剩下】的行才属于"回复流"，要交给另一个后台循环 —— 生成器天然支持"从中间
//   接着读"，把同一个迭代器传给 consumeResponses 就实现了这个切分。
const inputLines = readLines(Bun.stdin.stream())[Symbol.asyncIterator]();
// ↑【语法】★★★ 顶层 await ★★★：这一行不在任何 async 函数里，也直接 await 了。
//   ES 模块允许在文件顶层 await（Bun 支持），效果是"模块加载到这里就停住，
//   等结果再往下走"。整个文件因此可以写成一条直线脚本，不用包 main()。
const first = await inputLines.next();
if (first.done || first.value === undefined) {
  process.stderr.write("workflow worker requires a JSON payload\n");
  process.exit(2);
}
// ↑【语法】迭代器每次 .next() 返回 { value, done } 两个字段。在 TS 里它是个联合
//   类型：done 为 false 时 value 是"下一个元素"，done 为 true 时 value 是 undefined。
//   所以必须先判断 first.done，TS 才肯让你安全地读 first.value（这叫"类型收窄"）。

let client: WorkflowCapabilityClient | null = null;
// ↑ 先声明成 null 再在 try 里赋值，是为了 catch 块里也能拿到 client
//   （把已经发生的观测记录和 expect 声明带出去）。所以后面会用 client?.xxx。

// ── 第 2、3、4 步：主流程（整个包在 try/catch 里）────────────────────
try {
  const payloadValue: unknown = JSON.parse(first.value);
  // ↑【语法】JSON.parse 的返回值在 TS 里默认是 any；这里显式标成 unknown ——
  //   强迫后面先检查再用，这是本项目统一的写法。
  const payload = isPayload(payloadValue)
    ? payloadValue
    : { input: payloadValue, facts: {} } satisfies WorkerPayload;
  // ↑【语法】★★★ satisfies ★★★（TS 4.9+）：既校验这个对象字面量"符合 WorkerPayload
  //   的形状"，又【不】把它宽化成 WorkerPayload 类型（保留了字面量的精确类型）。
  //   这里也兼容了旧格式：payload 直接就是一个裸 input 值（没有 facts 字段）时，
  //   把它包成 { input, facts: {} }。
  const created = createWorkflowContext({
    workspaceRoot,
    input: payload.input,
    facts: payload.facts,
    transport: {
      // ↑ 这就是 client 依赖的 transport 实现：一行 JSON + 换行写到 stdout。
      //   注意 process.stdout.write 是异步缓冲的，写出去不等于对面读到了。
      send: (request) => process.stdout.write(`${JSON.stringify(request)}\n`),
    },
  });
  client = created.client;
  const context = created.context;
  // ↑【语法】`void consumeResponses(…)`：void 运算符丢弃返回值，表达
  //   "我知道这个 Promise 我不 await，故意让它后台跑"。这是启动一个并行任务的
  //   惯用标记（同时也压掉了某些 lint 规则对"未处理的 Promise"的抱怨）。
  void consumeResponses(inputLines, client);

  // Runtime-selected workflow entry: this is the intentional plugin boundary.
  // ↑【语法】★★★ 动态 import ★★★
  //   与文件顶部的静态 import 不同：import(表达式) 在【运行时】才决定加载哪个文件，
  //   返回一个 Promise（resolve 成模块对象）。这就是"插件边界"的实现手段 ——
  //   要跑哪个 workflow 是宿主 spawn 时才传进来的参数，静态 import 做不到。
  const loaded: unknown = await import(pathToFileURL(entry).href);
  if (!isWorkflowModule(loaded)) throw new Error("workflow module could not be loaded");
  // ← 约定优先取 default 导出（`export default async (ctx) => {}`），
  //   也兼容命名导出 run（`export async function run(ctx) {}`）。
  const candidate = loaded.default ?? loaded.run;
  if (!isWorkflowFunction(candidate)) {
    throw new Error("workflow must export a default function or named run function");
  }
  const result = await candidate(context);
  // ↑ 把 ctx 交给 workflow 函数，等它跑完。它内部每一次 ctx.fs.xxx / ctx.process.xxx
  //   都会走 client.call() → stdout → 宿主 broker → stdin → accept() 的来回。

  // ── 第 4 步：写"最终交账"envelope────────────────────────────────
  const envelope: WorkerEnvelope = {
    type: "workflow-result",
    ok: true,
    result: result ?? null,        // ← 函数返回 undefined 时归一成 null，JSON 里没有 undefined
    events: client.getEvents(),
    expectations: client.getExpectations(),   // ← ⚠️ ctx.expect 收集的声明从这里带出去
  };
  await writeLine(envelope);
  client.rejectAll(new Error("workflow completed"));  // ← 清掉还没回来的挂起请求，避免悬挂
  process.exit(0);
} catch (cause) {
  // 【关系】任何一步抛异常（包括 workflow 函数内部 throw，以及 validator 断言失败
  //   抛出来的错）都会落到这里 —— 宿主看到的就是 status:"failed" + envelope.error。
  const envelope: WorkerEnvelope = {
    type: "workflow-result",
    ok: false,
    error: cause instanceof Error ? cause.message : String(cause),
    events: client?.getEvents() ?? [],
    // ↑【语法】可选链 `client?.getEvents()`：client 是 null 时短路返回 undefined 而
    //   不报错，再由 `?? []` 兜底成空数组。异常可能发生在 client 赋值之前。
    expectations: client?.getExpectations() ?? [],
  };
  await writeLine(envelope);
  process.exit(1);
}

// ── consumeResponses：后台循环，把宿主的回复喂给 client──────────────
// 【作用】与 workflow 函数【并行】运行：函数在 await 一条能力请求时，
//   这个循环正在读 stdin，把配对的回复送进来。没有它，所有 await 都会永远挂着。
// 【参数】lines：readLines 剩下的部分（第一行 payload 已经被消费掉了）。
// 【关系】结束时机：宿主关掉 stdin（流结束）→ rejectAll("capability broker disconnected")。
async function consumeResponses(
  lines: AsyncIterator<string>,
  client: WorkflowCapabilityClient,
): Promise<void> {
  try {
    for (;;) {                        // ← 无限循环的经典写法（等价 while (true)）
      const next = await lines.next();
      if (next.done || next.value === undefined) {
        client.rejectAll(new Error("capability broker disconnected"));
        return;
      }
      const value = parseCapabilityResponse(next.value);
      if (value !== null) client.accept(value);
    }
  } catch (cause) {
    client.rejectAll(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

// ── parseCapabilityResponse：一行 → 校验 → 对象 或 null─────────────
// 【作用】双重防御：JSON.parse 可能抛（行不是合法 JSON），isCapabilityResponse
//   可能返回 false（是 JSON 但不是合法回复）。两种情况都返回 null 让调用方丢弃。
// 【语法】try { … } catch { … }：catch 后面不写参数（ES2019 起），
//   表示"我不关心异常对象是什么"。
function parseCapabilityResponse(line: string): CapabilityResponse | null {
  try {
    const value: unknown = JSON.parse(line);
    return isCapabilityResponse(value) ? value : null;
    // ↑ 这里体现了类型谓词的用处：isCapabilityResponse 为真时，value 被 TS
    //   收窄成 CapabilityResponse，才能原样作为返回值。
  } catch {
    return null;
  }
}

// ── readLines：把一个字节流变成"一行行字符串"的异步生成器──────────────
// 【语法】★★★ 异步生成器 ★★★：`async function*` + `yield`。
//   调用它不立刻执行，返回一个异步迭代器；每次 await iterator.next() 才推进到
//   下一个 yield。`for await (const chunk of stream)` 是它的异步版 for…of，
//   每轮等一块数据到达。这是全项目处理流式输出的两份实现之一（另一份在 runner.ts，
//   那边是事件回调风格，这边是迭代器风格，功能等价）。
// 【为什么要 buffer】TCP/管道没有"行"的概念，一次 chunk 可能半行、可能三行，
//   必须攒着，找到 \n 就切一行出去，剩下的留在 buffer 里等下一块。
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();     // ← 字节 → UTF-8 字符串；能正确处理跨块的多字节字符
  let buffer = "";
  for await (const chunk of stream) {
    // { stream: true }：告诉 decoder"这一块可能是一个多字节字符的前半截，先别急着报错"
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;            // ← 没有完整的一行，攒着
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) yield line;   // ← 忽略空行（比如两端多余的换行）
    }
  }
  // ↑【语法】`decoder.decode()` 不传参数：把 decoder 内部攒着的尾字节冲出来。
  //   最后如果还剩一段没有换行符的内容，也要作为一行 yield 出去（容忍"末行无换行"）。
  buffer += decoder.decode();
  if (buffer.trim().length > 0) yield buffer.trim();
}

// ── writeLine：写一行 JSON 到 stdout，并真正等它写完────────────────
// 【作用】envelope 必须完整送达才能 process.exit()，所以这里把 write 包成 Promise
//   等待回调。对比上面 transport.send（fire-and-forget）：请求丢出去就算了，
//   但最终交账必须确认写完。
// 【语法】process.stdout.write(data, callback)：回调风格的 API。
//   `new Promise<void>((resolveWrite, rejectWrite) => { … })` 把它 Promise 化 ——
//   和 client.ts 的 call() 是同一手法，只是成功/失败分别对应 resolve/reject。
async function writeLine(value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(line, (error?: Error | null) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

// ── 三个小守卫：worker 自己的运行时类型检查─────────────────────────
// 【语法】类型谓词 `value is T`（详见 capability-protocol.ts 的详细讲解）。
// isWorkflowModule 其实很宽松：只要是个非 null 对象就过 —— 真正的检查在下一行
//   "必须是函数"。
function isWorkflowModule(value: unknown): value is WorkflowModule {
  return typeof value === "object" && value !== null;
}
function isWorkflowFunction(value: unknown): value is WorkflowFunction {
  return typeof value === "function";
}
// isPayload：第一行 payload 必须同时带 input 和 facts 两个字段才算"新格式"。
// 【语法】`"input" in value`：in 运算符，运行时判断对象（或其原型链）有没有这个键。
function isPayload(value: unknown): value is WorkerPayload {
  return typeof value === "object" && value !== null &&
    "input" in value && "facts" in value;
}
