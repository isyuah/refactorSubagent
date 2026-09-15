/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/agents/dep-registry.ts —— B 方案"声明制依赖"的账本（纯逻辑核心）
 *
 * 【这个文件是干什么的】
 *   老方案里"这次跑哪几个 build 工作流"是宿主先决定好、再把 id 塞进提示词让
 *   AI 照抄。B 方案（docs/b-subagent-workflow.md）反过来：让写测试的 AI 会话
 *   自己查、自己声明。这个文件就是会话背后那本账本，只管三件事：
 *     1) 查（inspect）：库里已有哪些 build workflow（.refactorsa/ 里验证过的）
 *        + 本次 run 现场新造的（.refactor/runs/<会话id>/workflows/build/）；
 *     2) 记（declare）：test-writer 声明"我的测试依赖这几个 build id"；
 *     3) 造（generate）：把 AI 交来的 build workflow 源码做安检后写到 run 目录。
 *   关键点：本文件没有一行调用 Claude 的代码 —— 它是纯逻辑，可以用 bun test
 *   直接单测（tests/dep-registry.test.ts 就是这么做的）。把它"包成 AI 能点
 *   的按钮"是 dep-registry-server.ts 的活。
 *
 * 【关系图：四个新文件怎么咬合（B 方案时序 WORKFLOW_GENERATION → BUILD → TEST）】
 *
 *   workflow-agent-pipeline.ts（宿主，就是普通 TS 代码）
 *     │
 *     ├─ runWorkflowSession()             ← workflow-session.ts：开一个 Claude 会话
 *     │    ├─ new LocalDependencyRegistry(...)      ← 本文件：账本（宿主进程内）
 *     │    ├─ createDependencyMcpServer({ registry })  ← dep-registry-server.ts
 *     │    │    └─ 同一本账本被包成 3 个 MCP 工具，在会话里叫
 *     │    │       mcp__dep-registry__inspectWorkflow / declareDependency /
 *     │    │       generateBuildWorkflow
 *     │    │            ├─ test-writer（主 agent）调用：查清单 + 声明依赖
 *     │    │            └─ build-writer（子代理）调用：交出 build 源码
 *     │    │               （子代理定义在 build-writer.ts，它没有 Write/Bash）
 *     │    └─ 会话结束后：宿主从账本读"声明了哪些 id / test 文件写了没"
 *     │
 *     └─ 会话合格后，宿主再 new 一个本类（构造函数会 restoreRunLocal 从磁盘
 *        找回现场产物），用 resolveBuildEntry() 把每个声明的 id 解析成文件
 *        路径 → BUILD 阶段逐个执行 → TEST 阶段执行 test workflow
 *
 * 【小白词典：MCP 工具】（集中讲这一次）
 *   MCP（Model Context Protocol）是"给 AI 提供工具"的标准协议。本项目用的是
 *   SDK 的 createSdkMcpServer —— 不起子进程，就在宿主进程里注册几个函数，
 *   AI 调用它们时宿主代码原地执行。名字上必须长成 mcp__<服务器名>__<工具名>。
 *
 * 【先修知识】
 *   docs/b-subagent-workflow.md（设计）；src/agents/driver.ts 的【小白词典】
 *   （SDK / 会话 / hook）；src/workflow/registry.ts 的 discoverBuildWorkflows
 *   （怎么扫库）；src/workflow/source-policy.ts（落盘安检的"正式版"）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/agents/dep-registry.ts（代码与本文件逐字一致，仅多中文注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"; // ← Node 的文件模块：建目录 / 读文件 / 列目录 / 看大小 / 写文件，generate 和 restoreRunLocal 都要靠它
import { join, resolve } from "node:path"; // ← join 拼路径（自动适配 Windows 的 \ 和 Linux 的 /），resolve 把相对路径变成绝对路径
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js"; // ← `import type` 只导入"类型"，编译后整个被擦掉、运行时零开销。这俩分别是"宿主环境探测结果"和"C 工程识别结果"，用来判断库里的 build 对当前机器合不合适
import { discoverBuildWorkflows } from "../workflow/registry.js"; // ← 扫描 .refactorsa/build-workflows/，把持久化的 build workflow 一条条翻出来（详见 registry.ts 注释版）

