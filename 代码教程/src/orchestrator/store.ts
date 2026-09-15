/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/orchestrator/store.ts —— 会话仓库（状态机的"档案柜"）
 *
 * 【这个文件是干什么的】
 *   一次重构尝试 = 一个会话（session）。本文件负责把会话的所有状态持久化到磁盘：
 *     <root>/.refactor/sessions/<session_id>/
 *       ├─ state.json            当前状态 + 完整转移历史
 *       └─ artifacts/<stem>.json 每个 artifact 一个文件（trace 类按 baseline/candidate 分文件）
 *   有了落盘，进程崩了也能重新打开继续（open()），但注意：
 *   ⚠️ 目前生产入口从未调用 open()（都用的 create），所以"恢复"能力还只是半成品——
 *   这正是任务清单 #7（恢复机制）的伏笔。
 *
 * 【在整个项目里的位置】
 *   Orchestrator（orchestrator.ts）持有本类实例：submit() 调 saveArtifact() 落盘、
 *   commitTransition() 记录状态转移；两条流水线（workflow-agent-pipeline.ts 等）
 *   负责创建 SessionStore。
 *
 * 【先修知识】Zod 基础（z.enum / z.object / z.infer）、node:fs 同步 API。
 *
 * 【本文件是教程注释版】原文件 src/orchestrator/store.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

// node:fs —— Node 内置文件系统模块（Bun 兼容 node API）。这几个都是"同步"版本：
// 同步 = 代码停在这一行直到读写完成，简单直接（本项目文件都很小，同步够用）。
//   mkdirSync 建目录 / readFileSync 读文件 / writeFileSync 写文件 / existsSync 判存在
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";      // 跨平台路径拼接（自动处理 / 与 \）
import { z } from "zod";               // Zod：运行时 Schema 校验库（数据进门先安检）
import {
  Artifact,                            // 全部 artifact 的联合 Zod Schema（校验入口）
  type AnyArtifact,
  ObservationTrace,
  HostPreflight,
  ProjectDetection,
} from "../artifacts/index.js";
/**
 * SessionStore — durable state for one refactoring attempt.
 *
 * Layout under <root>/.refactor/sessions/<session_id>/:
 *   state.json            current state + full transition history
 *   artifacts/<stem>.json one file per artifact (traces: per build)
 */

// ── SessionState：全部合法状态的枚举 ────────────────────────────────────
// z.enum([...])：限制取值只能是列表中的字符串。z.infer<typeof X> 把 Zod Schema
// "反向"推导成 TypeScript 类型（这是 Zod 最常用的技巧：一处定义，校验+类型两用）。
export const SessionState = z.enum([
  "INIT",                  // 刚创建，什么都没有
  "CONTRACT_READY",        // 行为契约已提交
  "SCOPE_READY",           // 范围清单已提交
  "DEPENDENCY_READY",      // 依赖清单已提交
  "TESTS_READY",           // 测试规格已提交
  "BUILD_WORKFLOW_READY",  // BuildWorkflow 决策已提交（新路径）
  "TEST_WORKFLOW_READY",   // TestWorkflow 决策已提交（新路径）
  "ENV_READY",             // 环境规格已提交
  "BASELINE_READY",        // 基线（改动前版本）已跑完
  "PATCH_CREATED",         // Claude 的修改已提交成 patch
  "VERIFICATION_RUNNING",  // 候选（改动后版本）验证中
  "ACCEPTED",              // 终态：接受
  "REJECTED",              // 终态：拒绝
  "ABORTED",               // 终态：中止
]);
export type SessionState = z.infer<typeof SessionState>;

// ── 两个内部 Schema：历史条目 / 状态文件 ────────────────────────────────
// HistoryEntry：每次状态转移都会追加一条（谁转到谁、由什么 artifact 触发、何时、备注）。
// z.string().nullable()：可以是字符串或 null（abort 时没有触发 artifact）。
// .default("")：反序列化时缺这个字段就补空串（老文件兼容）。
const HistoryEntry = z.object({
  from: SessionState,
  to: SessionState,
  artifact_kind: z.string().nullable(),
  at: z.string(),
  note: z.string().default(""),
});

// SessionFile：state.json 的完整结构。⚠️ 注意 note 只是普通字符串——
// 拒绝原因没有结构化（任务清单 #6A 的改进点）。
const SessionFile = z.object({
  session_id: z.string().min(1),
  created_at: z.string(),
  state: SessionState,
  history: z.array(HistoryEntry),
});

type SessionFile = z.infer<typeof SessionFile>;

export class SessionStore {
  readonly sessionDir: string;     // 会话目录绝对路径（对外只读）
  private file: SessionFile;       // 内存中的状态文件内容（private：只能通过方法改）

