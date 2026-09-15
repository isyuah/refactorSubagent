/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/capability-protocol.ts —— 两个进程之间那条"管道"的报文格式
 *
 * 【这个文件是干什么的】
 *   定义主进程（宿主）和 workflow 子进程之间通信的三种"信封"：
 *     ① CapabilityRequest   子进程 → 宿主："我要读文件 / 跑 cmake / 断言产物"
 *     ② CapabilityResponse  宿主 → 子进程："可以 / 不可以，结果是这个"
 *     ③ WorkerEnvelope      子进程 → 宿主：workflow 跑完了（或崩了），最终交账
 *   每条报文都是一行 JSON，后面跟一个换行 —— 这种"一行一个 JSON"的格式叫 JSONL。
 *   为什么要一行一个？因为管道是流式的，两个进程没有"消息边界"这个概念，
 *   按行切分是最简单可靠的分帧方式（见 runner.ts / worker.ts 里两处按 \n 切的循环）。
 *
 * 【在整个项目里的位置】
 *   谁用 Request：client.ts 造（子进程侧）、runner.ts 收到后交给 capabilities.ts 的
 *                 LocalCapabilityBroker.handle() 处理。
 *   谁用 Response：capabilities.ts 造（宿主侧）、worker.ts 收到后喂给 client.accept()。
 *   谁用 Envelope：worker.ts 造（成功/失败各一处）、runner.ts 认领后转成 WorkflowRunResult。
 *   下游 artifact：Envelope 里的 events / expectations 最终进了构建/测试结果 artifact。
 *
 * 【本文件还有一个任务】类型守卫（type guard）
 *   管道上来的只是"一行 JSON 解析出来的 unknown"，宿主必须先确认它真是合法请求
 *   才能执行（fail-closed：看不懂的行绝不执行，扔进 protocolNoise 留档）。
 *   下面三个 isXxx 函数就是干这个的 —— 它们是全项目讲 TypeScript "类型谓词"语法
 *   最集中的地方。
 *
 * 【先修知识】src/workflow/types.ts（WorkflowEvent / ExpectationDeclaration /
 *   WorkflowCapabilityPolicy 都从这里 import）。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/capability-protocol.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import type {
  ExpectationDeclaration,
  WorkflowCapabilityPolicy,
  WorkflowEvent,
  WorkflowFacts,
} from "./types.js";

// ── WorkerPayload：宿主开机时递给子进程的"第一行"────────────────────
// 【作用】runner.ts spawn 子进程后，第一件事就是往它的 stdin 写一行 JSON：
//         { input, facts, policy }。子进程 worker.ts 读这第一行来组装 ctx。
// 【关系】worker.ts 用 isPayload() 检查这行的形状（不是本文件的守卫，是 worker 自己的）。
export interface WorkerPayload {
  readonly input: unknown;                       // ← 宿主传给 workflow 的业务数据
  readonly facts: WorkflowFacts;                 // ← 主机/项目测量事实
  readonly policy?: WorkflowCapabilityPolicy;    // ← 权限清单（可读/可写/工具白名单…）
}

// ── CapabilityRequest：子进程向宿主发的"申请单"──────────────────────
// 【语法】`type: "capability-request"`：字段类型是一个字符串字面量。这叫"可辨识字段"
//         —— 拿到一条 unknown 消息时，先看它的 type 字段是哪个值，就知道整条消息
//         该按哪个接口去解读。三种报文在这里的 type 取值都不同。
// 【关系】id 是配对用的"取件码"：子进程发请求时给个自增编号，宿主回复时原样带回，
//         子进程靠它把"哪条回复对应哪个 Promise"对上号（见 client.ts 的 pending Map）。
export interface CapabilityRequest {
  readonly type: "capability-request";
  readonly id: string;
  // capability 决定宿主里走哪个 dispatch 分支（capabilities.ts 的 dispatch()），
  // 取值与 types.ts 的 WorkflowEvent.capability 完全一致。
  readonly capability: "fs" | "process" | "tools" | "plan" | "validator";
  readonly method: string;      // ← 具体方法名，如 "readFile"、"run"、"assertFile"
  readonly args: unknown[];     // ← 参数数组。注意全是 unknown：宿主要自己再校验一遍
}

