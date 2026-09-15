/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/pipeline.ts —— 旧版"验证半场"（无 workflow 的差分验证执行器）
 *
 * 【这个文件是干什么的】
 *   它把一整套 fail-closed 门禁按顺序跑一遍：提交 5 个分析 artifact → 双版本构建 →
 *   （可选）sanitizer 审计 → 双版本差分运行 → 逐通道对比 → 让状态机裁决。
 *   它自己不做任何决定：每个门都是 Orchestrator 把关，它只负责"产出真实数据"。
 *
 * 【在整个项目里的位置】
 *   · 上游（谁调用 runVerification）：
 *     - src/runtime/agent-pipeline.ts（旧版带 Claude 的全流程）；
 *     - scripts/e2e-differential.ts（`bun run e2e:differential:*`，无 AI 的差分演示）；
 *     - scripts/demo-e2e.ts。
 *   · 下游：buildWorktree（builder.ts）、captureTrace（runner.ts）、runSanitizers
 *     （sanitizer-runner.ts）、compare（comparator.ts）、createWorktrees（worktree.ts）。
 *   · ⚠️ 这是**旧路径**：新版是 workflow-pipeline.ts（构建/测试由 Build/TestWorkflow 驱动，
 *     对比走 ctest-comparator 或 expectation-compare）。旧路径仍被 e2e:differential 使用。
 *
 * 【读这个文件最该看懂的三件事】
 *   ① submit() 这个小闭包：每个 artifact 都要过状态机，任何一步被拒就立刻终止（fail-closed）；
 *   ② 顺序不能变：contract → scope → deps → tests → env → baseline → patch → candidate → 对比，
 *      这正是状态机 PIPELINE 表的顺序（R1）；
 *   ③ baseline/candidate 走的是**完全相同**的构建与运行流程，差的是只有代码版本不同。
 *
 * 【先修知识】
 *   · Zod 的 .parse（Schema 校验不过会抛错）、可选属性 ?、空值合并 ??；
 *   · ReturnType<typeof fn>（"取某个函数返回值类型"的类型写法）；
 *   · try/finally（worktree 清理）。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/pipeline.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import {
  HostPreflight,
  type BehaviorContract,
  type DependencyManifest,
  type EnvironmentSpec,
  type PatchRecord,
  type ScopeManifest,
  type SanitizerResult,
  type TestSpec,
} from "../artifacts/index.js";
import { captureTrace } from "./runner.js";
import { runSanitizers } from "./sanitizer-runner.js";
import { Orchestrator, type SubmitResult } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import { buildWorktree } from "./builder.js";
import { probeHost } from "./host-preflight.js";
import { createWorktrees, resolveHead, type WorktreePair } from "./worktree.js";
// ← 旧版逐通道比较器（要求 baseline 失败在 candidate 复现，语义和 ctest-comparator 不同）
import { compare } from "./comparator.js";

// ── VerifyRequest：一次验证需要的全部材料 ───────────────────────────
// 【字段】前 4 个说明"在哪验证"：仓库、候选分支、（可选）已建好的 worktree 对、（可选）主机事实；
//        中间 5 个是分析 Agent 的产物（契约/范围/依赖/测试/环境）；
//        patch 是补丁记录，但 kind/version/base_commit_sha 三个字段由本文件自己补，
//        所以类型写成 Omit<PatchRecord, ...>（"去掉这几个字段的 PatchRecord"）。
export interface VerifyRequest {
  /** Repo containing the C project (already has the candidate branch). */
  repoPath: string;
  candidateBranch: string;
  /** Pre-created pair (agent pipeline refactors in the candidate before verifying). */
  worktrees?: WorktreePair;
  /** Measured once before analysis; reused for both builds. */
  host?: HostPreflight;
  contract: BehaviorContract;
  scope: ScopeManifest;
  deps: DependencyManifest;
  tests: TestSpec;
  env: EnvironmentSpec;
  patch: Omit<PatchRecord, "kind" | "version" | "base_commit_sha">;
}

// ← 返回值：终态字符串 + 每次提交的结果（成功/失败原因），给调用方打印用
export interface VerifyOutcome {
  state: string;
  results: SubmitResult[];
}

/**
 * Pipeline — drives one full verification attempt through the orchestrator:
 * contract → scope → deps → tests → env → baseline → patch → candidate
 * → comparison. Every gate is enforced by Orchestrator; this function only
 * produces artifacts from real builds and runs. First rejection stops the run.
 *
 * Requested sanitizers are an independent safety gate. Their results are
 * persisted as build-scoped audit artifacts and never reduced to stderr diffs.
 */