  // private constructor：禁止外部 new SessionStore()，必须走 create() / open()，
  //   保证"要么全新创建、要么从盘上恢复"，不会出现无主实例。
  private constructor(sessionDir: string, file: SessionFile) {
    this.sessionDir = sessionDir;
    this.file = file;
  }

  /** Create a fresh session directory. */
  // static create：类上的静态工厂方法，直接 SessionStore.create(root, id) 调用。
  static create(root: string, sessionId: string): SessionStore {
    const sessionDir = join(root, ".refactor", "sessions", sessionId);
    // ⚠️ 目录已存在直接抛错 → 这就是"失败必须从头再跑"的直接原因（任务清单 #7）。
    if (existsSync(sessionDir)) throw new Error(`session exists: ${sessionId}`);
    const file: SessionFile = {
      session_id: sessionId,
      created_at: new Date().toISOString(),   // ISO 8601 字符串，如 2026-09-03T06:00:00.000Z
      state: "INIT",
      history: [],
    };
    // { recursive: true }：像 mkdir -p，父目录不存在就一路建齐。
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    // .persist() 返回 this，链式写法：建完立刻落盘一次。
    return new SessionStore(sessionDir, file).persist();
  }

  /** Reopen an existing session (workflow recovery). */
  // ↑ 从磁盘恢复会话。功能完整（safeParse 校验损坏文件），但生产代码没有调用方。
  static open(root: string, sessionId: string): SessionStore {
    const path = join(
      root,
      ".refactor",
      "sessions",
      sessionId,
      "state.json",
    );
    // safeParse：校验失败不抛错，返回 {success:false, error}（parse 则直接抛）。
    const parsed = SessionFile.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (!parsed.success) throw new Error(`corrupt state.json: ${sessionId}`);
    return new SessionStore(join(root, ".refactor", "sessions", sessionId), parsed.data);
  }

  // getter：像属性一样访问（store.state），背后是方法调用。
  get id(): string {
    return this.file.session_id;
  }

  get state(): SessionState {
    return this.file.state;
  }

  // readonly z.infer<...>[]：对外暴露只读数组，防止调用方绕过方法改历史。
  get history(): readonly z.infer<typeof HistoryEntry>[] {
    return this.file.history;
  }

  /** Storage file stem: build/test resolutions and build-scoped artifacts stay distinct. */
  // ── storageStem：决定一个 artifact 存成什么文件名 ──────────────────────
  // 【作用】同一种类、不同侧别的 artifact 不能互相覆盖：
  //   observation-trace / sanitizer-result → 按 baseline/candidate 分文件；
  //   workflow-resolution → 按 build/test 分文件；其余直接用种类名。
  private static storageStem(a: AnyArtifact): string {
    if (a.kind === "observation-trace" || a.kind === "sanitizer-result") {
      return `${a.kind}.${a.build}`;          // 模板字符串：如 "observation-trace.baseline"
    }
    if (a.kind === "workflow-resolution") {
      return `${a.kind}.${a.workflow_kind}`;  // 如 "workflow-resolution.build"
    }
    return a.kind;
  }

  /** Load one uniquely named artifact; build/test resolutions use workflowResolution(). */
  // ── artifact<K extends …>：按种类读回一个 artifact ─────────────────────
  // 【语法】<K extends AnyArtifact["kind"]> 是泛型参数：K 只能是所有种类名的子集；
  //   Extract<AnyArtifact, {kind: K}> 从联合类型里"抽出" kind 等于 K 的那一员——
  //   这样调用 store.artifact("ctest-baseline") 拿到的类型自动是 CTestBaseline。
  // 【返回】找不到返回 null。
  artifact<K extends AnyArtifact["kind"]>(
    kind: K,
  ): Extract<AnyArtifact, { kind: K }> | null {
    if (kind === "workflow-resolution") return null;  // 它有两个文件，必须走下面的专用方法
    // 带侧别的种类读取时默认取 baseline 侧。
    const stem = kind === "observation-trace" || kind === "sanitizer-result"
      ? `${kind}.baseline`
      : kind;
    const path = join(this.sessionDir, "artifacts", `${stem}.json`);
    if (!existsSync(path)) return null;
    // as Extract<…>：类型断言——Artifact.parse 返回的是大联合，这里告诉 TS 具体是哪员。
    return Artifact.parse(JSON.parse(readFileSync(path, "utf8"))) as Extract<
      AnyArtifact,
      { kind: K }
    >;
  }

