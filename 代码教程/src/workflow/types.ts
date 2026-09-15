/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/types.ts —— workflow 子系统的"接口中枢"（只有类型，没有一句可执行代码）
 *
 * 【这个文件是干什么的】
 *   它规定了一件大事：一段 workflow（一段 TypeScript 源码，默认导出一个函数）
 *   运行时能拿到什么、能做什么、跑完之后要交回什么。整个文件只有 interface / type
 *   声明，编译成 JS 后几乎什么都不剩 —— 它是一份"合同"，不是"实现"。
 *
 * 【在整个项目里的位置】
 *   上游：src/workflow/ 下几乎每个文件都 import 它 —— client.ts、worker.ts、
 *         runner.ts、capabilities.ts、build-executor.ts、test-executor.ts、
 *         expectation-compare.ts、resolve-workflows.ts……
 *   下游：它不 import 本目录的任何实现，只引用 src/artifacts/index.js 里的
 *         HostPreflight / ProjectDetection 两个 artifact 类型。
 *   用法：workflow 作者（人或 AI）只看这个文件就知道 ctx 上有什么可用；
 *         src/agents/workflow-types.ts 里那份喂给 AI 的 types.d.ts 模板就是照它写的。
 *
 * 【两个进程、一条 JSON 管道】（本组 8 个文件的共同背景图景，后面反复用到）
 *   workflow 源码由 runner.ts spawn 一个 `bun run worker.ts <entry> <cwd>` 子进程执行。
 *   子进程里【没有】node:fs / child_process / 网络权限 —— 它要读文件、跑 cmake，
 *   只能通过 stdin/stdout 上一行行 JSON（即 JSONL）向主进程的 LocalCapabilityBroker
 *   （capabilities.ts，见 🔗 runner.ts）申请。本文件里的 WorkflowFilesystem /
 *   WorkflowProcess / WorkflowTools 等接口，就是这套"申请-放行"机制对 workflow
 *   作者暴露出来的那张脸：你调用 ctx.fs.readFile(...)，实际上是在发一条 JSON 请求。
 *
 * 【先修知识】
 *   TypeScript 的 interface（接口）、联合类型（A | B）、readonly、泛型 Promise<T>。
 *   这些都会在本文件第一次出现处讲透 —— 本组 8 个文件建议从这一个开始读。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/types.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 【语法】`import type { A, B } from "…"`：只导入"类型"，不导入"值"。
// 编译后这一行会整个消失（类型在 JS 里不存在）。这里引用的是 src/artifacts/ 里的
// Zod artifact 类型 —— 主机探测到的"主机事实"和"项目事实"。
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";

// ── WorkflowFacts：注入给 workflow 的"测量事实"──────────────────────
// 【作用】把主进程实测到的环境信息递给 workflow，让作者"基于测量写方案，不许猜"。
// 【关系】runner.ts 的 options.facts → 子进程 WorkerPayload.facts → ctx.facts。
// 🔗 见 零基础看懂教程.md §1.5「HostPreflight / ProjectDetection」。
export interface WorkflowFacts {
  // 【语法】`readonly`：只读。TS 会在编译期禁止你给这个字段赋值（运行时不设防，
  // 但这是本项目的统一写法 —— "注入的东西不许改"）。
  // 【语法】`host?:`：问号 = 可选字段，可能是 undefined。
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
}

// 【语法】`type 别名 = 联合类型`：把几种可能取值列出来。这里的取值只能是两个
// 字符串字面量之一（"字面量类型"），写别的字符串会编译报错。文件读出来是文本，
// 或者是 base64 编码的二进制。
export type WorkflowFileEncoding = "utf8" | "base64";

// ── WorkflowFsSnapshot：某一时刻的"文件快照"────────────────────────
// 【语法】`[path: string]: string` 叫"索引签名"：这个接口允许任意多的键，
// 键是文件路径（字符串），值是文件内容（字符串）。可以理解成一个"路径→内容"的字典。
// 典型用法：先 snapshot() 存下目录原样，跑完再 diff() 看改了什么。
export interface WorkflowFsSnapshot {
  readonly [path: string]: string;
}

