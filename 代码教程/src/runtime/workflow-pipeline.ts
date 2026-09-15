/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/workflow-pipeline.ts —— 验证半场（AI 阶段结束后的全部执行与裁决）
 *
 * 【这个文件是干什么的】
 *   runWorkflowVerification() 接手"AI 已经完成分析/声明/重构"的现场：
 *   把 artifact 依次提交状态机 → 双 worktree 构建与测试 → 对比 → 裁决。
 *   它有三条路径：
 *   ① 声明制自驱动（B 方案主路径）：DeclaredBuildSet 凭证 + N 个 build 循环执行
 *      + 自驱动 TestWorkflow 两侧 ctx.expect 差分（runDeclaredWorkflowVerification）；
 *   ② 单 build 自驱动（旧自驱动）：runSelfDrivenVerification；
 *   ③ 声明式 CTest：materialize 成 CTestSuiteSpec 跑 ctest + compareCTestSuites。
 *
 * 【贯穿全程的纪律】
 *   - submit() 闭包：每个 artifact 提交状态机，失败立即 abort 并停（fail-closed）；
 *   - 每个执行产物都 saveArtifact + logger.artifact 落盘（可审计）；
 *   - 任一构建失败 → abort（"任一 build 失败"是 B 方案的多构建纪律）。
 *
 * 【本文件是教程注释版】原文件 src/runtime/workflow-pipeline.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import type {
  BehaviorContract,
  BuildWorkflowOutput,
  CTestBaseline,
  CTestCandidate,
  CTestComparisonResult,
  DeclaredBuildSet as DeclaredBuildSetValue,   // as 起别名：类型与值同名时区分用
  DependencyManifest,
  HostPreflight,
  PatchRecord,
  ProjectDetection,
  ScopeManifest,
  TestSpec,
  WorkflowResolution,
} from "../artifacts/index.js";
import { EnvironmentSpec } from "../artifacts/index.js";
import { Orchestrator, type SubmitResult } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import { materializeTestWorkflow, type TestWorkflowResolution } from "../workflow/test-workflow.js";
import type { BuildWorkflowResolution } from "../workflow/build-workflow.js";
import { executeBuildWorkflow, type BuildWorkflowExecution } from "../workflow/build-executor.js";
import { classifyCTestBaseline, compareCTestSuites, createCTestCandidate } from "./ctest-comparator.js";
import { runCTest } from "./ctest-runner.js";
import { runTestSide } from "../workflow/test-executor.js";
import { compareExpectations } from "../workflow/expectation-compare.js";
import {
  ExpectationBaseline,
  ExpectationCandidate,
  ExpectationComparisonResult,
} from "../artifacts/index.js";
import type { WorktreePair } from "./worktree.js";
import type { E2ELogger } from "./e2e-log.js";

// 验证请求：调用方把"AI 阶段的全部成果"打包进来（artifact + 决策 + patch）。
export interface WorkflowVerificationRequest {
  readonly repoPath: string;
  readonly worktrees: WorktreePair;             // baseline/candidate 两个 worktree
  readonly store: SessionStore;                 // 状态机仓库
  readonly logger?: E2ELogger;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly contract: BehaviorContract;
  readonly scope: ScopeManifest;
  readonly deps: DependencyManifest;
  readonly tests: TestSpec;
  readonly buildResolution: WorkflowResolution;
  readonly testResolution: WorkflowResolution;
  readonly build: BuildWorkflowResolution;      // 主 build（旧路径单 build / 声明制的代表项）
  readonly test: TestWorkflowResolution;
  /** Declared-set mode artifact (carries the whole declaration set). */
  readonly declaredSet?: DeclaredBuildSetValue;   // ★ B 方案：声明集凭证（有它 = 声明制模式）
  /** Declared build resolutions, in declaration order (executed each side). */
  readonly declaredBuilds?: readonly BuildWorkflowResolution[];   // ★ 按声明顺序的 N 个 build
  readonly patch: Omit<PatchRecord, "kind" | "version" | "base_commit_sha">;
  // Omit<>：从 PatchRecord 里去掉三个"由宿主补"的字段（base_commit_sha 来自 worktree）。
  readonly buildTimeoutMs?: number;
  readonly ctestTimeoutMs?: number;
  readonly knownEnvironmentPatterns?: readonly RegExp[];   // 环境失败识别的模式表
}