// ── CapabilityResponse：宿主回给子进程的"答复单"─────────────────────
// 【语法】`value?: unknown`：可选属性。成功时才有 value，失败时才有 error ——
//         但接口层面没法表达"ok 为 true 才准有 value"，所以下面 isCapabilityResponse
//         里会做一点补充检查。capabilities.ts 里造对象时用的是展开写法：
//         `...(ok ? { value } : { error })`，保证二选一。
export interface CapabilityResponse {
  readonly type: "capability-response";
  readonly id: string;          // ← 原样带回请求的 id，子进程靠它配对
  readonly ok: boolean;         // ← broker 放行且执行成功吗
  readonly value?: unknown;     // ← 成功时的返回值（文件内容 / ProcessResult / 布尔…）
  readonly error?: string;      // ← 失败原因（被 policy 拒绝、文件不存在、命令失败…）
  readonly event: WorkflowEvent;  // ← 一条观测记录（id/能力/方法/耗时/是否成功），
                                  //    子进程会攒起来，最后随 envelope 交回宿主
}

// ── WorkerEnvelope：子进程的"最终交账"──────────────────────────────
// 【语法】这是一个【联合类型】（`A | B`）：值要么是上面那个形状（ok: true），
//         要么是下面那个形状（ok: false）。两个分支都有 type: "workflow-result"，
//         但成功分支有 result、失败分支有 error。使用方（runner.ts）先看 ok，
//         TS 就知道该读哪个字段 —— 和 types.ts 里 WorkflowReadyProbe 是同一套思路，
//         区别只是这次靠布尔字段 ok 来"辨识"，而 WorkflowReadyProbe 靠字符串 kind。
// 【⚠️ 关键】expectations 就是 ctx.expect 收集的期望声明。它是纯客户端本地攒出来的
//         （没有 IPC，见 client.ts 的 expectDeclaration），最后搭这班车一次性带回宿主。
export type WorkerEnvelope =
  | {
      readonly type: "workflow-result";
      readonly ok: true;                       // ← 字面量 true：成功分支
      readonly result: unknown;                // ← workflow 函数的返回值（可能为 null）
      readonly events: WorkflowEvent[];        // ← 这次运行所有能力调用的观测记录
      readonly expectations?: ExpectationDeclaration[];
    }
  | {
      readonly type: "workflow-result";
      readonly ok: false;                      // ← 失败分支
      readonly error: string;                  // ← 异常消息（人读的）
      readonly events: WorkflowEvent[];
      readonly expectations?: ExpectationDeclaration[];
    };

// ── isCapabilityRequest：类型守卫之一───────────────────────────────
// 【作用】判断"这行 JSON 解析出来的东西"是不是一条合法的能力申请。
// 【语法】★★★ 类型谓词（type predicate）★★★
//         `function isX(value: unknown): value is CapabilityRequest`
//         返回类型不写 boolean，而写 `value is CapabilityRequest`。
//         意思是："这个函数返回 true 时，请你（编译器）把 value 当成 CapabilityRequest"。
//         效果：
//             if (isCapabilityRequest(value)) {
//               value.capability   // ← 这里 TS 知道一定有这个字段，不报错
//             }
//         如果写成普通 boolean 返回，上面的 value 仍然是 unknown，取字段会报错。
//         本质上它是在"运行时检查"和"编译期收窄类型"之间架桥。
// 【语法】`value as Record<string, unknown>`：类型断言（as）。unknown 没法直接
//         取字段，这里断言它是"键为 string、值为 unknown 的对象"。
//         as 是程序员拍胸脯说"信我"，运行时不做任何检查 —— 所以断言前必须先
//         用 typeof value === "object" && value !== null 验过（注意 JS 里
//         typeof null 也是 "object"，所以要额外排除 null）。
// 【语法】`Array.isArray(record.args)`：运行时判断"是不是数组"，顺带把类型收窄成数组。
// 【关系】runner.ts 的 stdout 循环里第一个调用的就是它；不匹配的行进 protocolNoise。
export function isCapabilityRequest(value: unknown): value is CapabilityRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "capability-request" &&
    typeof record.id === "string" &&
    (record.capability === "fs" || record.capability === "process" || record.capability === "tools" || record.capability === "plan" || record.capability === "validator") &&
    typeof record.method === "string" &&
    Array.isArray(record.args);
}

