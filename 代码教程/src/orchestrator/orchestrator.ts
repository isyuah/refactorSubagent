/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/orchestrator/orchestrator.ts —— fail-closed 状态机（全项目的"裁判"）
 *
 * 【这个文件是干什么的】
 *   整个重构流程被抽象成一条状态流水线（INIT → … → ACCEPTED / REJECTED / ABORTED）。
 *   任何人（包括 Claude）想推进流程，都必须调用本文件的 Orchestrator.submit()，
 *   交上一个"当前状态正等着要"的 artifact（一份过审的结构化 JSON）。
 *   交不上、交错种类、内容不合规 → 一律拒绝推进。这就是 "fail-closed"：
 *   证不出来，就当不安全处理。
 *
 * 【在整个项目里的位置】
 *   上游：runtime/workflow-agent-pipeline.ts 和 workflow-pipeline.ts 在每个阶段
 *         结束时调用 submit() 把 artifact 交给状态机；
 *   依赖：store.ts（把 artifact 落盘、记住当前状态）、artifacts/（Zod Schema 校验）；
 *   权力：全项目只有这里能把会话状态往前推，也只有这里能给出终局裁决。
 *
 * 【先修知识】
 *   TypeScript 的联合类型 / 类型守卫、Zod（artifacts/ 目录）、Set/Map 基础。
 *   建议先读 artifacts/common.ts 和 store.ts。
 *
 * 【本文件是教程注释版】原文件 src/orchestrator/orchestrator.ts，
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

// import type { … } —— "仅类型导入"：只引入类型声明，编译后被擦除，不会真的加载模块代码。
// "../artifacts/index.js" 是"桶导出"文件，把 artifacts 目录所有类型集中再导出。
// （为什么写 .js 而不是 .ts？这是 TypeScript ESM 的惯例：编译产物里就是 .js 文件。）
import type {
  AnyArtifact,                 // 所有 artifact 的联合类型（"任意一种工件"）
  ObservationTrace,            // 逐用例行为观测（旧版路径用）
  PatchRecord,                 // 候选 patch 记录（改了哪些文件、commit 是什么）
  WorkflowResolution,          // Build/TestWorkflow 的三源决策记录
  CTestBaseline,               // CTest 基线结果（含失败分类）
  CTestCandidate,              // CTest 候选结果
  CTestComparisonResult,       // CTest 新旧对比结果
  ExpectationBaseline,         // 自驱动 TestWorkflow 基线侧期望声明
  ExpectationCandidate,        // 候选侧期望声明
  ExpectationComparisonResult, // 期望对比结果
} from "../artifacts/index.js";
import { matchGlob } from "../artifacts/scope-manifest.js"; // glob 匹配工具：判断某文件是否命中一组路径模式
import { SessionStore, type SessionState } from "./store.js"; // 会话仓库：管 state.json 与 artifacts 落盘

/**
 * Orchestrator — the only component allowed to move a session forward.
 *
 * The legacy TestSpec path and the Workflow-backed CTest path share the same
 * fail-closed gates. Models may propose artifacts; they cannot select a
 * terminal state or bypass a workflow/test stage.
 */
// ↑ 官方注释翻译：Orchestrator 是唯一允许"推动会话前进"的组件。
//   旧版 TestSpec 路径和新版 Workflow/CTest 路径共用同一套 fail-closed 闸门。
//   模型只能"提议" artifact，不能自己挑一个终态，也不能跳过某个阶段。

// ReadonlySet<string>：只读的字符串集合（Readonly 前缀 = 不允许 add/delete，防止运行时被篡改）。
// new Set([...])：ES 内置集合结构，has() 查询是 O(1)。
const TERMINAL: ReadonlySet<string> = new Set([
  "ACCEPTED",   // 接受：对比一致，候选代码可以合并
  "REJECTED",   // 拒绝：对比不一致（哪怕只差一条），候选不合并
  "ABORTED",    // 中止：结构性错误/中断（构建失败、越界、超时……）
]);

// interface：TS 的类型描述，只存在于编译期，运行时不存在。
// readonly to: … —— 属性只读；AnyArtifact["kind"] —— "取联合类型中 kind 字段的类型"（索引访问类型）。
interface TransitionRule {
  readonly to: SessionState;                       // 提交成功后转移到的状态
  readonly artifactKind: AnyArtifact["kind"];      // 当前状态期望收到的 artifact 种类
}

