/* ═══════════════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/capabilities.ts —— 能力代理（Capability Broker）
 *
 * 【这个文件是干什么的】
 *   workflow 源码（AI 写的那段 TypeScript）跑在一个 bun 子进程里。这个子进程
 *   被故意"饿着"：它不该碰 node:fs、不该碰 child_process。它想读一个文件、
 *   跑一次 cmake、杀一个进程，都必须发一条 JSON 消息向主进程"申请"。
 *   本文件就是主进程里接住这些申请的人：LocalCapabilityBroker。
 *   它按 policy（可读 glob / 可写 glob / 工具白名单 / 进程数 / 超时 / 输出
 *   上限）逐条裁决：放行 → 由它【代为执行】；越界 → 直接抛错（fail-closed）。
 *   这就是《零基础看懂教程.md》§1.5 "workflow 源码也是不可信代码" 的落点。
 *
 *   ⚠️ 把边界说准：这是【主进程内的策略边界】——Broker 只执行符合策略的请求；
 *      不是操作系统级沙箱。真正把 fs/进程 API 从 worker 手里拿走的是
 *      src/workflow/worker.ts（只注入 ctx 能力对象）+ source-policy.ts
 *      （源码静态检查，禁 node:/bun:/shell 字样）。worker 子进程的网络没有被禁。
 *
 * 【在整个项目里的位置】
 *   整个闭环长这样（本文件正中间）：
 *
 *   ┌─────────────────────────── 主进程 ───────────────────────────┐
 *   │ runner.ts / build-executor.ts                                 │
 *   │    │  new LocalCapabilityBroker({workspaceRoot, host, policy})│
 *   │    ▼                                                          │
 *   │  ┌─────────────────────────────────────────┐                  │
 *   │  │  LocalCapabilityBroker（本文件）         │                  │
 *   │  │  handle(request) → CapabilityResponse    │                  │
 *   │  └──────┬──────────────────────┬───────────┘                  │
 *   │         │ ① 裁决               │ ② 代为执行                    │
 *   │         ▼                      ▼                              │
 *   │   policy 白名单检查    真正的 readFileSync / spawn / taskkill   │
 *   └────────┬──────────────────────────────────────▲───────────────┘
 *            │ stdin  → {"type":"capability-request", ...}  一行一封信
 *            │ stdout // ← {"type":"capability-response",...}  一行一封回执
 *   ┌────────▼──────────────────────────────────────┴───────────────┐
 *   │ workflow worker 子进程（不可信代码）                            │
 *   │ worker.ts → client.ts → ctx.fs / ctx.process / ctx.tools /    │
 *   │ ctx.plan / ctx.validator                                      │
 *   └───────────────────────────────────────────────────────────────┘
 *
 *   对面的"客户"代码在 src/workflow/client.ts：它把 ctx.fs.readFile(...)
 *   翻译成一条 capability-request；本文件把结果翻译回 capability-response。
 *   信封格式定义在 src/workflow/capability-protocol.ts。
 *   每次裁决都会生成一个 WorkflowEvent 塞进响应里，最终随 workflow-result
 *   回到宿主并落盘（run.jsonl / Dashboard）——所以每一次"拒绝"都留了痕。
 *
 *   两个调用方：runner.ts（转发 worker 的 JSONL 请求）和 build-executor.ts
 *   （声明式构建路径：主进程自己拼 CapabilityRequest 直接调 handle()）。
 *
 * 【先修知识】
 *   1) 《零基础看懂教程.md》§1.5 的 Capability Broker 词条；
 *   2) src/workflow/capability-protocol.ts（请求/响应长什么样）；
 *   3) src/workflow/runner.ts（谁创建 Broker、JSONL 怎么来回传）；
 *   4) src/artifacts/host-preflight.ts 的 ToolProbe（"实测过的工具"是什么）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/workflow/capabilities.ts（代码与本文件逐字一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════════════ */
// ── 依赖导入 ──────────────────────────────────────────────────────────────
// 这里导入的全是 Node/Bun 标准库 + 本项目类型。注意一个有意思的对比：
// worker 子进程不许用下面这些东西，而主进程的 Broker 全都在用——
// 因为"代为执行"正是 Broker 存在的意义。
import { createHash } from "node:crypto";   // ← node:crypto 的 SHA-256：给文件算指纹（snapshot/diff 靠它判断"内容变没变"）
// child_process：spawn 用来启动子进程（跑 cmake / ctest 靠它）；
// execFileSync 用来同步跑 taskkill（Windows 下杀进程树）；ChildProcess 只是类型。
import {
  execFileSync,   // ← 同步执行命令；本文件只拿它跑 taskkill
  spawn,   // ← 异步启动子进程（process.start 的最终落点）
  type ChildProcess,   // ← 类型：一个还在运行的子进程对象（有 pid、有输出流）
} from "node:child_process";
// node:fs：这一整套"同步文件 API"就是被隔离的对象。worker 里调 ctx.fs.readFile
// 最终会落到这里的 readFileSync——只不过中间隔了一道策略检查。
import {
  existsSync,   // ← 存在性判断（fs.exists / validator.assertAbsent 用）
  lstatSync,   // ← 不跟随符号链接的 stat（能看出"这本身是个软链接"）
  mkdirSync,   // ← 建目录（recursive: true = 连父目录一起建）
  readFileSync,   // ← 读文件
  readdirSync,   // ← 列目录
  realpathSync,   // ← 解析出"真实物理路径"，戳穿符号链接
  statSync,   // ← 元数据：大小、是文件还是目录
  writeFileSync,   // ← 写文件
} from "node:fs";
import { createConnection } from "node:net";   // ← TCP 客户端，用于"服务起好了没"的 ready 探测
// node:path：路径处理。本文件安全检查的核心（resolve / relative）全在这里，
// 见文件末尾的 resolveInside / assertRealPathInside 两个函数。
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";   // ← relative() 算"从 workspace 走到目标要几步"，是判断越界的关键
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";   // ← 宿主实测事实；本文件只用 host.tools（每个工具是否可用、装在哪）
import { diffSnapshots, type Snapshot } from "../runtime/fs-snapshot.js";   // ← runtime 里现成的快照对比：两张"路径→哈希"表算出增/删/改
import type { CapabilityRequest, CapabilityResponse } from "./capability-protocol.js";   // ← JSONL 协议两端：子进程发 request，本文件回 response
// ./types.js 的一堆类型 = "worker 眼里的能力接口"（ctx.fs / ctx.process / ctx.plan…），
// 本文件就是这些接口在主进程侧的实现。全是 import type，编译后消失，零运行时开销。
import type {
  PlanStepDeclaration,
  ProcessHandle,
  ProcessResult,
  ProcessRunSpec,
  ProcessStartSpec,
  WorkflowCapabilityPolicy,
  WorkflowEvent,
  WorkflowFilesystem,
  WorkflowFsEffect,
  WorkflowFsSnapshot,
  WorkflowPlan,
  WorkflowPlanStep,
  WorkflowProcess,
  WorkflowReadyProbe,
  WorkflowTool,
  WorkflowTools,
} from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PROCESSES = 16;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
// ── SYSTEM_ENV_KEYS：环境变量白名单 ──────────────────────────────────────
// 子进程的 env 不是继承父进程的全部，而是【只挑这几个】重新拼一份。
// 为什么？因为 process.env 里有大量敏感/危险的东西：API key、代理设置、
// NODE_OPTIONS（可以给子进程注入参数）、各种 cloud 凭据……
// 白名单只留跑编译器必需的系统项：PATH（找可执行文件）、PATHEXT（Windows
// 判断 .exe/.bat 后缀）、SystemRoot/WINDIR（Windows 系统目录，很多程序没有
// 它起不来）、TEMP/TMP（临时目录）、HOME/USERPROFILE、LANG/LC_ALL（locale）。
// 其余任何键都要 policy.allowedEnv 显式放行。
const SYSTEM_ENV_KEYS = new Set([   // ← Set：成员检查 O(1)
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
]);

// ── 子进程的"死亡报告" ──────────────────────────────────────────────────
// code / signal / error 三者最多一个有值：正常退出给 code；被信号杀给
// signal；压根没起来（比如可执行文件不存在）给 error。
type ProcessExit = {
  readonly code: number | null;   // ← readonly：类型层面禁止改字段（TS 语法，运行时无开销）
  readonly signal: string | null;
  readonly error: Error | null;
};

// ── 创建 Broker 需要的原料 ──────────────────────────────────────────────
// 【参数】options.workspaceRoot —— workflow 的活动范围（worktree 根目录）。
//   所有相对路径以它为基准，所有越界判断以它为边界；
// 【参数】options.host —— HostPreflight（程序实测的主机事实），只用到
//   host.tools：工具名 → { available, path, version }；
// 【参数】options.project —— ProjectDetection。本文件用不到（见构造函数里的
//   void options.project），接口上保持和 facts 一致而已；
// 【参数】options.policy —— 能力策略，缺省时每个白名单都取"最严"。
export interface CapabilityHost {
  readonly workspaceRoot: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  readonly policy?: WorkflowCapabilityPolicy;
}

// ── Broker 的接口（面向调用方的最小面）──────────────────────────────────
// handle() 处理一条请求，close() 收尾（杀掉所有还没结束的子进程）。
// 调用方只认识这个接口，不关心实现是 Local 还是别的——以后若换成真正的
// 沙箱实现，接口可以不变。
export interface CapabilityBroker {
  handle(request: CapabilityRequest): Promise<CapabilityResponse>;   // ：一条请求进、一条响应出；async = 返回 Promise，调用方要 await
  close(): Promise<void>;
}

