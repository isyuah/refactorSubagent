/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/build-workflow.ts —— BuildWorkflow 的解析 + 校验入口
 *
 * 【这个文件是干什么的】
 *   给它一个 BuildWorkflow 源码文件路径（entry），它会：做沙箱源码检查 →
 *   算 sha256 指纹 → 判断这份源码是"声明式"还是"自驱动" → （声明式才）真正
 *   执行一次拿到构建计划 → 用 Zod 校验计划里的身份和产物路径 → 生成一份
 *   manifest（登记信息）→ 返回 BuildWorkflowResolution。
 *   通俗说：**这是 workflow 源码从"一段文字"变成"程序可信事实"的关卡。**
 *
 * 【声明式 vs 自驱动 —— 全项目最关键的一个区分】
 *   BuildWorkflow 源码默认导出一个函数，它有两种形态：
 *   · 声明式（declarative）：函数**返回**一个结构化对象（CMake 参数、产物路径
 *     ……），例如 examples/workflows/libuv-build.ts。解析阶段就可以执行一次，
 *     把返回值当"构建计划"存起来，之后 execute 阶段照着计划重放。
 *   · 自驱动（workflow-driven）：源码顶层写 `export const workflowKind =
 *     "workflow-driven"`，函数**返回 void**，自己用注入的能力（ctx.adapters /
 *     ctx.process / ctx.validator / ctx.plan）把构建真正跑起来。
 *     ⚠️ 这种形态在 resolve 阶段**不执行**，返回的 output 是 null ——
 *     因为产物要等真正跑完构建才知道。身份和产物路径的校验被推迟到
 *     execute 阶段（src/workflow/build-executor.ts 里由 validator.assertFile
 *     完成）。这也解释了一个下游现象：AI 生成 TestWorkflow 时拿到的
 *     "Selected BuildWorkflow" 字面上就是 null（resolve-workflows.ts 直接
 *     JSON.stringify(build.output)），它只能自己去猜产物叫什么名字。
 *
 * 【在整个项目里的位置】
 *   上游（谁调用它）：
 *     · src/workflow/resolve-workflows.ts —— 三处调用：
 *         - 生成路径（generate）：AI 写完源码后立即 resolve 一次（:193）；
 *         - 用户提供路径（inspectProvidedBuild）：先 resolve 试水，失败则把
 *           该候选标成 invalid（:263）；
 *         - 注册表复用路径（resolveStoredBuild）：workflow-driven 的持久化
 *           output 是 null，所以必须重新 resolve 源码以重验身份（:314）。
 *     · src/agents/build-workflow.ts —— proposeBuildWorkflow()（结构化提案入口，
 *       ⚠️ 目前主流水线没有接它，属于"已建未通车"的代码）。
 *   下游（它调用谁 / 产出给谁）：
 *     · checkWorkflowSource()（source-policy.ts）—— 沙箱源码检查；
 *     · runWorkflow()（runner.ts）—— spawn 一个 bun 子进程去执行 workflow 源码
 *       （子进程里才是真正的 `await import(源码)` 动态导入，见 worker.ts）；
 *     · 返回值交给 registry.ts 的 saveBuildWorkflow() 持久化；
 *     · resolution.output 被 workflow-pipeline.ts 用来决定 EnvironmentSpec、
 *       能力 policy，并传给 build-executor.ts 的 executeBuildWorkflow()。
 *
 * 【先修知识】
 *   · src/artifacts/build-workflow.ts —— BuildWorkflowOutput / BuildWorkflowManifest
 *     两个 Zod Schema（本文件所有 .parse 的依据）；
 *   · src/workflow/source-policy.ts —— 为什么要禁 workflow 源码 import node:fs；
 *   · src/workflow/runner.ts / worker.ts / capabilities.ts —— 源码是怎么被执行的；
 *   · 《零基础看懂教程.md》§1.5 "BuildWorkflow / TestWorkflow"。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/build-workflow.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 【语法】`createHash` 来自 Node 的内置 crypto 模块。本项目的 hash 全用它算
