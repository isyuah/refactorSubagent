/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/client.ts —— 子进程侧的"能力代理"（ctx 背后其实是发消息）
 *
 * 【这个文件是干什么的】
 *   workflow 作者写 `await ctx.fs.readFile("CMakeLists.txt")` 时，真正发生的事情是：
 *   这个文件造出来的代理对象把调用翻译成一条 JSON 报文
 *   {type:"capability-request", id:"c1", capability:"fs", method:"readFile", args:[…]}
 *   写到 stdout，然后【停下等】宿主把配对的回复写回 stdin，再把回复里的 value 还给你。
 *   对 workflow 作者来说完全像是本地函数调用 —— 这就是"代理"的全部意义。
 *
 * 【两个进程、一条 JSON 管道】
 *   本文件只跑在【子进程】里（被 worker.ts import）。它不知道宿主是谁，
 *   只认识一个 transport（能往 stdout 写一行）—— 真正干活的是主进程的
 *   LocalCapabilityBroker（capabilities.ts，不在本组）。
 *
 *   ┌─────────── 子进程 ───────────┐      ┌─────────── 主进程 ───────────┐
 *   │ workflow 函数                 │      │  LocalCapabilityBroker        │
 *   │   ↓ await ctx.fs.readFile     │      │   （有 node:fs、child_process）│
 *   │ client.call() → stdout 一行 → │ ───→ │  broker.handle(request)       │
 *   │   （pending Map 里挂起等待）    │ // ←─── │  ← stdin 一行 capability-…    │
 *   │ accept() → resolve 那个 Promise│      │   response（带 id 配对）       │
 *   └──────────────────────────────┘      └──────────────────────────────┘
 *
 * 【在本组里的位置】
 *   上游：worker.ts 调 createWorkflowContext() 造出 ctx，再交给 workflow 函数。
 *   下游：capability-protocol.ts（报文形状）、types.ts（接口形状）。
 *   测试：tests/workflow-capabilities.test.ts 直接对 policy 的越界行为做断言。
 *
 * 【先修知识】
 *   Promise / async-await / 类与 private 字段 / Map —— 本文件是这几个概念讲得最透的地方。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/client.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import type {
  CapabilityRequest,
  CapabilityResponse,
} from "./capability-protocol.js";
import type {
  ExpectationDeclaration,
  ExpectationRelation,
  WorkflowExpectApi,
} from "./types.js";
import type {
  CMakeAdapter,
  CompilerAdapter,
  CTestAdapter,
  NinjaAdapter,
  PlanStepDeclaration,
  ProcessHandle,
  ProcessResult,
  WorkflowAdapters,
  WorkflowCapabilities,
  WorkflowContext,
  WorkflowFacts,
  WorkflowFilesystem,
  WorkflowFsEffect,
  WorkflowFsSnapshot,
  WorkflowPlanApi,
  WorkflowProcess,
  WorkflowEvent,
  WorkflowTool,
  WorkflowTools,
  WorkflowValidator,
} from "./types.js";

// ── CapabilityClientTransport：唯一被允许的"对外通道"─────────────────
// 【作用】一个只有 send 一个方法的最小接口。子进程里除了它，什么宿主 API 都摸不到。
// 【语法】这是一个接口里只有一个"函数签名成员"的写法 —— 相当于定义
//         "一个能收 CapabilityRequest 的函数"。用接口而不用 type 别名，
//         是为了方便别人再扩展/实现。
// 【关系】worker.ts 传入的实现是：
//   `send: (request) => process.stdout.write(\`${JSON.stringify(request)}\n\`)`
//   —— 序列化成一行 JSON，再加一个换行（JSONL 的"行"就是这么来的）。
export interface CapabilityClientTransport {
  send(request: CapabilityRequest): void;
}

// ── PendingRequest：一次"还没回来的请求"的存根───────────────────────
// 【作用】请求发出去之后，Promise 不能凭空"补上"值，得有人握着它的 resolve/reject。
//         这两个函数被塞进 Map，等回复到达时再拿出来调用 —— 这是异步编程里
//         非常经典的"deferred"手法。
// 【语法】`resolve: (value: unknown) => void`：函数类型；调用它 = 把 Promise 变成"成功"。
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