/** Legacy transitions plus the two explicit Workflow stages. */
// ↑ 状态转移总表：key = 当前状态，value = {期望的 artifact 种类, 目标状态}。
// Partial<Record<…>>：Record<A,B> 表示"键为 A、值为 B 的对象"；Partial 表示每个键都可缺省
//   （因为 INIT/终态等状态没有列出，缺省意味着"该状态没有普通出边"）。
const PIPELINE: Partial<Record<SessionState, TransitionRule>> = {
  // —— 前四步：AI 分析产物逐个过审（每步必须提交指定种类的 artifact，顺序不可跳）——
  INIT: { to: "CONTRACT_READY", artifactKind: "behavior-contract" },        // 行为契约
  CONTRACT_READY: { to: "SCOPE_READY", artifactKind: "scope-manifest" },    // 修改范围
  SCOPE_READY: { to: "DEPENDENCY_READY", artifactKind: "dependency-manifest" }, // 依赖清单
  DEPENDENCY_READY: { to: "TESTS_READY", artifactKind: "test-spec" },       // 测试规格
  // TESTS_READY 也接受 build workflow resolution；见 expectedTransition。
  // ↑ 注释意思是：TESTS_READY 有两条出边（普通环境规格 / 新版先交 BuildWorkflow），
  //   一张表表达不了这种分叉，所以放到下面的 expectedTransition() 里特判。
  TESTS_READY: { to: "ENV_READY", artifactKind: "environment-spec" },       // 环境规格（旧路径直通）
  BUILD_WORKFLOW_READY: {
    to: "TEST_WORKFLOW_READY",
    artifactKind: "workflow-resolution",   // 新路径：再交 TestWorkflow 决策
  },
  TEST_WORKFLOW_READY: { to: "ENV_READY", artifactKind: "environment-spec" }, // 两个 workflow 都定了，才交环境
  // —— 以下是"执行与验证"半场 ——
  ENV_READY: { to: "BASELINE_READY", artifactKind: "observation-trace" },   // 旧路径：基线观测
  BASELINE_READY: { to: "PATCH_CREATED", artifactKind: "patch-record" },    // Claude 改完，patch 入库
  PATCH_CREATED: {
    to: "VERIFICATION_RUNNING",
    artifactKind: "observation-trace",     // 旧路径：候选观测
  },
  VERIFICATION_RUNNING: { to: "ACCEPTED", artifactKind: "comparison-result" }, // 旧路径：对比结果定生死
};

// 联合类型 + 字面量：submit() 的返回值只有两种形状（成功 / 失败）。
// 用 "ok: true" / "ok: false" 做可辨识联合的"标签"，调用方 if (result.ok) 后 TS 能自动收窄字段。
export type SubmitResult =
  | { ok: true; from: SessionState; to: SessionState }   // 成功：报告从哪转移到哪
  | { ok: false; reason: string };                       // 失败：一句人话原因（⚠️ 任务清单 #6A 想把它结构化）

export class Orchestrator {
  // 构造函数参数简写：`private readonly store: SessionStore` 直接声明并赋值 this.store。
  // "组合优于继承"：状态机本身不存数据，全部委托给 SessionStore。
  constructor(private readonly store: SessionStore) {}

