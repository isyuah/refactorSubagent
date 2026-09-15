/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/expectation-state-machine.test.ts —— 自驱动测试路径的状态机锁定
 *
 * 【这个文件锁定了哪些行为】
 *   ① 合法路径：ENV_READY 交期望基线 → BASELINE_READY → patch → PATCH_CREATED
 *      → 期望候选 → VERIFICATION_RUNNING → consistent 对比 → ★ ACCEPTED；
 *   ② ★ inconsistent 对比 → REJECTED（哪怕前面全对，只要有一条期望不匹配就拒绝）；
 *   ③ R1 时机闸门：还没到 ENV_READY 就交 expectation-baseline → 拒绝（原因含 R1）；
 *   ④ ★ 语义审计：自称 consistent 但里面有 matched=false 的声明 → 拒绝
 *      （"unmatched declarations"）——不许自相矛盾的结论过关。
 *
 * 【为什么重要】
 *   这是对"新路径（自驱动 TestWorkflow）"全链路的裁决规则测试；和
 *   state-machine.test.ts（旧路径 R1-R7）配对，两条路径的规则都要各自锁死。
 *
 * 【怎么跑】bun test tests/expectation-state-machine.test.ts（纯逻辑，不需要 gcc）
 *
 * 【本文件是教程注释版】原文件 tests/expectation-state-machine.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { SessionStore } from "../src/orchestrator/store.js";
import {
  ExpectationBaseline,
  ExpectationCandidate,
  ExpectationComparisonResult,
} from "../src/artifacts/index.js";
import { BehaviorContract } from "../src/artifacts/behavior-contract.js";
import { ScopeManifest } from "../src/artifacts/scope-manifest.js";
import { DependencyManifest } from "../src/artifacts/dependency-manifest.js";
import { TestSpec } from "../src/artifacts/test-spec.js";
import { EnvironmentSpec } from "../src/artifacts/environment-spec.js";
import { WorkflowResolution } from "../src/artifacts/workflow-resolution.js";
import { PatchRecord } from "../src/artifacts/patch-record.js";

/** Minimal happy path up to ENV_READY with workflow resolutions. */
// ── prefixArtifacts：造出"走到 ENV_READY 之前"的全部 7 个合法 artifact ───
// 每个都 .parse() 一遍：夹具本身就是过 Schema 的合法数据（造假的成本很高，这正是目的）。
// 顺序即状态机顺序：契约 → 范围 → 依赖 → 测试 → build决策 → test决策 → 环境规格。
function prefixArtifacts() {
  return [
    BehaviorContract.parse({
      kind: "behavior-contract", version: 1,
      channels: {
        exit_code: { mode: "exact" },     // 退出码必须精确一致
        signals: { mode: "ignore" },      // 其余通道本测试不关心
        stdout: { mode: "ignore" },
        stderr: { mode: "ignore" },
        filesystem: { mode: "ignore" },
      },
      allowed_change: { internal_structure: true, execution_time: true },
      notes: [],
    }),
    ScopeManifest.parse({
      kind: "scope-manifest", version: 1,
      editable_files: [{ file: "src/main.c", symbols: ["main"] }],
      readable_globs: ["src/**"],
      forbidden_globs: [],
    }),
    DependencyManifest.parse({
      kind: "dependency-manifest", version: 1,
      dependencies: [{ name: "stdout", kind: "pure", strategy: "real_isolated", evidence: [], notes: "" }],
    }),
    TestSpec.parse({
      kind: "test-spec", version: 1,
      cases: [{ id: "c1", kind: "differential", argv: ["app"], stdin: "", fixtures: [] }],
    }),
    // BuildWorkflow 决策：build 类，build_workflow 必须是 null（superRefine 规则）。
    WorkflowResolution.parse({
      kind: "workflow-resolution", version: 1,
      workflow_kind: "build",
      mode: "generated",
      workflow_id: "bw",
      workflow_revision: 1,
      build_workflow: null,
      entry_root: "workspace",
      root_path: ".",
      entry: ".refactor/generated-workflows/build/bw.ts",
      source_hash: "0".repeat(64),        // "0".repeat(64)：造一个 64 位假哈希凑格式
      reason: "generated",
    }),
    // TestWorkflow 决策：test 类，必须绑定上面的 bw@1（语义审计会核对）。
    WorkflowResolution.parse({
      kind: "workflow-resolution", version: 1,
      workflow_kind: "test",
      mode: "generated",
      workflow_id: "tw",
      workflow_revision: 1,
      build_workflow: { id: "bw", revision: 1 },
      entry_root: "workspace",
      root_path: ".",
      entry: ".refactor/generated-workflows/test/tw.ts",
      source_hash: "1".repeat(64),
      reason: "generated",
    }),
    // 环境规格：build.kind = "workflow-driven"（自驱动构建的形状）。
    EnvironmentSpec.parse({
      kind: "environment-spec", version: 1,
      build: { kind: "workflow-driven" },
      sanitizers: [],
      determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    }),
  ];
}

// patch 夹具：改了 src/main.c（正好在 editable 白名单里，能过 R4）。
// "c".repeat(40)：40 位十六进制假 commit 哈希。
function patch() {
  return PatchRecord.parse({
    kind: "patch-record", version: 1,
    branch: "candidate", commit_sha: "c".repeat(40), base_commit_sha: "b".repeat(40),
    changed_files: ["src/main.c"],
    summary: "refactor",
  });
}