// 验证结果：终态 + 全部提交记录 + 双侧构建/测试/对比的证据对象。
export interface WorkflowVerificationOutcome {
  readonly state: string;
  readonly results: SubmitResult[];
  readonly baselineBuild: BuildWorkflowExecution | null;
  readonly candidateBuild: BuildWorkflowExecution | null;
  readonly baseline: CTestBaseline | null;
  readonly candidate: CTestCandidate | null;
  readonly comparison: CTestComparisonResult | null;
}

/**
 * Execute one complete Workflow-backed CTest verification attempt.
 *
 * Claude supplies the analysis artifacts and patch; this function owns every
 * execution decision after that point. Both worktrees receive the exact same
 * validated BuildWorkflow and materialized TestWorkflow.
 */
export async function runWorkflowVerification(
  request: WorkflowVerificationRequest,
): Promise<WorkflowVerificationOutcome> {
  const orch = new Orchestrator(request.store);
  const results: SubmitResult[] = [];
  // ── submit 闭包：所有 artifact 的唯一入口 ───────────────────────────────
  // 提交状态机 → 留痕 → 失败就 abort 并返回 false（调用方用 || 短路层层止步）。
  const submit = (artifact: unknown): boolean => {
    const result = orch.submit(artifact);
    results.push(result);
    request.logger?.info(
      result.ok
        ? `state transition ${result.from} -> ${result.to}`
        : `artifact rejected: ${result.reason}`,
      result.ok
        ? { artifact: kindOf(artifact), to: result.to }
        : { artifact: kindOf(artifact), reason: result.reason },
    );
    if (!result.ok) {
      request.logger?.error(`workflow verification stopped: ${result.reason}`);
      results.push(orch.abort(`workflow verification rejected an artifact: ${result.reason}`));
      return false;
    }
    return true;
  };

  // 前四个是固定顺序的分析产物：契约 → 范围 → 依赖 → 测试。
  if (!submit(request.contract) ||
      !submit(request.scope) ||
      !submit(request.deps) ||
      !submit(request.tests)) {
    return emptyOutcome(request.store.state, results);
  }
  if (request.declaredSet !== undefined) {
    // Declared mode: the single DeclaredBuildSet artifact carries the whole
    // declaration (N build resolutions are executed later); it transitions
    // TESTS_READY -> BUILD_WORKFLOW_READY, then the declared test resolution
    // -> TEST_WORKFLOW_READY. No per-build workflow-resolution artifact exists
    // in this mode (the set is the audit record).
    // ↑ ★ 声明制：一份 DeclaredBuildSet 顶替"N 份 build 决策"，集合本身即审计记录。
    if (!submit(request.declaredSet)) return emptyOutcome(request.store.state, results);
    if (!submit(request.testResolution)) return emptyOutcome(request.store.state, results);
  } else {
    if (!submit(request.buildResolution)) return emptyOutcome(request.store.state, results);
    if (!submit(request.testResolution)) return emptyOutcome(request.store.state, results);
  }

  // workflow-driven builds have no static plan at resolution time; the host
  // supplies the fixed environment shape and execution fills in the output.
  // ↑ 自驱动构建 resolve 时没有静态计划：环境规格由宿主给固定形状，
  //   output 留到执行期填。声明式则直接用 workflow 返回的 environment。
  const environment = request.build.output === null
    ? EnvironmentSpec.parse({
        kind: "environment-spec",
        version: 1,
        build: { kind: "workflow-driven" },
        sanitizers: [],
        determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },
        sandbox: { run_cwd_strategy: "fresh_temp_dir" },
      })
    : EnvironmentSpec.parse(request.build.output.environment);
  if (!submit(environment)) return emptyOutcome(request.store.state, results);

  // Self-driven test workflows (workflow === null) execute their own test
  // logic once per worktree and declare expectations; the host compares.
  // 路径分叉：test.workflow === null → 自驱动；否则 → 声明式 CTest。
  if (request.test.workflow === null) {
    if (request.declaredBuilds !== undefined && request.declaredBuilds.length > 0) {
      const buildList = request.declaredBuilds.map((resolution) => ({
        id: resolution.manifest.id,
        resolution,
      }));
      return runDeclaredWorkflowVerification(request, orch, results, submit, environment, buildList);
    }
    return runSelfDrivenVerification(request, orch, results, submit, environment);
  }

  // —— 声明式 CTest 路径 ——
  // materialize：把声明 + 宿主策略（超时默认 120 万毫秒、串行）合成执行规格。
  const suite = materializeTestWorkflow(request.test, {
    timeout_ms: request.ctestTimeoutMs ?? 1_200_000,
    parallelism: 1,   // ⚠️ 硬编码串行（性能点，见任务 8）
  });
  if (suite === null) {
    results.push(orch.abort("TestWorkflow is not a CTest workflow; this executor requires CTest"));
    return emptyOutcome(request.store.state, results);
  }

  // ── baseline 构建 → CTest → 失败分类（R3 闸门）──────────────────────────
  const baselineBuild = await executeBuild(
    request,
    request.worktrees.baselineDir,
    "baseline",
  );
  if (baselineBuild.status !== "pass") {
    results.push(orch.abort(`baseline BuildWorkflow failed: ${baselineBuild.failure ?? "unknown failure"}`));
    return { ...emptyOutcome(request.store.state, results), baselineBuild };
  }

  const baselineResult = await runSuite(request, request.worktrees.baselineDir, suite, "baseline");
  const baseline = classifyCTestBaseline(baselineResult, {
    scopeFiles: request.scope.editable_files.map((target) => target.file),
    scopeSymbols: request.scope.editable_files.flatMap((target) => target.symbols),   // flatMap：展平成一层
    knownEnvironmentPatterns: request.knownEnvironmentPatterns,
  });   // R3：baseline 失败必须全部有解释，unknown/scope 相关 → 状态机拒绝
  request.store.saveArtifact(baseline);
  request.logger?.artifact("ctest-baseline.json", baseline);
  if (!submit(baseline)) {
    return { ...emptyOutcome(request.store.state, results), baselineBuild, baseline };
  }

  // patch-record：宿主补上 base_commit_sha 后提交（R4 在状态机里查白名单）。
  const patch: PatchRecord = {
    kind: "patch-record",
    version: 1,
    ...request.patch,
    base_commit_sha: request.worktrees.baseSha,
  };
  if (!submit(patch)) {
    return { ...emptyOutcome(request.store.state, results), baselineBuild, baseline };
  }

  // ── candidate 构建 → CTest → 提交 ──────────────────────────────────────
  const candidateBuild = await executeBuild(
    request,
    request.worktrees.candidateDir,
    "candidate",
  );
  if (candidateBuild.status !== "pass") {
    results.push(orch.abort(`candidate BuildWorkflow failed: ${candidateBuild.failure ?? "unknown failure"}`));
    return { ...emptyOutcome(request.store.state, results), baselineBuild, baseline, candidateBuild };
  }

  const candidateResult = await runSuite(request, request.worktrees.candidateDir, suite, "candidate");
  const candidate = createCTestCandidate(candidateResult);
  request.store.saveArtifact(candidate);
  request.logger?.artifact("ctest-candidate.json", candidate);
  if (!submit(candidate)) {
    return {
      ...emptyOutcome(request.store.state, results),
      baselineBuild,
      candidateBuild,
      baseline,
      candidate,
    };
  }

  // ── 对比 → 裁决（R6：consistent → ACCEPTED / inconsistent → REJECTED）────
  const comparison = compareCTestSuites(baseline, candidate);
  request.store.saveArtifact(comparison);
  request.logger?.artifact("ctest-comparison-result.json", comparison);
  submit(comparison);
  return {
    state: request.store.state,
    results,
    baselineBuild,
    candidateBuild,
    baseline,
    candidate,
    comparison,
  };
}

