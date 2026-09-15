/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/agents/workflow-types.ts —— 写给 AI 看的类型声明模板
 *
 * 【这个文件是干什么的】
 *   这里只有一个常量 WORKFLOW_TYPES：一整段**模板字符串**，内容是 TypeScript
 *   的 interface 声明（WorkflowContext / WorkflowValidator / WorkflowPlanApi…）。
 *   它不会被本项目编译或运行——运行时会被"擦掉"，唯一的用途是被
 *   workflow-generator.ts 用 writeFileSync 写成生成目录旁边的 types.d.ts，
 *   让 AI 在写 workflow 源码时能 import 到正确的类型（`import type {...} from "./types"`），
 *   而不用自己发明接口。
 *
 * 【⚠️ 已知漂移（注释必须点明）】
 *   这份模板里的 WorkflowContext **没有 expect 字段**，但
 *   .claude/plugins/workflow-spec/skills/workflow-spec/workflow-api.md 的文档
 *   写了 ctx.expect(...) 存在（自驱动 TestWorkflow 的核心 API，见 §1.5）。
 *   也就是说：AI 在编译期看到的接口比运行时实际能用的窄。这是一个已知的
 *   文档/模板漂移（任务清单 §3.5 第 4 条，两行即可修复）——读代码时别被它误导。
 *
 * 【为什么类型导入是安全的】
 *   `import type` 只在编译期存在，运行时完全没有这行代码。真正的 fs / process /
 *   validator / plan 对象由宿主在执行期注入（见 src/workflow/capabilities.ts 的
 *   capability broker）。所以"声明文件里什么都没有"不会造成运行时错误。
 *
 * 【在整个项目里的位置】
 *   唯一消费方：src/agents/workflow-generator.ts（写盘成 types.d.ts）。
 *
 * 【先修知识】workflow-generator.ts；src/workflow/capabilities.ts / capability-protocol.ts。
 *
 * 【本文件是教程注释版】
 *   原文件：src/agents/workflow-types.ts（代码与本文件逐字一致，仅多中文注释）
 *   ⚠️ 注意：模板字符串内部的任何字符都会原样成为文件内容，所以本文件的注释
 *      只能加在字符串外面（这也是它注释比其他文件少的原因）。
 * ═══════════════════════════════════════════════════════════════════ */
/**
 * Host-provided workflow types. Generated next to every workflow source;
 * import these instead of declaring your own interfaces.
 *
 * IMPORTANT: type-only imports are erased at runtime; the worker injects the
 * real objects. Never import values from this file.
 */
// ↑ 原注释翻译：宿主提供的 workflow 类型。会生成在每个 workflow 源码旁边；
//   请 import 这些类型，别自己声明接口。重要：type-only 导入在运行时被擦除，
//   真正的对象由 worker 注入。绝不要从这个文件 import 值。