/**
 * dep-registry — host-side dependency registry for the subagent-driven
 * workflow flow. TestWorkflow writers inspect available BuildWorkflows
 * (persisted library + current run), declare their dependency set, and ask
 * the host to materialize new BuildWorkflow sources.
 *
 * The tool layer (MCP server binding) lives in dep-registry-server.ts; the
 * state/logic here is pure and unit-testable without Claude.
 */

// ↑ 原注释翻译：dep-registry 是"子代理驱动工作流"流程的宿主侧依赖登记簿。
//   写 TestWorkflow 的人（test-writer 会话）用它查看可用的 BuildWorkflow（持久库
//   + 本次 run），声明自己的依赖集合，并请求宿主物化（落盘）新的 BuildWorkflow 源码。
//   工具层（MCP 绑定）在 dep-registry-server.ts；这里的状态/逻辑是纯的，不依赖 Claude 即可单测。
// ── WorkflowLibraryItem：库里一条 build workflow 的"名片"（给 AI 看的元数据）──
// 【为什么只有元数据】⚠️ 设计文档明确"不返回大段源码"——源码动辄几百行，塞进
//   会话上下文会把 token 烧光，AI 只需要知道"有没有、叫什么、干什么用"。
export interface WorkflowLibraryItem {
  readonly id: string; // ← 工作流的稳定 id（库里的形如 libuv-cmake）
  readonly kind: "build" | "test"; // ← 字面量联合类型：这个字段的值只可能是这两个字符串之一
  readonly revision: number; // ← 版本号（第几次修订），从 1 开始
  readonly status: "library-verified" | "library-draft" | "run-local"; // ← 三种来源状态：库内已验证 / 库内草稿 / 本次 run 现场生成
  readonly description: string; // ← 人写的/AI 写的一句话描述（AI 靠它判断"能不能复用"）
  readonly entry: string; // ← 源码文件的路径
  readonly producedArtifacts: readonly string[]; // ← 会产出哪些产物路径。⚠️ 本文件一律给空数组：宿主"零产物知识"，产物路径是 build-writer 汇报给 test-writer 的
  readonly appliesTo: { // ← 适用条件（和 manifest.json 里的 applies_to 字段一一对应，注意用下划线命名）
    readonly build_systems: readonly string[]; // ← 适用的构建系统（cmake / make …）
    readonly platforms: readonly string[]; // ← 适用的平台（win32 / linux …）
    readonly architectures: readonly string[]; // ← 适用的架构（x64 / arm64 …）
    readonly required_tools: readonly string[]; // ← 需要哪些工具链（cmake、ninja…）
  };
}

// ── RunLocalWorkflow：本次 run 现场新造、还没入库的 build workflow ────────
// 它比库条目简单得多：没有 appliesTo、没有验证状态（因为还没验证过）。
export interface RunLocalWorkflow {
  readonly id: string; // ← run-local id，形如 libuv-cmake-a1b2c3（名字 + 会话短 id 后缀）
  readonly kind: "build" | "test"; // ← 目前代码里只会是 "build"
  readonly name: string; // ← slug 化后的短名（生成 id 用的那一半）
  readonly description: string; // ← 生成时 AI 给的描述（从旁车文件读回来，见 readDescriptionSidecar）
  readonly revision: number; // ← 同名重造一次就 +1
  /** Absolute path to the materialized source under the run dir. */
  // ↑ 原注释：物化（写）到 run 目录下的源码的绝对路径。
  readonly entry: string;
}

// ── InspectQuery：查清单时可以带上 id 精确查，也可以不带（列全部）────────
export interface InspectQuery {
  readonly kind: "build" | "test"; // ← 查 build 还是 test
  /** Exact id, or omit/empty for listing all. */
  // ↑ 原注释：精确 id；省略或留空 = 列出该 kind 的全部。
  readonly id?: string; // ← `?` 表示可选字段：不传就是 undefined
}

// ── InspectResult：查清单的返回值，就是一堆名片 ─────────────────────────
export interface InspectResult {
  readonly items: WorkflowLibraryItem[];
}

// ── DeclareDependencyInput：声明依赖的工具入参 ──────────────────────────
export interface DeclareDependencyInput {
  /** Full dependency set (idempotent overwrite). Empty = explicit none. */
  // ↑ 原注释：传完整的依赖集合（幂等覆盖）。空数组 = 显式声明"无依赖"。
  //   ⚠️ "幂等覆盖"是关键字段语义：不是"追加一条"，而是"这就是全部"——
  //   AI 每次都要把完整名单报一遍，最后一次的名单就是生效名单。
  readonly buildWorkflowIds: readonly string[];
}