/**
 * Self-driven TestWorkflow path: build both worktrees, run the test workflow
 * once per side (it declares expectations via ctx.expect), then compare the
 * two sides' declarations by position with the declared relations.
 */
// 单 build 的自驱动路径：把唯一的 build 包成列表走通用核心。
interface BuildToExecute {
  readonly id: string;
  readonly resolution: BuildWorkflowResolution;
}

async function runSelfDrivenVerification(
  request: WorkflowVerificationRequest,
  orch: Orchestrator,
  results: SubmitResult[],
  submit: (artifact: unknown) => boolean,
  environment: unknown,
): Promise<WorkflowVerificationOutcome> {
  return runSelfDrivenCore(
    request, orch, results, submit, environment,
    [{ id: request.build.manifest.id, resolution: request.build }],
  );
}

// ── runSelfDrivenCore：自驱动路径的通用核心（单 build / N build 共用）───────
// 流程：baseline 全部构建 → 跑 test（收 expect）→ 提交基线 → patch →
//       candidate 全部构建 → 跑 test → 提交候选 → 配对比较 → 裁决。
async function runSelfDrivenCore(
  request: WorkflowVerificationRequest,
  orch: Orchestrator,
  results: SubmitResult[],
  submit: (artifact: unknown) => boolean,
  environment: unknown,
  buildList: readonly BuildToExecute[],
): Promise<WorkflowVerificationOutcome> {
  // 小工具：空结果 + 额外字段的合并（每个失败出口都用它，避免重复）。
  const empty = (extra: Record<string, unknown> = {}) => ({
    ...emptyOutcome(request.store.state, results),
    ...extra,
  });

  // Run every build in the (declaration) set on the baseline worktree.
  // ★ B 方案：按声明顺序逐个执行全部 build——任一失败整体失败。
  const baselineBuild = await executeBuildList(request, request.worktrees.baselineDir, "baseline", buildList);
  if (baselineBuild.status !== "pass") {
    results.push(orch.abort(`baseline BuildWorkflow failed: ${baselineBuild.failure ?? "unknown failure"}`));
    return empty({ baselineBuild });
  }

  request.logger?.phase("BASELINE_TEST_WORKFLOW");
  // 在 baseline worktree 跑一次自驱动测试（workflow 不知道自己在哪侧）。
  const baselineRun = await runTestSide(request.test.entry, request.worktrees.baselineDir, {
    host: request.host,
    project: request.project,
    policy: testWorkflowPolicy(request),
    input: {
      kind: "test-workflow-input",
      version: 1,
      build_workflow_id: request.build.manifest.id,
      build_workflow_revision: request.build.manifest.revision,
    },
    timeoutMs: request.ctestTimeoutMs ?? 1_200_000,
  });
  if (baselineRun.status !== "pass") {
    results.push(orch.abort(`baseline test workflow failed: ${baselineRun.failure ?? baselineRun.status}`));
    return empty({ baselineBuild });
  }
  // 期望声明 → 基线证据 artifact（schema 里 workflow_passed 是字面量 true，
  // 跑失败的 run 根本存不进来）。
  const baselineArtifact = ExpectationBaseline.parse({
    kind: "expectation-baseline",
    version: 1,
    workflow_passed: true,
    expectations: baselineRun.expectations,
  });
  request.store.saveArtifact(baselineArtifact);
  request.logger?.artifact("expectation-baseline.json", baselineArtifact);
  if (!submit(baselineArtifact)) return empty({ baselineBuild });

  const patch: PatchRecord = {
    kind: "patch-record",
    version: 1,
    ...request.patch,
    base_commit_sha: request.worktrees.baseSha,
  };
  if (!submit(patch)) return empty({ baselineBuild });

  const candidateBuild = await executeBuildList(request, request.worktrees.candidateDir, "candidate", buildList);
  if (candidateBuild.status !== "pass") {
    results.push(orch.abort(`candidate BuildWorkflow failed: ${candidateBuild.failure ?? "unknown failure"}`));
    return empty({ baselineBuild, candidateBuild });
  }

  request.logger?.phase("CANDIDATE_TEST_WORKFLOW");
  const candidateRun = await runTestSide(request.test.entry, request.worktrees.candidateDir, {
    host: request.host,
    project: request.project,
    policy: testWorkflowPolicy(request),
    input: {
      kind: "test-workflow-input",
      version: 1,
      build_workflow_id: request.build.manifest.id,
      build_workflow_revision: request.build.manifest.revision,
    },
    timeoutMs: request.ctestTimeoutMs ?? 1_200_000,
  });
  if (candidateRun.status !== "pass") {
    results.push(orch.abort(`candidate test workflow failed: ${candidateRun.failure ?? candidateRun.status}`));
    return empty({ baselineBuild, candidateBuild });
  }
  const candidateArtifact = ExpectationCandidate.parse({
    kind: "expectation-candidate",
    version: 1,
    workflow_passed: true,
    expectations: candidateRun.expectations,
  });
  request.store.saveArtifact(candidateArtifact);
  request.logger?.artifact("expectation-candidate.json", candidateArtifact);
  if (!submit(candidateArtifact)) {
    return empty({ baselineBuild, candidateBuild });
  }

  // ── 两侧声明按位置配对比较（expectation-compare.ts 的职责）───────────────
  const comparison = compareExpectations(baselineRun.expectations, candidateRun.expectations);
  const consistent = comparison.overall === "consistent";
  const reason = consistent
    ? `all ${String(comparison.matched.length)} expectation(s) consistent`
    : [
        ...comparison.errors,
        ...comparison.mismatched.map((m) => `'${m.declaration.name}': ${m.reason}`),
      ].join("; ") || "expectations inconsistent";
  // 组装对比 artifact：matched 与 mismatched 两段拼接（顺序 = 声明顺序）。
  const comparisonArtifact = ExpectationComparisonResult.parse({
    kind: "expectation-comparison-result",
    version: 1,
    overall: consistent ? "consistent" : "inconsistent",
    declarations: [
      ...comparison.matched.map((m) => ({
        name: m.declaration.name,
        relation: m.declaration.relation,
        matched: true,
        reason: "",
      })),
      ...comparison.mismatched.map((m) => ({
        name: m.declaration.name,
        relation: m.declaration.relation,
        matched: false,
        reason: m.reason,
      })),
    ],
    errors: comparison.errors,
    reason,
  });
  request.store.saveArtifact(comparisonArtifact);
  request.logger?.artifact("expectation-comparison-result.json", comparisonArtifact);
  submit(comparisonArtifact);   // inconsistent → 状态机自动改判 REJECTED（R6）
  return {
    state: request.store.state,
    results,
    baselineBuild,
    candidateBuild,
    baseline: null,      // 自驱动路径没有 CTest 证据对象（对比走 expectation 通道）
    candidate: null,
    comparison: null,
  };
}