// ── WorkflowFsEffect：diff 出来的"一条改动记录"──────────────────────
export interface WorkflowFsEffect {
  readonly path: string;                 // ← 哪个文件（相对 workspaceRoot）
  readonly op: "create" | "modify" | "delete";  // ← 这次 diff 发现它是新建/修改/删除
  readonly sha256: string | null;        // ← 内容摘要；delete 时文件没了，所以是 null
}

// ── WorkflowFilesystem：ctx.fs 的真面目─────────────────────────────
// 【作用】workflow 眼中的文件系统。注意：这是【接口】不是实现 —— 真正干活的是
//         主进程 capabilities.ts 里的 broker；子进程这边由 client.ts 造一个"代理
//         对象"填进这个形状，每个方法内部都是"发一条 capability-request 然后等回复"。
// 【语法】接口里的方法写法 `readFile(path: string): Promise<string>`：
//         - 参数名后面冒号是参数类型，括号后面是返回值类型；
//         - 【泛型】`Promise<T>`：Promise 是"还没完成的异步操作"这个容器，
//           尖括号里的 T 说明它将来会装着一个什么类型的值。
//           `Promise<string>` = "最终会给你一个字符串"。这就是 TypeScript 版的
//           "这个函数是异步的，结果要用 await 拿"。
// 【关系】workflow 作者：`const text = await ctx.fs.readFile("CMakeLists.txt");`
export interface WorkflowFilesystem {
  readFile(path: string, encoding?: WorkflowFileEncoding): Promise<string>;
  writeFile(path: string, content: string, encoding?: WorkflowFileEncoding): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
  snapshot(path?: string): Promise<WorkflowFsSnapshot>;
  diff(path: string, before: WorkflowFsSnapshot): Promise<WorkflowFsEffect[]>;
}

// ── ProcessRunSpec：跑一个外部命令的"请求单"────────────────────────
// 【作用】描述"我要跑 cmake --build build"这种事。workflow 只能通过它请求，
//         不能自己 spawn（子进程没有 child_process 权限）。
// 【关系】ctx.process.run(spec) → 一条 JSON 请求 → 主进程 broker 真正 spawn →
//         回填一个 ProcessResult。
export interface ProcessRunSpec {
  /** A measured tool name (e.g. `cmake`) or a workspace-relative executable path. */
  readonly program: string;
  // 【语法】`readonly string[]` 前再加 readonly（即 `readonly args?: readonly string[]`）：
  //         外层 readonly 表示"这个字段不能换数组"，内层 readonly string[] 表示
  //         "数组里的元素也不能改"。双层锁死，典型的"只读入参"写法。
  readonly args?: readonly string[];
  readonly cwd?: string;                 // ← 工作目录；不填就用 broker 的 workspaceRoot
  readonly stdinBase64?: string;         // ← 要喂给子进程的标准输入（base64 编码）
  readonly env?: Readonly<Record<string, string>>;  // ← 额外环境变量；broker 按 policy 的 allowedEnv 过滤
  readonly timeoutMs?: number;           // ← 单位毫秒！超时后子进程被杀，status 变 "timeout"
  readonly maxOutputBytes?: number;      // ← stdout+stderr 的字节上限，防止单条命令把内存吃爆
}

// ── ProcessStartSpec：start/wait/stop 用的"启动单"───────────────────
// 【语法】`extends`：接口继承。ProcessStartSpec 拥有 ProcessRunSpec 的全部字段，
//         再额外加一个 ready。适合"长期运行的进程"（比如起了个测试服务器）。
export interface ProcessStartSpec extends ProcessRunSpec {
  readonly ready?: WorkflowReadyProbe;
}

// ── WorkflowReadyProbe：怎么判断"启动好了"──────────────────────────
// 【语法】"可辨识联合"（discriminated union）：三种形状都用同一个字段 kind 开头，
//         且 kind 取值互不相同。使用方先 `if (probe.kind === "tcp")`，TS 就知道
//         这个分支里一定有 host/port 字段 —— 这是 TS 里代替"一大堆可选参数"的利器。
export type WorkflowReadyProbe =
  | {
      readonly kind: "none";             // ← 不探测，start() 立即返回
    }
  | {
      readonly kind: "tcp";              // ← 等 TCP 端口能连上
      readonly host: string;
      readonly port: number;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "file";             // ← 等某个文件出现（很多程序用文件当"我ready了"的信号）
      readonly path: string;
      readonly timeoutMs?: number;
    };

