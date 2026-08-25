/**
 * E2E demo: real C project, real gcc, real differential runs.
 *
 *  1. materialize examples/trim-app/base into a temp repo (base commit)
 *  2. branch refactor/safe   — behavior-preserving extraction
 *  3. branch refactor/broken — trims trailing whitespace only (behavior change)
 *  4. runVerification() on each branch:
 *        safe   → ACCEPTED
 *        broken → REJECTED
 */
import { cpSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/orchestrator/store.js";
import { runVerification, type VerifyRequest } from "../src/runtime/pipeline.js";

const BASE = join(import.meta.dir, "..", "examples", "trim-app", "base");
const GIT = 'git -c user.email=demo@local -c user.name=demo';

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

// --- build the sample repo with two candidate branches -------------------
const root = mkdtempSync(join(tmpdir(), "refactor-e2e-"));
const repo = join(root, "repo");
cpSync(BASE, repo, { recursive: true });

sh(`${GIT} init -b main`, repo);
sh(`${GIT} add -A`, repo);
sh(`${GIT} commit -m base`, repo);

for (const variant of ["safe", "broken"] as const) {
  sh(`git checkout -b refactor/${variant}`, repo);
  copyFileSync(
    join(BASE, "..", "variants", variant, "util.c"),
    join(repo, "src", "util.c"),
  );
  sh(`${GIT} add -A`, repo);
  sh(`${GIT} commit -m "${variant} refactor"`, repo);
  sh("git checkout main", repo);
}

// --- shared verification inputs ------------------------------------------
const request = (
  candidateBranch: string,
  summary: string,
): Omit<VerifyRequest, "contract" | "scope" | "deps" | "tests" | "env" | "patch"> & {
  contract: VerifyRequest["contract"];
  scope: VerifyRequest["scope"];
  deps: VerifyRequest["deps"];
  tests: VerifyRequest["tests"];
  env: VerifyRequest["env"];
  patch: VerifyRequest["patch"];
} => ({
  repoPath: repo,
  candidateBranch,
  contract: {
    kind: "behavior-contract",
    version: 1,
    channels: {
      exit_code: { mode: "exact" },
      signals: { mode: "exact" },
      stdout: { mode: "exact" },
      stderr: { mode: "ignore" },
      filesystem: { mode: "semantic", comparator: "fs-effects-v1" },
    },
    allowed_change: { internal_structure: true, execution_time: true },
    notes: [],
  },
  scope: {
    kind: "scope-manifest",
    version: 1,
    editable_files: [{ file: "src/util.c", symbols: ["trim"] }],
    readable_globs: ["src/**"],
    forbidden_globs: [],
  },
  deps: {
    kind: "dependency-manifest",
    version: 1,
    dependencies: [
      { name: "time()", kind: "time", strategy: "freeze", evidence: ["src/main.c"], notes: "" },
      { name: "rand()", kind: "randomness", strategy: "seed", evidence: ["src/main.c"], notes: "" },
    ],
  },
  tests: {
    kind: "test-spec",
    version: 1,
    cases: [
      { id: "r1", kind: "regression", argv: ["app", "hello"], stdin: "", fixtures: [], expect_exit_code: 0 },
      { id: "d-normal", kind: "differential", argv: ["app", "  padded  "], stdin: "", fixtures: [] },
      { id: "d-empty-args", kind: "differential", argv: ["app"], stdin: "", fixtures: [] },
      { id: "d-blank", kind: "differential", argv: ["app", "", "   ", "\t"], stdin: "", fixtures: [] },
      { id: "d-mixed", kind: "differential", argv: ["app", "ünïcødé\t", "a b c "], stdin: "", fixtures: [] },
    ],
  },
  env: {
    kind: "environment-spec",
    version: 1,
    build: {
      cc: "gcc",
      flags: ["-O2", "-Wall"],
      defines: {},
      command: `gcc -O2 -Wall src/main.c src/util.c -o app.exe`,
      binary: "app.exe",
    },
    determinism: {
      frozen_time_epoch_ms: 1700000000000,
      random_seed: 42,
      intercept_headers: ["shim/determinism.h"],
    },
    sandbox: { run_cwd_strategy: "fresh_temp_dir" },
  },
  patch: {
    branch: candidateBranch,
    commit_sha: "0".repeat(40), // pipeline records the true sha itself
    changed_files: ["src/util.c"],
    summary,
  },
});

function verify(branch: string, label: string): void {
  const store = SessionStore.create(root, `session-${branch.split("/")[1]}`);
  const outcome = runVerification(store, request(branch, `${branch} refactor`));
  console.log(`\n=== ${label} (${branch}) ===`);
  for (const r of outcome.results) {
    console.log(
      r.ok ? `  ✓ ${r.from} → ${r.to}` : `  ✗ ${r.reason.slice(0, 120)}`,
    );
  }
  console.log(`  ⇒ final state: ${outcome.state}`);
}

verify("refactor/safe", "behavior-preserving refactor");
verify("refactor/broken", "behavior-changing refactor");

console.log(`\n(temp artifacts left in ${root}; delete manually if needed)`);
