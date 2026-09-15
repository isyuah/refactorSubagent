/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/runner.ts —— 宿主侧执行器（"spawn 子进程 + 当经纪人"）
 *
 * 【这个文件是干什么的】
 *   给它一段 workflow 源码的路径，它负责把这段源码【安全地】跑起来并交回结果：
 *     ① 先静态检查源码（source-policy.ts，禁止 import node:/bun:/child_process）——
 *        检查不过直接返回 status:"rejected"，连子进程都不启动（fail-closed）；
 *     ② spawn 一个 `bun run worker.ts <entry> <cwd>` 子进程；
 *     ③ 盯着子进程的 stdout 一行行读：
 *          capability-request → 交给 LocalCapabilityBroker 处理，把回复写回子进程 stdin
 *          workflow-result    → 存下来，这就是最终结果
 *          其他               → 原样攒进 protocolNoise（最后算作 stdout 返回）
 *     ④ 整个运行有超时；超时就 taskkill 杀掉整棵进程树，返回 status:"timeout"。
 *
 * 【两个进程、一条 JSON 管道】
 *   本文件在【主进程】里跑，是管道的宿主那一端。对面的 worker.ts 是子进程那一端。
 *   宿主这边真正有 node:fs / child_process 权限，但它只替子进程"代办"，
 *   且代办时按 policy 过滤 —— 这就是 Capability Broker 的意义。
 *
 * 【在整个项目里的位置】
 *   上游（谁调用 runWorkflow）：
 *     - src/workflow/build-executor.ts  （workflow-driven 构建）
 *     - src/workflow/test-executor.ts   （自驱动测试的单侧运行）
 *     - src/workflow/build-workflow.ts / test-workflow.ts（声明式 workflow 解析期执行）
 *     - scripts/cli.ts（直接跑一个 workflow 的调试入口）
 *     - tests/workflow-*.test.ts（大量单测直接调用它）
 *   下游（它调用谁）：source-policy.ts、capabilities.ts 的 LocalCapabilityBroker。
 *   产出：WorkflowRunResult（events / plan / expectations 进后续对比与 artifact）。
 *
 * 【先修知识】
 *   client.ts（对面的那一端）、capability-protocol.ts（报文）；
 *   本文件新增的语法：事件回调、Buffer、setTimeout、Promise 链。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/runner.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import { execFileSync, spawn } from "node:child_process";
// ↑ spawn：异步起一个子进程（不等待，靠事件通知）；execFileSync：同步跑一条命令
//   并阻塞到结束（本文件只拿它来 taskkill，简单粗暴但可靠）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import type { WorkflowCapabilityPolicy, WorkflowFacts, WorkflowRunResult } from "./types.js";
import {
  isCapabilityRequest,
  isWorkerEnvelope,
  type WorkerEnvelope,
  type WorkerPayload,
} from "./capability-protocol.js";
import { checkWorkflowSource } from "./source-policy.js";
import { LocalCapabilityBroker } from "./capabilities.js";

// ── RunWorkflowOptions：调用方要给的东西────────────────────────────
// 【参数】entry：workflow 源码路径（绝对或相对都行）；cwd：worktree 目录（子进程的
//   工作目录，也是 broker 的 workspaceRoot，所有相对路径都相对它）；
//   input：给 workflow 的业务数据；facts：主机/项目测量事实；
//   policy：能力权限清单；timeoutMs：整个 workflow 的墙钟上限（毫秒！）。
// 【注意】前 4 个是可选的，但 timeoutMs【没有默认值】—— 调用方必须想清楚，
//   这是刻意的：执行多久这件事不该由基础设施替你决定。
// 🔗 呼应《零基础看懂教程.md》任务 6C：全项目超时值目前散落多处，这里是其中之一。
export interface RunWorkflowOptions {
  entry: string;
  cwd: string;
  input?: unknown;
  facts?: WorkflowFacts;
  policy?: WorkflowCapabilityPolicy;
  timeoutMs: number;
}