// ── RunningProcess：一个"正在跑"的子进程在 Broker 里的全部记账 ───────────
// startProcess() 把 spawn 出来的东西包成这个结构存进 this.running，
// 后续 wait / stop / 超时 / 输出截断都基于它工作。
interface RunningProcess {
  readonly child: ChildProcess;   // ← spawn 返回的子进程对象
  readonly startedAt: number;   // ← 启动时刻（毫秒时间戳），用来算 durationMs
  readonly spec: ProcessStartSpec;   // ← 归一化后的启动参数（超时/输出上限已填默认值）
  readonly stdout: Buffer[];   // ← stdout 按块收集的数组（最后拼起来）
  readonly stderr: Buffer[];   // ← 同上，错误输出
  readonly exit: Promise<ProcessExit>;   // ← "必然结束"的 Promise：进程一死它就完成（见 createExitPromise）
  timeoutTimer: ReturnType<typeof setTimeout> | null;   // ← spec.timeoutMs 的定时器句柄
  resultPromise: Promise<ProcessResult> | null;   // ← wait 结果缓存：多个等待者共享同一次收集
  outputBytes: number;   // ← 已收到的输出字节数（stdout+stderr 合计）
  outputLimit: boolean;   // ← 一旦超限就置 true，并且进程被杀
  timedOut: boolean;   // ← spec.timeoutMs 触发过
  stopRequested: boolean;   // ← 有人显式调过 stop
}

// ── LocalCapabilityBroker：本文件唯一导出的类 ───────────────────────────
// 下面这段英文注释说得很准：worker 只能通过"经过校验的 JSON 请求"够到这个
// 对象；一切文件系统和进程操作都留在这里发生。
/**
 * Main-process capability broker. The worker can only reach this object through
 * validated JSON requests; all filesystem and process operations stay here.
 */
export class LocalCapabilityBroker implements CapabilityBroker {   // ← implements：TS 语法，要求本类实现接口全部成员（编译期检查）
// 类字段一览：前三个在构造函数里赋值且不再变（readonly），后四个是运行时状态。
  private readonly workspaceRoot: string;   // ← 唯一的边界基准：realpath 之后的 workspace 根（绝对路径）
  private readonly host: HostPreflight | undefined;   // ← 宿主事实，可能没给
  private readonly policy: Required<WorkflowCapabilityPolicy>;   // ← Required<> 是 TS 工具类型：把原接口的 ? 都去掉，默认值已在构造函数填好
  private readonly running = new Map<string, RunningProcess>();   // ← 存活进程表：进程 id → 记录（Map = 键值容器）
  private nextProcessId = 1;   // ← 自增编号，用来生成 p1、p2…
  private closed = false;   // ← close() 之后置 true，再来的请求一律拒绝

// ── 构造函数：把可选项收拢成一份"无可争议"的策略 ────────────────────────
// 两个动作：
//   1) 把 workspaceRoot 变成 realpath（解析符号链接、变成绝对路径）——后面
//      所有路径检查都以这个"真实根"为基准，否则别人给个软链接路径就能把
//      边界挪走；
//   2) 给 policy 每个字段填默认值，默认一律取"最严"：可写 []（啥都不能写）、
//      可执行 []、工具 []、环境变量 []。只有 readableGlobs 默认 ["**"]（能读
//      整个 workspace），因为读是构建必需的、而且只读不落地。
//   这就是"白名单默认全关"：没显式打开的能力，等于不存在。
  constructor(options: CapabilityHost) {
    const requestedRoot = resolve(options.workspaceRoot);   // ← resolve() 把传入路径变成绝对路径
    this.workspaceRoot = realpathSync(requestedRoot);   // ← ⚠️ 目录不存在时 realpathSync 会抛错：workspace 必须真实存在
    this.host = options.host;   // ← 存下宿主实测事实（工具探测结果）
    void options.project;   // ← 惯用法：显式"用掉"暂时不用的值，避免 TS/lint 报 unused
    this.policy = {   // ← ?. 可选链：options.policy 可能是 undefined，是 undefined 就整体取默认
      readableGlobs: options.policy?.readableGlobs ?? ["**"],
      writableGlobs: options.policy?.writableGlobs ?? [],
      executableGlobs: options.policy?.executableGlobs ?? [],
      allowedTools: options.policy?.allowedTools ?? [],
      allowedEnv: options.policy?.allowedEnv ?? [],
      maxProcesses: options.policy?.maxProcesses ?? DEFAULT_MAX_PROCESSES,
      maxOutputBytes: options.policy?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxFileBytes: options.policy?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    };
  }

// ── handle：Broker 总入口（每个能力请求都从这里过一次）──────────────────
// 【作用】计时 → 真正干活（dispatch）→ 无论成败都包出一个 WorkflowEvent
//   → 组装 CapabilityResponse 返回。
// 【参数】request —— worker 发来的请求，形如：
//     { type:"capability-request", id:"r3", capability:"fs",
//       method:"readFile", args:["build/log.txt","utf8"] }
// 【返回】Promise<CapabilityResponse>：
//     { type:"capability-response", id:"r3", ok:true, value:..., event:{...} }
//     失败时没有 value，而是 error 字符串（见 144 行的条件展开）。
// 【关系】runner.ts 收到 worker 的 JSONL 行后调它；client.ts 的 accept()
//   按响应里的 id 找回 pending 的 Promise，resolve 或 reject。
// 【为什么重要】失败也会被记成 ok:false 的 event。这些事件最终随
//   workflow-result 回到宿主并落盘，所以"Broker 拒绝了一次写"不会被悄悄
//   吞掉——观测、排错、以及"到底拦下了几次越界"都靠它。
  async handle(request: CapabilityRequest): Promise<CapabilityResponse> {
    const started = Date.now();   // ← 记下开始时间，最后算 durationMs（毫秒）
    let value: unknown;
    let error: string | null = null;   // ← null 表示"没出错"（ok 的判定就是 error === null）
    try {
      if (this.closed) throw new Error("capability broker is closed");   // ← 已关闭的 Broker 不再服务：宁可报错也不执行（fail-closed）
      value = await this.dispatch(request);   // ← 真正的裁决+执行在 dispatch()，它抛的任何异常都在下面接住
    } catch (cause) {
      error = errorMessage(cause);   // ← 把任意抛出的东西变成字符串（可能是 Error，也可能是别的）
    }
    const ok = error === null;
    const event: WorkflowEvent = {   // ← WorkflowEvent：一次能力调用的完整档案（协议层有类型校验）
      id: request.id,
      capability: request.capability,
      method: request.method,
      ok,
      durationMs: Date.now() - started,   // ← 耗时 = 结束 - 开始，单位毫秒
      error,
    };
    return {
      type: "capability-response",
      id: request.id,
      ok,
      ...(ok ? { value } : { error: error ?? "capability request failed" }),   // ← 展开 + 三元：ok 时带 value，失败时带 error，两个键二选一
      event,
    };
  }

// ── close：把还活着的子进程全杀掉，然后关门 ────────────────────────────
// 幂等：关过一次就直接返回。runner.ts 在 workflow 结束/超时后收尾用。
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.running.keys()]) await this.stopProcess({ id });   // ← [...map.keys()] 先拷贝一份键列表：stopProcess 内部会删 Map 元素，边遍历边删是经典事故源
  }

// ── dispatch：按 capability 分发到五个子分发器 ──────────────────────────
// capability 只有五种：fs / process / tools / plan / validator。
// 最后一行没有 if：不认识的一律当 tools 处理，而 dispatchTools 的 default
// 分支会抛 unsupported —— 等于换个地方 fail-closed。（协议层的
// isCapabilityRequest 其实已把 capability 限制在这五种，这里是双保险。）
  private async dispatch(request: CapabilityRequest): Promise<unknown> {
    if (request.capability === "fs") return this.dispatchFs(request.method, request.args);
    if (request.capability === "process") return this.dispatchProcess(request.method, request.args);
    if (request.capability === "plan") return this.dispatchPlan(request.method, request.args);
    if (request.capability === "validator") return this.dispatchValidator(request.method, request.args);
    return this.dispatchTools(request.method, request.args);
  }

// ── plan 步骤表（Broker 侧状态机的存储）────────────────────────────────
// plan 能力不碰文件也不碰进程，它只在 Broker 里维护一棵"步骤树"：
// worker 声明步骤、标记开始/完成/失败，宿主最后用 getPlan() 收走整棵树，
// 给 Dashboard 画图、给观测记录用。键 = 步骤 id，值 = 元数据 + 当前状态。
// status 只有四种合法值（TS 联合类型），合法迁移见下面的 planMark()。
  private readonly planSteps = new Map<string, {
    readonly title: string;
    readonly description: string | undefined;
    status: "pending" | "running" | "completed" | "failed";
    readonly parent: string | null;
    readonly children: string[];
  }>();
  private readonly planRoots: string[] = [];   // ← 顶层步骤（没有父步骤的）按声明顺序放在这里

// ── dispatchPlan：plan 能力的 4 个方法 ────────────────────────────────
// declare 声明整棵树；begin / complete / fail 推进状态。
// planDeclarationsArg / stringArg 这些 *Arg 函数是"参数验收员"：先确认类型
// 合法再往下走。args 是从 JSON 反序列化出来的 unknown，类型系统在这里帮
// 不上忙，必须手动验。
  private async dispatchPlan(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "declare":
        return this.planDeclare(planDeclarationsArg(args, 0));
      case "begin":
        return this.planMark("begin", stringArg(args, 0, "id"));
      case "complete":
        return this.planMark("complete", stringArg(args, 0, "id"));
      case "fail":
        return this.planMark("fail", stringArg(args, 0, "id"), optionalErrorArg(args, 1));
      default:
        throw new Error(`unsupported plan capability method: ${method}`);
    }
  }

// 自动 id 计数器（类字段可以写在类体任意位置，效果等同在构造函数里赋值）
  private planNextAutoId = 1;   // ← 没给 id 的顶层步骤按 p1、p2… 编号