// ── GenerateBuildWorkflowInput：请求宿主物化一个新 build workflow ────────
export interface GenerateBuildWorkflowInput {
  readonly name: string; // ← 短名（宿主会把它 slug 化 + 加会话后缀变成 id）
  readonly description: string; // ← 这个 build 干什么、产出什么（会持久化）
  /** Complete TypeScript source of a workflow-driven BuildWorkflow. */
  // ↑ 原注释：一份完整的、workflow-driven 型 BuildWorkflow 的 TypeScript 源码。
  readonly content: string;
}

// ── GenerateBuildWorkflowResult：物化成功后回给 AI 的回执 ────────────────
// ⚠️ 注意没有路径！只回 id / 版本 / 行数 / 描述 —— 路径是宿主内部的事，
//    AI 只需要拿 workflowId 去 declareDependency 里报。
export interface GenerateBuildWorkflowResult {
  readonly workflowId: string; // ← 宿主分配的 run-local id
  readonly revision: number; // ← 本次是该 id 的第几版
  readonly lineCount: number; // ← 源码行数（AI 可以自检"是不是真写完整了"）
  readonly description: string; // ← 原样回显
}

// ── DependencyRegistry：账本对外的"接口"（interface 只定形状不给实现）────
// 【为什么要个接口】dep-registry-server.ts 只认这个接口，不认具体类 ——
//   将来想换成数据库版的账本，server 一行都不用改。
// 【语法】方法写法 `名字(参数): 返回类型`，没有函数体 = "谁实现谁填"。
export interface DependencyRegistry {
  inspect(query: InspectQuery): Promise<InspectResult>; // ← 查清单。Promise<…> 表示"异步结果"，调用方要 await
  /** Declared build ids currently in effect (idempotent overwrite semantics). */
  // ↑ 原注释：当前生效的声明 build id 集合（幂等覆盖语义）。
  declare(input: DeclareDependencyInput): Promise<readonly string[]>;
  generate(input: GenerateBuildWorkflowInput): Promise<GenerateBuildWorkflowResult>;
  /** Persisted + run-local ids known to this registry (for validation). */
  // ↑ 原注释：本账本认识的所有 id（库 + run-local），用于校验声明是否合法。
  knownBuildIds(): Promise<readonly string[]>;
  /** True once declareDependency was called at least once (even with []). */
  // ↑ 原注释：只要调过一次 declareDependency 就是 true（哪怕传的是空数组）。
  //   🔗 workflow-session.ts 收尾校验靠它区分"忘了声明"和"明确声明无依赖"。
  declaredExplicitly(): Promise<boolean>;
}

// ── DependencyRegistryOptions：new 这个账本时要给的配置 ─────────────────
export interface DependencyRegistryOptions {
  /** Absolute repo root containing the persisted library (.refactorsa). */
  // ↑ 原注释：仓库根目录（绝对路径），里面有持久化的库（.refactorsa）。
  readonly workspaceRoot: string;
  /** Absolute session root where run-local workflows are materialized. */
  // ↑ 原注释：会话根目录（绝对路径），run-local 的 workflow 落在这里。
  readonly sessionRoot: string;
  /** Session id used for run-local directory naming. */
  // ↑ 原注释：会话 id，用来拼 run-local 目录名。
  readonly sessionId: string;
  readonly host?: HostPreflight; // ← 可选：宿主环境探测（不传就不做平台兼容过滤）
  readonly project?: ProjectDetection; // ← 可选：工程识别结果（不传就不做构建系统过滤）
}

// ── 三个路径常量：拼出 .refactor/runs/<sessionId>/workflows/build ────────
// 🔗 workflow-agent-pipeline.ts 里 test 文件落在同级的 .../workflows/test。
const RUN_DIR = join(".refactor", "runs");
const WORKFLOW_DIR = "workflows";
const BUILD_DIR = "build";