// ── ProcessResult：一次进程运行的"体检报告"─────────────────────────
// 【作用】run/wait 的返回值。status 这 5 个枚举值是理解构建失败原因的关键。
// 【关系】它也出现在 artifact 里（构建/CTest 结果里带 base64 的 stdout/stderr）。
export interface ProcessResult {
  // exited   正常跑完（不管退出码是不是 0）
  // timeout  超时被杀
  // output_limit  输出超过 maxOutputBytes 被截断
  // spawn_error   根本没启动起来（比如程序不存在）
  // stopped        被显式 stop() 掉了
  readonly status: "exited" | "timeout" | "output_limit" | "spawn_error" | "stopped";
  readonly exitCode: number | null;      // ← 退出码；没跑起来/被信号杀掉时是 null
  readonly signal: string | null;        // ← 是被哪个信号杀的（如 SIGTERM）
  readonly stdoutBase64: string;         // ← 【注意】stdout/stderr 都是 base64，不是明文！
  readonly stderrBase64: string;         //    因为命令输出可能含任意字节，JSON 里装不下；
                                         //    用的时候要 Buffer.from(x, "base64").toString()
  /** Decoded stdout text (utf8). Present on results delivered to workflow
   *  source via WorkflowCapabilityClient — workflows read result.stdout. */
  // ★ 新增：解码后的明文（client.ts 的 decodeProcess 负责填），workflow 直接读它。
  readonly stdout?: string;
  /** Decoded stderr text (utf8). See stdout. */
  readonly stderr?: string;
  readonly durationMs: number;           // ← 耗时，毫秒
  readonly error: string | null;         // ← spawn_error 时的具体原因
}

// ── ProcessHandle：start() 发的"号牌"──────────────────────────────
// 【作用】start() 不等进程结束，只发回一个 id；之后用这个 id 去 wait()/stop()。
//         这样 broker 才知道你等的是哪个进程。
export interface ProcessHandle {
  readonly id: string;
}

// ── WorkflowProcess：ctx.process 的真面目──────────────────────────
// 【关系】四个方法分别对应 capability 协议里 "process" 能力的 run/start/wait/stop
//         四个 method（见 client.ts 和 capabilities.ts）。
export interface WorkflowProcess {
  run(spec: ProcessRunSpec): Promise<ProcessResult>;      // ← 最常用：跑一条命令等它结束
  start(spec: ProcessStartSpec): Promise<ProcessHandle>;  // ← 起一个进程不等它
  wait(handle: ProcessHandle, timeoutMs?: number): Promise<ProcessResult>;
  stop(handle: ProcessHandle): Promise<ProcessResult>;
}

// ── WorkflowTool：一个"实测到的工具"────────────────────────────────
// 【作用】主进程 preflight 阶段测过 gcc/cmake/ctest 这些工具在不在、路径在哪。
//         path 给的是绝对路径，workflow 可以拿它当 process.run 的 program。
export interface WorkflowTool {
  readonly name: string;
  readonly path: string;
}

// ── WorkflowTools：ctx.tools 的真面目───────────────────────────────
export interface WorkflowTools {
  available(name: string): Promise<boolean>;  // ← "gcc 在这台机器上有吗？"
  list(): Promise<WorkflowTool[]>;
}