// ── planDeclare：登记一棵步骤树 ────────────────────────────────────────
// 【作用】递归遍历声明，给每个步骤分配 id、建立父子关系、状态置 pending。
// 【返回】string[] —— 顶层步骤的 id 列表（按声明顺序），会传回 worker，
//   worker 之后再拿这些 id 去 begin / complete / fail。
// 【语法】内部箭头函数 assign 递归处理 children；嵌套三元运算符见 199 行。
  private planDeclare(declarations: readonly PlanStepDeclaration[]): string[] {
    const roots: string[] = [];
    const assign = (items: readonly PlanStepDeclaration[], parentId: string | null): string[] => {   // ← 箭头函数：局部函数，可以递归调用自己
      const local: string[] = [];
      for (const item of items) {
// title 是步骤在人眼里的名字，必须有且非空——空名字会让 Dashboard 上的
// 计划图没法看，不如在这里就拒绝。
        if (typeof item.title !== "string" || item.title.length === 0) {
          throw new Error("plan step title must be a non-empty string");
        }
        // Caller-supplied ids are used verbatim; missing ids get a host
        // fallback (pN / parentId.N) so a workflow that skips ids still runs.
// 嵌套三元：caller 给了非空 id 就原样用 caller 的；否则宿主兜底——顶层
// 步骤叫 p1、p2…，子步骤叫「父id.本层序号」（如 build.1、build.2）。
// 这样"懒得写 id"的 workflow 也能跑，"写了 id"的 workflow 能被引用。
        const id = typeof item.id === "string" && item.id.length > 0
          ? item.id
          : parentId === null
            ? `p${String(this.planNextAutoId++)}`
            : `${parentId}.${String(local.length + 1)}`;
// 全局唯一性检查：id 重复直接报错。为什么这么严？id 是宿主和 worker 之间
// 的"合同"——若允许覆盖，后声明的步骤会悄悄顶掉前面的，Dashboard 上的
// 状态就再也对不上号了。
        if (this.planSteps.has(id)) {
          throw new Error(`plan step id '${id}' is not unique; ids must be globally unique`);
        }
        const children = item.children === undefined ? [] : assign(item.children, id);   // ← 先递归登记 children（返回它们的 id 列表），再把 parent 存进去
        this.planSteps.set(id, {   // ← Map.set：登记这条步骤，状态从 pending 起步
          title: item.title,
          description: item.description,
          status: "pending",
          parent: parentId,
          children,
        });
        if (parentId === null) this.planRoots.push(id);   // ← 顶层步骤追加进 planRoots（根列表），顺序即声明顺序
        local.push(id);   // ← local 记录"本层的 id 顺序"，供上层建立 children 数组
      }
      return local;
    };
    return assign(declarations, null);
  }

// ── planMark：状态机的三根栏杆 ────────────────────────────────────────
// 合法迁移只有：
//     pending ──begin──▶ running ──complete──▶ completed
//        └───────fail（除 completed 外任意状态）──────▶ failed
// 为什么要拦？这些请求来自"不可信"的 workflow 源码：AI 完全可能把同一步骤
// complete 两次、或没 begin 就 complete。计划图一旦乱序，看图的人会误判
// 进度，所以宁可在这里抛错。
  private planMark(method: "begin" | "complete" | "fail", id: string, error?: string): void {
    const step = this.planSteps.get(id);   // ← Map.get 找不到时返回 undefined（不是抛错），所以必须显式判
// 没声明过就 begin/complete/fail？直接拒绝——防止 worker 用一个拼错的 id
// 静默"成功"。
    if (step === undefined) {
      throw new Error(`plan step '${id}' was not declared; use the exact ids passed to plan.declare`);
    }
    if (method === "begin") {
      if (step.status !== "pending") throw new Error(`plan step ${id} is already ${step.status}`);   // ← 只有 pending 才能 begin
      step.status = "running";
      return;
    }
    if (method === "complete") {
      if (step.status !== "running") throw new Error(`plan step ${id} cannot complete while ${step.status}`);   // ← 只有 running 才能 complete
      step.status = "completed";
      return;
    }
    // fail
    if (step.status === "completed") throw new Error(`plan step ${id} is already completed`);   // ← 已 completed 的步骤不许再标失败（成功不可被"追认"成失败）
    if (error !== undefined && error.length === 0) throw new Error("plan fail error must be a non-empty string");   // ← 允许不带 error（undefined），但给了就必须非空
    step.status = "failed";
  }

// ── getPlan：把步骤表重新组装成一棵树交出去 ────────────────────────────
// 【作用】从 planRoots 出发递归 build，产出 WorkflowPlanStep 嵌套结构。
// 【关系】runner.ts 在 workflow 结束（成败/超时都一样）后调 broker.getPlan()，
//   结果放进 WorkflowRunResult.plan，供 Dashboard 与报告使用。
// 【语法】...(cond ? {} : { x: 1 }) 条件展开：条件不成立就"什么都不加"，
//   这是表达"可选字段"而不引入 null 的惯用法。
  /** Assemble the declared plan tree with final statuses. */
  getPlan(): WorkflowPlan {
    const build = (ids: readonly string[]): WorkflowPlanStep[] => ids.map((id) => {   // ← ids.map：把一组 id 递归映射成一组步骤对象
      const step = this.planSteps.get(id);
      if (step === undefined) throw new Error(`plan step ${id} missing during assembly`);
      return {
        id,
        title: step.title,
        ...(step.description === undefined ? {} : { description: step.description }),
        status: step.status,
        ...(step.children.length === 0 ? {} : { children: build(step.children) }),
      };
    });
    return { steps: build(this.planRoots) };
  }

// ── dispatchFs：文件能力的 7 个方法 ───────────────────────────────────
// 全部是"先 resolveReadable / resolveWritable 检查、再执行"的两段式。
// 返回 null 表示"成功但没有返回值"（对应 writeFile / mkdir 的 void 语义）。
// 编码只支持 utf8 和 base64 —— base64 是为了让二进制（.o、.exe、压缩包）
// 也能安全地走 JSON 文本通道。
  private async dispatchFs(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "readFile":
        return this.readFile(stringArg(args, 0, "path"), encodingArg(args, 1));   // ← 读文件（默认 utf8）
      case "writeFile":   // ← 写文件：调用后不 return，统一落到下面的 return null
        this.writeFile(
          stringArg(args, 0, "path"),
          stringArg(args, 1, "content"),
          encodingArg(args, 2),
        );
        return null;
      case "mkdir":
        this.mkdir(stringArg(args, 0, "path"));
        return null;
      case "exists":
        return this.exists(stringArg(args, 0, "path"));
      case "readdir":
        return this.readdir(stringArg(args, 0, "path"));
      case "snapshot":   // ← snapshot：拍一张"路径 → SHA-256"快照，供之后 diff 用
        return this.snapshot(optionalStringArg(args, 0));
      case "diff":   // ← diff：拿旧快照和现在比，算出 create/modify/delete 列表
        return this.diff(stringArg(args, 0, "path"), snapshotArg(args, 1));
      default:
        throw new Error(`unsupported fs capability method: ${method}`);
    }
  }

// ── dispatchProcess：进程能力的 4 个方法 ──────────────────────────────
// run   = start + wait（一步到位，最常用）；
// start = 启动并立刻返回句柄（配合 ready 探测跑常驻服务，比如测试服务器）；
// wait  = 等它结束并收结果（可再给一个等待超时）；
// stop  = 主动杀掉。
  private async dispatchProcess(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "run":
        return this.runProcess(processRunSpecArg(args, 0));
      case "start":
        return this.startProcess(processStartSpecArg(args, 0));
      case "wait":
        return this.waitProcess(handleArg(args, 0), optionalPositiveInt(args, 1, "timeoutMs"));   // ← 第二个参数是可选的等待超时（毫秒），必须是正整数
      case "stop":
        return this.stopProcess(handleArg(args, 0));
      default:
        throw new Error(`unsupported process capability method: ${method}`);
    }
  }

// ── dispatchTools：工具能力的 2 个方法 ────────────────────────────────
// "工具"指宿主在 preflight 阶段【实测过】的可执行程序（cmake、ninja、
// ctest、编译器……），记录在 HostPreflight.tools 里。
  private async dispatchTools(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "available":
        return this.toolAvailable(stringArg(args, 0, "name"));
      case "list":
        if (args.length !== 0) throw new Error("tools.list does not accept arguments");   // ← list 明确要求零参数：多传一个都算协议错误
        return this.toolList();
      default:
        throw new Error(`unsupported tools capability method: ${method}`);
    }
  }

// ── dispatchValidator：结果校验（fail-closed 断言）──────────────────────
// 三个断言：assertFile（必须是文件）/ assertDir（必须是目录）/
// assertAbsent（必须不存在）。语义是"不满足就抛错"，不是"返回布尔"——
// 抛错会让这条能力请求失败，进而让整个 workflow 失败。
// 【关系】workflow 在构建/测试结束时自己断言"产物真的存在"；取代了旧版
// "workflow 返回产物清单、宿主事后核对"的做法——现在是 workflow 声明
// 期望、宿主强制执行，谁也别想漏检。
  private async dispatchValidator(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "assertFile": {
        const path = stringArg(args, 0, "path");
        const description = optionalStringArg(args, 1) ?? path;   // ← ?? 右侧兜底：没给 description 就用路径本身
        const absolute = this.resolveReadable(path);   // ← 断言目标也要过"可读"检查——断言不是旁门，照样受 readableGlobs 管
        if (!existsSync(absolute) || !statSync(absolute).isFile()) {   // ← 两次确认：存在，且真的是文件（目录不算）
          throw new Error(`assertion failed: expected file '${description}' (${path})`);
        }
        return null;
      }
      case "assertDir": {
        const path = stringArg(args, 0, "path");
        const description = optionalStringArg(args, 1) ?? path;
        const absolute = this.resolveReadable(path);
        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
          throw new Error(`assertion failed: expected directory '${description}' (${path})`);
        }
        return null;
      }
      case "assertAbsent": {
        const path = stringArg(args, 0, "path");
        const description = optionalStringArg(args, 1) ?? path;
        if (existsSync(this.resolveReadable(path))) {   // ← 反向断言：存在就算失败
          throw new Error(`assertion failed: expected '${description}' (${path}) to be absent`);
        }
        return null;
      }
      default:
        throw new Error(`unsupported validator capability method: ${method}`);
    }
  }