  /** Advance the session using an artifact; domain violations never throw. */
  // ↑ 用 artifact 推进会话；业务违规一律"返回失败"而绝不抛异常——调用方不用写 try/catch。
  // raw: unknown —— 刻意用 unknown（未知类型）：调用方可能传来任何 JSON，
  //   我们不信任它的形状，必须先过 Zod 校验（见 saveArtifact）。
  submit(raw: unknown): SubmitResult {
    const current = this.store.state;        // 从 store 读当前状态（会话的唯一事实来源）
    const rule = PIPELINE[current];          // 查表：当前状态有没有普通出边？
    if (!rule) {
      // 没出边的情况有两种：已经到了终态（R7：终态不可变），或者表里压根没定义。
      return {
        ok: false,
        reason: TERMINAL.has(current)
          ? `terminal state ${current} is immutable (R7)`   // R7：终态不可变
          : `no transition defined from ${current}`,
      };
    }

    let artifact: AnyArtifact;
    try {
      // R2: parse before inspecting kind or semantics.
      // ↑ R2（先过 Schema 再谈别的）：saveArtifact 内部会用 Zod 校验 raw，
      //   校验不过会抛错 → 这里把它转成一句失败原因。
      artifact = this.store.saveArtifact(raw);
    } catch (error) {
      return { ok: false, reason: `artifact rejected by schema: ${msg(error)}` };
    }

    // 第 2 道闸门：种类对不对？（R1 —— 只能交"当前状态期望的种类"，不许跳阶段/乱序）
    const transition = expectedTransition(current, artifact, rule);
    if (transition.error !== null) {
      return { ok: false, reason: transition.error };
    }

    // 第 3 道闸门：内容语义合不合规？（R3/R4/R5 等，见下方 checkSemantic）
    const semantic = this.checkSemantic(current, artifact);
    if (semantic !== null) return { ok: false, reason: semantic };

    // R6: terminal state is derived from a program-checked comparison.
    // ↑ R6（裁决只看对比结果）：三连三元表达式（a ? x : (b ? y : z)）依次检查三种对比
    //   artifact；只要 overall === "inconsistent"，无论转移表写到哪，一律改判 REJECTED。
    //   —— 这行是"模型无权宣布安全"的最终落实：对比结果必须由程序重新计算核实（见
    //   checkCTestComparison），模型哪怕伪造 overall 也过不了语义审计。
    const to = artifact.kind === "comparison-result" && artifact.overall === "inconsistent"
      ? "REJECTED"
      : artifact.kind === "ctest-comparison-result" && artifact.overall === "inconsistent"
        ? "REJECTED"
        : artifact.kind === "expectation-comparison-result" && artifact.overall === "inconsistent"
          ? "REJECTED"
          : transition.to;

    this.store.commitTransition(to, artifact.kind);  // 写入 state.json + history
    return { ok: true, from: current, to };
  }

  /** Abort from any non-terminal state. */
  // ↑ 任何非终态都可以直接中止（比如构建失败、分析失败）。终态不行（R7）。
  abort(reason: string): SubmitResult {
    const from = this.store.state;
    if (TERMINAL.has(from)) {
      return { ok: false, reason: `terminal state ${from} is immutable (R7)` };
    }
    // commitTransition 第二个参数传 null：中止不是由某个 artifact 触发的。
    this.store.commitTransition("ABORTED", null, reason);
    return { ok: true, from, to: "ABORTED" };
  }