// ── runWorkflow：本文件最核心的函数（也是全组最重要的函数之一）─────────
// 【返回】Promise<WorkflowRunResult> —— status 一定是 pass/failed/timeout/rejected 之一，
//   【永远不 throw】：失败也是结果的一种，调用方不用写 try/catch。
/** Execute a source-checked workflow with brokered filesystem/process capabilities. */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const entry = resolveEntry(options.entry);
  const checked = checkWorkflowSource(entry);
  // ← 第一道门：静态检查。注意这里是同步函数，直接返回结果对象。
  if (!checked.ok) return rejected(checked.reason ?? "workflow source rejected");

  // 【语法】`new URL("./worker.ts", import.meta.url)` + fileURLToPath：
  //   import.meta.url 是"当前这个模块文件自己的 URL"（file:///D:/…/runner.ts），
  //   以它为基准解析出同目录下 worker.ts 的路径 —— 也就是说 runner 无论被谁从
  //   哪个目录 import，都能找到身边的 worker.ts。这比写死相对路径稳。
  const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
  const cwd = resolve(options.cwd);
  // 【关系】broker 是宿主侧的能力总管：收 request、按 policy 放行、真正碰文件系统。
  //   它拿着 cwd 当 workspaceRoot，host/project 事实也会被它用来判断工具可用性。
  const broker = new LocalCapabilityBroker({
    workspaceRoot: cwd,
    host: options.facts?.host,
    project: options.facts?.project,
    policy: options.policy,
  });
  // 【语法】spawn(命令, 参数数组, 选项) —— 参数用数组而不是字符串拼接，
  //   避免空格/特殊字符被 shell 误解（这是安全常识：绝不拼字符串再交给 shell）。
  const child = spawn(process.execPath, ["run", worker, entry, cwd], {
    // ↑ process.execPath = 当前 Bun 可执行文件的绝对路径。
    //   所以实际命令是：bun run <worker.ts> <workflow.ts> <worktree目录>
    cwd,
    env: process.env,                      // ← 继承宿主全部环境变量
    stdio: ["pipe", "pipe", "pipe"],       // ← stdin/stdout/stderr 全是管道，由我们手动接
    shell: false,                          // ← 不经过 shell，参数原样传递
    windowsHide: true,                     // ← Windows 上别弹出黑框
    // detached：POSIX 上让子进程成为新进程组组长（这样下面才能 kill(-pid) 团灭）。
    // Windows 上不这么设，因为 Windows 用 taskkill /T 更可靠。
    detached: process.platform !== "win32",
  });

  const protocolNoise: Buffer[] = [];    // ← stdout 上"不是合法协议报文"的行（往往是 workflow 自己 print 的东西）
  const stderr: Buffer[] = [];           // ← 子进程的 stderr 原样攒着（console 被劫持到这里）
  let protocolBuffer = "";               // ← 半行的攒存区（管道一次给的可能是半行 JSON）
  let finalEnvelope: WorkerEnvelope | null = null;
  let timedOut = false;
  let requestChain = Promise.resolve();
  // ↑【本文件最精妙的一行】见下面 stdout 回调里的讲解：它是一条"串行队列"。

  // ── stdout 处理：按行切分 + 分拣──────────────────────────────────
  // 【语法】`child.stdout.on("data", (chunk) => {…})`：Node/Bun 的事件回调风格。
  //   chunk 是 Buffer（原始字节），不是字符串 —— 管道传的是字节。
  child.stdout.on("data", (chunk: Buffer) => {
    protocolBuffer += chunk.toString("utf8");
    for (;;) {
      // ↑ 和 worker.ts 的 readLines 一样：找不到完整一行就攒着，找到就切。
      const newline = protocolBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = protocolBuffer.slice(0, newline).trim();
      protocolBuffer = protocolBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // ← 不是合法 JSON 的行不算错误，留档（最后会出现在结果的 stdout 字段里，
        //   方便人看 workflow 是不是打印了什么多余的东西）
        protocolNoise.push(Buffer.from(`${line}\n`, "utf8"));
        continue;
      }
      if (isCapabilityRequest(value)) {
        // ── 串行化：为什么要 requestChain？─────────────────────────
        // 【问题】stdout 上的请求可能一行接一行来得很快，而 broker.handle 是异步的
        //   （有的要跑几十秒，比如 cmake）。如果同时发起 N 个 handle，响应到达
        //   子进程的顺序就乱了 —— 而子进程是靠【顺序】读 stdin 行的。
        // 【做法】`requestChain = requestChain.then(async () => { … })` 把每次处理
        //   追加到同一条 Promise 链的尾部：上一个处理完（并且回复已写出），
        //   下一个才开始。这就是"用 Promise 链当串行队列"的经典手法，
        //   等价于一个单工作线程的任务队列。
        requestChain = requestChain.then(async () => {
          const response = await broker.handle(value);
          if (child.stdin.writable) child.stdin.write(`${JSON.stringify(response)}\n`);
          // ↑ child.stdin.writable：子进程可能已经退出，这时候再写会抛错。
        });
      } else if (isWorkerEnvelope(value)) {
        finalEnvelope = value;             // ← 这才是最终交账，存起来
      } else {
        protocolNoise.push(Buffer.from(`${line}\n`, "utf8"));
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  // ── 开机 payload：往子进程 stdin 写第一行──────────────────────────
  // 【语法】`… satisfies WorkerPayload`：校验这个对象字面量确实符合 WorkerPayload
  //   的形状（拼错字段名会编译报错），又不丢失字面量类型 —— 和 worker.ts 里那处一样。
  child.stdin.write(`${JSON.stringify({
    input: options.input ?? null,          // ← undefined 在 JSON 里不存在，归一成 null
    facts: options.facts ?? {},
    policy: options.policy,
  } satisfies WorkerPayload)}\n`);

  // ── 超时与退出等待───────────────────────────────────────────────
  // 【语法】setTimeout(回调, 毫秒)：到点执行回调，返回一个 timer 句柄，
  //   clearTimeout(timer) 可以取消。注意：到点了【不会】自动结束 workflow，
  //   而是我们主动杀进程树，然后走下面的正常退出流程（timedOut 标志决定结果）。
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child.pid);
  }, options.timeoutMs);
  // 【语法】★★★ 把回调风格 API 包成 Promise ★★★（本组第三次出现这个手法）
  //   child 的 "error"（起不起来）和 "close"（流关完、进程彻底结束）都是事件，
  //   这里用 once()（只触发一次）+ resolveExit 把它变成一个可以 await 的 Promise。
  //   所以这一行 await 的语义就是："阻塞到子进程彻底死掉为止"。
  const exit = await new Promise<{ code: number | null; signal: string | null; error: Error | null }>((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolveExit({ code, signal, error: null }));
  });
  clearTimeout(timer);                   // ← 正常退出就别让定时器再响了
  const completedEnvelope = finalEnvelope as WorkerEnvelope | null;
  // ↑【语法】as 断言：finalEnvelope 是在回调里赋值的，TS 的控制流分析追不到
  //   "事件回调一定已经跑过"，所以它的类型仍是 null。这里靠 as 告诉编译器
  //   "到这一步事件肯定处理完了"。这是回调风格代码里的常见妥协。
  const out = Buffer.concat(protocolNoise).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  // ↑【语法】Buffer.concat(数组)：把一堆字节块拼成一块（因为 stdout 是一块块到的）。
  const events = completedEnvelope?.events ?? [];
  // ↑【语法】`?.`（可选链）+ `??`（空值合并）：超时/崩溃时可能根本没有 envelope，
  //   就用空数组兜底。
  const expectations = completedEnvelope?.expectations ?? [];
  if (timedOut) {
    return {
      status: "timeout",
      exitCode: null,
      result: null,
      stdout: out,
      stderr: err,
      failure: `workflow exceeded timeout ${options.timeoutMs}ms`,
      events,
      plan: broker.getPlan(),
      // ↑ getPlan()：broker 记着子进程声明过的步骤树。超时了也要带出去 ——
      //   这样 Dashboard 能看到"卡死在哪一步"。
      expectations,
    };
  }
  if (exit.error !== null) {
    // ← spawn 本身失败（比如 bun 不在 PATH 里），连子进程都没起来。
    return {
      status: "failed",
      exitCode: null,
      result: null,
      stdout: out,
      stderr: err,
      failure: exit.error.message,
      events,
      plan: broker.getPlan(),
      expectations,
    };
  }
  // ← 三种"失败"归成一堆：退出码非 0 / 没收到 envelope / envelope 明确说 ok:false
  if (exit.code !== 0 || completedEnvelope === null || !completedEnvelope.ok) {
    return {
      status: "failed",
      exitCode: exit.code,
      // 【细节】即使整个 workflow 失败，如果 envelope 拿得到，result 仍会带出来 ——
      //   声明式 workflow 抛错前可能已经算出了部分结果。
      result: completedEnvelope?.ok === true ? completedEnvelope.result : null,
      stdout: out,
      stderr: err,
      // ← 优先用子进程自己报的错误信息（它更准确），没有才用退出码拼一句。
      failure: completedEnvelope?.ok === false
        ? completedEnvelope.error
        : `workflow exited with code ${String(exit.code)}${exit.signal === null ? "" : ` (${exit.signal})`}`,
      events,
      plan: broker.getPlan(),
      expectations,
    };
  }

  // ← 唯一能走到这里的：退出码 0 + 收到 ok:true 的 envelope
  return {
    status: "pass",
    exitCode: exit.code,
    result: completedEnvelope.result,
    stdout: out,
    stderr: err,
    failure: null,
    events,
    plan: broker.getPlan(),
    expectations,
  };
}