// 自驱动测试的 capability policy：读/写放开、可执行只认 build/**、
// 进程数 4、输出 32MiB、文件 64MiB。（第二个参数 request 当前未用——预留。）
function testWorkflowPolicy(request: WorkflowVerificationRequest) {
  return {
    readableGlobs: ["**"],
    writableGlobs: ["**"],
    // The self-driven test workflow runs the artifacts the declared builds
    // produced (assertFile first, then process.run). Allow executables under
    // the build tree only — never arbitrary programs.
    executableGlobs: ["build/**"],
    allowedTools: [],
    maxProcesses: 4,
    maxOutputBytes: 32 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
  };
}

/**
 * Run every build in a (declaration) set on one worktree, sequentially.
 * Stops at the first failure (fail-closed). Single-build callers pass one item.
 */
// ── executeBuildList：按声明顺序逐个执行构建（B 方案的多构建纪律）───────────
// 第一个失败立刻返回（failure 里指名是哪个 build）；空列表返回"空 pass"占位。
async function executeBuildList(
  request: WorkflowVerificationRequest,
  cwd: string,
  side: "baseline" | "candidate",
  buildList: readonly BuildToExecute[],
): Promise<BuildWorkflowExecution> {
  let last: BuildWorkflowExecution | null = null;
  for (const item of buildList) {
    request.logger?.info(`executing ${side} build ${item.id}`, { cwd });
    const result = await executeBuildFor(
      request,
      item.resolution,
      cwd,
      side,
      // artifact 名里的非法字符替换成下划线（正则 [^A-Za-z0-9._-] 取反集）。
      `${side}-build-${item.id.replace(/[^A-Za-z0-9._-]/g, "_")}`,
    );
    last = result;
    if (result.status !== "pass") {
      return {
        ...result,
        failure: `build ${item.id} failed: ${result.failure ?? result.status}`,
      };
    }
  }
  // 空列表兜底：返回一个"什么都没做但成功"的占位 execution。
  return last ?? {
    status: "pass",
    artifact: { kind: "custom", version: 1, workflow_id: "", workflow_revision: 0, paths: {}, metadata: {} },
    steps: [],
    missingArtifacts: [],
    events: [],
    failure: null,
  };
}