//   sha256（不是 Bun.CryptoHasher——两个都行，这个文件选了 node:crypto）。
//   sha256 的用途：把源码文本压成一个 64 位十六进制"指纹"，存进 manifest。
//   以后再加载这份 workflow 时重算一次指纹比对，就能发现"源码被人改过了"。
import { createHash } from "node:crypto";
// 【语法】node:path 的几个路径工具：
//   resolve(a, b) 把相对路径拼成绝对路径（并整理掉 ../ 和多余的 ./）；
//   isAbsolute(p) 判断是不是绝对路径；normalize(p) 整理路径但不一定转绝对；
//   relative(from, to) 算 to 相对于 from 的"回头路"（用于判断是否逃出根目录）；
//   sep 是当前平台的路径分隔符（Windows 是 "\\"，Linux/macOS 是 "/"）。
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
// 【语法】这一段 import 是理解本文件的关键，值得一字一句看：
//   同一个名字被引入了两次，却互不冲突——
//     `BuildWorkflowManifest` / `BuildWorkflowOutput` 不带 type 前缀，引入的是
//       **Zod Schema（运行时真实存在的值）**，用来 .parse() 校验数据；
//     `type BuildWorkflowManifest as BuildWorkflowManifestValue` 引入的是
//       **TS 类型（编译后就不存在了）**，用来给变量/字段做类型标注。
//   Zod 有个很实用的能力：从 Schema 自动推断出 TS 类型（z.infer<typeof Schema>），
//   所以 src/artifacts/*.ts 里每个 Schema 都顺手 `export type X = z.infer<...>`，
//   这里才能用同一个名字既拿 Schema 又拿类型。`as` 是给 import 起别名。
//   只有类型用 `type ... from` 引入，编译后这一行会被删掉（零运行时成本）。
import {
  BuildWorkflowManifest,
  BuildWorkflowOutput,
  type BuildWorkflowManifest as BuildWorkflowManifestValue,
  type BuildWorkflowOutput as BuildWorkflowOutputValue,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import { checkWorkflowSource } from "./source-policy.js";
import { runWorkflow } from "./runner.js";
import type { WorkflowCapabilityPolicy, WorkflowFacts } from "./types.js";

// ── ResolveBuildWorkflowOptions：调用方要传什么 ───────────────────────
// 【语法】interface 里所有字段都带 `readonly`：告诉使用者"这个对象我不会改你
//   的字段"。字段后面的 `?` 表示可选（可以不传，此时值是 undefined）。
export interface ResolveBuildWorkflowOptions {
  /** Workflow module path, relative to entryRoot when not absolute. */
  // ← workflow 源码的路径。相对路径时相对 entryRoot 解析；绝对路径就直接用。
  readonly entry: string;
  /** Optional expected identity; generated/provided workflows may establish it themselves. */
  // ← 期望的 workflow id。⚠️ 可选：只有"外部指定了身份"的调用方才传。
  //   AI 现场生成的 workflow 身份是它自己在返回值里定的，宿主无从预知，
  //   所以那条路径不传 workflowId（此时返回值里的 id 就被照单全收）。
  readonly workflowId?: string;
  // ← 期望的 revision（版本号，正整数）。与 workflowId 一对，同样可选。
  readonly revision?: number;
  /** Backward-compatible root for the workflow and target project. */
  // ← 兜底根目录：不传 entryRoot / workspaceRoot 时都用它。
  readonly cwd: string;
  /** Root that contains the workflow source. Defaults to cwd. */
  // ← workflow 源码所在的根，entry 的相对路径以它为基准（默认 = cwd）。
  readonly entryRoot?: string;
  /** Target project exposed through workflow capabilities. Defaults to cwd. */
  // ← 被构建的目标工程根目录（声明式执行时它就是子进程的工作目录）。
  readonly workspaceRoot?: string;
  // ← 程序实测的主机事实（平台 / 架构 / 工具在不在）。可选。
  readonly host?: HostPreflight;
  // ← 程序实测的项目事实（构建系统 / marker 文件）。可选。
  readonly project?: ProjectDetection;
  /** Capability policy for the workflow run; defaults to host defaults. */
  // ← 能力白名单：workflow 子进程能读哪些 glob、能调哪些工具……
  //   不传就用 host 默认值（见 capabilities.ts）。
  readonly policy?: WorkflowCapabilityPolicy;
  // ← 超时（毫秒！）。不传默认 60_000（即 60 秒，_ 是数字分隔符，纯为了可读）。
  readonly timeoutMs?: number;
}

// ── BuildWorkflowResolution：解析结果 ─────────────────────────────────
// 【作用】resolve 的产出物，四样东西：源码绝对路径、manifest、构建计划、指纹。
export interface BuildWorkflowResolution {
  /** Absolute source entry used to produce this resolution. */
  // ← 解析时用的源码绝对路径（后面 registry 存档时会再读它一次）。
  readonly entry: string;
  // ← 登记信息（id / revision / 入口相对路径 / 源码指纹 / 适用环境）。
  readonly manifest: BuildWorkflowManifestValue;
  /**
   * Declarative build plan. Null for workflow-driven workflows: the output
   * is only known after the function executes (during execute), so
   * resolution records null and execute validates identity + artifacts.
   */
  // ← 构建计划（声明式才有）。⚠️ 自驱动 = null，这是本文件最重要的字段：
  //   所有下游代码都要处理"output 可能是 null"（workflow-pipeline.ts 就在
  //   output === null 时手工拼了一个 workflow-driven 的 EnvironmentSpec）。
  readonly output: BuildWorkflowOutputValue | null;
  // ← 源码 sha256 指纹，manifest 里也存了一份。
  readonly sourceHash: string;
}

/** Run a BuildWorkflow and validate its compatibility-bridge output. */
// ── resolveBuildWorkflow：本文件的唯一导出函数 ─────────────────────────
// 【作用】跑一遍 BuildWorkflow（声明式才真的跑）并校验它的产出。
// 【语法】`async function` + `Promise<...>`：异步函数，内部可以有 await，
//   调用方必须也用 await 等它。返回的 Promise<T> 表示"未来会有一个 T"。
// 【关系】被 resolve-workflows.ts 三处调用（见文件头）；内部调用
//   checkWorkflowSource → runWorkflow → BuildWorkflowOutput.parse。
//   任何一步不合法都直接 throw（**fail-closed**：解析不出来就报错，
//   上游 resolve-workflows 会把这个候选标记为 invalid，绝不"先放着"）。
export async function resolveBuildWorkflow(
  options: ResolveBuildWorkflowOptions,
): Promise<BuildWorkflowResolution> {
  // 第 1 步：确定两个根目录。entryRoot 是"源码相对于谁"，workspaceRoot 是
  //   "workflow 被授权操作的项目在哪"。两者默认都退回 cwd。
  // 【语法】`??` 是空值合并：左边是 null 或 undefined 才取右边。
  //   和 `||` 的区别在于 0 / "" / false 也算"有值"，不会被 || 误判成空。
  const entryRoot = resolve(options.entryRoot ?? options.cwd);
  // 第 2 步：把 entry 变成绝对路径，并确认它没逃出 entryRoot。
  const entry = absoluteWithin(options.entry, entryRoot, "workflow entry");
  // 第 3 步：沙箱源码检查（source-policy.ts）：
  //   · 文件存在、后缀是 .ts/.tsx/.js/.jsx；
  //   · 文本里不许出现 node:/bun: 的 import、裸 process.xxx、Bun.xxx 等——
  //     workflow 是不可信代码，想读文件/跑命令必须走注入的能力；
  //   · 用 Bun.Transpiler 试转译一遍，保证语法能编译。
  // 【语法】checked 的类型是 WorkflowSourceCheck = { ok, source, reason }，
  //   这是"可辨识联合"式返回：用 ok 这个字段区分成功/失败两种形态。
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) throw new Error(checked.reason ?? "build workflow source rejected");

  // 第 4 步：算源码指纹（后面写进 manifest，加载时用来防篡改）。
  const sourceHash = sha256(checked.source);
  const workspaceRoot = resolve(options.workspaceRoot ?? options.cwd);
  // workflow-driven workflows are executed only once, during execute, so
  // resolution neither runs the function nor extracts a plan: the output is
  // null until the function produces it. Declarative workflows run here
  // (pure, no side effects) to obtain the plan the executor replays.
  // A workflow-driven workflow declares its mode explicitly (export const
  // workflowKind = "workflow-driven"); the host does not guess from source
  // text. Declarative workflows export workflowKind = "declarative" or omit it.
  // 第 5 步：⚠️ 探测形态。用一条正则去**源码文本**里找
  //   `export const workflowKind = "workflow-driven"`（单引号双引号都认）。
  //   注意两点：
  //   · 为什么在文本上探测而不是先 import 再看导出值？因为探测必须发生在
  //     执行之前——自驱动 workflow 一旦 import 并调用就会真的开始构建，
  //     而 resolve 阶段我们只想"看一眼、不干活"。
  //   · 正则里 \s+ 允许任意空白，但**这行字必须原样出现在源码里**（skill
  //     文档 .claude/plugins/.../build-output.md 明确要求写在顶层）。
  //     上方英文注释说的 "the host does not guess from source text" 指的是：
  //     模式由作者**显式声明**、宿主不做行为推断——这条正则只是宿主读取
  //     那份声明的方式，不是在猜。
  const isWorkflowDriven = /export\s+const\s+workflowKind\s*=\s*["']workflow-driven["']/.test(checked.source);
  let output: BuildWorkflowOutputValue | null = null;
  if (!isWorkflowDriven) {
    // 第 6 步：声明式 —— 真的执行一次，把返回值当构建计划。
    //   执行方式（runner.ts）：spawn 一个 `bun run worker.ts <entry> <cwd>`
    //   子进程，worker.ts 里 `await import(源码)` 动态加载它、调用默认导出的
    //   函数；子进程没有 node:fs / child_process，读文件、跑 cmake 都要通过
    //   JSONL 协议向主进程的 Broker 申请，Broker 按 policy 放行。
    //   【语法】`await import(…)` 就是"动态 import"：普通 import 写在文件顶部、
    //   启动时就加载；动态 import 在运行时按需加载并返回一个 Promise。
    //   本文件不直接做动态 import，那是 worker.ts 的职责，这里只负责发起。
    const facts: WorkflowFacts = { host: options.host, project: options.project };
    const result = await runWorkflow({
      entry,
      cwd: workspaceRoot,
      input: { kind: "build-workflow-input", version: 1 },
      facts,
      policy: options.policy,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    // runWorkflow 不抛异常，而是把结果归为 pass / failed / timeout / rejected
    //   四种状态；不是 pass 就说明执行失败（语法错、断言失败、超时……），
    //   把 failure 原因抛出去，让上游把这个候选判死。
    if (result.status !== "pass") {
      throw new Error(`build workflow failed: ${result.failure ?? result.status}`);
    }
    // 第 7 步：Zod 校验返回值。Zod 像"海关安检"：数据必须完全符合 Schema
    //   才放行（通过时返回带类型的干净数据），否则抛错。这一步同时把
    //   "AI 随手返回的对象" 变成 "程序可以放心读字段的结构化事实"。
    output = BuildWorkflowOutput.parse(result.result);
  }
  // 第 8 步：身份与产物路径校验。⚠️ 整块都包在 `output !== null` 里——
  //   自驱动 workflow 在这里什么都不验，验的部分留给 execute 阶段。
  if (output !== null) {
    // 8a：调用方如果指定了期望的 id / revision，就必须严丝合缝。
    //   （例如注册表里存的 id 是 X@2，加载回来的源码却自称 Y@3 → 拒绝。）
    if (options.workflowId !== undefined && output.workflow_id !== options.workflowId) {
      throw new Error(
        `build workflow id mismatch: expected '${options.workflowId}', got '${output.workflow_id}'`,
      );
    }
    if (options.revision !== undefined && output.workflow_revision !== options.revision) {
      throw new Error(
        `build workflow revision mismatch: expected ${String(options.revision)}, got '${output.workflow_revision}'`,
      );
    }
    // 8b：output 自称的身份必须和它里面 artifact 的身份一致。
    //   （防止"外层说自己是 X@1，里面产物却写着 Y@2"的错位。）
    if (
      output.artifact.workflow_id !== output.workflow_id ||
      output.artifact.workflow_revision !== output.workflow_revision
    ) {
      throw new Error("build artifact identity does not match workflow output identity");
    }
    // 8c：产物路径必须是 workspace 相对路径、且不许逃出 workspace。
    //   【语法】Object.values(对象) 取出所有值；paths 的类型是
    //   Record<名字, 路径>，比如 { shared_tests: "build/uv_run_tests", ... }。
    for (const path of Object.values(output.artifact.paths)) assertWorkspaceRelative(path);
  }

  // 第 9 步：生成 manifest（登记信息）。
  //   自驱动的场合 output 为 null，id / revision 只能取调用方给的（或兜底值）；
  //   声明式的场合以 workflow 自己申报的身份为准。
  // 【语法】`条件 ? A : B` 三元表达式，嵌套两层时建议从外往里读。
  const manifestId = output === null
    ? (options.workflowId ?? "workflow-driven")
    : output.workflow_id;
  const manifestRevision = output === null
    ? (options.revision ?? 1)
    : output.workflow_revision;
  // 【语法】`.parse(...)` 校验并返回带类型的数据；字段缺失但有 .default() 的
  //   会被自动补上默认值（比如 status 不传就是 "draft"）。
  // 【细节】entry 存的是**相对于 entryRoot 的路径**，并且把 Windows 的反斜杠
  //   统一替换成正斜杠（`.split(sep).join("/")`），这样 manifest.json 在不同
  //   平台之间长得一样、可比较。
  const manifest = BuildWorkflowManifest.parse({
    kind: "build-workflow-manifest",
    version: 1,
    id: manifestId,
    revision: manifestRevision,
    entry: relative(entryRoot, entry).split(sep).join("/"),
    source_hash: sourceHash,
    workflow_api_version: 1,
    // applies_to 描述"这份 workflow 适用于什么环境"，注册表的 discover 阶段
    //   拿它和当前 host/project 比对，决定能否复用（见 registry.ts 的
    //   compatibilityReasons）。这里能填多少填多少：实测到的构建系统、
    //   marker、平台、架构、以及这个计划真正需要的工具。
    applies_to: {
      build_systems: options.project?.build_systems ?? [],
      markers: options.project?.markers ?? [],
      platforms: options.host ? [options.host.platform] : [],
      architectures: options.host ? [options.host.arch] : [],
      required_tools: output === null ? [] : requiredTools(output),
    },
    status: "draft",
  });
  // 【关系】返回值接下来通常被 saveBuildWorkflow() 存进 .refactorsa/ 注册表，
  //   或被 workflow-pipeline.ts 拿去执行。
  // ⚠️ status 永远是 "draft"：本项目目前没有任何机制把它晋级成 "verified"
  //   （分析文档 3.5-3 提过这个缺口——复用一个从未验证过的 workflow 与
  //   fail-closed 哲学有张力）。
  return { entry, manifest, output, sourceHash };
}

// ── requiredTools：从构建计划里提炼"需要哪些命令行工具" ────────────────
// 【作用】给 manifest.applies_to.required_tools 提供数据，注册表据此判断
//   "这台机器装没装 cmake / ninja / 编译器"，装不上就判 incompatible。
// 【语法】`if (!("kind" in build)) return []` —— `in` 运算符判断对象有没有
//   某个字段。environment.build 是个联合类型（cmake / ninja / direct-compiler /
//   workflow-driven…），不同形态字段不同，`in` 是 TS 里收窄联合类型的标准手段。
function requiredTools(output: BuildWorkflowOutputValue): string[] {
  const build = output.environment.build;
  if (!("kind" in build)) return [];
  if (build.kind === "direct-compiler") return [build.compiler];
  if (build.kind === "cmake") return ["cmake"];
  if (build.kind === "ninja") return ["ninja"];
  // workflow-driven 或其他形态：宿主无法静态判断需要什么工具，返回空数组
  //   表示"不设限"（注册表不会因此拒掉它）。
  return [];
}

// ── absoluteWithin：把路径转绝对，并确保它没逃出 root ──────────────────
// 【作用】安全检查：`../../etc/passwd` 这种"往上翻目录"的写法会被直接拒绝。
// 【参数】label 只用于报错信息（告诉调用方是哪个字段越界了）。
// 【语法】relative(base, absolute) 算出"从 base 走到 absolute 的相对路径"：
//   如果结果是以 .. 开头（或是 ".." 本身、或根本不在同一个盘成了绝对路径），
//   说明目标在 base 之外。
function absoluteWithin(entry: string, root: string, label: string): string {
  const base = resolve(root);
  const absolute = isAbsolute(entry) ? normalize(entry) : resolve(base, entry);
  const rel = relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes root: ${entry}`);
  }
  return absolute;
}

// ── assertWorkspaceRelative：产物路径必须是 workspace 内的相对路径 ─────
// 【作用】构建产物路径（如 "build/uv_run_tests"）会被下游拿去断言文件存在、
//   甚至拼进命令行。如果不限制成相对路径，一个绝对路径或 ../ 开头的路径
//   就能让 workflow 指到 workspace 之外的任意文件。这是路径层面的第二道锁。
// ⚠️ 只拦了 `..` 开头和绝对路径，不拦 "build/../secret" 这类中间夹带 ——
//   不过 normalize 之后后者会变成 "secret"，依然在 workspace 内部，风险可控。
function assertWorkspaceRelative(path: string): void {
  if (isAbsolute(path)) throw new Error(`build artifact path must be relative: ${path}`);
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`build artifact path escapes workspace: ${path}`);
  }
}

// ── sha256：算源码指纹 ────────────────────────────────────────────────
// 【语法】Node 风格的链式调用：createHash("sha256") 选算法 → .update(内容,
//   "utf8") 喂数据 → .digest("hex") 输出十六进制字符串（64 个字符）。
// 【关系】registry.ts / test-registry.ts / test-workflow.ts 各有一份一模一样的
//   私有实现（本项目刻意不抽公共工具，让每个文件自包含）。
function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