// ── slug：把任意名字洗成"能当文件名"的短横线小写串 ─────────────────────
// 【作用】AI 给的 name 可能是 "LibUV CMake Build!!!" 这种，直接当文件名会出事。
// 【参数】name：AI 提供的短名。
// 【返回】只含 a-z 0-9 . _ - 的字符串，最长 64 字符；全被洗掉时兜底叫 "workflow"。
// 【语法】链式调用：每一步返回字符串，继续往下调。
function slug(name: string): string {
  return (
    name
      .trim() // ← 去掉首尾空白
      .toLowerCase() // ← 统一小写（Windows 文件名不区分大小写，顺便避免冲突）
      .replace(/[^a-z0-9._-]+/g, "-") // ← 正则：不是字母数字点下划线短横线的（+ 表连续多个）一律换成一个 "-"
      .replace(/^-+|-+$/g, "") // ← 再把开头/结尾的 - 削掉（^=开头，|=或者，$=结尾）
      .slice(0, 64) || "workflow" // ← 最多留 64 个字符；`||` 兜底：若结果是空串（falsy）就给 "workflow"
  );
}

// ── safeRunLocalId：id = 名字 + 会话短后缀 ─────────────────────────────
// 【为什么加后缀】不同 run 生成的同名 build 不能互相覆盖，也方便日后
//   curator 判定入库时映射成稳定 id（设计文档 §5 的 alias.json）。
// 【防穿越】把会话 id 里的非安全字符全部删掉，只留 12 个字符 —— 这样 id
//   里不可能出现 / 或 .. ，后面拼路径就不会被"路径穿越"攻击。
function safeRunLocalId(slugged: string, sessionId: string): string {
  const session = sessionId.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 12);
  return `${slugged}-${session}`; // ← 模板字符串：`${…}` 里可以嵌表达式
}

/**
 * Validate a workflow-driven BuildWorkflow source string before
 * materialization. Mirrors source-policy (syntax, forbidden host imports,
 * workflowKind literal) without requiring the file to exist.
 */