// 单 build 便捷封装（声明式 CTest 路径用）。
async function executeBuild(
  request: WorkflowVerificationRequest,
  cwd: string,
  build: "baseline" | "candidate",
): Promise<BuildWorkflowExecution> {
  return executeBuildFor(request, request.build, cwd, build, `${build}-build`);
}

/** Execute one build workflow resolution in one worktree. */
// ── executeBuildFor：单次构建执行 + 能力策略 ─────────────────────────────
// 策略要点：自驱动/workflow-driven 的写权限放开到 **（函数是可信构建逻辑）；
// 声明式只许写 build/**；allowedTools 按声明式构建的种类精确给（cmake/ninja/编译器）。
async function executeBuildFor(
  request: WorkflowVerificationRequest,
  resolution: BuildWorkflowResolution,
  cwd: string,
  side: "baseline" | "candidate",
  artifactName: string,
): Promise<BuildWorkflowExecution> {
  request.logger?.phase(`${side.toUpperCase()}_BUILD`);
  request.logger?.info(`executing ${side} BuildWorkflow`, {
    workflow_id: resolution.manifest.id,
    workflow_revision: resolution.manifest.revision,
    cwd,
  });
  const result = await executeBuildWorkflow({
    cwd,
    output: resolution.output,   // 声明式有 output；自驱动为 null（执行期才知道）
    host: request.host,
    project: request.project,
    entry: resolution.entry,
    policy: {
      readableGlobs: ["**"],
      writableGlobs: resolution.output !== null && isWorkflowDriven(resolution.output)
        ? ["**"]
        : resolution.output === null
          ? ["**"]
          : ["build/**"],
      allowedTools: resolution.output === null
        ? []                       // 自驱动：构建函数自己用实测工具，不需要预授权
        : requiredBuildTools(resolution.output),
      maxProcesses: 4,
      maxOutputBytes: 16 * 1024 * 1024,
      maxFileBytes: 64 * 1024 * 1024,
    },
    timeoutMs: request.buildTimeoutMs ?? 1_200_000,   // ⚠️ 每步都拿全额预算（任务 8 点过）
  });
  request.logger?.artifact(`${artifactName}.json`, result);
  // 每个构建步骤（configure/build…）逐条留痕：退出码/耗时/错误。
  for (const step of result.steps) {
    request.logger?.info(`${side} build step ${step.name}: ${step.status}`, {
      exit_code: step.exitCode,
      duration_ms: step.durationMs,
      error: step.error,
    });
  }
  return result;
}