// ── WorkflowCapabilityClient：本文件的主角──────────────────────────
// 【作用】三件事：
//   ① call()：发出请求、登记 pending、返回 Promise（所有能力的公共底层）；
//   ② accept()：收到回复，按 id 找到 pending，把对应的 Promise 唤醒；
//   ③ createCapabilities()：把 ctx.fs / ctx.process / … 这些对象造出来。
/** Worker-side capability proxy. It has no host API other than the transport. */
export class WorkflowCapabilityClient {
  // 【语法】`private readonly pending = new Map<string, PendingRequest>()`：
  //   - private：只有本类内部能访问（编译期检查）；
  //   - Map 是 JS 的哈希表，set(key, value) / get(key) / delete(key)，比普通对象
  //     更适合"键是运行时字符串"的场景（不用担心键名撞上原型链上的东西）。
  //   - ⚠️ 这就是"id 配对机制"的核心：请求发出去时 id→{resolve,reject} 进表，
  //     回复到达时用 response.id 取出来。取不到说明回复没对上号，直接丢弃。
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: WorkflowEvent[] = [];          // ← 攒观测记录，最后带回宿主
  private readonly expectations: ExpectationDeclaration[] = [];  // ← 攒 ctx.expect 声明
  private nextId = 1;                                     // ← 自增取件码，保证唯一

  // 【语法】★★★ 构造函数参数属性 ★★★
  //   `constructor(private readonly transport: CapabilityClientTransport) {}`
  //   在参数前写 private/readonly，TS 会自动帮你声明同名字段并赋值，
  //   等价于手写 `transport: CapabilityClientTransport;` + `this.transport = transport;`。
  //   函数体是空的 —— 语法糖而已。
  constructor(private readonly transport: CapabilityClientTransport) {}