// ── isCapabilityResponse：类型守卫之二──────────────────────────────
// 【作用】子进程侧用。worker.ts 从 stdin 读到一行，先问它是不是一条合法回复，
//         不是就静默丢掉（parseCapabilityResponse 返回 null）。
// 【语法】`!Object.hasOwn(record, "error")`：Object.hasOwn(o, key) 判断对象【自身】
//         有没有这个键（不看原型链），ES2022 的新写法，等价于老的
//         Object.prototype.hasOwnProperty.call(o, key)。
//         这行整体表达："要么根本没带 error 字段，要么带的是 undefined 或字符串"。
// 【关系】它还递归调用了下面的 isWorkflowEvent —— 回复里附带的 event 也要验。
export function isCapabilityResponse(value: unknown): value is CapabilityResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "capability-response" &&
    typeof record.id === "string" &&
    typeof record.ok === "boolean" &&
    isWorkflowEvent(record.event) &&
    (!Object.hasOwn(record, "error") || record.error === undefined || typeof record.error === "string");
}

// ── isWorkerEnvelope：类型守卫之三（宿主侧最关键的判据）────────────────
// 【作用】runner.ts 靠它区分"这条 lines 是普通请求还是最终结果"。
// 【语法】`if (record.ok) return true;` —— 因为 ok 是字面量 true/false 的联合，
//         TS 在这个 if 为真时把 record 收窄成"ok: true 那个分支"，成功分支不需要
//         error 字段，所以直接放行；失败分支再单独检查 error 必须是字符串。
// 【关系】注意它【不】校验 expectations 的元素形状（只要求 events 合法）。
//         宿主拿到 expectations 之后，真正做配对比较的是 expectation-compare.ts。
export function isWorkerEnvelope(value: unknown): value is WorkerEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "workflow-result" || typeof record.ok !== "boolean") return false;
  if (!isWorkflowEvents(record.events)) return false;
  if (record.ok) return true;
  return typeof record.error === "string";
}

// ── isWorkflowEvents / isWorkflowEvent：私有校验器──────────────────
// 【语法】`value.every(isWorkflowEvent)`：every 对数组每个元素调用一次谓词函数，
//         全部为真才返回真。这里直接把类型守卫函数当参数传进去 —— 这也是
//         TS 能"顺带收窄"的原因（Array<T>.every 的签名用了类型谓词）。
// 【这两个函数没有 export】它们只是上面三个守卫的内部工具。
function isWorkflowEvents(value: unknown): value is WorkflowEvent[] {
  return Array.isArray(value) && value.every(isWorkflowEvent);
}

// 【作用】逐字段核对 WorkflowEvent 的形状。这些检查看起来啰嗦，但它们是
//         fail-closed 的肉：管道对面是不可信的子进程，一行脏数据混进来
//         就可能把观测记录污染掉。
// 【语法】`(record.error === null || typeof record.error === "string")`：
//         允许两种取值 —— 明确的 null，或者一个字符串。别的（比如 undefined、数字）都不行。
function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" &&
    (record.capability === "fs" || record.capability === "process" || record.capability === "tools" || record.capability === "plan" || record.capability === "validator") &&
    typeof record.method === "string" &&
    typeof record.ok === "boolean" &&
    typeof record.durationMs === "number" &&
    (record.error === null || typeof record.error === "string");
}