// ── resolveEntry：相对路径 → 绝对路径（相对宿主的当前目录）──────────────
function resolveEntry(entry: string): string {
  return isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
}

// ── rejected：构造"静态检查没过"的结果（根本没起子进程）────────────────
// 【关系】注意它的 status 是 "rejected" 而不是 "failed" —— 语义不同：
//   rejected = 这份源码不被允许跑（沙箱策略）；failed = 跑了但出错了。
function rejected(reason: string): WorkflowRunResult {
  return {
    status: "rejected",
    exitCode: null,
    result: null,
    stdout: "",
    stderr: "",
    failure: reason,
    events: [],
    plan: null,
    expectations: [],
  };
}

// ── terminateTree：杀掉整个进程树（含孙子进程）──────────────────────
// 【为什么必须"树杀"】workflow 跑 cmake 时 cmake 又会起编译器，如果只杀 worker，
//   编译器们会变成孤儿继续占着 CPU，甚至拿着管道句柄不撒手导致宿主卡死。
// 【Windows】taskkill /PID <pid> /T /F：/T 连子进程一起、/F 强制。
// 【POSIX】process.kill(-pid, "SIGTERM")：pid 前加负号 = 发给整个进程组
//   （能这么做靠的是上面 spawn 时的 detached: true）。
// 【语法】try { … } catch {} 整个吞掉异常：进程可能在"超时"和"清理"之间刚好自己
//   退出了，杀一个不存在的进程会抛错 —— 这不是失败，是好事。
function terminateTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",        // ← 不关心 taskkill 自己的输出
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // The process may have exited between timeout and cleanup.
  }
}

// ── readJsonInput：给 CLI 用的小工具（读一个 JSON 文件当 input）────────
// 【关系】scripts/cli.ts 用它把 --input-file 指定的文件读进来传给 runWorkflow。
export function readJsonInput(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}