  // ── accept：收到宿主回复时调用（worker.ts 的 consumeResponses 循环里）──────
  // 【作用】按 id 配对，唤醒等待中的 Promise。
  // 【参数】response：从 stdin 读到的一行，已经过 isCapabilityResponse() 校验。
  // 【关系】取不到 pending 时【静默丢弃】—— 可能是请求方已经放弃了（比如超时），
  //         晚到的回复不该把无关的 Promise 误唤醒。
  accept(response: CapabilityResponse): void {
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    this.events.push(response.event);            // ← 观测记录顺手存下来（审计/进度用）
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error(response.error ?? "capability request failed"));
    // ↑ 【语法】`??`（空值合并）：左边的值是 null 或 undefined 时才取右边。
    //   和 `||` 的区别：0、""、false 不会触发 ??，但会触发 ||。
  }

  // ── rejectAll：把所有还挂着的请求全部判死────────────────────────────
  // 【作用】两个调用时机：workflow 正常结束（worker.ts 里传 "workflow completed"）
  //         和 stdin 断了（"capability broker disconnected"）。
  //         不清掉的话这些 Promise 会永远挂着，子进程退出不了。
  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    // ↑ 【语法】for…of 遍历 Map 的 values() 迭代器。
    this.pending.clear();
  }

  getEvents(): WorkflowEvent[] {
    return [...this.events];
    // ↑ 【语法】`[...]` 展开成一个新数组 —— 返回副本，调用方改了也不会影响内部状态。
  }

  getExpectations(): ExpectationDeclaration[] {
    return [...this.expectations];
  }

  /** Local declaration: no IPC needed, host reads via envelope. */
  // ⚠️【重点】ctx.expect 的落点在这里：只是 push 进一个本地数组，
  //   【没有任何 IPC】。宿主是在收到 workflow-result envelope 时才一次性拿到全部
  //   声明（见 worker.ts 的 expectations: client.getExpectations()）。
  //   推论：如果你在 expect 之后提前 return、或者按 baseline/candidate 分支导致
  //   两侧声明数量不一致，宿主配对就会失败 —— 这是自驱动 TestWorkflow 最常见的坑。
  private expectDeclaration(declaration: ExpectationDeclaration): void {
    this.expectations.push(declaration);
  }

  // ── createCapabilities：把"七个能力"的对象字面量造出来────────────────
  // 【作用】这是 ctx.capabilities 里每个对象的真身。注意所有方法体都是同一个套路：
  //         `async (...) => await this.call(能力名, 方法名, [参数数组])`。
  // 【语法】对象字面量直接"实现"接口：TS 会检查每个方法签名是否匹配
  //         WorkflowFilesystem / WorkflowProcess 等接口，少写/写错参数都会报错。
  // 【语法】`async (path, encoding = "utf8") => …`：异步箭头函数 + 参数默认值。
  //         参数类型没写 —— TS 从接口方法签名里"上下文推断"出来，省得重复写。
  createCapabilities(): WorkflowCapabilities {
    const fs: WorkflowFilesystem = {
      readFile: async (path, encoding = "utf8") => await this.call("fs", "readFile", [path, encoding]) as string,
      // ↑ 行尾的 `as string`：call() 返回 Promise<unknown>，这里断言"我知道它是个字符串"。
      //   断言不会做运行时检查 —— 真正的检查在宿主 broker 和类型系统里。
      writeFile: async (path, content, encoding = "utf8") => { await this.call("fs", "writeFile", [path, content, encoding]); },
      mkdir: async (path) => { await this.call("fs", "mkdir", [path]); },
      exists: async (path) => await this.call("fs", "exists", [path]) as boolean,
      readdir: async (path) => await this.call("fs", "readdir", [path]) as string[],
      snapshot: async (path) => await this.call("fs", "snapshot", [path]) as WorkflowFsSnapshot,
      diff: async (path, before) => await this.call("fs", "diff", [path, before]) as WorkflowFsEffect[],
    };
    // ★ 新增 decodeProcess：把 base64 的 stdout/stderr 解码成明文一起放进结果——
    //   workflow 源码里写 result.stdout 就能直接用（不用自己 Buffer.from）。
    const decodeProcess = (result: ProcessResult): ProcessResult => ({
      ...result,
      stdout: Buffer.from(result.stdoutBase64, "base64").toString("utf8"),
      stderr: Buffer.from(result.stderrBase64, "base64").toString("utf8"),
    });
    const processCapability: WorkflowProcess = {
      run: async (spec) => decodeProcess(await this.call("process", "run", [spec]) as ProcessResult),
      start: async (spec) => await this.call("process", "start", [spec]) as ProcessHandle,
      wait: async (handle, timeoutMs) => decodeProcess(await this.call(
        "process",
        "wait",
        timeoutMs === undefined ? [handle] : [handle, timeoutMs],
      ) as ProcessResult),
      stop: async (handle) => decodeProcess(await this.call("process", "stop", [handle]) as ProcessResult),
    };
    const tools: WorkflowTools = {
      available: async (name) => await this.call("tools", "available", [name]) as boolean,
      list: async () => await this.call("tools", "list", []) as WorkflowTool[],
    };
    const plan: WorkflowPlanApi = {
      declare: async (steps: readonly PlanStepDeclaration[]) => await this.call("plan", "declare", [steps]) as string[],
      begin: async (id: string) => { await this.call("plan", "begin", [id]); },
      complete: async (id: string) => { await this.call("plan", "complete", [id]); },
      fail: async (id: string, error: string) => { await this.call("plan", "fail", [id, error]); },
    };
    const validator: WorkflowValidator = {
      assertFile: async (path, description) => {
        await this.call("validator", "assertFile", description === undefined ? [path] : [path, description]);
      },
      assertDir: async (path, description) => {
        await this.call("validator", "assertDir", description === undefined ? [path] : [path, description]);
      },
      assertAbsent: async (path, description) => {
        await this.call("validator", "assertAbsent", description === undefined ? [path] : [path, description]);
      },
    };
    // ── expect：ctx.expect 本体（一个普通函数，不是对象）───────────────
    // 【作用】把三种调用写法（见 types.ts 的可调用接口）归一成一条 ExpectationDeclaration。
    // 【语法】参数名体现它的尴尬处境：第一个参数既可能是字符串（写法①②），
    //         也可能整个就是声明对象（写法③），所以叫 nameOrDeclaration；
    //         第二个参数可能是关系字符串、也可能是值 —— TS 里没法用重载写一个实现，
    //         只能收宽类型再在函数体里自己分辨。
    // 【语法】`typeof maybeRelation === "string" && […].includes(maybeRelation)
    //          ? maybeRelation as ExpectationRelation : "equal"`：三目运算符。
    //         includes() 确认字符串确实是五个合法关系之一，然后才 as 成字面量联合类型。
    //         这一步是必要的：运行时根本没人检查你传的字符串对不对，这里就是检查点。
    const expect: WorkflowExpectApi = (
      nameOrDeclaration: string | ExpectationDeclaration,
      maybeRelation?: ExpectationRelation | unknown,
      maybeValue?: unknown,
      pattern?: string,
    ) => {
      if (typeof nameOrDeclaration === "string") {
        // (name, value) => equal; (name, relation, value, pattern?) => relation
        const relation = typeof maybeRelation === "string" &&
          ["equal", "not-equal", "baseline-greater", "baseline-less", "both-matches"].includes(maybeRelation)
          ? maybeRelation as ExpectationRelation
          : "equal";
        // ↑ 第二个参数是关系字符串时，值在第三个位置；否则第二个参数本身就是值。
        const value = typeof maybeRelation === "string" ? maybeValue : maybeRelation;
        // ↑【语法】条件展开：pattern 没传就不要往对象里放一个 undefined 字段。
        //   `...(条件 ? {} : { pattern })` —— 对象展开运算符把键"摊"进字面量。
        this.expectDeclaration({ name: nameOrDeclaration, relation, value, ...(pattern === undefined ? {} : { pattern }) });
      } else {
        this.expectDeclaration(nameOrDeclaration);
      }
    };
    return {
      fs,
      process: processCapability,
      tools,
      plan,
      validator,
      expect,
      adapters: createAdapters(processCapability),
    };
  }

  // ── call：所有能力共用的"发请求并等待"底层──────────────────────────
  // 【语法】`capability: CapabilityRequest["capability"]`：索引访问类型 ——
  //   "取 CapabilityRequest 接口里 capability 字段的类型"，也就是那 5 个字符串的联合。
  //   接口改了这里自动跟着改，不用复制粘贴。
  // 【语法】★★★ new Promise((resolve, reject) => { … }) ★★★
  //   Promise 的构造函数接收一个函数（叫 executor），它会被【立刻同步执行】，
  //   并拿到 resolve / reject 两个回调。Promise 从此进入"等待"状态，直到某个回调被调用。
  //   这个写法有个专有名字叫"Promise 化"（promisify）：把回调风格的东西变成 await 风格。
  // 【配对机制】① 生成 id（`c${String(this.nextId++)}` —— 模板字符串拼出自增编号）
  //             ② 把 resolve/reject 存进 pending 表
  //             ③ 才真正把报文写到 stdout（顺序不能反：万一写完立刻有回复，
  //                表里得已经有那条记录才行）
  //             ④ 失败时把表里的记录删掉再 reject，不留脏数据
  private call(capability: CapabilityRequest["capability"], method: string, args: unknown[]): Promise<unknown> {
    const id = `c${String(this.nextId++)}`;
    const request: CapabilityRequest = { type: "capability-request", id, capability, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.send(request);
      } catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
        // ↑【语法】instanceof：运行时判断"是不是这个类的实例"。
        //   throw 出来的东西不一定是 Error（JS 允许 throw 任何值），所以要兜底转成 Error。
      }
    });
  }
}

