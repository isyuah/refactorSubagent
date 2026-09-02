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
function prefixArtifacts() {
  return [
    BehaviorContract.parse({
      kind: "behavior-contract", version: 1,
      channels: {
        exit_code: { mode: "exact" },
        signals: { mode: "ignore" },
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
      source_hash: "0".repeat(64),
      reason: "generated",
    }),
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
    EnvironmentSpec.parse({
      kind: "environment-spec", version: 1,
      build: { kind: "workflow-driven" },
      sanitizers: [],
      determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    }),
  ];
}

function patch() {
  return PatchRecord.parse({
    kind: "patch-record", version: 1,
    branch: "candidate", commit_sha: "c".repeat(40), base_commit_sha: "b".repeat(40),
    changed_files: ["src/main.c"],
    summary: "refactor",
  });
}

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

let orch: Orchestrator;
let store: SessionStore;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "rfr-exp-"));
  store = SessionStore.create(root, "s-" + Math.random().toString(36).slice(2, 8));
  orch = new Orchestrator(store);
});

function advance(n: number) {
  for (const a of prefixArtifacts().slice(0, n)) {
    const r = orch.submit(a);
    if (!r.ok) throw new Error(`setup failed: ${r.reason}`);
  }
}

describe("self-driven test (expectation) state machine", () => {
  test("consistent expectation comparison reaches ACCEPTED", () => {
    advance(7); // → ENV_READY
    expect(store.state).toBe("ENV_READY");
    expect(orch.submit(baseline()).ok).toBeTrue(); // → BASELINE_READY
    expect(store.state).toBe("BASELINE_READY");
    expect(orch.submit(patch()).ok).toBeTrue(); // → PATCH_CREATED
    expect(store.state).toBe("PATCH_CREATED");
    expect(orch.submit(candidate()).ok).toBeTrue(); // → VERIFICATION_RUNNING
    expect(store.state).toBe("VERIFICATION_RUNNING");
    const r = orch.submit(comparison("consistent"));
    expect(r).toEqual({ ok: true, from: "VERIFICATION_RUNNING", to: "ACCEPTED" });
    expect(store.state).toBe("ACCEPTED");
  });

  test("inconsistent expectation comparison lands on REJECTED", () => {
    advance(7);
    orch.submit(baseline());
    orch.submit(patch());
    orch.submit(candidate());
    const r = orch.submit(comparison("inconsistent"));
    expect(r).toEqual({ ok: true, from: "VERIFICATION_RUNNING", to: "REJECTED" });
    expect(store.state).toBe("REJECTED");
  });

  test("expectation-baseline is rejected at the wrong state", () => {
    advance(6); // → TEST_WORKFLOW_READY, not ENV_READY yet
    const r = orch.submit(baseline());
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("R1");
  });

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