  /** Load a persisted Workflow resolution by its explicit workflow kind. */
  // ↑ 读取 workflow-resolution.build.json / .test.json（与上面 artifact() 互斥分工）。
  workflowResolution(
    workflowKind: "build" | "test",
  ): Extract<AnyArtifact, { kind: "workflow-resolution" }> | null {
    const path = join(
      this.sessionDir,
      "artifacts",
      `workflow-resolution.${workflowKind}.json`,
    );
    if (!existsSync(path)) return null;
    return Artifact.parse(JSON.parse(readFileSync(path, "utf8"))) as Extract<
      AnyArtifact,
      { kind: "workflow-resolution" }
    >;
  }

  /** Load the stored observation trace for one build; null if absent. */
  trace(build: "baseline" | "candidate"): ObservationTrace | null {
    const path = join(
      this.sessionDir,
      "artifacts",
      `observation-trace.${build}.json`,
    );
    if (!existsSync(path)) return null;
    return ObservationTrace.parse(JSON.parse(readFileSync(path, "utf8")));
  }
  /** Load the stored sanitizer result for one build; null if absent. */
  sanitizer(build: "baseline" | "candidate") {
    const path = join(
      this.sessionDir,
      "artifacts",
      `sanitizer-result.${build}.json`,
    );
    if (!existsSync(path)) return null;
    return Artifact.parse(JSON.parse(readFileSync(path, "utf8"))) as Extract<
      AnyArtifact,
      { kind: "sanitizer-result" }
    >;
  }

  /** Persist measured host facts outside the Artifact state transition union. */
  // ↑ HostPreflight 是"程序测量的审计材料"，不参与状态机转移，所以单独提供存取方法
  //   （不经过 saveArtifact / submit）。
  saveHostPreflight(raw: unknown): HostPreflight {
    const parsed = HostPreflight.parse(raw);
    writeFileSync(
      join(this.sessionDir, "artifacts", "host-preflight.json"),
      // JSON.stringify(x, null, 2)：缩进 2 空格的"美化"输出，人可以直接读。
      // + "\n"：文件末尾补换行（POSIX 习惯，也方便 diff）。
      JSON.stringify(parsed, null, 2) + "\n",
    );
    return parsed;
  }

  /** Load measured host facts for workflow recovery. */
  hostPreflight(): HostPreflight | null {
    const path = join(this.sessionDir, "artifacts", "host-preflight.json");
    if (!existsSync(path)) return null;
    return HostPreflight.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  /** Persist project build-system detection separately from workflow Artifacts. */
  // ↑ 同上：项目探测结果也是审计材料，单独存取。
  saveProjectDetection(raw: unknown): ProjectDetection {
    const parsed = ProjectDetection.parse(raw);
    writeFileSync(
      join(this.sessionDir, "artifacts", "project-detection.json"),
      JSON.stringify(parsed, null, 2) + "\n",
    );
    return parsed;
  }

  projectDetection(): ProjectDetection | null {
    const path = join(this.sessionDir, "artifacts", "project-detection.json");
    if (!existsSync(path)) return null;
    return ProjectDetection.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  /** Validate then durably store an artifact (no state transition — orchestrator decides that). */
  // ── saveArtifact：所有 artifact 入库的唯一入口 ─────────────────────────
  // 【职责边界】这里只做"校验 + 落盘"，不做状态转移——推不推状态由 Orchestrator 决定，
  //   职责分离。返回校验后的强类型对象给调用方继续用。
  saveArtifact(raw: unknown): AnyArtifact {
    const parsed = Artifact.parse(raw);   // Zod 校验：不过就抛错（submit 会接住转成失败原因）
    writeFileSync(
      join(
        this.sessionDir,
        "artifacts",
        `${SessionStore.storageStem(parsed)}.json`,
      ),
      JSON.stringify(parsed, null, 2) + "\n",
    );
    return parsed;
  }
  /** Record a completed transition and persist. Only the orchestrator calls this. */
  // ── commitTransition：记录一次状态转移 ────────────────────────────────
  // 【语法】{...this.file, state: to, history: [...旧, 新元素]} —— 展开运算符创建
  //   "替换了部分字段的新对象"（不可变更新风格，不直接改旧对象）。
  // 【参数】to 目标状态；artifactKind 触发转移的 artifact 种类（abort 时为 null）；note 备注。
  commitTransition(to: SessionState, artifactKind: string | null, note = "") {
    this.file = {
      ...this.file,
      state: to,
      history: [
        ...this.file.history,
        {
          from: this.file.state,
          to,
          artifact_kind: artifactKind,
          at: new Date().toISOString(),
          note,
        },
      ],
    };
    this.persist();   // 立刻落盘，进程崩了也不丢
  }

  // persist(): this —— 返回 this 支持链式调用（见 create 里 new SessionStore(...).persist()）。
  private persist(): this {
    writeFileSync(
      join(this.sessionDir, "state.json"),
      JSON.stringify(this.file, null, 2) + "\n",
    );
    return this;
  }
}