// ── readFile：受控读 ─────────────────────────────────────────────────
// 四道关卡：①路径合法（在 workspace 内、真实路径不越界、glob 允许）
// ②是普通文件（不是目录/设备）③大小不超 maxFileBytes ④按编码转成字符串。
// 关卡②的意义：如果目标是目录，readFileSync 会抛出含糊的系统错误，
// 不如自己给出一句能看懂的话。
// 关卡③的意义：没有它，一条 fs.readFile("巨大日志") 就能把主进程内存吃光。
  private readFile(path: string, encoding: "utf8" | "base64"): string {
    const absolute = this.resolveReadable(path);
    const stats = statSync(absolute);   // ← 拿到大小和类型
    if (!stats.isFile()) throw new Error(`capability path is not a regular file: ${path}`);   // ← 目录/设备文件一律拒绝
    if (stats.size > this.policy.maxFileBytes) {   // ← stats.size 单位是字节，与 maxFileBytes 同单位，直接比
      throw new Error(`file exceeds capability limit ${this.policy.maxFileBytes} bytes: ${path}`);
    }
    const bytes = readFileSync(absolute);
    return encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");   // ← Buffer 是字节数组；toString("base64") 转成能进 JSON 的文本
  }

// ── writeFile：受控写 ────────────────────────────────────────────────
// 与 readFile 对应，但走的是 writableGlobs（默认空 = 什么都写不了）。
// 大小检查在【解码之后】做：base64 编码会让体积膨胀约 1/3，按原始字节
// 检查才准确。写之前先 mkdirSync 父目录，省得 workflow 还得自己建目录。
  private writeFile(path: string, content: string, encoding: "utf8" | "base64"): void {
    const absolute = this.resolveWritable(path);
    const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");   // ← base64 / utf8 都转成原始字节（Buffer.from 第二参数是编码）
    if (bytes.length > this.policy.maxFileBytes) {
      throw new Error(`file exceeds capability limit ${this.policy.maxFileBytes} bytes: ${path}`);
    }
    mkdirSync(dirname(absolute), { recursive: true });   // ← dirname 取父目录；recursive 多级一并创建（已存在也不报错）
    writeFileSync(absolute, bytes);
  }

// ── mkdir：受控建目录 ────────────────────────────────────────────────
// 同样走 writableGlobs。注意它能一次建出多层目录，所以同样受策略约束。
  private mkdir(path: string): void {
    mkdirSync(this.resolveWritable(path), { recursive: true });
  }

// ── exists：存在性查询 ───────────────────────────────────────────────
// 也要过 readableGlobs——"探测某文件在不在"同样能泄露信息（比如逐个
// 试探敏感路径是否存在），所以读权限的检查不因操作轻量而豁免。
  private exists(path: string): boolean {
    return existsSync(this.resolveReadable(path));
  }

// ── readdir：列目录 ─────────────────────────────────────────────────
// 只返回【直接子项的名字数组】，不递归、不带类型——给"看看构建产物有哪些"
// 这类需求用。想看整棵树请用 snapshot。
  private readdir(path: string): string[] {
    const absolute = this.resolveReadable(path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`capability path is not a directory: ${path}`);   // ← 必须存在且是目录，否则给一句人话
    }
    return readdirSync(absolute);
  }

// ── snapshot：给目录（或单个文件）拍"内容指纹" ──────────────────────────
// 【作用】递归遍历，产出 { "相对路径": "sha256" } 的对象。内容哪怕只变
//   一个字节，哈希就完全不同——这是 diff 能判断 create/modify 的基础。
// 【返回】WorkflowFsSnapshot：键是 workspace 相对路径（统一正斜杠，跨平台
//   一致），根目录自身记作 "."。
// 【关系】典型用法：构建前 snapshot(".")，构建后 diff(".", before) 得到
//   "这次构建到底动了哪些文件"，供 validator / 对比逻辑使用。
// ⚠️ snapshot 拒绝符号链接和特殊文件（见 walkDirectory）：快照的语义是
//   "普通文件树的内容"，遇到软链接宁可直接失败，也不悄悄跟进去
//   （否则一次循环链接/越界读就能把 Broker 拖死）。
  private snapshot(path: string | undefined): WorkflowFsSnapshot {
    const root = this.resolveReadable(path ?? ".");
    if (!existsSync(root)) throw new Error(`snapshot path does not exist: ${path ?? "."}`);
    const stats = statSync(root);
    if (stats.isFile()) {
      return { [this.relativeWorkspace(root)]: hashFile(root) };   // ← 单文件情形：整张快照只有这一条
    }
    const local = snapshotDirectory(root);
    const prefix = this.relativeWorkspace(root);
    return Object.fromEntries([...local.entries()].map(([entry, hash]) => [   // ← Object.fromEntries：把 [键, 值] 数组变回对象
      prefix === "." ? entry : `${prefix}/${entry}`,   // ← 前缀是根时直接用子路径；否则拼成 "前缀/子路径"
      hash,
    ]));
  }

// ── diff：before 快照 vs 现在，算出文件级增删改 ─────────────────────────
// 【参数】path —— 要对比的目录（或文件）；before —— 之前 snapshot 的结果。
// 【返回】WorkflowFsEffect[]：{ path, op: "create"|"modify"|"delete", sha256 }。
// 【过程】先把 before 里属于本路径前缀的条目挑出来（键去掉前缀，变成
//   "局部相对路径"），再拍现在的快照，交给 diffSnapshots 比较，最后把
//   结果路径再拼回带前缀的形式。
// 为什么有一行要抛错？因为传进来的快照可能根本不是这个目录拍的（比如
// 拿 build/ 的快照来 diff src/）——那之后的"增删改"结论全是错的，
// 不如当场拒绝。
  private diff(path: string, before: WorkflowFsSnapshot): WorkflowFsEffect[] {
    const root = this.resolveReadable(path);
    const prefix = this.relativeWorkspace(root);
    const beforeLocal: Snapshot = new Map();   // ← 局部表：键是"去掉前缀后的相对路径"
    for (const [entry, hash] of Object.entries(before)) {
      if (prefix === ".") beforeLocal.set(entry, hash);   // ← 前缀是根（"."）时键原样保留
      else if (entry.startsWith(`${prefix}/`)) beforeLocal.set(entry.slice(prefix.length + 1), hash);   // ← slice(prefix.length + 1)：把 "前缀/" 去掉
      else throw new Error(`snapshot does not belong to diff path: ${entry}`);   // ← 不是这个目录的快照 → 当场拒绝
    }
    const afterLocal = statSync(root).isFile()   // ← 单文件时用 "." 作键（与 snapshot 的约定一致）
      ? new Map([[".", hashFile(root)]])
      : snapshotDirectory(root);
    return diffSnapshots(beforeLocal, afterLocal).map((effect) => ({   // ← 真正的对比逻辑在 src/runtime/fs-snapshot.ts，按路径排序保证输出确定
      ...effect,   // ← ...effect：继承 FsDiff 里的 op / sha256 字段
      path: prefix === "." ? effect.path : `${prefix}/${effect.path}`,   // ← 把 path 换回带前缀的 workspace 相对路径
    }));
  }

// ── runProcess：最常用的"跑一下、等结果" ─────────────────────────────
// 它 = startProcess + waitProcess。注意这里强行把 ready 探测关掉
// （kind:"none"）：run 的语义就是等进程退出，不需要"等服务就绪"。
// 【语法】{ ...spec, ready: {...} } 展开运算符：继承 spec 的全部字段，
//   但 ready 用新值覆盖。
  private async runProcess(spec: ProcessRunSpec): Promise<ProcessResult> {
    const handle = await this.startProcess({ ...spec, ready: { kind: "none" } });
    return this.waitProcess(handle);
  }

// ── startProcess：本文件安全检查最密集的地方 ────────────────────────────
// 【作用】把"跑一个程序"拆成：进程数限额 → 工具解析 → 工作目录检查 →
//   环境变量白名单 → 无 shell 启动 → 输出/超时挂钩 → ready 探测。
// 【返回】Promise<ProcessHandle>：只有 { id } 一个字段。worker 之后拿这个
//   id 去 wait / stop——它永远接触不到 ChildProcess 对象本身。
// 【关系】run() 调它；wait / stop 通过 this.running 表找到它留下的记录。
  private async startProcess(spec: ProcessStartSpec): Promise<ProcessHandle> {
    if (this.running.size >= this.policy.maxProcesses) {   // ← 进程数上限：防止 workflow 一口气 fork 出一堆进程拖垮机器
      throw new Error(`process limit exceeded: ${this.policy.maxProcesses}`);
    }
    const normalized = normalizeProcessSpec(spec);   // ← 填默认值（timeoutMs / maxOutputBytes），并把 args 拷成可变数组
    const program = this.resolveProgram(normalized.program);   // ← ★ 关键：把 "cmake" 变成绝对路径（或直接拒绝），见 resolveProgram
    const cwd = this.resolveReadable(normalized.cwd ?? ".");   // ← 工作目录也按"可读路径"校验：cwd 同样不许跑出 workspace
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`process cwd is not a directory: ${normalized.cwd ?? "."}`);   // ← cwd 必须真实存在且是目录，否则子进程会莫名失败
    }
    const env = this.buildEnv(normalized.env);   // ← 拼一份"净化过"的环境变量（见 buildEnv）