// 判断声明式 output 是否描述的是 workflow-driven 构建（"kind" in x 收窄写法）。
function isWorkflowDriven(output: BuildWorkflowOutput): boolean {
  const build = output.environment.build;
  return "kind" in build && build.kind === "workflow-driven";
}

// ── runSuite：声明式 CTest 的单侧执行（带心跳与流式日志）───────────────────
// Parameters<typeof runCTest>[0]["spec"]：直接"借用"runCTest 参数类型里的 spec 类型
// （类型推导的组合技，避免重复声明）。
async function runSuite(
  request: WorkflowVerificationRequest,
  repoDir: string,
  spec: Parameters<typeof runCTest>[0]["spec"],
  build: "baseline" | "candidate",
) {
  request.logger?.phase(`${build.toUpperCase()}_CTEST`);
  const logName = `${build}-ctest.log`;
  request.logger?.logFile(logName, "");
  request.logger?.startHeartbeat(10_000);   // 10 秒一次心跳：证明"还活着没卡死"
  try {
    const result = await runCTest({
      repoDir,
      spec,
      host: request.host,
      requiredTopLevelTests: requiredTopLevelTests(request.test),   // 缺顶层目标 = fail-closed
      onOutput: (stream, chunk) => {
        request.logger?.appendLogFile(logName, `[${stream}] ${chunk}`);   // 输出流式追加到日志
      },
    });
    request.logger?.artifact(`${build}-ctest-result.json`, result);
    request.logger?.info(`${build} CTest finished`, {
      status: result.status,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      failed_tests: result.failed_tests.map((failure) => failure.name),
    });
    return result;
  } finally {
    request.logger?.stopHeartbeat();   // 无论成败都停心跳
  }
}