// ── runVerification：本文件唯一导出的函数（旧版验证主流程）──────────
// 【作用】按状态机顺序提交 artifact 并真的去构建/运行/对比。
// 【参数】store：会话存储（artifact 落盘、状态推进都靠它）；req：见 VerifyRequest。
// 【返回】VerifyOutcome：终态 + 全部提交结果。
// 【关系】agent-pipeline.ts 在重构+提交之后调它；e2e-differential.ts 直接调它。
//        任何一步被拒 → 立刻 return finish(...)，后面的步骤不再执行。
//        finally 里 worktrees.cleanup() —— 所以这轮跑完两个 worktree 就没了（永远冷构建）。
export function runVerification(
  store: SessionStore,
  req: VerifyRequest,
): VerifyOutcome {
  const orch = new Orchestrator(store);
  const results: SubmitResult[] = [];

  // ← submit：把"提交 + 记录 + 判断成败"收拢成一个小函数。
  //   箭头函数写法 `(raw: unknown) => boolean`；unknown 表示"任何类型都收"，类型检查交给状态机。
  const submit = (raw: unknown): boolean => {
    const result = orch.submit(raw);
    results.push(result);
    return result.ok;
  };

  // ← 前五连击：契约 → 范围 → 依赖 → 测试 → 环境。
  //   用 || 短路：前一个失败就不会提交后一个（顺序即状态机的 R1 规则）。
  if (
    !submit(req.contract) ||
    !submit(req.scope) ||
    !submit(req.deps) ||
    !submit(req.tests) ||
    !submit(req.env)
  ) {
    return finish(store, results);
  }

  // ← 主机事实：可能要补 sanitizer 实测（见下面 resolveVerificationHost 的说明）
  const host = resolveVerificationHost(store, req);
  // ← baseline 要检出的 commit：记录下来，patch-record 里也要写它
  const baseSha = resolveHead(req.repoPath);
  // ← 调用方已经建好 worktree（agent-pipeline）就直接用；否则现场建一对
  const worktrees = req.worktrees ?? createWorktrees(
    req.repoPath,
    store.sessionDir,
    req.candidateBranch,
  );

  // ← try/finally：无论哪一步失败，worktree 都会被清理
  try {
    // ── BASELINE 侧：构建 → sanitizer 审计 → 差分运行 ──
    const baselineBuild = buildWorktree(worktrees.baselineDir, req.env, host);
    const baselineSanitizer = saveSanitizerResult(
      store,
      worktrees.baselineDir,
      req,
      "baseline",
      "env-baseline-sanitized",
      host,
      baselineBuild,
    );

    if (!baselineBuild.ok) {
      // ← 构建失败：优先把 sanitizer 的结论写进原因（它可能才是真正的失败点）
      results.push(orch.abort(baselineSanitizer
        ? `baseline sanitizer ${baselineSanitizer.status}: ${failureText(baselineSanitizer)}`
        : `baseline build failed:\n${baselineBuild.log}`));
      return finish(store, results);
    }
    if (baselineSanitizer !== null && baselineSanitizer.status !== "pass") {
      // ← sanitizer 是**独立**的安全门：不 pass 就中止。
      //   本机（Windows/MinGW）缺 -lasan/-lubsan，只要环境规格要求了 sanitizer 就会走到这里，
      //   这正是教程 §1.8 说的"阶段三 UNSUPPORTED"。
      results.push(orch.abort(
        `baseline sanitizer ${baselineSanitizer.status}: ${failureText(baselineSanitizer)}`,
      ));
      return finish(store, results);
    }

    if (!submit(captureTrace(
      worktrees.baselineDir,
      req.env,
      req.tests,
      "baseline",
      "env-baseline",
    ))) {
      return finish(store, results); // R3 rejected an unexplained baseline failure.
    }

    if (!submit({
      kind: "patch-record",
      version: 1,
      ...req.patch,
      base_commit_sha: baseSha,
    })) {
      return finish(store, results); // R4 rejected an out-of-scope patch.
    }

    // ── CANDIDATE 侧：完全一样的流程，只是目录和标签不同 ──
    // ⚠️ 注意两次构建是严格串行的（先 baseline 后 candidate），没有并行——
    //    这是零基础教程"任务 8 为什么 e2e 这么慢"点名的原因之一。
    const candidateBuild = buildWorktree(worktrees.candidateDir, req.env, host);
    const candidateSanitizer = saveSanitizerResult(
      store,
      worktrees.candidateDir,
      req,
      "candidate",
      "env-candidate-sanitized",
      host,
      candidateBuild,
    );

    if (!candidateBuild.ok) {
      results.push(orch.abort(candidateSanitizer
        ? `candidate sanitizer ${candidateSanitizer.status}: ${failureText(candidateSanitizer)}`
        : `candidate build failed:\n${candidateBuild.log}`));
      return finish(store, results);
    }
    if (candidateSanitizer !== null && candidateSanitizer.status !== "pass") {
      results.push(orch.abort(
        `candidate sanitizer ${candidateSanitizer.status}: ${failureText(candidateSanitizer)}`,
      ));
      return finish(store, results);
    }

    const candidateTrace = captureTrace(
      worktrees.candidateDir,
      req.env,
      req.tests,
      "candidate",
      "env-candidate",
    );
    if (!submit(candidateTrace)) return finish(store, results); // R5 gate.

    // ← 对比需要 baseline 那份 trace；它是刚才提交时落盘的，这里从磁盘读回来
    const baselineTrace = store.trace("baseline");
    if (baselineTrace === null) {
      results.push(orch.abort("baseline trace disappeared before comparison"));
      return finish(store, results);
    }
    // ← 最后一击：对比结果决定终态（R6）——consistent → ACCEPTED，inconsistent → REJECTED
    submit(compare(req.contract, baselineTrace, candidateTrace)); // R6 decides terminal state.
    return finish(store, results);
  } finally {
    // ← 即使是调用方传进来的 worktree 也在这里被删；agent-pipeline 的 finally 再删一次也安全
    //   （worktree.ts 的 cleanup 明确写了"重复调用是安全的"）。
    worktrees.cleanup();
  }
}