// ★ 为什么 shell: false 更安全？
//   如果走 shell（相当于 "sh -c <整行命令>"），就得先把参数拼成一行字符串，
//   于是文件名里的空格、引号、$() 、&& 都可能被 shell 解释成新命令——
//   AI 写的 workflow 只要把某个文件名设成 "a; rm -rf ~" 就能注入命令。
//   shell:false 时参数数组逐个传给操作系统，每个元素都只是"一个参数"，
//   没有再被解析的机会。这也是为什么上面要求 args 必须是 string[]。
    let child: ChildProcess;
    try {
      child = spawn(program, normalized.args, {   // ← 无 shell、argv 直传
        cwd,
        env,
        shell: false,
        windowsHide: true,   // ← Windows 上不弹出黑色控制台窗口
        stdio: ["pipe", "pipe", "pipe"],   // ← 三个标准流都走管道，Broker 才能截获并限制输出
        detached: process.platform !== "win32",   // ← 非 Windows 上放进独立进程组，之后才能用 -pid 杀整组
      });
// spawn 同步抛错的情况很少（多数错误走 'error' 事件，见 createExitPromise），
// 但还是包一层，给出带程序名的可读信息。
    } catch (cause) {
      throw new Error(`failed to spawn '${normalized.program}': ${errorMessage(cause)}`);
    }

    const id = `p${String(this.nextProcessId++)}`;   // ← Broker 内部编号（注意：与 plan 步骤的 pN 是两套互不相干的编号）
    const running: RunningProcess = {
      child,
      startedAt: Date.now(),
      spec: normalized,
      stdout: [],
      stderr: [],
      exit: createExitPromise(child),   // ← 立刻挂上"退出监听"，保证不会漏掉早夭的进程
      timeoutTimer: null,
      resultPromise: null,
      outputBytes: 0,
      outputLimit: false,
      timedOut: false,
      stopRequested: false,
    };
    this.running.set(id, running);
    child.stdout?.on("data", (chunk: Buffer) => appendOutput(running, running.stdout, chunk));   // ← ?. 可选链：类型上流可能为 null（实际已配置成 pipe）
    child.stderr?.on("data", (chunk: Buffer) => appendOutput(running, running.stderr, chunk));
    running.timeoutTimer = setTimeout(() => {   // ← 超时定时器：到点就标记 timedOut 并杀整棵进程树
      running.timedOut = true;
      terminateTree(child.pid);   // ← 杀的是 pid 的整棵树（含孙进程），不是只杀直接子进程
    }, normalized.timeoutMs);   // ← 定时器时长 = 归一化后的超时（默认 60 秒），单位毫秒

    if (normalized.stdinBase64 !== undefined) {   // ← 有数据就写完关闭；没数据也要 end()，否则子进程会一直等输入
      child.stdin?.end(Buffer.from(normalized.stdinBase64, "base64"));
    } else {
      child.stdin?.end();
    }
    try {
      await waitReady(normalized.ready, this.workspaceRoot, this.policy, child);   // ← 阻塞在这里等"服务就绪"（TCP 端口 / 某个文件出现）
    } catch (cause) {
// ready 探测失败 → 先把自己刚启动的进程杀干净，再把错误抛出去。
// 不杀的话会留下一个占着端口的孤儿进程，下次运行就起不来了。
      await this.stopProcess({ id });
      throw cause;
    }
    return { id };   // ← 只交出 id，不交出进程对象本身
  }

// ── waitProcess：等一个进程结束 ──────────────────────────────────────
// 【参数】handle —— start 返回的 { id }；timeoutMs —— 本次等待的上限
//   （毫秒，可选）。注意：超时不抛错，而是把结果定性为 status:"timeout"。
// resultPromise 缓存：同一个进程被 wait 两次时，返回的是同一个 Promise，
//   避免重复清理、重复计数。
  private waitProcess(handle: ProcessHandle, timeoutMs?: number): Promise<ProcessResult> {
    const running = this.running.get(handle.id);
    if (running === undefined) throw new Error(`unknown process handle: ${handle.id}`);   // ← 不认识的 id 直接报错——绝不能让错误的句柄静默成功
    if (running.resultPromise !== null) return running.resultPromise;
    running.resultPromise = this.collectProcess(handle.id, running, timeoutMs);
    return running.resultPromise;
  }

// ── collectProcess：收尸 + 定性 ───────────────────────────────────────
// 【作用】挂上本次等待的定时器 → await exit（进程真正死掉）→ 清掉所有
//   定时器、从存活表里移除 → 给这次死亡"定性"。
// 定性优先级（从上往下，命中即停）：
//   output_limit  输出超限被杀
//   timeout       spec 超时或本次 wait 超时被杀
//   spawn_error   压根没起来（如可执行文件不存在）
//   stopped       被人显式 stop 过
//   exited        正常退出（此时 exitCode 才有意义）
// 【返回】ProcessResult：stdout/stderr 以 base64 返回（可能是二进制）。
  private async collectProcess(
    id: string,
    running: RunningProcess,
    timeoutMs: number | undefined,
  ): Promise<ProcessResult> {
    let waitTimedOut = false;
    const waitTimer = timeoutMs === undefined   // ← 本次 wait 专属的定时器（区别于 start 时挂的 spec 超时）
      ? null
      : setTimeout(() => {
          waitTimedOut = true;
          terminateTree(running.child.pid);
        }, timeoutMs);
    const exit = await running.exit;   // ← 真正的等待：exit 是 startProcess 里挂好的 Promise
    if (waitTimer !== null) clearTimeout(waitTimer);   // ← 及时清掉本次等待的定时器，避免它以后误伤
    if (running.timeoutTimer !== null) clearTimeout(running.timeoutTimer);   // ← spec 超时定时器也清掉
    this.running.delete(id);   // ← 从存活表移除（之后再用这个 id 来 wait 就会报 unknown handle）

    const status: ProcessResult["status"] = running.outputLimit   // ← 嵌套三元定性；类型注解写在冒号后
      ? "output_limit"
      : running.timedOut || waitTimedOut
        ? "timeout"
        : exit.error !== null
          ? "spawn_error"
          : running.stopRequested
            ? "stopped"
            : "exited";
    return {
      status,
      exitCode: status === "exited" ? exit.code : null,   // ← 只有"正常退出"才有意义的退出码；被杀/超时时是 null
      signal: exit.signal,
      stdoutBase64: Buffer.concat(running.stdout).toString("base64"),   // ← Buffer.concat 把散落的块拼成一块再转 base64
      stderrBase64: Buffer.concat(running.stderr).toString("base64"),
      durationMs: Date.now() - running.startedAt,
      error: running.outputLimit
        ? `process output exceeded ${running.spec.maxOutputBytes} bytes`
        : running.timedOut || waitTimedOut
          ? `process exceeded timeout ${timeoutMs ?? running.spec.timeoutMs}ms`
          : exit.error?.message ?? null,
    };
  }

// ── stopProcess：主动杀 ──────────────────────────────────────────────
// 找不到这个 id 时不报错，而是返回一个"什么都没发生"的 stopped 结果——
// 因为 stop 常被用在"清理"场景（close() 也调它），目标可能早就退出了。
  private async stopProcess(handle: ProcessHandle): Promise<ProcessResult> {
    const running = this.running.get(handle.id);
    if (running === undefined) {
      return {
        status: "stopped",
        exitCode: null,
        signal: null,
        stdoutBase64: "",
        stderrBase64: "",
        durationMs: 0,
        error: null,
      };
    }
    running.stopRequested = true;   // ← 标记"这是被人为停掉的"（collectProcess 用它定性为 stopped）
    terminateTree(running.child.pid);
    return this.waitProcess(handle);   // ← 杀完复用 wait 的收集逻辑，拿到退出信息
  }

// ── toolAvailable：某个工具此刻能不能用 ──────────────────────────────
// 两道门：①policy.allowedTools 非空时，名单外的一律 false（白名单）；
// ②必须真的被 preflight 实测过：available === true 且探测到了路径。
// "实测"的含义——不靠 PATH 猜、不靠文档说，是程序真的跑过一次探测命令。
// workflow 只能问，不能自己发现新工具。
  private toolAvailable(name: string): boolean {
    if (this.policy.allowedTools.length > 0 && !this.policy.allowedTools.includes(name)) return false;
    const tool = this.host?.tools[name];   // ← host 可能没给（undefined），所以用 ?.
    return tool?.available === true && tool.path !== null;   // ← 严格等于 true：undefined / false 都会被挡下
  }

// ── toolList：列出所有"可用且被允许"的工具 ───────────────────────────
// 给 workflow 做能力自检用（"这台机器上有哪些工具可调度"）。
  private toolList(): WorkflowTool[] {
    const tools = this.host?.tools ?? {};
    return Object.entries(tools)   // ← Object.entries：把对象变成 [键, 值] 数组
      .filter(([name, probe]) => this.toolAvailable(name) && probe.path !== null)   // ← 过滤：既过白名单、又确实测到了路径
      .map(([name, probe]) => ({ name, path: probe.path! }))   // ← path! 非空断言：上一行已确认不是 null（TS 语法）
      .sort((a, b) => a.name.localeCompare(b.name));   // ← 按名字排序，保证输出顺序稳定（对比/测试很依赖这一点）
  }

