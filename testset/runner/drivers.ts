/**
 * Drivers: how a suite case actually produces a result.
 *
 *   pipeline      — clone the pinned baseline, run the harness CLI against it
 *                   (one clone + one session root per case → cases are isolated)
 *   upstream-part — one shared clone of the baseline, built once; every case of
 *                   the part is then executed R times and classified
 *
 * Nothing here decides pass/fail; that is evaluate.ts.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ensureDir, exists, readJson, writeJson } from "./util.js";
import { exec, type ExecResult } from "./exec.js";
import type { Part, SuiteCase } from "./suite.js";

export interface JobContext {
  readonly caseDir: string;
  /**
   * Persistent per-worker directory used by `--build-cache` pipeline cases:
   * the clone and the worktree pair live here so warm build outputs survive
   * between cases. Null = every case gets its own clone and fresh worktrees.
   */
  readonly slotDir: string | null;
  readonly suiteRoot: string;
  readonly baselineRepo: string;
  readonly baselineCommit: string;
  readonly harnessDir: string;
  readonly harnessCli: string;
  readonly bun: string;
  /** overrides the part policy's repeat count when set (> 0). */
  readonly repeats: number;
  readonly rebuild: boolean;
  readonly keepClones: boolean;
  readonly onPhase: (phase: string, detail?: string) => void;
}

export interface HarnessSummary {
  readonly state: string;
  readonly session: string;
  readonly log_dir: string;
  readonly pipeline: string;
  readonly injected_stages: string[];
  readonly verification_authoritative: boolean;
  readonly declared_builds: string[];
  readonly baseline_build: string | null;
  readonly candidate_build: string | null;
  readonly comparison: string | null;
  readonly refactor_summary: string;
}

export interface PipelineRunResult {
  readonly status: ExecResult["status"] | "clone-failed";
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  readonly summary: HarnessSummary | null;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly clonePath: string;
  readonly sessionId: string;
  readonly logDir: string | null;
  readonly comparisonPath: string | null;
  readonly mismatches: readonly string[];
  readonly comparisonErrors: readonly string[];
  readonly pipelinePath: string;
  readonly error: string | null;
}

export interface PartCaseRun {
  readonly name: string;
  readonly classification: "stable-ok" | "stable-fail" | "flaky" | "error";
  readonly repeats: number;
  readonly exitCodes: readonly (number | null)[];
  readonly taps: readonly (string | null)[];
  readonly stdoutSha: readonly string[];
  readonly detail: string;
}

export interface PartRunResult {
  readonly partId: string;
  readonly status: "ok" | "failed" | "build-failed";
  readonly elapsedMs: number;
  readonly buildMs: number;
  readonly cases: readonly PartCaseRun[];
  readonly counts: Readonly<Record<string, number>>;
  readonly checkoutPath: string;
  readonly error: string | null;
}

async function git(args: readonly string[], cwd: string, timeoutMs = 300000): Promise<ExecResult> {
  return await exec({ program: "git", args, cwd, timeoutMs });
}