// ── 四个构建适配器：把"拼命令行"这件脏活包起来───────────────────────
// 【作用】下面 CMakeAdapter/NinjaAdapter/CTestAdapter/CompilerAdapter 是"便利层"：
//         它们底层其实就是 process.run（见 client.ts 的 createAdapters），
//         只是把 `cmake -S . -B build` 这种命令行参数帮你拼好，避免写错。
// 【语法】参数直接写成一个内联对象类型 `{ readonly buildDir: string; … }`，
//         调用方就是 `await ctx.adapters.cmake.build({ buildDir: "build" })`。
export interface CMakeAdapter {
  configure(options: {
    readonly sourceDir?: string;   // ← -S，源码目录；不填默认 "."
    readonly buildDir: string;     // ← -B，构建产物目录
    readonly generator?: string;   // ← -G，如 "Ninja"、"Visual Studio 17 2022"
    readonly flags?: readonly string[];  // ← 额外的 -D 变量等
  }): Promise<ProcessResult>;
  build(options: {
    readonly buildDir: string;
    readonly target?: string;      // ← --target；不填编默认目标
    readonly flags?: readonly string[];
  }): Promise<ProcessResult>;
}

export interface NinjaAdapter {
  build(options: {
    readonly buildDir?: string;    // ← -C，进哪个目录跑 ninja
    readonly target?: string;
    readonly flags?: readonly string[];
  }): Promise<ProcessResult>;
}

export interface CTestAdapter {
  run(options: {
    readonly buildDir: string;         // ← --test-dir
    readonly configuration?: string;   // ← -C，多配置生成器（VS）需要，默认 Debug
    readonly args?: readonly string[]; // ← 透传给 ctest 的额外参数
    readonly timeoutMs?: number;
  }): Promise<ProcessResult>;
}

export interface CompilerAdapter {
  compile(options: {
    readonly compiler?: string;    // ← 默认 gcc
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly timeoutMs?: number;
  }): Promise<ProcessResult>;
}

// ── WorkflowAdapters：四个适配器的打包──────────────────────────────
// 【关系】ctx.adapters.cmake / ctx.adapters.ninja / ctx.adapters.ctest /
//         ctx.adapters.compiler（也有 ctx.adapters 便利别名，见 WorkflowContext）。
export interface WorkflowAdapters {
  readonly cmake: CMakeAdapter;
  readonly ninja: NinjaAdapter;
  readonly ctest: CTestAdapter;
  readonly compiler: CompilerAdapter;
}

/**
 * Result-validation capability. Workflows assert that expected side effects
 * (e.g. produced executables) exist before completing; a failed assertion
 * throws and fails the workflow. This replaces the old pattern of returning
 * an artifact manifest for the host to check after the fact.
 */
// ── WorkflowValidator：验收断言（ctx.validator）────────────────────
// 【作用】workflow 自己声明"我承诺产出了这些东西"，宿主当场验证。
//         断言失败会 throw，整个 workflow 判失败 —— 这取代了旧版"workflow 返回一个
//         产物清单、宿主事后核对"的写法。fail-closed 的味道：说不清楚就不过。
// 【关系】client.ts 造代理 → capability "validator" → capabilities.ts 的
//         dispatchValidator 真正去看文件。
export interface WorkflowValidator {
  /** Assert a file exists (relative to the workspace root). Throws otherwise. */
  assertFile(path: string, description?: string): Promise<void>;
  /** Assert a directory exists. Throws otherwise. */
  assertDir(path: string, description?: string): Promise<void>;
  /** Assert a path does NOT exist. Throws otherwise. */
  assertAbsent(path: string, description?: string): Promise<void>;
}

// ── WorkflowCapabilities：七项能力的"全家桶"────────────────────────
// 【作用】把上面所有能力装一个对象里。它同时出现在 ctx.capabilities 和
//         ctx.fs / ctx.process / … 这些便利别名里（见 WorkflowContext 的注释）。
export interface WorkflowCapabilities {
  readonly fs: WorkflowFilesystem;
  readonly process: WorkflowProcess;
  readonly tools: WorkflowTools;
  readonly adapters: WorkflowAdapters;
  readonly validator: WorkflowValidator;
  readonly plan: WorkflowPlanApi;
  readonly expect: WorkflowExpectApi;
}