// ── resolveProgram：把 "cmake" 变成一个安全、确切的绝对路径 ─────────────
// 只允许两类程序：
//   ①实测过的工具名（纯名字，如 "cmake"）→ 用 preflight 记录的绝对路径；
//   ②workspace 内的相对路径可执行文件（如 "build/app.exe"）→ 还要过
//     executableGlobs。
// 三条明确拒绝：
//   · 绝对路径 —— 不给 workflow 直接执行任意位置程序的能力；
//   · 纯名字但不是实测工具 —— 防止靠 PATH 命中 "sh"、"bash"、"python"、
//     "rm" 这些宿主机上恰好存在的程序；
//   · 符号链接 / 目录 —— 软链接能把执行目标偷换到 workspace 外面去。
  private resolveProgram(program: string): string {
    const measured = this.resolveMeasuredTool(program);   // ← 先查"是不是实测工具"，命中就返回它的绝对路径
    if (measured !== null) return measured;
    let candidate = program;   // ★ 新版：绝对路径不再一刀切拒绝，先归一化成 workspace 相对路径再继续检查
    if (isAbsolute(program)) {
      // An absolute path inside the workspace is the same executable as its
      // relative form; workflows naturally build paths from ctx.workspaceRoot.
      // Normalize to the workspace-relative path and continue the checks.
      // ↑ 官方注释：workspace 内的绝对路径和它的相对形式是同一个可执行文件；
      //   workflow 天然会用 ctx.workspaceRoot 拼路径，归一化后继续走检查。
      const rel = relative(this.workspaceRoot, program).split(sep).join("/");   // ← 相对化 + 统一成正斜杠
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        // ⚠️ 逃出 workspace 的绝对路径仍然 fail-closed 拒绝。
        throw new Error(`absolute executable paths are not allowed: ${program}`);
      }
      candidate = rel;
    }
    if (!candidate.includes("/") && !candidate.includes("\\")) {   // ← 既不含 / 也不含反斜杠 → 是个"裸名字"，只可能是工具名
      throw new Error(`measured tool is unavailable: ${program}`);
    }
    const absolute = this.resolveReadable(candidate);   // ← 相对路径也要过一遍可读检查（在 workspace 内 + readableGlobs）
    if (!matchesAnyGlob(this.relativeWorkspace(absolute), this.policy.executableGlobs)) {   // ← executableGlobs 默认是 []：不显式开就一律不许
      throw new Error(`executable is not allowed by executableGlobs: ${program}`);
    }
    if (!existsSync(absolute)) throw new Error(`executable does not exist: ${program}`);
    if (lstatSync(absolute).isSymbolicLink() || statSync(absolute).isDirectory()) {   // ← lstat 不跟随软链接，所以能看出"它本身是个链接"
      throw new Error(`executable is not a regular file: ${program}`);
    }
    return absolute;
  }

// ── resolveMeasuredTool：查"实测工具表" ──────────────────────────────
// 满足以下全部条件才返回工具的绝对路径（宿主测到的，不是拼出来的）：
//   · 名字里没有路径分隔符、也不是绝对路径（纯名字才是工具名）；
//   · allowedTools 为空，或者包含它（白名单放行）；
//   · preflight 里测到它：available === true 且 path 非 null。
// 否则返回 null，由 resolveProgram 继续按"workspace 相对可执行文件"处理。
  private resolveMeasuredTool(name: string): string | null {
    if (name.includes("/") || name.includes("\\") || isAbsolute(name)) return null;
    if (this.policy.allowedTools.length > 0 && !this.policy.allowedTools.includes(name)) {
      return null;
    }
    const tool = this.host?.tools[name];
    return tool?.available === true && tool.path !== null ? tool.path : null;
  }

// ── buildEnv：给子进程配一份"干净的"环境变量 ───────────────────────────
// 【作用】先从父进程 env 里挑 SYSTEM_ENV_KEYS（白名单），再叠上 workflow
//   要求的 overrides；不在白名单、也不在 policy.allowedEnv 里的键直接拒绝。
// 【返回】Record<string,string>：完全重造的 env，不是"继承后修改"。
// 【为什么】默认继承全套环境变量是常见的泄密渠道（API key、内网代理、
//   cloud 凭据都在 env 里），也常是构建行为失控的来源（NODE_OPTIONS、
//   CFLAGS 之类）。白名单里只留编译器能跑起来的必需项。
  private buildEnv(overrides: Readonly<Record<string, string>> | undefined): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of SYSTEM_ENV_KEYS) {
      const value = process.env[key];   // ← 逐个白名单键尝试取值，父进程没有的键就跳过
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(overrides ?? {})) {   // ← ?? {}：没传 overrides 时当空对象处理
      if (!SYSTEM_ENV_KEYS.has(key) && !this.policy.allowedEnv.includes(key)) {
        throw new Error(`environment key is not allowed: ${key}`);
      }
      env[key] = value;   // ← 能走到这里说明该键已过白名单检查
    }
    return env;
  }

// ── resolveReadable：所有"读"操作的统一关卡 ───────────────────────────
// 三步：①resolveInside —— 路径不许逃出 workspace（挡 ../ 攻击）；
// ②assertRealPathInside —— 真实路径也不许逃出（挡符号链接攻击）；
// ③matchesAnyGlob —— 还得命中 readableGlobs（默认 ["**"] = 整个 workspace）。
// 【返回】绝对路径。之后所有 fs 调用都用这个返回值，不用原始输入。
  private resolveReadable(path: string): string {
    const absolute = resolveInside(this.workspaceRoot, path, "readable path");
    assertRealPathInside(this.workspaceRoot, absolute, "readable path");
    if (!matchesAnyGlob(this.relativeWorkspace(absolute), this.policy.readableGlobs)) {   // ← relativeWorkspace：把绝对路径转成正斜杠的 workspace 相对路径
      throw new Error(`path is not readable by capability policy: ${path}`);
    }
    return absolute;
  }

// ── resolveWritable：所有"写"操作的统一关卡 ───────────────────────────
// 与 resolveReadable 相同的三步，但最后查的是 writableGlobs——
// 默认 []，也就是"默认什么都写不了"，必须由 policy 显式放开。
// 读宽写窄是刻意的：读错顶多泄露信息，写错会污染 worktree、破坏对比结论。
  private resolveWritable(path: string): string {
    const absolute = resolveInside(this.workspaceRoot, path, "writable path");
    assertRealPathInside(this.workspaceRoot, absolute, "writable path");
    if (!matchesAnyGlob(this.relativeWorkspace(absolute), this.policy.writableGlobs)) {
      throw new Error(`path is not writable by capability policy: ${path}`);
    }
    return absolute;
  }

// ── relativeWorkspace：绝对路径 → workspace 相对路径（用 / 分隔）───────
// Windows 上 relative() 返回反斜杠路径，这里统一换成 /，
// 因为 glob 和快照的键全部用 / 风格。路径就是根时返回 "."。
  private relativeWorkspace(absolute: string): string {
    const rel = relative(this.workspaceRoot, absolute).split(sep).join("/");   // ← relative() 算相对路径，再把 Windows 反斜杠统一换成 /
    return rel.length === 0 ? "." : rel;   // ← 相对路径为空说明目标就是 workspace 根，返回 "."
  }
// ↑ 类定义到此结束；下面是模块级工具函数（不依赖 this，供上面的方法调用）。
}

// ── createExitPromise：把"进程死亡"变成一个 Promise ────────────────────
// 【语法】new Promise((resolve) => {...})：把回调风格的事件包成能 await 的
//   Promise。settled 标志保证只取第一个结果（error 和 close 都可能触发）。
// 【为什么需要】child 的 "exit" 事件只在进程真的跑起来后才触发；如果
//   可执行文件不存在，只会发 "error" 事件。两个都接住，await 才不会永远
//   挂着（挂住的话整个 Broker 就卡死了）。
function createExitPromise(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolveExit) => {
    let settled = false;
    const settle = (value: ProcessExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(value);
    };
    child.once("error", (error) => settle({ code: null, signal: null, error }));   // ← error：进程根本没起来，或启动出错
    child.once("close", (code, signal) => settle({ code, signal, error: null }));   // ← close：进程彻底结束（code 与 signal 二者有一个）
  });
}

// ── appendOutput：一边收输出，一边看住上限 ────────────────────────────
// 策略不是简单的"超了才截断"：先算还剩多少额度（remaining），只把额度内
// 的部分 push 进去——内存占用被精确压在 maxOutputBytes 以内；字节照常
// 计数，总量一旦超限就置标志并杀掉整棵进程树。
// 已经超限后（outputLimit === true）直接丢弃后续块，不再耗内存。
function appendOutput(running: RunningProcess, target: Buffer[], chunk: Buffer): void {
  if (running.outputLimit) return;   // ← 已超限：静默丢弃
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);   // ← 正常是 Buffer，兜底再转一次
  const max = running.spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;   // ← 单进程可自定义上限，没设就用全局默认 4 MiB
  const remaining = max - running.outputBytes;
  if (remaining > 0) target.push(bytes.subarray(0, remaining));   // ← subarray 不复制内存，只是"视图"，所以这一步很便宜
  running.outputBytes += bytes.length;
  if (running.outputBytes > max) {
    running.outputLimit = true;
    terminateTree(running.child.pid);
  }
}