  // ── checkSemantic：语义审计（第 3 道闸门）───────────────────────────────
  // 【作用】按"当前状态 + artifact 种类"分发到各个专项检查；返回 null 表示通过，
  //   返回字符串就是拒绝原因。注意它需要回读 store 里"之前提交过的 artifact"做交叉验证。
  // 【关系】被 submit() 调用；内部用到 store.artifact()/trace() 回查历史证据。
  private checkSemantic(from: SessionState, artifact: AnyArtifact): string | null {
    // —— TESTS_READY 交来 BuildWorkflow 决策：记录必须"干净"（build 类，且不引用上游）——
    if (from === "TESTS_READY" && artifact.kind === "workflow-resolution") {
      if (artifact.workflow_kind !== "build" || artifact.build_workflow !== null) {
        return "BuildWorkflow resolution has an invalid dependency record";
        // ↑ BuildWorkflow 是起点，不允许再引用别的 BuildWorkflow（那是 TestWorkflow 的事）。
      }
    }
    // —— BUILD_WORKFLOW_READY 交来 TestWorkflow 决策：必须引用"刚提交的那个 BuildWorkflow"——
    if (from === "BUILD_WORKFLOW_READY" && artifact.kind === "workflow-resolution") {
      if (artifact.workflow_kind !== "test") {
        return "TestWorkflow resolution has an invalid BuildWorkflow dependency";
      }
      if (artifact.mode === "declared") {
        // Declared-mode test workflows are self-driven: build dependencies live
        // in the DeclaredBuildSet artifact, not a single static reference.
        // ↑ ★ B 方案：declared 模式的构建依赖集中记在 DeclaredBuildSet 里，
        //   这里只审计"凭证存在"——依赖内容本身的正确性由 resolve-declared 保证。
        const set = this.store.artifact("declared-build-set");
        if (set === null) {
          return "DeclaredBuildSet missing — cannot audit TestWorkflow dependency";
        }
      } else {
        if (artifact.build_workflow === null) {
          return "TestWorkflow resolution has an invalid BuildWorkflow dependency";
        }
        const build = this.store.workflowResolution("build");  // 回查已入库的 build 决策
        if (build === null || build.workflow_kind !== "build") {
          return "BuildWorkflow resolution missing — cannot audit TestWorkflow dependency";
        }
        if (
          artifact.build_workflow.id !== build.workflow_id ||
          artifact.build_workflow.revision !== build.workflow_revision
        ) {
          // ⚠️ 防止"测试工作流绑定到另一个版本的构建工作流"——构建和测试必须配套。
          return "TestWorkflow resolution references a different BuildWorkflow";
        }
      }
    }
    // —— ENV_READY：接受三种"基线结果"（旧观测 / CTest 基线 / 期望基线）——
    if (from === "ENV_READY") {
      if (artifact.kind === "observation-trace") return checkBaseline(artifact);          // R3（旧路径）
      if (artifact.kind === "ctest-baseline") return checkCTestBaseline(artifact);        // R3（CTest 路径）
      if (artifact.kind === "expectation-baseline") {
        // Baseline side must have run cleanly (workflow_passed is enforced
        // by the schema literal true).
        // ↑ 期望基线不需要额外审计：schema 里 workflow_passed 是 z.literal(true)，
        //   "必须跑成功"已经在 Schema 层强制了（跑失败根本存不进来）。
        return null;
      }
    }
    if (from === "BASELINE_READY" && artifact.kind === "patch-record") {
      return checkPatchScope(this.store, artifact);   // R4：patch 只许改白名单文件
    }
    if (from === "PATCH_CREATED") {
      if (artifact.kind === "observation-trace") return checkCandidate(this.store, artifact);       // R5（旧）
      if (artifact.kind === "ctest-candidate") return checkCTestCandidate(this.store, artifact);    // R5（CTest）
    }
    if (from === "VERIFICATION_RUNNING" && artifact.kind === "ctest-comparison-result") {
      return checkCTestComparison(this.store, artifact);      // R6：程序重算对比，不许模型说了算
    }
    if (from === "VERIFICATION_RUNNING" && artifact.kind === "expectation-comparison-result") {
      return checkExpectationComparison(this.store, artifact); // R6（自驱动路径）
    }
    return null;  // 其余组合：类型对了即可通过
  }
}

interface ExpectedTransition {
  readonly to: SessionState;
  readonly error: string | null;
}