// 基线/候选期望夹具：各声明一条 { name:"exit", relation:"equal", value:0 }。
function baseline(expectations: unknown[] = [{ name: "exit", relation: "equal", value: 0 }]) {
  return ExpectationBaseline.parse({
    kind: "expectation-baseline", version: 1, workflow_passed: true, expectations,
  });
}

function candidate(expectations: unknown[] = [{ name: "exit", relation: "equal", value: 0 }]) {
  return ExpectationCandidate.parse({
    kind: "expectation-candidate", version: 1, workflow_passed: true, expectations,
  });
}

// 对比结果夹具：按参数造 consistent 或 inconsistent 的判决，
// declarations 的内容与 overall 自洽（consistent→全 matched / inconsistent→有 unmatched）。
function comparison(overall: "consistent" | "inconsistent") {
  return ExpectationComparisonResult.parse({
    kind: "expectation-comparison-result", version: 1, overall,
    declarations: overall === "consistent"
      ? [{ name: "exit", relation: "equal", matched: true, reason: "" }]
      : [{ name: "exit", relation: "equal", matched: false, reason: "values differ" }],
    errors: [],
    reason: overall === "consistent" ? "all consistent" : "inconsistent",
  });
}

// 每个测试共用的一对"新鲜"实例：beforeEach 在【每个 test 前】重新执行，
// 随机 session id 避免目录冲突 —— 测试之间互不污染。
let orch: Orchestrator;
let store: SessionStore;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "rfr-exp-"));
  store = SessionStore.create(root, "s-" + Math.random().toString(36).slice(2, 8));
  orch = new Orchestrator(store);
});

// ── advance：把状态机推到第 n 个 artifact 之后的状态 ────────────────────
// slice(0, n)：只交前 n 个；任何一个失败就炸出明确错误（测试夹具问题立刻暴露）。
function advance(n: number) {
  for (const a of prefixArtifacts().slice(0, n)) {
    const r = orch.submit(a);
    if (!r.ok) throw new Error(`setup failed: ${r.reason}`);
  }
}

describe("self-driven test (expectation) state machine", () => {
  // ── 测试①：consistent → ACCEPTED（自驱动路径的完整合法旅程）────────────
  test("consistent expectation comparison reaches ACCEPTED", () => {
    advance(7); // → ENV_READY                            交满 7 个夹具，到达 ENV_READY
    expect(store.state).toBe("ENV_READY");
    expect(orch.submit(baseline()).ok).toBeTrue(); // → BASELINE_READY   期望基线
    expect(store.state).toBe("BASELINE_READY");
    expect(orch.submit(patch()).ok).toBeTrue(); // → PATCH_CREATED      候选 patch
    expect(store.state).toBe("PATCH_CREATED");
    expect(orch.submit(candidate()).ok).toBeTrue(); // → VERIFICATION_RUNNING 期望候选
    expect(store.state).toBe("VERIFICATION_RUNNING");
    const r = orch.submit(comparison("consistent"));
    // toEqual 直接比对整个 SubmitResult 对象：精确锁定"从哪到哪"。
    expect(r).toEqual({ ok: true, from: "VERIFICATION_RUNNING", to: "ACCEPTED" });
    expect(store.state).toBe("ACCEPTED");
  });

  // ── 测试②（★）：inconsistent → REJECTED ─────────────────────────────
  // 前面步骤一模一样，只有对比结果不同——状态机必须改判 REJECTED（R6）。
  test("inconsistent expectation comparison lands on REJECTED", () => {
    advance(7);
    orch.submit(baseline());
    orch.submit(patch());
    orch.submit(candidate());
    const r = orch.submit(comparison("inconsistent"));
    expect(r).toEqual({ ok: true, from: "VERIFICATION_RUNNING", to: "REJECTED" });
    expect(store.state).toBe("REJECTED");
  });

  // ── 测试③：R1 时机闸门——期望基线交早了 → 拒绝 ────────────────────────
  // 只交 6 个夹具（到 TEST_WORKFLOW_READY），此时按规则该交环境规格；
  // 交 expectation-baseline 属于乱序 → 失败原因要含 "R1"。
  test("expectation-baseline is rejected at the wrong state", () => {
    advance(6); // → TEST_WORKFLOW_READY, not ENV_READY yet
    const r = orch.submit(baseline());
    expect(r.ok).toBeFalse();               // toBeFalse：布尔假断言
    if (!r.ok) expect(r.reason).toContain("R1");   // 收窄后才能读 r.reason
  });

  // ── 测试④（★ 语义审计）：自相矛盾的对比 → 拒绝 ────────────────────────
  // overall 说 "consistent"，declarations 里却有 matched=false——
  // checkExpectationComparison 会抓住这种矛盾（"unmatched declarations"）。
  // Consistent overall but one declaration unmatched — semantic violation.
  test("consistent comparison with unmatched declarations is rejected", () => {
    advance(7);
    orch.submit(baseline());
    orch.submit(patch());
    orch.submit(candidate());
    // Consistent overall but one declaration unmatched — semantic violation.
    const bad = ExpectationComparisonResult.parse({
      kind: "expectation-comparison-result", version: 1, overall: "consistent",
      declarations: [{ name: "exit", relation: "equal", matched: false, reason: "x" }],
      errors: [],
      reason: "all consistent",
    });
    const r = orch.submit(bad);
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("unmatched declarations");
  });
});
