import type {
  AnyArtifact,
  BehaviorContract,
  ComparisonResult,
  DependencyManifest,
  EnvironmentSpec,
  TestSpec,
  PatchRecord,
  ScopeManifest,
  ObservationTrace,
} from "../src/artifacts/index.js";

const SHA = "a".repeat(64);

/** Sample artifacts describing a small C project: `trim()` in src/util.c. */

export const contract = (): BehaviorContract => ({
  kind: "behavior-contract",
  version: 1,
  channels: {
    exit_code: { mode: "exact" },
    signals: { mode: "exact" },
    stdout: { mode: "exact" },
    stderr: { mode: "normalize" },
    filesystem: { mode: "semantic", comparator: "fs-effects-v1" },
  },
  allowed_change: { internal_structure: true, execution_time: true },
  notes: [],
});

export const scope = (): ScopeManifest => ({
  kind: "scope-manifest",
  version: 1,
  editable_files: [{ file: "src/util.c", symbols: ["trim"] }],
  readable_globs: ["src/**"],
  forbidden_globs: ["tests/**"],
});

export const deps = (): DependencyManifest => ({
  kind: "dependency-manifest",
  version: 1,
  dependencies: [
    { name: "time()", kind: "time", strategy: "freeze", evidence: [], notes: "" },
    { name: "rand()", kind: "randomness", strategy: "seed", evidence: [], notes: "" },
  ],
});

export const tests = (): TestSpec => ({
  kind: "test-spec",
  version: 1,
  cases: [
    { id: "r1", kind: "regression", argv: ["app"], stdin: "", fixtures: [], expect_exit_code: 0 },
    { id: "d1", kind: "differential", argv: ["app", "  hi  "], stdin: "", fixtures: [] },
    { id: "d2", kind: "differential", argv: ["app", ""], stdin: "", fixtures: [] },
  ],
});

export const env = (): EnvironmentSpec => ({
  kind: "environment-spec",
  version: 1,
  build: {
    cc: "gcc",
    flags: ["-O2", "-Wall"],
    defines: {},
    command: "gcc -O2 -Wall src/main.c src/util.c -o bin/app",
    binary: "bin/app",
  },
  determinism: {
    frozen_time_epoch_ms: 1700000000000,
    random_seed: 42,
    intercept_headers: ["shim/determinism.h"],
  },
  sandbox: { run_cwd_strategy: "fresh_temp_dir" },
});

export function trace(
  build: "baseline" | "candidate",
  overrides: Partial<ObservationTrace> = {},
): ObservationTrace {
  const obs = tests().cases.map((c) => ({
    case_id: c.id,
    status: "observed" as const,
    exit_code: 0,
    signal: null,
    stdout_b64: Buffer.from(`out:${c.id}`).toString("base64"),
    stderr_b64: "",
    filesystem: [],
    duration_ms: 3,
  }));
  const base = {
    kind: "observation-trace" as const,
    version: 1 as const,
    build,
    env_id: "env001",
    observations: obs,
    failures: [] as ObservationTrace["failures"],
  };
  return { ...base, ...overrides };
}

export const patch = (changed: string[] = ["src/util.c"]): PatchRecord => ({
  kind: "patch-record",
  version: 1,
  branch: "refactor/trim",
  commit_sha: "b".repeat(40),
  base_commit_sha: "c".repeat(40),
  changed_files: changed,
  summary: "extract helper from trim()",
});

export function comparison(
  verdicts: Array<"match" | "mismatch"> = ["match", "match", "match"],
): ComparisonResult {
  const per_case = tests().cases.map((c, i) => ({
    case_id: c.id,
    verdict: verdicts[i] ?? "mismatch",
    channels: {},
    detail: "",
  }));
  const overall = per_case.every((p) => p.verdict !== "mismatch")
    ? "consistent"
    : "inconsistent";
  return {
    kind: "comparison-result",
    version: 1,
    baseline_env_id: "env001",
    candidate_env_id: "env002",
    // deno-lint-ignore no-explicit-any
    per_case,
    overall,
  } as ComparisonResult;
}

/** Happy-path artifact sequence, in submission order. */
export const happyPath = (): AnyArtifact[] => [
  contract(),
  scope(),
  deps(),
  tests(),
  env(),
  trace("baseline"),
  patch(),
  trace("candidate"),
  comparison(),
];