// ── waitReady：等"服务就绪" ──────────────────────────────────────────
// start 之后立刻返回的话，workflow 可能马上就去连一个还没开始监听的端口。
// 这里提供两种探测：
//   file —— 轮询某个文件是否出现（很多服务会写 pid/ready 文件）；
//   tcp  —— 轮询某个 host:port 是否连得上。
// 都不做（undefined 或 kind:"none"）就直接返回，等价于 run() 的行为。
// 【关系】只被 startProcess 使用；探测失败会让 startProcess 把刚启动的
//   进程杀掉再抛错。
function waitReady(
  probe: WorkflowReadyProbe | undefined,
  workspaceRoot: string,
  policy: Required<WorkflowCapabilityPolicy>,
  child: ChildProcess,
): Promise<void> {
  if (probe === undefined || probe.kind === "none") return Promise.resolve();
  const timeoutMs = probe.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;   // ← 探测自己的超时，默认 10 秒（独立于进程的 spec.timeoutMs）
  const started = Date.now();
  if (probe.kind === "file") {
    const path = resolveInside(workspaceRoot, probe.path, "ready probe path");   // ← 探测路径也要过同样的路径安全检查：不能拿"探测"当后门
    assertRealPathInside(workspaceRoot, path, "ready probe path");
    if (!matchesAnyGlob(relativeWorkspacePath(workspaceRoot, path), policy.readableGlobs)) {
      return Promise.reject(new Error(`ready probe path is not readable: ${probe.path}`));
    }
    return poll(
      async () => existsSync(path),   // ← 每 25ms 查一次文件是否存在
      () => `file ready probe timed out after ${timeoutMs}ms: ${probe.path}`,
      timeoutMs,
      started,
    );
  }
  return poll(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {   // ← 进程已经死了就别再傻等端口，直接给出更有用的报错
        throw new Error(`process exited before TCP ready probe on ${probe.host}:${String(probe.port)}`);
      }
      return canConnect(probe.host, probe.port);   // ← 每次连接尝试自带 100ms 超时（见 canConnect）
    },
    () => `TCP ready probe timed out after ${timeoutMs}ms: ${probe.host}:${String(probe.port)}`,
    timeoutMs,
    started,
  );
}

// ── poll：通用轮询框架 ──────────────────────────────────────────────
// 每 25ms 跑一次 check()，返回 true 就成功返回；总时长超过 timeoutMs 就
// 抛出 timeoutMessage() 给出的错误。
// 【语法】async 函数 + await delay(25)：让出事件循环。这一点很重要——
//   Broker 是单线程的，同步忙等会把所有其他能力请求都卡住。
async function poll(
  check: () => Promise<boolean>,
  timeoutMessage: () => string,
  timeoutMs: number,
  started: number,
): Promise<void> {
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;   // ← check 是 async 的，返回 Promise<boolean>，必须 await
    await delay(25);
  }
  throw new Error(timeoutMessage());
}

// ── canConnect：能不能连上这个 TCP 端口（一次性探测）────────────────────
// createConnection 发起连接，三种结局都算"有答案"：连上（true）、
// 出错（false，比如端口没人听）、100ms 没反应（false）。
// done 里的 settled 防止重复结算；socket.destroy() 立刻关掉这个只为探测
// 而开的连接，不占资源。
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(100, () => done(false));   // ← setTimeout 的单位是毫秒：空闲 100ms 就放弃
  });
}

// ── snapshotDirectory：目录 → Map<相对路径, sha256> ───────────────────
// 真正的遍历在 walkDirectory；这里只是建好容器、算好入口。
// Snapshot 类型来自 src/runtime/fs-snapshot.ts（用 Map 而不是对象，键多时更省）。
function snapshotDirectory(root: string): Snapshot {
  const result: Snapshot = new Map();
  walkDirectory(root, root, result);
  return result;
}

// ── walkDirectory：递归遍历（拒绝一切非常规文件）──────────────────────
// readdirSync(..., { withFileTypes: true }) 直接给出每项的类型，不用再
// stat 一次。三种情况：目录 → 递归；文件 → 记录哈希；其余（符号链接、
// FIFO、socket、设备）→ 抛错。
// 为什么拒绝符号链接？快照会被用来对比"构建到底改了什么"。如果构建过程
// 在 workspace 里塞了一个指向外面的链接，跟随它就会把无关内容算进快照；
// 链接成环更会无限递归。宁可失败，也不要一份错误的确定性。
function walkDirectory(root: string, directory: string, result: Snapshot): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);   // ← resolve 拼绝对路径（比字符串拼接可靠）
    if (entry.isSymbolicLink()) throw new Error(`filesystem snapshot refuses symbolic link: ${relative(root, absolute)}`);
    if (entry.isDirectory()) {
      walkDirectory(root, absolute, result);
    } else if (entry.isFile()) {
      result.set(relative(root, absolute).split(sep).join("/"), hashFile(absolute));   // ← 键统一用 / 分隔，跨平台一致
    } else {
      throw new Error(`filesystem snapshot refuses special file: ${relative(root, absolute)}`);
    }
  }
}

// ── resolveInside：第一道关卡——路径不许"走出"workspace ─────────────────
// 【作用】把输入路径变成绝对路径，再检查它是否还在 workspace 内。
// 【攻击场景】worker 传 "../.git/config" 或 "../../../etc/passwd"——系统
//   会老老实实解析那些 ..，所以必须在这里用 relative() 拦下。
// 【语法细节】isAbsolute(path) ? resolve(path) : resolve(root, path)：
//   绝对路径按它自己算（反正马上要被检查），相对路径基于 workspace。
// 【判定】relative(root, absolute) 的结果：
//   · 以 "../" 开头，或就是 ".." → 往上跑了；
//   · 本身是绝对路径（Windows 跨盘符时会这样）→ 根本不在同一棵目录树。
//   三种都算越界。
function resolveInside(root: string, path: string, label: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, absolute);   // ← relative 返回"从 root 走到 absolute 的相对路径"
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes workspace: ${path}`);
  }
  return absolute;
}

// ── assertRealPathInside：第二道关卡——真实路径也不许越界 ───────────────
// 【攻击场景】workspace 里有个软链接 link → /home/me，worker 传 "link/x"。
//   resolveInside 检查的是"字面路径"，看起来乖乖待在 workspace 里；但真正
//   被读写的是 /home/me/x。所以这里用 realpathSync 把路径里的所有软链接
//   都解析掉，再看"物理位置"在不在 workspace 内。
// 【为什么要往上爬】realpathSync 要求路径存在。如果 worker 写的是一个
//   还没创建的文件（比如 build/out.o），就对它逐级向上找第一个真实存在
//   的祖先（如 build/），解析它、再检查。一路到文件系统根都没有就返回
//   （parent === current），此时按定义不越界。
function assertRealPathInside(root: string, absolute: string, label: string): void {
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);   // ← 逐级取父目录；parent === current 说明已经到根了
    if (parent === current) return;
    current = parent;
  }
  const real = realpathSync(current);   // ← real = 解析掉所有软链接后的物理路径
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} resolves outside workspace: ${absolute}`);   // ← 报错给的是 worker 传入的 absolute，便于定位是哪条请求被拒
  }
}

// ── relativeWorkspacePath：模块级版本的 relativeWorkspace ──────────────
// 和类里的方法一模一样，只是不依赖 this——供 waitReady 这类模块级函数用。
function relativeWorkspacePath(root: string, absolute: string): string {
  const rel = relative(root, absolute).split(sep).join("/");
  return rel.length === 0 ? "." : rel;
}

// ── hashFile：读整个文件算 SHA-256 ──────────────────────────────────
// 链式调用：createHash("sha256") 建哈希器 → update(...) 喂数据 →
// digest("hex") 出十六进制字符串。快照和 diff 全靠它区分"内容变没变"。
function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ── matchesAnyGlob：路径是否命中任意一条 glob ──────────────────────────
// some = 有一条命中就算过。第一个特判：glob 以 "/**" 结尾时，路径恰好等于
// 去掉 "/**" 的前缀也算命中——即 "build/**" 既匹配 build 本身，也匹配
// build 下的所有东西。
function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => {
    if (glob.endsWith("/**") && path === glob.slice(0, -3)) return true;   // ← slice(0, -3) 去掉末尾 3 个字符（"/**"）
    return globToRegExp(glob).test(path);   // ← 其余情况：把 glob 翻译成正则再匹配
  });
}

// ── globToRegExp：把 "build/**/*.o" 这样的通配符翻成正则 ───────────────
// 手写的迷你翻译器，只支持三种通配符：
//   **  →  .*     匹配任意（含 /，可跨目录）
//   *   →  [^/]*  匹配一段不含 / 的字符（只在本目录内）
//   ?   →  [^/]   恰好一个非 / 字符
// 其他字符按字面处理；正则元字符（. ^ $ 等）加反斜杠转义——不转义的
// 话，glob 里的 "build.v2" 会被当成正则的"任意字符"。
// 最后 ^...$ 锚定，保证整条路径完整匹配，而不是部分匹配。
function globToRegExp(glob: string): RegExp {
  let expression = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;   // ← 非空断言：TS 已知 index 在字符串范围内
    if (char === "*") {
      if (glob[index + 1] === "*") {   // ← 当前是 * 且下一个也是 * → 这是一条 **
        expression += ".*";
        index++;
        if (glob[index + 1] === "/") index++;   // ← ** 后面跟 / 就把它吞掉：a/**/b 能匹配 a/b
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");   // ← 正则转义：在元字符前加反斜杠，让它失去特殊含义
    }
  }
  return new RegExp(`^${expression}$`);   // ← ^...$ 锚定：整条路径完整匹配
}

// ── terminateTree：杀掉一整棵进程树 ─────────────────────────────────
// 为什么要"整棵"？cmake 会拉起 make，make 又拉起 cc、ld——只杀 cmake 的
// 话，编译器还在后台继续跑、继续写文件。必须连孙进程一起收。
// 两个平台的做法：
//   Windows  taskkill /PID <pid> /T /F（/T = 含子进程，/F = 强制）
//   POSIX    kill(-pid, SIGTERM)：负数 pid = 杀整个进程组。这要求启动时
//            detached: true（见 startProcess），否则没有独立进程组。
// 下面的 catch 是空块：定时器到点时进程可能已经自己退出了，taskkill / kill
// 会报"找不到进程"，这不是错误，忽略即可。
function terminateTree(pid: number | undefined): void {
  if (pid === undefined) return;   // ← 进程还没拿到 pid 就死了的情况
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // The process may have exited between timeout and cleanup.
  }
}