// ── expectedTransition：R1 的实现（种类闸门）────────────────────────────
// 【作用】判断"当前状态 + 交来的 artifact"是否匹配转移表；分叉路径在这里特判。
// 【参数】current 当前状态；artifact 交来的工件；rule 转移表里查到的默认规则。
// 【返回】{ to, error }——error 非 null 即拒绝。
function expectedTransition(
  current: SessionState,
  artifact: AnyArtifact,
  rule: TransitionRule,
): ExpectedTransition {
  // New path: test intent → build workflow → test workflow → environment.
  // ↑ 新路径顺序铁律：必须先定 BuildWorkflow 再定 TestWorkflow，不许跳。
  // ★ B 方案新增快速通道：TESTS_READY 直接收 DeclaredBuildSet（声明制下
  //   "构建方案"由 test-writer 一次性声明，单凭证即可推进到 BUILD_WORKFLOW_READY）。
  if (current === "TESTS_READY" && artifact.kind === "declared-build-set") {
    return { to: "BUILD_WORKFLOW_READY", error: null };
  }
  if (current === "TESTS_READY" && artifact.kind === "workflow-resolution") {
    return artifact.workflow_kind === "build"
      ? { to: "BUILD_WORKFLOW_READY", error: null }   // 正确：先交 build
      : {
          to: rule.to,
          error: "R1 violation: TESTS_READY requires a build workflow resolution first",
        };                                            // 越级交 test → 拒绝
  }
  if (current === "BUILD_WORKFLOW_READY" && artifact.kind === "workflow-resolution") {
    return artifact.workflow_kind === "test"
      ? { to: "TEST_WORKFLOW_READY", error: null }
      : {
          to: rule.to,
          error: "R1 violation: BUILD_WORKFLOW_READY requires a test workflow resolution",
        };
  }

  // New path: the actual CTest suite is an execution artifact, not an
  // ObservationTrace pretending to be a test suite.
  // ↑ CTest 结果是"执行工件"，不该伪装成旧版的 ObservationTrace——所以每种都有专属转移。
  if (current === "ENV_READY" && artifact.kind === "ctest-baseline") {
    return { to: "BASELINE_READY", error: null };
  }
  if (current === "PATCH_CREATED" && artifact.kind === "ctest-candidate") {
    return { to: "VERIFICATION_RUNNING", error: null };
  }
  if (current === "VERIFICATION_RUNNING" && artifact.kind === "ctest-comparison-result") {
    return { to: "ACCEPTED", error: null };
  }
  // —— 自驱动 TestWorkflow 路径的三个对应转移 ——
  if (current === "ENV_READY" && artifact.kind === "expectation-baseline") {
    return { to: "BASELINE_READY", error: null };
  }
  if (current === "PATCH_CREATED" && artifact.kind === "expectation-candidate") {
    return { to: "VERIFICATION_RUNNING", error: null };
  }
  if (current === "VERIFICATION_RUNNING" && artifact.kind === "expectation-comparison-result") {
    return { to: "ACCEPTED", error: null };
  }

  // 兜底：回到转移表的普通规则——种类不符即 R1 违规。
  if (artifact.kind !== rule.artifactKind) {
    return {
      to: rule.to,
      error: `R1 violation: ${current} requires '${rule.artifactKind}', got '${artifact.kind}'`,
    };
  }
  return { to: rule.to, error: null };
}

// ── checkExpectationComparison：期望对比的语义审计 ───────────────────────
// 【作用】自驱动路径的 R6：不信任提交来的对比结果，回查两侧基线/候选工件，
//   并检查"自称 consistent 的结果里不允许混入未匹配声明或结构错误"。
// 【参数】store 会话仓库；artifact 提交来的期望对比结果。
// 【返回】null = 通过；字符串 = 拒绝原因。
function checkExpectationComparison(
  store: SessionStore,
  artifact: ExpectationComparisonResult,
): string | null {
  const baseline = store.artifact("expectation-baseline");     // 回查基线侧声明
  const candidate = store.artifact("expectation-candidate");   // 回查候选侧声明
  if (baseline === null || candidate === null) {
    return "expectation baseline/candidate artifact missing — cannot compare";
  }
  if (artifact.overall === "consistent") {
    // some()：数组里只要有一个元素让回调返回 true，整体就是 true（存在性判断）。
    if (artifact.declarations.some((decl) => !decl.matched)) {
      return "expectation comparison marked consistent but has unmatched declarations";
    }
    if (artifact.errors.length > 0) {
      return "expectation comparison marked consistent but has structural errors";
    }
  }
  return null;
}

// 小工具：把任意抛出的值转成可读字符串（unknown 类型必须先收窄才能用 .message）。
function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** R3 for the legacy invocation-level baseline trace. */
// ── checkBaseline：R3（旧路径版）────────────────────────────────────────
// 【作用】baseline（改动前版本）跑出的每个失败都必须"可证明与本次修改无关"：
//   要么是 preexisting_behavior（原有行为如此），要么是 environment 且与范围无关。
//   任何 unknown / scope 相关的失败 → 阻断整个流程（fail-closed）。
function checkBaseline(artifact: ObservationTrace): string | null {
  if (artifact.build !== "baseline") {
    return `expected a baseline build trace, got '${artifact.build}'`;
  }
  for (const failure of artifact.failures) {
    const provablyUnrelated =
      failure.category === "preexisting_behavior" ||
      (failure.category === "environment" && !failure.related_to_scope);
    if (!provablyUnrelated) {
      // 字符串用 + 拼接（跨行）；也可以用模板字符串 `…${x}…`，效果一样。
      return (
        `R3 violation: baseline failure on '${failure.case_id}' (${failure.category}) ` +
        "cannot be proven unrelated to the modification scope"
      );
    }
  }
  return null;
}