// 从声明式构建输出里提取"需要的实测工具"（决定 allowedTools 白名单）。
function requiredBuildTools(output: BuildWorkflowOutput): string[] {
  const build = output.environment.build;
  if ("kind" in build && build.kind === "cmake") return ["cmake"];
  if ("kind" in build && build.kind === "ninja") return ["ninja"];
  if ("kind" in build && build.kind === "direct-compiler") return [build.compiler];
  return [];
}

// CTest 声明里的必现顶层测试（自驱动 test 没有 → 空数组）。
function requiredTopLevelTests(test: TestWorkflowResolution): readonly string[] {
  return test.workflow !== null && test.workflow.runner === "ctest"
    ? test.workflow.required_top_level_tests
    : [];
}

// 空结果工厂：state 用当前值（abort 已推进），证据字段全空。
function emptyOutcome(
  state: string,
  results: SubmitResult[],
): WorkflowVerificationOutcome {
  return {
    state,
    results,
    baselineBuild: null,
    candidateBuild: null,
    baseline: null,
    candidate: null,
    comparison: null,
  };
}

// 从任意对象里安全取 kind 字符串（日志用）。
function kindOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !("kind" in value)) return "unknown";
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "unknown";
}

/**
 * Declared-set workflow verification (subagent-driven flow). The test-writer
 * session declared N build workflows; the host executes every one on both
 * worktrees, then runs the self-driven test workflow once per side and compares
 * expectations. Mirrors runSelfDrivenVerification but over a build list.
 */
// ★ B 方案入口：声明集验证 = 通用核心 + N 个 build 的列表。
export async function runDeclaredWorkflowVerification(
  request: WorkflowVerificationRequest,
  orch: Orchestrator,
  results: SubmitResult[],
  submit: (artifact: unknown) => boolean,
  environment: unknown,
  builds: readonly BuildToExecute[],
): Promise<WorkflowVerificationOutcome> {
  return runSelfDrivenCore(request, orch, results, submit, environment, builds);
}