async function mustGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(-400)}`);
  }
  return result.stdout.trim();
}

/** Clone the pinned baseline into `dest` and leave it on a detached checkout. */
export async function cloneBaseline(ctx: JobContext, dest: string): Promise<string> {
  rmSync(dest, { recursive: true, force: true });
  ensureDir(join(dest, ".."));
  // No --local: the pinned baseline is a shallow clone, so git ignores (and warns
  // about) --local and falls back to a plain copy — which is what we want anyway.
  const cloned = await git(["clone", "--no-checkout", ctx.baselineRepo, dest], ctx.caseDir, 600000);
  if (cloned.status !== "exited" || cloned.exitCode !== 0) {
    throw new Error(`git clone failed: ${(cloned.stderr || cloned.stdout).trim().slice(-400)}`);
  }
  await mustGit(["checkout", "--detach", ctx.baselineCommit], dest);
  // The pinned byte-for-byte checkout recipe: root .gitattributes sets `* -text`,
  // and this mirrors the documented per-clone config so CRLF can never sneak in.
  await mustGit(["config", "core.autocrlf", "false"], dest);
  return dest;
}

/** Reset a cached slot clone to the pinned commit instead of re-cloning it. */
async function resetClone(ctx: JobContext, dest: string): Promise<void> {
  // A slot survives batches, so it may predate the pinned commit (a rebased or
  // re-created baseline): re-clone when this clone cannot reach it.
  const reachable = await git(["cat-file", "-e", `${ctx.baselineCommit}^{commit}`], dest);
  if (reachable.status !== "exited" || reachable.exitCode !== 0) {
    await cloneBaseline(ctx, dest);
    return;
  }
  await mustGit(["checkout", "--force", "--detach", ctx.baselineCommit], dest);
  await mustGit(["reset", "--hard", ctx.baselineCommit], dest);
  // Tracked files are restored above; untracked leftovers (stale run dirs,
  // stray build output inside the clone) must go. The warm build lives in the
  // worktrees, not here, so -x is unnecessary.
  await mustGit(["clean", "-fd"], dest);
}

async function applyClonePreparation(ctx: JobContext, c: SuiteCase, clonePath: string): Promise<void> {
  const remove = c.clone?.remove ?? [];
  if (remove.length === 0) return;
  for (const rel of remove) {
    rmSync(join(clonePath, rel), { recursive: true, force: true });
  }
  if (c.clone?.commit === true) {
    await mustGit(["add", "-A"], clonePath);
    await mustGit(["-c", "user.name=suite", "-c", "user.email=suite@local",
                   "commit", "-q", "-m", `suite: hide ${remove.join(", ")} (writer capability case)`], clonePath);
  }
}

export async function runPipelineCase(
  ctx: JobContext,
  c: SuiteCase,
  pipeline: Record<string, unknown>,
  task: string,
): Promise<PipelineRunResult> {
  // With --build-cache the heavy state (clone + worktree pair) lives in a
  // persistent per-worker slot so the next case in this worker reuses the warm
  // build tree; everything the case *produces* still lands in its own caseDir.
  const workRoot = ctx.slotDir ?? ctx.caseDir;
  const clonePath = join(workRoot, "repo");
  const sessionId = `${c.id}-s1`;
  const pipelinePath = join(ctx.caseDir, "pipeline.json");
  writeJson(pipelinePath, pipeline);

  ctx.onPhase("clone", relative(ctx.caseDir, clonePath));
  let started = Date.now();
  try {
    if (ctx.slotDir !== null && exists(join(clonePath, ".git"))) {
      await resetClone(ctx, clonePath);
    } else {
      await cloneBaseline(ctx, clonePath);
    }
    await applyClonePreparation(ctx, c, clonePath);
  } catch (error) {
    return {
      status: "clone-failed", exitCode: null, elapsedMs: Date.now() - started, summary: null,
      stdoutText: "", stderrText: "", clonePath, sessionId, logDir: null, comparisonPath: null,
      mismatches: [], comparisonErrors: [], pipelinePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  ctx.onPhase("harness", `session ${sessionId}`);
  started = Date.now();
  const args = [
    ctx.harnessCli, "run", clonePath,
    "--task", task,
    "--session", sessionId,
    "--session-root", ctx.caseDir,
    "--pipeline-file", pipelinePath,
    "--format", "json",
  ];
  // A caller-owned worktree root keeps the baseline/candidate pair (and its warm
  // build tree) alive between cases; the harness resets it in place each run.
  if (ctx.slotDir !== null) args.push("--worktree-root", ctx.slotDir);
  for (const [key, value] of Object.entries(c.limits ?? {})) {
    args.push("--limit", `${key}=${value === null ? "null" : String(value)}`);
  }
  const timeoutMs = c.timeoutMs ?? 3600000;
  const result = await exec({
    program: ctx.bun, args, cwd: ctx.harnessDir, timeoutMs,
    onOutput: () => {
      ctx.onPhase("harness", `session ${sessionId} (${String(Math.round((Date.now() - started) / 1000))}s)`);
    },
  });

  writeFileSync(join(ctx.caseDir, "harness.stdout.txt"), result.stdout, "utf8");
  writeFileSync(join(ctx.caseDir, "harness.stderr.txt"), result.stderr, "utf8");

  let summary: HarnessSummary | null = null;
  try {
    summary = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as HarnessSummary;
  } catch {
    summary = null;
  }

  const logDir = summary?.log_dir ?? null;
  let comparisonPath: string | null = null;
  let mismatches: string[] = [];
  let comparisonErrors: string[] = [];
  if (logDir !== null) {
    comparisonPath = join(logDir, "artifacts", "expectation-comparison-result.json");
    if (exists(comparisonPath)) {
      const comparison = readJson<{
        declarations?: { name: string; matched: boolean }[];
        errors?: string[];
      }>(comparisonPath);
      mismatches = (comparison.declarations ?? []).filter((d) => !d.matched).map((d) => d.name);
      comparisonErrors = comparison.errors ?? [];
    } else {
      comparisonPath = null;
    }
  }

  return {
    status: result.status,
    exitCode: result.exitCode,
    elapsedMs: Date.now() - started,
    summary,
    stdoutText: result.stdout,
    stderrText: result.stderr,
    clonePath,
    sessionId,
    logDir,
    comparisonPath,
    mismatches,
    comparisonErrors,
    pipelinePath,
    error: result.error,
  };
}

/* ------------------------------------------------------------------ */
/* upstream-part driver                                                */
/* ------------------------------------------------------------------ */

const BUILD_TARGET = "uv_run_tests_a";

function runnerBinary(repo: string): string {
  const exe = join(repo, "build", `${BUILD_TARGET}.exe`);
  return exists(exe) ? exe : join(repo, "build", BUILD_TARGET);
}

/**
 * cmake configure + build, byte-for-byte the same commands the preset build
 * workflow declares (GCC 15 needs the two -Wno-error flags).
 */
async function buildRunner(ctx: JobContext, repo: string): Promise<{ ok: boolean; error: string | null; ms: number }> {
  const started = Date.now();
  const binary = runnerBinary(repo);
  if (exists(binary) && !ctx.rebuild) return { ok: true, error: null, ms: 0 };

  const configure = await exec({
    program: "cmake",
    args: ["-S", ".", "-B", "build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug", "-DBUILD_TESTING=ON",
           "-DCMAKE_C_FLAGS=-Wno-error=incompatible-pointer-types -Wno-error=discarded-qualifiers"],
    cwd: repo, timeoutMs: 300000,
    onOutput: () => ctx.onPhase("configure", `cmake (${String(Math.round((Date.now() - started) / 1000))}s)`),
  });
  if (configure.status !== "exited" || configure.exitCode !== 0) {
    return { ok: false, error: `cmake configure: ${(configure.stderr || configure.stdout).trim().slice(-600)}`, ms: Date.now() - started };
  }
  const build = await exec({
    program: "cmake",
    args: ["--build", "build", "--target", BUILD_TARGET, "-j", "8"],
    cwd: repo, timeoutMs: 1800000,
    onOutput: () => ctx.onPhase("build", `${BUILD_TARGET} (${String(Math.round((Date.now() - started) / 1000))}s)`),
  });
  if (build.status !== "exited" || build.exitCode !== 0) {
    return { ok: false, error: `cmake build: ${(build.stderr || build.stdout).trim().slice(-600)}`, ms: Date.now() - started };
  }
  if (!exists(runnerBinary(repo))) {
    return { ok: false, error: `build finished but ${relative(repo, runnerBinary(repo))} is missing`, ms: Date.now() - started };
  }
  return { ok: true, error: null, ms: Date.now() - started };
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function classify(
  runs: { exitCode: number | null; tap: string | null; stdout: string; status: ExecResult["status"] }[],
  policy: Part["policy"],
): PartCaseRun["classification"] {
  if (runs.some((r) => r.status !== "exited")) return "error";
  const expectTapPrefix = policy.expectTap.replace("{case}", "");
  const allOk = runs.every((r) => r.exitCode === policy.expectExit && (r.tap ?? "").startsWith(expectTapPrefix));
  const identical = runs.every((r) => r.exitCode === runs[0]!.exitCode && r.stdout === runs[0]!.stdout);
  if (!identical) return "flaky";
  return allOk ? "stable-ok" : "stable-fail";
}

export async function runPartCase(
  ctx: JobContext,
  c: SuiteCase,
  part: Part,
  caseFilter: string | null,
): Promise<PartRunResult> {
  const started = Date.now();
  const checkoutPath = join(ctx.caseDir, "corpus");
  ctx.onPhase("clone", "corpus checkout");
  await cloneBaseline(ctx, checkoutPath);

  const build = await buildRunner(ctx, checkoutPath);
  if (!build.ok) {
    return {
      partId: part.id, status: "build-failed", elapsedMs: Date.now() - started, buildMs: build.ms,
      cases: [], counts: {}, checkoutPath, error: build.error,
    };
  }

  const repeats = ctx.repeats > 0 ? ctx.repeats : part.policy.repeats;
  const names = caseFilter === null ? part.cases : part.cases.filter((n) => n.includes(caseFilter));
  const results: PartCaseRun[] = [];
  for (const name of names) {
    ctx.onPhase("cases", `${name} (${String(results.length + 1)}/${String(names.length)})`);
    const runs: { exitCode: number | null; tap: string | null; stdout: string; status: ExecResult["status"] }[] = [];
    for (let i = 0; i < repeats; i++) {
      const run = await exec({
        program: runnerBinary(checkoutPath),
        args: [name],
        cwd: checkoutPath,
        timeoutMs: 120000,
      });
      const stdout = run.stdout.trim();
      const tapLine = stdout.split(/\r?\n/).find((line) => line.startsWith("ok ") || line.startsWith("not ok ")) ?? null;
      runs.push({ exitCode: run.exitCode, tap: tapLine, stdout, status: run.status });
    }
    const classification = classify(runs, part.policy);
    results.push({
      name,
      classification,
      repeats,
      exitCodes: runs.map((r) => r.exitCode),
      taps: runs.map((r) => r.tap),
      stdoutSha: runs.map((r) => sha(r.stdout)),
      detail: classification === "stable-ok"
        ? `${String(repeats)}/${String(repeats)} identical, ${part.policy.expectTap.replace("{case}", name)}`
        : `exit=[${runs.map((r) => String(r.exitCode)).join(",")}] tap=[${runs.map((r) => String(r.tap)).join(",")}]`,
    });
  }

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.classification] = (counts[r.classification] ?? 0) + 1;
  const strictFailure = part.policy.kind === "strict" && results.some((r) => r.classification !== "stable-ok");
  const infraFailure = results.some((r) => r.classification === "error");
  return {
    partId: part.id,
    status: strictFailure || infraFailure ? "failed" : "ok",
    elapsedMs: Date.now() - started,
    buildMs: build.ms,
    cases: results,
    counts,
    checkoutPath,
    error: null,
  };
}

/**
 * Drop the per-case clone (about 7 MB plus the build output) while keeping the
 * evidence: anything the run wrote INSIDE the clone — the workflow sources a
 * writer session produced — is copied into `<case>/written/` first. The harness's
 * own artifacts live in the session root, i.e. the case directory, and stay put.
 */
/**
 * Copy the workflows a writer session produced out of the clone. Returns the
 * destination, or null when the clone holds nothing worth keeping.
 */
export function preserveWritten(clonePath: string, caseDir: string, sessionId: string): string | null {
  const sources = [
    join(clonePath, ".refactor", "runs", sessionId),
    join(clonePath, ".refactor", "workflows"),
    join(clonePath, ".refactor", "build-workflows"),
  ].filter((path) => exists(path));
  if (sources.length === 0) return null;
  const dest = join(caseDir, "written");
  mkdirSync(dest, { recursive: true });
  for (const source of sources) {
    cpSync(source, join(dest, source.split(/[\\/]/).slice(-1)[0]!), { recursive: true });
  }
  return dest;
}

export function dropClone(clonePath: string, caseDir: string, sessionId: string): string | null {
  const dest = preserveWritten(clonePath, caseDir, sessionId);
  rmSync(clonePath, { recursive: true, force: true });
  return dest;
}