// ── WorkflowContext：workflow 函数拿到的唯一入参────────────────────
// 【作用】一个 workflow 就是这样用的：
//           export default async (context) => {
//             await context.fs.readFile("CMakeLists.txt");
//             …
//           };
// 【关系】这个对象由 client.ts 的 createWorkflowContext() 造出来（子进程里），
//         传给动态 import 进来的 workflow 函数。喂给 AI 的 types.d.ts 模板描述的也是它。
export interface WorkflowContext {
  readonly apiVersion: 1;   // ← 字面量类型：永远是数字 1。将来 ctx 形状大改时升成 2，
                            //   workflow 一眼就能看出自己写的是哪一代 API
  readonly workspaceRoot: string;  // ← 相对路径都相对它（通常是某个 worktree 目录）
  // 【语法】`unknown`：TS 里"一个我不知道是什么类型的东西"的顶类型。
  // 与 any 的区别：unknown 拿到手必须先判断类型才能用，any 则完全放开检查。
  // 本项目全用 unknown —— 这是 fail-closed 在类型层面的体现：不许糊弄。
  readonly input: unknown;         // ← 宿主传进来的任意业务数据（如用户指定的参数）
  readonly facts: WorkflowFacts;
  readonly capabilities: WorkflowCapabilities;
  /** Convenience aliases; both forms refer to the same injected objects. */
  // ↓ 下面这 7 个是便利别名，和 capabilities 里的对象是同一个（ctx.fs === ctx.capabilities.fs）。
  //   好处：写 workflow 时少打字；坏处：新人会以为它们是两套东西 —— 不是。
  readonly fs: WorkflowFilesystem;
  readonly process: WorkflowProcess;
  readonly tools: WorkflowTools;
  readonly adapters: WorkflowAdapters;
  readonly validator: WorkflowValidator;
  readonly plan: WorkflowPlanApi;
  readonly expect: WorkflowExpectApi;
}

// ── WorkflowCapabilityPolicy：宿主给子进程的"权限清单"────────────────
// 【作用】限制子进程能读哪里、写哪里、跑哪些工具、给多少环境变量、多大输出。
//         这是 capabilities.ts 里 broker 放行/拒绝的依据。
// 【关系】runner.ts 的 options.policy → WorkerPayload.policy → broker 的 Required<…> 策略。
// 🔗 见 零基础看懂教程.md §1.5「Capability Broker」。
export interface WorkflowCapabilityPolicy {
  /** Workspace-relative globs readable by the Workflow. */
  readonly readableGlobs?: readonly string[];   // ← 通配符，如 ["src/**", "CMakeLists.txt"]
  /** Workspace-relative globs writable by the Workflow. */
  readonly writableGlobs?: readonly string[];   // ← 不填 = 什么都不许写
  /** Workspace-relative executable globs. Measured tools do not use this list. */
  readonly executableGlobs?: readonly string[];
  /** Empty means every measured host tool may be used. */
  readonly allowedTools?: readonly string[];    // ← 空数组 = 主机测到的工具全能用
  /** Environment override keys allowed for child processes. */
  readonly allowedEnv?: readonly string[];      // ← 允许覆盖哪些环境变量键
  readonly maxProcesses?: number;               // ← 同时能跑几个子进程
  readonly maxOutputBytes?: number;             // ← 单条命令输出上限（字节）
  readonly maxFileBytes?: number;               // ← 单个文件读写上限（字节）
}

// ── WorkflowFunction：workflow 源码必须导出的那个函数的类型────────────
// 【作用】`export default async (ctx) => { … }` 里的那个函数就长这样。
// 【语法】这是"函数类型"：`(参数: 类型) => 返回类型`。
//         注意 `unknown | Promise<unknown>`：unknown 是顶类型，任何类型和它联合
//         都会被它"吞掉"，所以这一行实际等价于 `(context: WorkflowContext) => unknown`。
//         写成两支只是为了让读者一眼看出"可以同步返回，也可以 async"。
// 【关系】worker.ts 动态 import 完模块后，检查导出的东西是不是这个类型
//         （运行时只能检查 typeof === "function"），然后调用它。
export type WorkflowFunction = (
  context: WorkflowContext,
) => unknown | Promise<unknown>;