// ── WORKFLOW_TYPES：一整段"将来会被写成 types.d.ts"的文本 ─────────────
// 【语法】反引号字符串里出现的 ${ 会被当作插值，所以这段文本里不能随便写 ${；
//   这里全是普通 TS 声明文本，安全。
// 【结构速览】（想看某个能力干嘛，按名字对照下面）
//   HostPreflight / ProjectDetection → 程序实测的主机与项目事实（只读）
//   ProcessRunSpec / ProcessResult   → 跑外部命令的入参与结果（stdout 是 base64）
//   WorkflowFilesystem               → 受限文件能力（读/写/快照/对比）
//   WorkflowProcess                  → 跑命令、后台起进程、等待、停止
//   WorkflowTools                    → 查"哪些工具实测可用"
//   WorkflowAdapters                 → cmake / ninja / ctest / compiler 四个现成封装
//   WorkflowValidator                → assertFile / assertDir / assertAbsent（失败即抛错）
//   WorkflowPlanApi                  → declare/begin/complete/fail，给 Dashboard 看的步骤树
//   WorkflowContext                  → 以上全部的聚合入口（ctx.fs 与 ctx.capabilities.fs 是同一个对象）
export const WORKFLOW_TYPES = `
export interface WorkflowFacts {
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
}

export interface HostPreflight {
  readonly platform: "win32" | "linux" | "darwin";
  readonly arch: string;
  readonly executable_suffix: string;
  readonly shell: string;
  readonly tools: Record<string, {
    readonly available: boolean;
    readonly path: string | null;
    readonly version: string | null;
  }>;
  readonly cmake: {
    readonly version: string | null;
    readonly generators: string[];
    readonly default_generator: string | null;
    readonly c_compiler: string | null;
    readonly configure_probe: "pass" | "fail" | "not-run";
    readonly build_probe: "pass" | "fail" | "not-run";
  };
}

export interface ProjectDetection {
  readonly kind: "project-detection";
  readonly version: 1;
  readonly repo_root: string;
  readonly language: string;
  readonly build_systems: string[];
  readonly primary_build_system: string | null;
  readonly markers: string[];
  readonly source_files: string[];
  readonly adapter: "direct-compiler" | "cmake" | "ninja" | null;
  readonly status: "ready" | "needs-adapter" | "unsupported";
  readonly reason: string;
}

export type WorkflowFileEncoding = "utf8" | "base64";

export interface ProcessRunSpec {
  readonly program: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly stdinBase64?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ProcessStartSpec extends ProcessRunSpec {
  readonly ready?: {
    readonly kind: "none" | "tcp" | "file";
    readonly host?: string;
    readonly port?: number;
    readonly path?: string;
    readonly timeoutMs?: number;
  };
}

export interface ProcessResult {
  readonly status: "exited" | "timeout" | "output_limit" | "spawn_error" | "stopped";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly durationMs: number;
  readonly error: string | null;
}

export interface ProcessHandle {
  readonly id: string;
}

export interface WorkflowFilesystem {
  readFile(path: string, encoding?: WorkflowFileEncoding): Promise<string>;
  writeFile(path: string, content: string, encoding?: WorkflowFileEncoding): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
  snapshot(path?: string): Promise<Record<string, string>>;
  diff(path: string, before: Record<string, string>): Promise<Array<{
    readonly path: string;
    readonly op: "create" | "modify" | "delete";
    readonly sha256: string | null;
  }>>;
}

export interface WorkflowProcess {
  run(spec: ProcessRunSpec): Promise<ProcessResult>;
  start(spec: ProcessStartSpec): Promise<ProcessHandle>;
  wait(handle: ProcessHandle, timeoutMs?: number): Promise<ProcessResult>;
  stop(handle: ProcessHandle): Promise<ProcessResult>;
}

export interface WorkflowTool {
  readonly name: string;
  readonly path: string;
}

export interface WorkflowTools {
  available(name: string): Promise<boolean>;
  list(): Promise<WorkflowTool[]>;
}

export interface WorkflowAdapters {
  readonly cmake: {
    configure(options: {
      readonly sourceDir?: string;
      readonly buildDir: string;
      readonly generator?: string;
      readonly flags?: readonly string[];
    }): Promise<ProcessResult>;
    build(options: {
      readonly buildDir: string;
      readonly target?: string;
      readonly flags?: readonly string[];
    }): Promise<ProcessResult>;
  };
  readonly ninja: {
    build(options: {
      readonly buildDir?: string;
      readonly target?: string;
      readonly flags?: readonly string[];
    }): Promise<ProcessResult>;
  };
  readonly ctest: {
    run(options: {
      readonly buildDir: string;
      readonly configuration?: string;
      readonly args?: readonly string[];
      readonly timeoutMs?: number;
    }): Promise<ProcessResult>;
  };
  readonly compiler: {
    compile(options: {
      readonly compiler?: string;
      readonly args: readonly string[];
      readonly cwd?: string;
      readonly timeoutMs?: number;
    }): Promise<ProcessResult>;
  };
}

/** Result-validation capability. Assertions throw on failure (fail-closed). */
export interface WorkflowValidator {
  assertFile(path: string, description?: string): Promise<void>;
  assertDir(path: string, description?: string): Promise<void>;
  assertAbsent(path: string, description?: string): Promise<void>;
}

export interface PlanStepDeclaration {
  readonly id?: string;
  readonly title: string;
  readonly description?: string;
  readonly children?: readonly PlanStepDeclaration[];
}

export interface WorkflowPlanApi {
  declare(steps: readonly PlanStepDeclaration[]): Promise<readonly string[]>;
  begin(id: string): Promise<void>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}

export interface WorkflowContext {
  readonly apiVersion: 1;
  readonly workspaceRoot: string;
  readonly input: unknown;
  readonly facts: WorkflowFacts;
  readonly capabilities: {
    readonly fs: WorkflowFilesystem;
    readonly process: WorkflowProcess;
    readonly tools: WorkflowTools;
    readonly adapters: WorkflowAdapters;
    readonly validator: WorkflowValidator;
    readonly plan: WorkflowPlanApi;
  };
  /** Convenience aliases; both forms refer to the same injected objects. */
  readonly fs: WorkflowFilesystem;
  readonly process: WorkflowProcess;
  readonly tools: WorkflowTools;
  readonly adapters: WorkflowAdapters;
  readonly validator: WorkflowValidator;
  readonly plan: WorkflowPlanApi;
}
`;
// ⚠️ 再提醒一次（呼应文件头）：上面的 WorkflowContext 里没有 expect。
//   但运行时注入的对象确实带 expect（自驱动 TestWorkflow 靠它声明期望，
//   见 src/workflow/capabilities.ts 与 workflow-api.md）。这是模板落后于实现的已知漂移。