// ↑ 原注释：在物化（写盘）之前校验一段 workflow-driven BuildWorkflow 源码。
//   它是 src/workflow/source-policy.ts 的"镜像版"（语法 / 禁止的宿主 import /
//   workflowKind 字面量），区别是这里只看字符串、不需要文件真实存在。
// ── validateBuildWorkflowSource：落盘前的安检门（fail-closed 关键一环）────
// 【作用】AI 交来的源码要先过三关：非空、不碰宿主 API、声明了 workflowKind，
//   最后还要能用 Bun 的编译器转译（= 语法没写错）。任何一关不过都返回 {ok:false, reason}。
// 【返回】{ ok: boolean; reason: string | null } —— ok=false 时 reason 说明原因，
//   这个 reason 会被 dep-registry-server.ts 原样回给 AI，AI 同会话就能改了重交（loop）。
// 【关系】generate() 调它；tests/dep-registry.test.ts 单测覆盖每条拒绝分支。
export function validateBuildWorkflowSource(source: string): { ok: boolean; reason: string | null } {
  const trimmed = source.trim(); // ← 先去首尾空白，避免"全空格"这种假内容骗过检查
  if (trimmed.length === 0) {
    return { ok: false, reason: "content must not be empty" }; // ← 第一关：不许交白卷
  }
  const forbidden = [ // ← 第二关：一组"禁手"正则，命中任意一条就拒收
    /from\s+["'](?:node:|bun:)/, // ← `import … from "node:fs"` 这种（\s+ = 一个以上空白；(?:…) 是不捕获分组）
    /import\s*\(\s*["'](?:node:|bun:)/, // ← 动态 import：`await import("node:fs")`（\* 表示 0 个以上空白）
    /require\s*\(\s*["'](?:node:|bun:)/, // ← 老式 CommonJS 的 require()
    /from\s*["'](?:fs|child_process|worker_threads|net|http|https|os|process)["']/, // ← 不带 node: 前缀的危险模块（读写文件/起子进程/网络）
    /(?<![\w.])process\s*\.(?!run\b|start\b|wait\b|stop\b)/, // ← 碰全局 process 对象。(?<![\w.]) 是"后面回顾"：前面不能是字母数字或点（避免误伤 ctx.process）；(?!…) 是"前瞻"：process.run/start/wait/stop 是注入能力，放行
    /(?<![\w.])Bun\s*\./, // ← 碰 Bun 全局同理禁止
  ];
  // 【为什么要禁】workflow 源码执行在宿主里，如果它能 import fs，就能绕过
  //   "能力注入 + 路径白名单"整套安全模型 —— 所以一律只准用 context.* 注入的能力。
  for (const pattern of forbidden) {
    if (pattern.test(trimmed)) { // ← regex.test(s) 返回布尔："这段文字里有没有匹配"
      return { ok: false, reason: "workflow directly imports a host API; use injected capabilities instead" };
    }
  }
  if (!/export\s+const\s+workflowKind\s*=\s*["']workflow-driven["']/.test(trimmed)) {
    // ↑ 第三关：源码最顶部必须写明 `export const workflowKind = "workflow-driven"`，
    //   宿主的执行器靠这行字面量判断"这个文件是会自己驱动构建的类型"。
    return {
      ok: false,
      reason: 'build workflow must declare export const workflowKind = "workflow-driven"',
    };
  }
  try {
    new Bun.Transpiler({ loader: "ts" }).transformSync(trimmed); // ← 第四关：让 Bun 的 TypeScript 转译器真的过一遍。能转译 = 语法合法（不是"类型正确"——运行时不查类型）
  } catch (error) {
    return { ok: false, reason: `workflow syntax transpilation failed: ${errorMessage(error)}` }; // ← 语法错就把编译器的报错原样带回给 AI
  }
  return { ok: true, reason: null }; // ← 四关全过，放行
}

// ── errorMessage：把"抛出来的东西"变成能看的字符串 ─────────────────────
// 【语法】throw 的东西类型是 unknown（可能是 Error，也可能是个字符串），
//   所以先 instanceof 判断。本项目很多文件都有一份一模一样的私有副本。
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registry over a persisted workflow library (discoverBuildWorkflows) plus
 * run-local materializations under sessionRoot/.refactor/runs/<session>/workflows.
 */
// ↑ 原注释：这本账本盖在两叠东西上：持久化的 workflow 库（discoverBuildWorkflows
//   扫出来的）+ 落在 sessionRoot/.refactor/runs/<会话>/workflows 下的现场产物。
// ── LocalDependencyRegistry：账本的唯一实现类 ────────────────────────────
// 【关系】workflow-session.ts 和 workflow-agent-pipeline.ts 各 new 一个；
//   dep-registry-server.ts 拿它包成 MCP 工具。implements = 承诺实现上面那个接口。
export class LocalDependencyRegistry implements DependencyRegistry {
  private readonly workspaceRoot: string; // ← private：只有类内部能碰（TS 语法层面的保护）
  private readonly sessionRoot: string;
  private readonly sessionId: string;
  private readonly host?: HostPreflight;
  private readonly project?: ProjectDetection;
  private readonly runLocal = new Map<string, RunLocalWorkflow>(); // ← Map：键值对容器（id → 条目）。new Map<K,V>() 的尖括号是泛型，指定键和值的类型
  private declared: readonly string[] = []; // ← 当前生效的声明集（注意：不在内存里的声明不算数）
  private revisionCounter = new Map<string, number>(); // ← 记每个 id 已经造到第几版
  private declareCalled = false; // ← 关键开关：declareDependency 有没有被"至少调过一次"

  // ── constructor：new 的时候跑一次 ───────────────────────────────────
  // 【关系】🔴 会话结束后宿主会再 new 一个新实例（见 workflow-agent-pipeline.ts），
  //   新实例内存里的 runLocal 是空的 —— 所以必须从磁盘恢复，这就是下一行 restoreRunLocal()
  //   存在的原因；声明集则由宿主另行从 session 结果里拿回来。
  constructor(options: DependencyRegistryOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot); // ← 统一转成绝对路径，避免后面拼路径时相对/绝对混用
    this.sessionRoot = resolve(options.sessionRoot);
    this.sessionId = options.sessionId;
    this.host = options.host;
    this.project = options.project;
    this.restoreRunLocal(); // ← 从磁盘找回本会话之前物化过的 build workflow
  }

  /** Recover run-local builds materialized on disk (host restarts/rebuilds registry). */
  // ↑ 原注释：从磁盘找回已物化的 run-local build（宿主重启/重建 registry 时用）。
  // ── restoreRunLocal：扫 run 目录，把 .ts 文件重新登记进内存 ─────────────
  private restoreRunLocal(): void {
    const dir = this.runLocalBuildDir(); // ← 目标目录（可能是第一次跑、还不存在）
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".ts")); // ← 列目录，只留 .ts 文件
    } catch {
      return; // dir not created yet
      // ↑ catch 不带参数（`catch {`）：只要"出错了"这个事实，不关心错误对象。
      //   目录不存在 = 本会话还没生成过任何 build，直接返回不算错误。
    }
    for (const name of names) {
      const id = name.slice(0, -3); // ← 去掉末尾 ".ts" 三个字符得到 id（slice(0,-3) = 从头取到倒数第 3 个之前）
      const entry = join(dir, name);
      try {
        const size = statSync(entry).size; // ← statSync 拿文件信息，.size 是字节数
        if (size === 0) continue; // ← 空文件跳过：多半是上次写盘写了一半，不能当有效 workflow
      } catch {
        continue; // ← 文件刚被删了之类的情况，跳过即可
      }
      if (this.runLocal.has(id)) continue; // ← 已经在内存里了就不重复登记
      this.runLocal.set(id, { // ← 登记一条"磁盘恢复版"条目
        id,
        kind: "build",
        name: id, // ← ⚠️ 恢复场景拿不到原始短名，只能拿 id 顶上
        description: this.readDescriptionSidecar(entry),
        revision: 1, // ← 同样拿不到历史版本计数，只能归 1
        entry,
      });
    }
  }

  // ── runLocalBuildDir：本会话 build 目录的绝对路径 ─────────────────────
  // 【返回】<workspaceRoot>/.refactor/runs/<sessionId>/workflows/build
  // 【关系】generate() 在这里写文件，restoreRunLocal() 在这里读文件，
  //   workflow-agent-pipeline.ts 也会调用它来做存在性检查。
  runLocalBuildDir(): string {
    return join(this.workspaceRoot, RUN_DIR, this.sessionId, WORKFLOW_DIR, BUILD_DIR);
  }

  // 私有小工具：某个 id 对应的源码文件完整路径
  private runLocalEntry(id: string): string {
    return join(this.runLocalBuildDir(), `${id}.ts`);
  }

  // ── readDescriptionSidecar：读"旁车文件"里的描述 ──────────────────────
  // 【什么叫 sidecar】旁边挂着的同名小文件：xxx.ts.description.json。
  //   源码旁边存一份 { name, description }，这样即使账本实例没了（进程重启），
  //   下一个实例也能把描述读回来 —— 信息跟着文件走，不跟内存走。
  // 【语法】`as { description?: string }` 是类型断言："我确信它长这样"。
  private readDescriptionSidecar(entry: string): string {
    try {
      const parsed = JSON.parse(readFileSync(`${entry}.description.json`, "utf8")) as {
        description?: string;
      };
      return parsed.description ?? ""; // ← 字段缺失时给空串
    } catch {
      return ""; // ← 文件不存在 / 不是合法 JSON，一律当"没描述"
    }
  }

  // ── inspect：查清单（对应 MCP 工具 inspectWorkflow）─────────────────
  // 【作用】把"库条目 + run-local 条目"合并成一张名片列表返回。
  // 【参数】query.kind 必填；query.id 可选（传了就只回这个 id）。
  // 【返回】{ items }，按 id 字典序排好 —— 顺序稳定，AI 看到的清单不会忽上忽下。
  async inspect(query: InspectQuery): Promise<InspectResult> {
    const items: WorkflowLibraryItem[] = []; // ← 待填的结果列表
    const kind = query.kind;

    if (kind === "build") { // ← 目前只实现了 build 的查询
      for (const candidate of discoverBuildWorkflows( // ← 先扫持久库（.refactorsa/）
        this.workspaceRoot,
        this.host,
        this.project,
      )) {
        if (query.id !== undefined && candidate.manifest?.id !== query.id) continue; // ← `?.`：manifest 为 null 时整个表达式是 undefined，必然 ≠ query.id → 被 continue 跳过（精确查询时顺带排掉坏条目）
        if (candidate.manifest === null) continue; // ← 没有合法 manifest 的目录跳过（discover 那边已标为 invalid/stale）
        items.push({
          id: candidate.manifest.id,
          kind: "build",
          revision: candidate.manifest.revision,
          status: candidate.manifest.status === "verified" // ← 三元表达式：库里的 verified 映射成 library-verified
            ? "library-verified"
            : "library-draft", // ← 其余（draft）映射成 library-draft
          description: candidate.manifest.description ?? "",
          entry: candidate.entry ?? "", // ← entry 类型是 string | null，这里收敛成字符串
          producedArtifacts: [],
          appliesTo: {
            build_systems: candidate.manifest.applies_to.build_systems,
            platforms: candidate.manifest.applies_to.platforms,
            architectures: candidate.manifest.applies_to.architectures,
            required_tools: candidate.manifest.applies_to.required_tools,
          },
        });
      }
      for (const runLocal of [...this.runLocal.values()]) { // ← `[…map.values()]`：把迭代器摊开成数组，才能用 for-of 以外的方法
        if (runLocal.kind !== "build") continue;
        if (query.id !== undefined && runLocal.id !== query.id) continue;
        items.push({
          id: runLocal.id,
          kind: "build",
          revision: runLocal.revision,
          status: "run-local", // ← 现场生成的统一标 run-local（AI 能看出"这个没验证过"）
          description: runLocal.description,
          entry: runLocal.entry,
          producedArtifacts: [],
          appliesTo: { build_systems: [], platforms: [], architectures: [], required_tools: [] }, // ← 现场条目没有兼容性元数据，全空
        });
      }
    }

    items.sort((a, b) => a.id.localeCompare(b.id)); // ← localeCompare 是"按字典序比较字符串"，sort 用它保证顺序稳定
    return { items };
  }

  // ── knownBuildIds：账本认识的所有 build id（声明校验的白名单）──────────
  // 【作用】declare() 拿它判断 AI 报的 id 是不是真的存在。
  // 【返回】库 id ∪ run-local id，排序去重（Set 自动去重，`[…set]` 转回数组）。
  async knownBuildIds(): Promise<readonly string[]> {
    const ids = new Set<string>();
    for (const candidate of discoverBuildWorkflows(
      this.workspaceRoot,
      this.host,
      this.project,
    )) {
      if (candidate.manifest !== null) ids.add(candidate.manifest.id);
    }
    for (const runLocal of [...this.runLocal.values()]) {
      if (runLocal.kind === "build") ids.add(runLocal.id);
    }
    return [...ids].sort(); // ← sort() 无参时按字符串默认顺序排
  }

  // ── declare：声明依赖集（对应 MCP 工具 declareDependency）───────────
  // 【作用】把 AI 报来的完整名单记下来；先逐个校验 id 是否已知。
  // 【幂等】每次调用都是"整体覆盖"—— 调三次，生效的是最后一次的名单。
  // 【失败会怎样】有未知 id 就 throw（AI 会拿到错误文本 + 可用清单，同会话改正），
  //   ⚠️ 但注意 declareCalled 在校验之前就被置 true 了。
  async declare(input: DeclareDependencyInput): Promise<readonly string[]> {
    this.declareCalled = true; // ← "至少声明过一次"这个事实先记账（哪怕传 []）
    const known = new Set(await this.knownBuildIds()); // ← await：等异步结果回来再用
    const unknown = input.buildWorkflowIds.filter((id) => !known.has(id)); // ← filter 挑出不认识的那些 id
    if (unknown.length > 0) {
      throw new Error(
        `declareDependency: unknown build workflow id(s): ${unknown.join(", ")}. ` +
          `Known ids: ${known.size > 0 ? [...known].sort().join(", ") : "(none)"}`,
        // ↑ 报错文本里特意带上"现在有哪些可用 id"—— AI 看到就能在同一次会话里修正，
        //   这就是设计文档说的 loop（工具返回文本 → 同会话可见可修正）。
      );
    }
    this.declared = [...input.buildWorkflowIds]; // ← 复制一份存起来（不持有调用方的数组引用）
    return [...this.declared]; // ← 回显生效名单，AI 可以确认"我声明成功了"
  }

  // ── currentDeclared：读当前生效的声明集 ─────────────────────────────
  // 【关系】会话结束后 workflow-session.ts 用它取名单，交给宿主去执行 BUILD。
  async currentDeclared(): Promise<readonly string[]> {
    return [...this.declared];
  }

  // ── declaredExplicitly：AI 到底声明过没有 ───────────────────────────
  // 【为什么需要】`declared = []` 和"从没调用过 declare"在 declared 字段上
  //   看起来一样（都是空），但语义天差地别：前者是"我确认没有依赖"，
  //   后者是"它忘了"。收尾校验必须能区分（否则 AI 忘了调用也能蒙混过关）。
  async declaredExplicitly(): Promise<boolean> {
    return this.declareCalled;
  }

  /**
   * Materialize a run-local BuildWorkflow source. Validates content before
   * writing (fail-closed); idempotent create-or-replace by slug name.
   */
  // ↑ 原注释：物化一份 run-local 的 BuildWorkflow 源码。写盘前先校验内容
  //   （fail-closed：不合格就一个字节都不落盘）；按 slug 名幂等地"创建或整体替换"。
  // ── generate：落盘一个新 build workflow（对应 MCP 工具 generateBuildWorkflow）──
  // 【作用】AI 交来 {name, description, content}，宿主：安检 → 生成 id → 写源码
  //   → 写描述旁车文件 → 登记进内存 → 回执 {workflowId, revision, lineCount, description}。
  // 【失败会怎样】安检不过直接 throw，磁盘上一个文件都不会出现（AI 拿到错误可重试）。
  // 【幂等】同名再交一次 = 覆盖同一个 id 的文件，revision +1。
  async generate(input: GenerateBuildWorkflowInput): Promise<GenerateBuildWorkflowResult> {
    const content = input.content.trim();
    const checked = validateBuildWorkflowSource(content); // ← 第一件事：安检（见上）
    if (!checked.ok) {
      throw new Error(`generateBuildWorkflow: invalid workflow source: ${checked.reason ?? "unknown"}`);
    }

    const slugged = slug(input.name); // ← 名字洗白
    const id = safeRunLocalId(slugged, this.sessionId); // ← 拼出 run-local id（带会话后缀，防穿越）
    const revision = (this.revisionCounter.get(id) ?? 0) + 1; // ← 没记录过就当第 0 次，+1 = 第 1 版
    this.revisionCounter.set(id, revision);

    mkdirSync(this.runLocalBuildDir(), { recursive: true }); // ← 建目录；recursive: true 表示"多级一次建齐，已存在也不报错"
    const target = this.runLocalEntry(id);
    writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`, "utf8"); // ← 写源码；末尾保证有换行符（文本文件的礼貌）
    // Persist the description next to the source so later processes (registry
    // rebuild, curator promotion) can recover it without holding this instance.
    // ↑ 原注释：把描述存在源码旁边，这样后续进程（重建 registry、curator 入库）
    //   不必依赖这个内存实例也能找回描述。
    writeFileSync(
      `${target}.description.json`,
      JSON.stringify({ name: slugged, description: input.description }) + "\n",
      "utf8",
    );
    this.runLocal.set(id, { // ← 同步登记进内存，本次会话内立刻可查/可声明
      id,
      kind: "build",
      name: slugged,
      description: input.description,
      revision,
      entry: target,
    });

    const lineCount = content.split("\n").length; // ← 按换行切一刀数行数（给 AI 自检用）
    return { workflowId: id, revision, lineCount, description: input.description };
  }

  /** Resolve a declared build id to an absolute workflow entry, if known. */
  // ↑ 原注释：把一个已声明的 build id 解析成 workflow 源码的绝对路径（若认识）。
  // ── resolveBuildEntry：BUILD 阶段的"按名单找文件" ──────────────────────
  // 【作用】会话结束、宿主要执行声明集时，把每个 id 变成真实文件路径。
  // 【优先级】先查 run-local（本次现场生成的），再查库 —— 现场版优先，
  //   因为 test-writer 是基于"刚生成的这份"来写测试的。
  // 【返回】{ entry, runLocal } 或 null（= 谁都不认识这个 id → 宿主 fail-closed 中止）。
  async resolveBuildEntry(id: string): Promise<{ entry: string; runLocal: boolean } | null> {
    const runLocal = this.runLocal.get(id); // ← Map.get 找不到返回 undefined
    if (runLocal !== undefined) {
      return { entry: runLocal.entry, runLocal: true };
    }
    for (const candidate of discoverBuildWorkflows(
      this.workspaceRoot,
      this.host,
      this.project,
    )) {
      if (candidate.manifest?.id === id && candidate.entry !== null) {
        return { entry: candidate.entry, runLocal: false };
      }
    }
    return null; // ← 找不到：调用方（pipeline）会抛"declared build cannot be resolved"并中止整个 run
  }
}