// ── createWorkflowContext：worker.ts 的唯一入口─────────────────────
// 【作用】一次调用造出两个东西：client（worker 要用它的 accept/rejectAll/getEvents）
//         和 context（交给 workflow 函数的那个 ctx）。
// 【语法】返回值类型写成内联对象类型 `{ readonly context: …; readonly client: … }`，
//         调用方解构出来用：`const { client, context } = createWorkflowContext(…)`。
// 【关系】注意 ctx 里既有 capabilities 整包、又有 7 个便利别名 —— 两次注释里都强调过：
//         它们是同一个对象，不是两套。
export function createWorkflowContext(options: {
  readonly workspaceRoot: string;
  readonly input: unknown;
  readonly facts: WorkflowFacts;
  readonly transport: CapabilityClientTransport;
}): { readonly context: WorkflowContext; readonly client: WorkflowCapabilityClient } {
  const client = new WorkflowCapabilityClient(options.transport);
  const capabilities = client.createCapabilities();
  return {
    client,
    context: {
      apiVersion: 1,
      workspaceRoot: options.workspaceRoot,
      input: options.input,
      facts: options.facts,
      capabilities,
      fs: capabilities.fs,
      process: capabilities.process,
      tools: capabilities.tools,
      adapters: capabilities.adapters,
      validator: capabilities.validator,
      plan: capabilities.plan,
      expect: capabilities.expect,
    },
  };
}