// ── saveSanitizerResult：需要 sanitizer 时跑一次并落盘 ──────────────
// 【作用】环境规格里要求了 sanitizer 才做事；否则返回 null（调用方据此跳过相关判断）。
// 【返回】SanitizerResult | null。
// 【抛错】要求了 sanitizer 却没有实测的 HostPreflight → 抛错（不允许"没测就假装能跑"）。
// 【关系】内部调 sanitizer-runner.ts 的 runSanitizers；结果用 store.saveArtifact 落盘成
//        sanitizer-result.baseline.json / .candidate.json。
function saveSanitizerResult(
  store: SessionStore,
  worktreeDir: string,
  req: VerifyRequest,
  build: "baseline" | "candidate",
  envId: string,
  host: HostPreflight | undefined,
  buildResult: ReturnType<typeof buildWorktree>,
): SanitizerResult | null {
  if (req.env.sanitizers.length === 0) return null;
  if (host === undefined) {
    throw new Error("sanitizer verification requires measured HostPreflight");
  }
  const result = runSanitizers({
    worktreeDir,
    env: req.env,
    spec: req.tests,
    build,
    envId,
    host,
    buildResult,
  });
  store.saveArtifact(result);
  return result;
}

// ── failureText：把 sanitizer 的失败解释抽出来 ──────────────────────
// 【作用】拼进 abort 的 reason 里。?? 兜底："没有解释"本身也是一种要暴露的问题。
function failureText(result: SanitizerResult): string {
  return result.failure?.explanation ?? "no failure explanation";
}

// ── resolveVerificationHost：保证主机事实够用（缺就现场补测）────────
// 【作用】分两种情况：
//   ① 环境没要求 sanitizer → 现有 host（传入的 / 会话里存的）够用，直接返回；
//   ② 要求了 sanitizer → 必须确保 host.sanitizers 里**每一项**都有实测结论；
//      缺哪项就重新 probeHost（带 probeSanitizers: true）并把 sanitizer 结果合并进去。
// 【语法】`req.env.sanitizers.every((kind) => ...)` 是"全部满足才 true"；
//        HostPreflight.parse({ ...existing, sanitizers: measured.sanitizers }) 是
//        "抄一份旧的，只替换 sanitizers 字段"，再过一遍 Schema 校验。
// 【细节】每次补测完都会 store.saveHostPreflight(...) 落盘，下次就不用再测了。
function resolveVerificationHost(
  store: SessionStore,
  req: VerifyRequest,
): HostPreflight | undefined {
  if (req.env.sanitizers.length === 0) return req.host ?? store.hostPreflight() ?? undefined;

  const stored = store.hostPreflight();
  const existing = req.host ?? stored ?? undefined;
  const complete = existing !== undefined && req.env.sanitizers.every(
    (kind) => existing.sanitizers[kind] !== undefined,
  );
  if (complete) {
    store.saveHostPreflight(existing);
    return existing;
  }

  // ← 真正去测量 sanitizer 能力（会真的编译一次探针，所以放在"确实需要"时才做）
  const measured = probeHost(req.repoPath, { probeSanitizers: true });
  const enriched = existing === undefined
    ? measured
    : HostPreflight.parse({ ...existing, sanitizers: measured.sanitizers });
  store.saveHostPreflight(enriched);
  return enriched;
}

// ── finish：把返回值打包的小工具 ────────────────────────────────────
function finish(store: SessionStore, results: SubmitResult[]): VerifyOutcome {
  return { state: store.state, results };
}