/** R3 for a complete CTest suite. Unknown and scope-related failures stop. */
// ── checkCTestBaseline：R3（CTest 路径版）───────────────────────────────
// 【作用】双向审计：① 每个失败都必须有分类；② 每条分类必须真实对应一个失败，
//   且不允许 unknown / scope_related / related_to_scope=true。
// 【为什么重要】libuv 实测中 Windows 网络类失败被分类为 environment 后流程才得以继续；
//   而一旦出现解释不了的失败，就按 fail-closed 停止。
function checkCTestBaseline(artifact: CTestBaseline): string | null {
  const failedNames = ctestFailureNames(artifact);   // 实际失败集合（Set）
  const classifiedNames = new Set(
    artifact.failure_classifications.map((failure) => failure.test),
  );                                                  // 分类覆盖的集合
  for (const name of failedNames) {
    if (!classifiedNames.has(name)) {
      return `R3 violation: CTest baseline failure '${name}' has no classification`;
    }
  }
  for (const classification of artifact.failure_classifications) {
    if (!failedNames.has(classification.test)) {
      return `R3 violation: classification has no corresponding CTest failure '${classification.test}'`;
    }
    if (
      classification.category === "unknown" ||
      classification.category === "scope_related" ||
      classification.related_to_scope
    ) {
      return (
        `R3 violation: CTest baseline failure '${classification.test}' ` +
        `is ${classification.category} or scope-related`
      );
    }
  }
  return null;
}

// ── ctestFailureNames：提取"失败名字集合"（带一个补丁）──────────────────
// 【作用】收集 failed_tests 的名字；⚠️ 特殊情况：套件整体崩了但一条具名失败都没有
//   （比如可执行文件都没跑起来），此时合成一个虚拟名 "__suite__" 当作唯一失败，
//   防止"零失败"被误读成"没问题"。
function ctestFailureNames(artifact: CTestBaseline | CTestCandidate): Set<string> {
  const names = new Set(artifact.result.failed_tests.map((failure) => failure.name));
  if (names.size === 0 && artifact.result.status !== "pass") names.add("__suite__");
  return names;
}

/** R4: patch must stay inside Modification Scope. */
// ── checkPatchScope：R4（越界修改检查）─────────────────────────────────
// 【作用】Claude 实际改的文件（changed_files）必须全部命中 ScopeManifest 的 editable 白名单。
//   这是第三道防线：第 1 道 = PreToolUse hook 拦工具调用，第 2 道 = git diff 确认，
//   这里是状态机层面的最终复核。
function checkPatchScope(store: SessionStore, artifact: PatchRecord): string | null {
  const scope = store.artifact("scope-manifest");   // 回查之前提交的范围清单
  if (scope === null) return "scope manifest missing — cannot verify patch scope";
  const editablePaths = scope.editable_files.map((target) => target.file);
  // filter + matchGlob：留下"不在白名单里"的文件。matchGlob(路径, 模式数组) 任一命中即算在内。
  const outside = artifact.changed_files.filter((file) => !matchGlob(file, editablePaths));
  if (outside.length > 0) {
    return `R4 violation: patch touches non-editable files: ${outside.join(", ")}`;
  }
  return null;
}

/** R5 for the legacy invocation-level candidate trace. */
// ── checkCandidate：R5（旧路径版）──────────────────────────────────────
// 【作用】candidate 观测的用例集合必须和 baseline 完全一致——多测、漏测都不行。
//   否则"对比一致"就没有意义（可能只是没测到）。
function checkCandidate(store: SessionStore, artifact: ObservationTrace): string | null {
  if (artifact.build !== "candidate") {
    return `expected a candidate build trace, got '${artifact.build}'`;
  }
  const baseline = store.trace("baseline");
  if (baseline === null) return "baseline trace missing — cannot compare case coverage";
  const baseIds = new Set(baseline.observations.map((observation) => observation.case_id));
  const candidateIds = new Set(artifact.observations.map((observation) => observation.case_id));
  // 展开运算符 [...set] 把 Set 转数组；filter + has 做"集合差"。
  const missing = [...baseIds].filter((id) => !candidateIds.has(id));   // baseline 有、candidate 没有
  const extra = [...candidateIds].filter((id) => !baseIds.has(id));     // candidate 多出来的
  if (missing.length > 0 || extra.length > 0) {
    return `R5 violation: case set drift — missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`;
  }
  return null;
}

