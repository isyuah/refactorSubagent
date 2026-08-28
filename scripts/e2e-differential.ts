import { cpSync, copyFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/orchestrator/store.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { runVerification, type VerifyRequest } from "../src/runtime/pipeline.js";

const BASE = join(import.meta.dir, "..", "examples", "trim-app", "base");
const VARIANTS = new Set(["safe", "broken"]);
const variant = readVariant();
const root = mkdtempSync(join(tmpdir(), `refactor-e2e-${variant}-`));
const repo = join(root, "repo");
cpSync(BASE, repo, { recursive: true });

git(repo, ["init", "-b", "main"]);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-m", "base"]);
const candidateBranch = `refactor/${variant}`;
git(repo, ["checkout", "-b", candidateBranch]);
copyFileSync(join(BASE, "..", "variants", variant, "util.c"), join(repo, "src", "util.c"));
git(repo, ["add", "-A"]);
git(repo, ["commit", "-m", `${variant} refactor`]);
git(repo, ["checkout", "main"]);

const host = probeHost(repo);
const store = SessionStore.create(root, `session-${variant}`);
const outcome = runVerification(store, request(repo, candidateBranch, host));
const expected = variant === "safe" ? "ACCEPTED" : "REJECTED";

console.log(JSON.stringify({
  scenario: variant === "safe" ? "targeted-differential-accept" : "targeted-differential-reject",
  root,
  candidate_branch: candidateBranch,
  expected_state: expected,
  actual_state: outcome.state,
  transitions: outcome.results.map((result) => result.ok
    ? `${result.from} -> ${result.to}`
    : `rejected: ${result.reason}`),
}, null, 2));

if (outcome.state !== expected) {
  console.error(`targeted differential ${variant} expected ${expected}, got ${outcome.state}`);
  process.exitCode = 1;
}

function readVariant(): "safe" | "broken" {
  const args = Bun.argv.slice(2);
  const index = args.indexOf("--variant");
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || !VARIANTS.has(value)) {
    console.error("用法: bun run scripts/e2e-differential.ts --variant <safe|broken>");
    process.exit(2);
  }
  return value as "safe" | "broken";
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  }).trim();
}

function request(
  repoPath: string,
  candidateBranch: string,
  host: VerifyRequest["host"],
): VerifyRequest {
  return {
    repoPath,
    candidateBranch,
    host,
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
        { id: "d-blank", kind: "differential", argv: ["app", "", "   ", "\t"], stdin: "", fixtures: [] },
        { id: "d-mixed", kind: "differential", argv: ["app", "ünïcødé\t", "a b c "], stdin: "", fixtures: [] },
      ],
    },
    env: {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "direct-compiler",
        compiler: "gcc",
        flags: ["-O2", "-Wall"],
        defines: {},
        sources: ["src/main.c", "src/util.c"],
        output: "app",
      },
      sanitizers: [],
      determinism: {
        frozen_time_epoch_ms: 1_700_000_000_000,
        random_seed: 42,
        intercept_headers: ["shim/determinism.h"],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    },
    patch: {
      branch: candidateBranch,
      commit_sha: "0".repeat(40),
      changed_files: ["src/util.c"],
      summary: `${variant} targeted differential refactor`,
    },
  };
}