// 【语法】下面的 WorkflowEvent 原文件缩进有些不规则（有的行多几个空格），
// 这是仓库里的原样，教程版一字未改 —— 缩进不影响 TS 语义。
 export interface WorkflowEvent {
   readonly id: string;
     // capability 一共 5 种，与 capability-protocol.ts 里 CapabilityRequest 的
     // capability 字段完全一致：文件 / 进程 / 工具 / 计划步骤 / 验收断言。
     readonly capability: "fs" | "process" | "tools" | "plan" | "validator";
   readonly method: string;              // ← 具体调了哪个方法，如 "readFile"、"run"
   readonly ok: boolean;                 // ← broker 放行且执行成功吗
   readonly durationMs: number;          // ← 这一次能力调用花了多少毫秒
   readonly error: string | null;        // ← 被拒/出错时的原因，成功时是 null
 }

/** A step declared by a workflow for observability. IDs are host-assigned. */
// ── WorkflowPlanStep：计划树上的一个"步骤"──────────────────────────
// 【作用】纯观测用途：workflow 用 ctx.plan.declare 声明"我要做哪几步"，宿主把它
//         画进 Dashboard，让人看得见构建进行到哪一步了。它不影响执行结果。
// 【关系】子进程只发声明/状态变化，真正的步骤树由主进程 broker 拼装（getPlan()）。
export interface WorkflowPlanStep {
  readonly id: string;                  // ← 步骤 id；可以由调用方给文本，也可以宿主生成
  readonly title: string;               // ← 显示名
  readonly description?: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly children?: readonly WorkflowPlanStep[];  // ← 可以嵌套成树
}

/** Tree of declared steps, assembled by the broker. */
export interface WorkflowPlan {
  readonly steps: readonly WorkflowPlanStep[];
}

/**
 * Declaration shape accepted by declare(). The caller MAY supply a globally
 * unique id (free-form text); when omitted the host assigns one. Supplied ids
 * are validated for uniqueness across the whole tree.
 */
// ── PlanStepDeclaration：declare() 接受的"声明形状"──────────────────
// 【与 WorkflowPlanStep 的区别】这个是"我要声明什么"（id 可省略），
// WorkflowPlanStep 是"宿主最终记录下来的样子"（id 一定有）。
export interface PlanStepDeclaration {
  readonly id?: string;                 // ← 可以不给，宿主按顺序生成
  readonly title: string;
  readonly description?: string;
  readonly children?: readonly PlanStepDeclaration[];
}

/** Worker-side plan declaration/marking object injected as context.plan. */
// ── WorkflowPlanApi：ctx.plan 的真面目──────────────────────────────
// 【作用】declare 一次性声明整棵树；之后用 begin/complete/fail 标记进度。
// 【坑】顺序由宿主状态机校验：没 declare 就 begin、重复 complete 都会报错。
// 🔗 见 零基础看懂教程.md §1.5「Capability Broker」里的 ctx.plan 条目。
export interface WorkflowPlanApi {
  /** Declare a step tree; returns the supplied ids (root ids in tree order). */
  declare(steps: readonly PlanStepDeclaration[]): Promise<readonly string[]>;
  begin(id: string): Promise<void>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}

// ── WorkflowPlanEvent：子进程发给宿主的"计划消息"────────────────────
// 【关系】它是 capability 协议 plan 能力的内部载荷之一，宿主据此更新步骤树。
export interface WorkflowPlanEvent {
  readonly type: "plan-declare" | "plan-begin" | "plan-complete" | "plan-fail";
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly error?: string;
}

/**
 * Expectation relations between baseline and candidate observations.
 * The workflow declares an expectation once; the host records the observed
 * value on each side (baseline/candidate) and compares them using the
 * relation semantics. The workflow never knows which side it runs on.
 */