// ── createAdapters：把"拼命令行"包成好用的方法（私有函数，不导出）────────
// 【作用】四个适配器底层全是 process.run（也就是一条 capability-request），
//         它们存在的意义只是把 cmake/ninja/ctest/gcc 的参数拼法固定下来，
//         让 workflow 作者不用背命令行。
// 【语法】★ 闭包（closure）★：内层函数用到了外层的 processCapability 变量。
//   JS 里函数会"记住"它定义时能看到的外部变量 —— 这就是闭包。
//   `const run = (program, args, cwd?, timeoutMs?) => processCapability.run({…})`
//   造了一个缩小版 helper，后面 4 个适配器都靠它。
function createAdapters(processCapability: WorkflowProcess): WorkflowAdapters {
  const run = (program: string, args: readonly string[], cwd?: string, timeoutMs?: number): Promise<ProcessResult> =>
    processCapability.run({ program, args, cwd, timeoutMs });
  const cmake: CMakeAdapter = {
    configure: ({ sourceDir = ".", buildDir, generator, flags = [] }) => {
      // ↑【语法】★ 解构 + 默认值 ★：参数是一个对象，直接在参数位置把它拆成变量，
      //   没传的字段给默认值（sourceDir 缺省 "."，flags 缺省空数组）。
      const args = ["-S", sourceDir, "-B", buildDir];
      if (generator !== undefined) args.push("-G", generator);
      args.push(...flags);
      // ↑【语法】`...flags` 展开：把数组一个一个摊进 push 的参数列表。
      return run("cmake", args);
    },
    build: ({ buildDir, target, flags = [] }) => {
      const args = ["--build", buildDir];
      if (target !== undefined) args.push("--target", target);
      args.push(...flags);
      return run("cmake", args);
    },
  };
  const ninja: NinjaAdapter = {
    build: ({ buildDir = ".", target, flags = [] }) => {
      const args = ["-C", buildDir, ...flags];
      if (target !== undefined) args.push(target);
      return run("ninja", args);
    },
  };
  const ctest: CTestAdapter = {
    // configuration 默认 Debug：多配置生成器（如 Visual Studio）没有 -C 会挑不到产物。
    run: ({ buildDir, configuration = "Debug", args = [], timeoutMs }) =>
      run("ctest", ["--test-dir", buildDir, "-C", configuration, "--output-on-failure", ...args], ".", timeoutMs),
      // ↑ "--output-on-failure"：失败的用例把输出打出来，否则 CTest 只报通过与否。
  };
  const compiler: CompilerAdapter = {
    compile: ({ compiler = "gcc", args, cwd, timeoutMs }) => run(compiler, args, cwd, timeoutMs),
  };
  return { cmake, ninja, ctest, compiler };
}