// ── checkCTestCandidate：R5（CTest 路径版，较宽松）──────────────────────
// 【作用】候选套件至少要观测到顶层测试（防止"啥也没跑"被当成通过）；
//   用例集合一致性的强校验放在对比阶段（checkCTestComparison）做。
function checkCTestCandidate(store: SessionStore, artifact: CTestCandidate): string | null {
  const baseline = store.artifact("ctest-baseline");
  if (baseline === null) return "CTest baseline missing — cannot compare candidate suite";
  if (artifact.result.top_level_tests.length === 0) {
    return "R5 violation: candidate CTest observed no top-level tests";
  }
  return null;
}

/** Recompute all CTest comparison fields from persisted baseline/candidate evidence. */
// ── checkCTestComparison：R6 的核心（程序重算裁决）──────────────────────
// 【作用】这是全项目最能体现 fail-closed 的函数：模型提交来的对比结果，这里
//   不信——而是回查两侧落盘的原始证据，自己重新算一遍 added/removed/overall，
//   逐字段比对。任何字段"对不上"（drift，漂移）都拒绝。
// 【关系】被 checkSemantic 在 VERIFICATION_RUNNING 状态调用；依赖 store 里的
//   ctest-baseline / ctest-candidate 两个工件。
function checkCTestComparison(
  store: SessionStore,
  artifact: CTestComparisonResult,
): string | null {
  const baseline = store.artifact("ctest-baseline");
  const candidate = store.artifact("ctest-candidate");
  if (baseline === null || candidate === null) {
    return "CTest baseline/candidate artifact missing — cannot compare suites";
  }

  // —— 第一步：从原始证据重算对比字段 ——
  const baseFailures = ctestFailureNames(baseline);
  const candidateFailures = ctestFailureNames(candidate);
  const added = setDifference(candidateFailures, baseFailures);     // 新增失败（candidate 有、baseline 无）
  const removed = setDifference(baseFailures, candidateFailures);   // 消失失败（可能是行为变化！）
  const sameTopLevel = sameSet(
    new Set(baseline.result.top_level_tests),
    new Set(candidate.result.top_level_tests),
  );
  const sameFailures = added.length === 0 && removed.length === 0;
  const sameStatus = baseline.result.status === candidate.result.status;
  const expectedOverall = sameTopLevel && sameFailures && sameStatus
    ? "consistent"     // 全部相同 → 一致（⚠️ 注意：两侧"同样失败"今天也算 consistent，
                       //   且没有任何警告——这正是任务清单 #9 要加 warnings 的地方）
    : "inconsistent";

  // —— 第二步：逐字段核对提交来的结果与程序重算值 ——
  if (artifact.baseline_status !== baseline.result.status) return "CTest comparison baseline status drift";
  if (artifact.candidate_status !== candidate.result.status) return "CTest comparison candidate status drift";
  if (!sameArray(artifact.baseline_top_level_tests, baseline.result.top_level_tests)) {
    return "CTest comparison baseline top-level test set drift";
  }
  if (!sameArray(artifact.candidate_top_level_tests, candidate.result.top_level_tests)) {
    return "CTest comparison candidate top-level test set drift";
  }
  if (!sameArray(artifact.baseline_failed_tests, [...baseFailures])) {
    return "CTest comparison baseline failure set drift";
  }
  if (!sameArray(artifact.candidate_failed_tests, [...candidateFailures])) {
    return "CTest comparison candidate failure set drift";
  }
  if (!sameArray(artifact.added_failures, added) || !sameArray(artifact.removed_failures, removed)) {
    return "CTest comparison delta drift";
  }
  // 最终裁决核对：overall 必须等于程序重算值。
  if (artifact.overall !== expectedOverall) {
    return `R6 violation: program recomputed CTest verdict is ${expectedOverall}`;
  }
  return null;
}

// ── 三个小工具函数（纯函数：不依赖任何外部状态，输入定输出）───────────────

// 集合差：left 有 right 没有 的元素，排序后返回数组（排序保证输出稳定、可比较）。
function setDifference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

// 集合相等：大小相同且每个元素都存在于对方。
function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

// 数组"当作集合"比较：忽略顺序和重复。
function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return sameSet(new Set(left), new Set(right));
}