// ── ExpectationRelation：两侧观测值之间允许的"关系"──────────────────
// 【作用】自驱动 TestWorkflow 的核心。同一份 TestWorkflow 源码会在 baseline
//         worktree 和 candidate worktree 各跑一遍，函数不知道自己在哪一侧；
//         它只管 ctx.expect("用例名", 值) 把观测值报上去，宿主把两侧按声明顺序
//         配对，再用这里的关系语义判定是否行为保持。
// 🔗 见 零基础看懂教程.md §1.5「两侧运行」与 src/workflow/expectation-compare.ts。
export type ExpectationRelation =
  | "equal"              // baseline === candidate
  | "not-equal"          // baseline !== candidate
  | "baseline-greater"   // baseline > candidate
  | "baseline-less"      // baseline < candidate
  | "both-matches";      // each side matches /regex/ (second arg of expect)

/** One expectation declaration: name + relation + observed value (this side). */
export interface ExpectationDeclaration {
  readonly name: string;                // ← 通常是测试用例名
  readonly relation: ExpectationRelation;
  /** Observed value on the current side (baseline or candidate). */
  readonly value: unknown;              // ← 本侧观测到的值（数字/字符串/布尔都行）
  /** For "both-matches": the regex source to match against. */
  readonly pattern?: string;            // ← 只有 both-matches 才需要
}

/** Worker-side expectation API injected as context.expect. */
// ── WorkflowExpectApi：ctx.expect 的真面目（重点！）──────────────────
// 【语法】这个接口里没有任何字段，只有 3 行"调用签名" —— 叫"可调用接口"
//         （callable interface），意思是：这个对象本身可以像函数一样被调用，
//         且有 3 种重载形式（TS 会按顺序挑第一个匹配的）：
//           ① (name, value)                                  → 关系默认 equal
//           ② (name, relation, value, pattern?)              → 显式给关系
//           ③ (declaration)                                  → 一次性传整个对象
// 【⚠️ 重要】expect 是【纯客户端本地收集】：调用它【不发任何 IPC 请求】，
//         只是往 client.ts 里的一个数组 push 一条记录，最后随 workflow-result
//         envelope 一次性带回宿主（见 client.ts 的 expectDeclaration 与
//         worker.ts 的 getExpectations()）。所以你在 events 里看不到 expect。
export interface WorkflowExpectApi {
  /**
   * Declare an expectation. The host compares the value observed on the
   * baseline side with the value observed on the candidate side.
   *
   * relation "equal" (default): both sides must be equal.
   * relation "both-matches": each side's value must match `pattern`.
   * relation "baseline-greater": baseline value must be > candidate value.
   * relation "baseline-less": baseline value must be < candidate value.
   */
  (name: string, value: unknown): void;
  (name: string, relation: ExpectationRelation, value: unknown, pattern?: string): void;
  (declaration: ExpectationDeclaration): void;
}

// ── WorkflowRunResult：runner.ts 的最终产出─────────────────────────
// 【作用】宿主侧（build-executor / test-executor / resolve-workflows / scripts/cli）
//         拿到的结果。注意这里的 status 是【整个 workflow 运行】的状态，
//         和 ProcessResult.status（单个子命令）不是一个东西。
// 【语法】这些字段没有 readonly —— 宿主侧的调用方有时要往结果上补信息。
export interface WorkflowRunResult {
  // pass      workflow 正常跑完且 envelope 说 ok
  // failed    跑崩了 / 退出码非 0 / envelope 报错 / spawn 失败
  // timeout   超过 options.timeoutMs 被强杀
  // rejected  连子进程都没启动 —— 源码静态检查（source-policy.ts）没通过
  status: "pass" | "failed" | "timeout" | "rejected";
  exitCode: number | null;
  result: unknown;                       // ← workflow 函数的返回值（声明式 workflow 在这里给对象）
  stdout: string;                        // ← 通道里"不属于协议"的脏行（见 runner.ts 的 protocolNoise）
  stderr: string;                        // ← 子进程 stderr（worker.ts 把 console 劫持到这里）
  failure: string | null;                // ← 失败原因，人读的字符串
  events: WorkflowEvent[];               // ← 本次运行所有能力调用记录（观测/审计用）
  plan: WorkflowPlan | null;             // ← 宿主拼装出的步骤树（超时/失败时也有，便于看死在哪）
  /** Expectation declarations collected during this run (this side's values). */
  expectations: ExpectationDeclaration[];  // ← 本侧（baseline 或 candidate）声明的期望
}