// ── normalizeProcessSpec：补默认值 + 拷贝参数 ────────────────────────
// timeoutMs / maxOutputBytes 都在这里兜底（60 秒 / 4 MiB）；
// args 用 [...] 浅拷贝一份——传进来的是 readonly 数组，RunningProcess 里
// 要长期持有，拷一份顺带切断与调用方对象的共享。
function normalizeProcessSpec(spec: ProcessStartSpec): ProcessStartSpec {
  return {
    ...spec,
    args: [...(spec.args ?? [])],   // ← 浅拷贝 args：传进来的是 readonly，这里留一份自己的
    timeoutMs: positiveInt(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),   // ← 没给就默认 60 秒
    maxOutputBytes: positiveInt(spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes"),   // ← 没给就默认 4 MiB
  };
}

// ── 下面一整段 *Arg 函数：请求参数的"验收员" ───────────────────────────
// args 来自 JSON.parse，类型系统已经帮不上忙（全是 unknown），所以每个
// 方法入口都要手动验类型。验不过就抛错——错误会进 WorkflowEvent，
// worker 那边看到的是一句清楚的解释，而不是深处的崩溃堆栈。
// processRunSpecArg 和 processSpecArg 目前是同一个东西（历史分层留下来的）。
function processRunSpecArg(args: unknown[], index: number): ProcessRunSpec {
  return processSpecArg(args, index);
}

// ── processStartSpecArg：在 run spec 基础上额外校验 ready 探测 ─────────
function processStartSpecArg(args: unknown[], index: number): ProcessStartSpec {
  const spec = processSpecArg(args, index) as ProcessStartSpec;
  if (spec.ready !== undefined && !isReadyProbe(spec.ready)) throw new Error("invalid process ready probe");   // ← ready 结构复杂（none/file/tcp 三种），交给 isReadyProbe 统一判
  return spec;
}

// ── processSpecArg：校验 program / args / cwd / stdin / env 等字段 ──────
// 【语法】record as Record<string, unknown>：把 unknown 断言成"可以用
//   字符串下标取字段的对象"。as 不做任何转换，只是让类型检查器闭嘴——
//   所以前面那些 typeof 检查才是真正的安全网，as 只是最后的形式。
function processSpecArg(args: unknown[], index: number): ProcessRunSpec {
  const value = args[index];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {   // ← 必须是普通对象；数组也是 object，所以要显式排除
    throw new Error("process spec must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.program !== "string" || record.program.length === 0) {   // ← program 是唯一必填字段
    throw new Error("process spec requires program");
  }
  if (
    record.args !== undefined &&
    (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string"))
  ) throw new Error("process args must be strings");   // ← args 缺省可以，给了就必须全是字符串（shell:false 依赖这一点）
  if (record.cwd !== undefined && typeof record.cwd !== "string") throw new Error("process cwd must be a string");
  if (record.stdinBase64 !== undefined && typeof record.stdinBase64 !== "string") {
    throw new Error("process stdinBase64 must be a string");
  }
  if (record.env !== undefined && !isStringRecord(record.env)) throw new Error("process env must be a string record");
  return record as unknown as ProcessRunSpec;   // ← 最后一次性断言成 ProcessRunSpec
}

// ── handleArg：校验进程句柄 { id: "p3" } ────────────────────────────
function handleArg(args: unknown[], index: number): ProcessHandle {
  const value = args[index];
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).id !== "string"
  ) throw new Error("process handle must have an id");
  return value as ProcessHandle;
}

// ── snapshotArg：校验快照对象 { "路径": "sha256", ... } ────────────────
// 这里只验"所有值都是字符串"。路径和哈希的对应关系在 diff 里还会再检查
// （见 diff 的前缀校验），这里先挡住明显不是快照的东西。
function snapshotArg(args: unknown[], index: number): WorkflowFsSnapshot {
  const value = args[index];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some((hash) => typeof hash !== "string")
  ) throw new Error("snapshot must be a path-to-hash object");
  return value as WorkflowFsSnapshot;
}

// ── stringArg：最常用的验收员（第 index 个参数必须是 string）──────────
// label 用来拼错误信息，例如 "path must be a string"。
function stringArg(args: unknown[], index: number, label: string): string {
  const value = args[index];
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

// ── optionalErrorArg：plan.fail 的错误说明 ──────────────────────────
// worker 可能拿任何东西当 error（对象、Error 序列化结果……），
// 这里统一 String() 成字符串再存档。
/** Accept any fail payload; errors are stringified for the plan record. */
function optionalErrorArg(args: unknown[], index: number): string | undefined {
  const value = args[index];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return String(value);
}

// ── optionalStringArg：可缺省的字符串参数（缺省返回 undefined）──────────
// ⚠️ 注意：缺省时返回 undefined，但"给了"就必须是字符串；而且报错文案
// 固定是 "path must be a string"（label 写死了）。本文件里它只用于路径
// 参数，所以这样够用。
 function optionalStringArg(args: unknown[], index: number): string | undefined {
   const value = args[index];
   if (value === undefined) return undefined;
   return stringArg(args, index, "path");   // ← label 固定写成 path：本文件里这个函数只处理路径参数
 }

// ── planDeclarationsArg：递归校验整棵步骤树 ─────────────────────────
// 在真正进入状态机之前，把"结构对不对"（id / title / description /
// children 的类型、title 非空）全部查完。这样 planDeclare 里就只剩业务逻辑。
// 【语法】...(cond ? {} : { id: record.id })：字段可选时的条件展开惯用法，
//   不给就不出现在结果对象里（而不是给个 undefined）。
function planDeclarationsArg(args: unknown[], index: number): PlanStepDeclaration[] {
  const value = args[index];
  if (!Array.isArray(value)) throw new Error("plan declarations must be an array");
  const validate = (items: unknown[]): PlanStepDeclaration[] => items.map((item) => {   // ← validate 在 map 里递归调用自己处理 children
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("plan step must be an object");
    }
    const record = item as Record<string, unknown>;
    if (record.id !== undefined && (typeof record.id !== "string" || record.id.length === 0)) {   // ← id 可以不给，但给了就必须是非空字符串
      throw new Error("plan step id must be a non-empty string when provided");
    }
    if (typeof record.title !== "string" || record.title.length === 0) {
      throw new Error("plan step title must be a non-empty string");
    }
    if (record.description !== undefined && typeof record.description !== "string") {
      throw new Error("plan step description must be a string");
    }
    if (record.children !== undefined && !Array.isArray(record.children)) {
      throw new Error("plan step children must be an array");
    }
    return {
      ...(record.id === undefined ? {} : { id: record.id }),   // ← 只挑选已知字段重组对象：多余字段在这里被丢掉
      title: record.title,
      ...(record.description === undefined ? {} : { description: record.description }),
      ...(record.children === undefined ? {} : { children: validate(record.children as unknown[]) }),
    };
  });
  return validate(value);
}

// ── encodingArg：编码参数（缺省 utf8）───────────────────────────────
// ?? "utf8"：undefined / null 都取默认。只允许两个值，别的统统拒绝——
// 不给自由度，就不会有编码相关的意外。
function encodingArg(args: unknown[], index: number): "utf8" | "base64" {
  const value = args[index] ?? "utf8";
  if (value !== "utf8" && value !== "base64") throw new Error("encoding must be utf8 or base64");
  return value;
}

// ── optionalPositiveInt：可缺省的正整数（毫秒类参数用它）──────────────
function optionalPositiveInt(args: unknown[], index: number, label: string): number | undefined {
  const value = args[index];
  if (value === undefined) return undefined;
  return positiveInt(value, label);
}

// ── positiveInt：必须是正整数 ──────────────────────────────────────
// Number.isSafeInteger 排除了小数、NaN、Infinity 和超过 2^53-1 的数；
// value <= 0 排除 0 和负数。超时/上限这类参数一旦是 0 或负数，行为会变得
// 很难解释（0 毫秒超时 = 立刻杀进程），所以干脆禁掉。
function positiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

// ── isStringRecord：{ 全是字符串值的对象 } ───────────────────────────
// 【语法】"value is Record<string,string>" 是类型谓词（type predicate）：
//   函数返回 true 时，TS 就把 value 当成那个类型用。env 参数的校验靠它。
function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

// ── isReadyProbe：校验 ready 探测的三种形态 ──────────────────────────
// {kind:"none"} / {kind:"file", path} / {kind:"tcp", host, port}，
// 三者都可带 timeoutMs。这里手写校验而不是用 Zod：数据来自进程间 JSON，
// 量小、结构固定，直接写清楚反而更直观。
function isReadyProbe(value: unknown): value is WorkflowReadyProbe {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).kind !== "string"
  ) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "none") return true;
  if (record.kind === "file") {
    return typeof record.path === "string" &&
      (record.timeoutMs === undefined || typeof record.timeoutMs === "number");
  }
  return record.kind === "tcp" &&
    typeof record.host === "string" &&
    typeof record.port === "number" &&
    (record.timeoutMs === undefined || typeof record.timeoutMs === "number");
}

// ── delay：睡 ms 毫秒（Promise 版 sleep）────────────────────────────
// poll 每 25ms 调一次。用异步等待而不是同步忙等很关键：Broker 在主进程的
// 单线程事件循环里跑，忙等会把其他能力请求全部卡住。
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// ── errorMessage：把"随便什么东西"变成一条字符串 ─────────────────────
// JS 里 throw 的可以不是 Error（数字、字符串都行），所以 instanceof 判断
// 之后还要 String() 兜底。handle() 用它把异常写进 WorkflowEvent。
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
