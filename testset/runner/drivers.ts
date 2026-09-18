/**
 * Drivers: how a case produces a result.
 *
 *   pipeline      — run the harness CLI against the environment the case's
 *                   prepare script built (one env dir + one session root per
 *                   case, so cases never share mutable state)
 *   upstream-part — the same environment, built once with the pinned cmake
 *                   recipe; every case of the part is executed R times and
 *                   classified (strict / calibrate)
 *
 * Nothing here decides pass/fail; that is evaluate.ts.
 */
import { createHash } from "node:crypto";
import { existsSync as exists, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { exec, type ExecResult } from "./exec.js";
import { readJson, writeJson } from "./util.js";
import type { Part, SuiteCase } from "./suite.js";

export interface JobContext {
  /** Per-case evidence directory (results, logs, session root). */
  readonly caseDir: string;
  readonly testRoot: string;
  readonly harnessDir: string;
  readonly harnessCli: string;
  readonly bun: string;
  readonly repeats: number;
  readonly rebuild: boolean;
  /** Wall-clock start of this case, for progress details. */
  readonly startedAt: number;
  readonly onPhase: (phase: string, detail?: string) => void;
}

export interface HarnessSummary {
  readonly state?: string;
  readonly session?: string;
  readonly log_dir?: string;
  readonly comparison?: string | null;
  readonly injected_stages?: string[];
  readonly verification_authoritative?: boolean;
  readonly baseline_build?: string | null;
  readonly candidate_build?: string | null;
  readonly declared_builds?: string[];
}

export interface PipelineRunResult {
  readonly status: ExecResult["status"];
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  readonly summary: HarnessSummary | null;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly envDir: string;
  readonly repoDir: string;
  readonly sessionRoot: string;
  readonly sessionId: string;
  readonly logDir: string | null;
  readonly comparisonPath: string | null;
  readonly mismatches: readonly string[];
  readonly comparisonErrors: readonly string[];
  /** Injection destinations that already held a different file (tamper attempts). */
  readonly injectionReplaced: readonly string[];
  /** Last harness phase seen in the session log (post-mortem evidence). */
  readonly harnessPhase: string;
  readonly pipelinePath: string;
  readonly error: string | null;
}

/** Run the harness CLI once against a prepared environment. */
export async function runPipelineCase(
  ctx: JobContext,
  c: SuiteCase,
  task: string,
): Promise<PipelineRunResult> {
  const started = Date.now();
  const envDir = join(ctx.caseDir, "env");
  const repoDir = join(envDir, c.repo);
  const sessionRoot = join(ctx.caseDir, "session");
  let sessionId = `${c.id}-s1`;
  const pipelinePath = join(ctx.caseDir, "pipeline.json");
  writeJson(pipelinePath, { version: 1, stages: c.stages });
  // The session id is derived from the case id, so a re-run into the same out
  // directory must start from an empty session root. A stale process from an
  // interrupted run can hold it (Windows), so falling back to a fresh id beats
  // failing the case over housekeeping.
  try {
    rmSync(sessionRoot, { recursive: true, force: true });
  } catch {
    sessionId = `${c.id}-s${String(Math.floor(Date.now() / 1000) % 100000)}`;
    ctx.onPhase("harness", `session ${sessionId} (stale session root left in place)`);
  }

  const args = [
    ctx.harnessCli, "run", repoDir,
    "--task", task,
    "--session", sessionId,
    "--session-root", sessionRoot,
    "--pipeline-file", pipelinePath,
    "--format", "json",
  ];
  for (const injection of c.inject) args.push("--inject", `${injection.source}=${injection.dest}`);
  for (const [key, value] of Object.entries(c.limits)) {
    args.push("--limit", `${key}=${value === null ? "null" : String(value)}`);
  }

  ctx.onPhase("harness", `session ${sessionId}`);
  // The harness keeps its progress in run.jsonl and prints nothing on stdout
  // until the end, so a long session would otherwise show only "running". Tail
  // the log and surface the phase it is in (PREFLIGHT → … → VERIFICATION).
  const sessionLog = join(sessionRoot, ".refactor", "e2e", sessionId, "run.jsonl");
  let lastPhase = "starting";
  let lastLogLine = "";
  const tailSessionLog = (): void => {
    try {
      if (!exists(sessionLog)) return;
      const lines = readFileSync(sessionLog, "utf8").trimEnd().split(/\r?\n/);
      const line = lines[lines.length - 1] ?? "";
      if (line === "" || line === lastLogLine) return;
      lastLogLine = line;
      const event = JSON.parse(line) as { phase?: string; event?: string; msg?: string };
      lastPhase = `${event.phase ?? "?"}${event.msg === undefined ? "" : ` (${event.msg})`}`;
    } catch {
      // The log is being written; a partial line is not a failure.
    }
  };
  const tailer = setInterval(() => {
    tailSessionLog();
    ctx.onPhase("harness", `session ${sessionId} (${String(Math.round((Date.now() - started) / 1000))}s) · ${lastPhase}`);
  }, 2000);
  const result = await exec({
    program: ctx.bun,
    args,
    cwd: ctx.harnessDir,
    timeoutMs: c.timeoutMs ?? 3_600_000,
    onOutput: () => {
      ctx.onPhase("harness", `session ${sessionId} (${String(Math.round((Date.now() - started) / 1000))}s) · ${lastPhase}`);
    },
  });
  clearInterval(tailer);
  tailSessionLog();

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
  let injectionReplaced: string[] = [];
  if (logDir !== null) {
    const candidate = join(logDir, "artifacts", "expectation-comparison-result.json");
    if (exists(candidate)) {
      comparisonPath = candidate;
      const comparison = readJson<{
        declarations?: { name: string; matched: boolean }[];
        errors?: string[];
      }>(candidate);
      mismatches = (comparison.declarations ?? []).filter((d) => !d.matched).map((d) => d.name);
      comparisonErrors = comparison.errors ?? [];
    }
    const injectionsPath = join(logDir, "artifacts", "injections.json");
    if (exists(injectionsPath)) {
      const record = readJson<{ injections?: { preExisting?: string[] }[] }>(injectionsPath);
      injectionReplaced = (record.injections ?? []).flatMap((entry) => entry.preExisting ?? []);
    }
  }

  return {
    status: result.status,
    exitCode: result.exitCode,
    elapsedMs: Date.now() - started,
    summary,
    stdoutText: result.stdout,
    stderrText: result.stderr,
    envDir,
    repoDir,
    sessionRoot,
    sessionId,
    logDir,
    comparisonPath,
    mismatches,
    comparisonErrors,
    injectionReplaced,
    harnessPhase: lastPhase,
    pipelinePath,
    error: result.error,
  };
}

/** Delete the prepared environment (--drop-env); the evidence outside it stays. */
export function dropEnvironment(run: PipelineRunResult): void {
  rmSync(run.envDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* upstream-part driver                                                */
/* ------------------------------------------------------------------ */

const BUILD_TARGET = "uv_run_tests_a";

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
  readonly repoDir: string;
  readonly error: string | null;
}

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
  if (exists(runnerBinary(repo)) && !ctx.rebuild) return { ok: true, error: null, ms: 0 };

  const configure = await exec({
    program: "cmake",
    args: ["-S", ".", "-B", "build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug", "-DBUILD_TESTING=ON",
           "-DCMAKE_C_FLAGS=-Wno-error=incompatible-pointer-types -Wno-error=discarded-qualifiers"],
    cwd: repo, timeoutMs: 300_000,
    onOutput: () => ctx.onPhase("configure", `cmake (${String(Math.round((Date.now() - started) / 1000))}s)`),
  });
  if (configure.status !== "exited" || configure.exitCode !== 0) {
    return { ok: false, error: `cmake configure: ${(configure.stderr || configure.stdout).trim().slice(-600)}`, ms: Date.now() - started };
  }
  const build = await exec({
    program: "cmake",
    args: ["--build", "build", "--target", BUILD_TARGET, "-j", "8"],
    cwd: repo, timeoutMs: 1_800_000,
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

/** Execute one corpus part against the prepared environment. */
export async function runPartCase(
  ctx: JobContext,
  c: SuiteCase,
  part: Part,
  caseFilter: string | null,
): Promise<PartRunResult> {
  const started = Date.now();
  const repoDir = join(ctx.caseDir, "env", c.repo);
  const build = await buildRunner(ctx, repoDir);
  if (!build.ok) {
    return {
      partId: part.id, status: "build-failed", elapsedMs: Date.now() - started, buildMs: build.ms,
      cases: [], counts: {}, repoDir, error: build.error,
    };
  }

  const repeats = ctx.repeats > 0 ? ctx.repeats : part.policy.repeats;
  const names = caseFilter === null ? part.cases : part.cases.filter((name) => name.includes(caseFilter));
  const results: PartCaseRun[] = [];
  for (const name of names) {
    ctx.onPhase("cases", `${name} (${String(results.length + 1)}/${String(names.length)})`);
    const runs: { exitCode: number | null; tap: string | null; stdout: string; status: ExecResult["status"] }[] = [];
    for (let index = 0; index < repeats; index++) {
      const run = await exec({ program: runnerBinary(repoDir), args: [name], cwd: repoDir, timeoutMs: 120_000 });
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
      stdoutSha: runs.map((r) => createHash("sha256").update(r.stdout).digest("hex").slice(0, 16)),
      detail: classification === "stable-ok"
        ? `${String(repeats)}/${String(repeats)} identical, ${part.policy.expectTap.replace("{case}", name)}`
        : `exit=[${runs.map((r) => String(r.exitCode)).join(",")}] tap=[${runs.map((r) => String(r.tap)).join(",")}]`,
    });
  }

  const counts: Record<string, number> = {};
  for (const result of results) counts[result.classification] = (counts[result.classification] ?? 0) + 1;
  const strictFailure = part.policy.kind === "strict" && results.some((r) => r.classification !== "stable-ok");
  const infraFailure = results.some((r) => r.classification === "error");
  return {
    partId: part.id,
    status: strictFailure || infraFailure ? "failed" : "ok",
    elapsedMs: Date.now() - started,
    buildMs: build.ms,
    cases: results,
    counts,
    repoDir,
    error: null,
  };
}

/** Read the task brief a case points at. */
export function readTask(c: SuiteCase): string {
  return c.taskFile === null ? "" : readFileSync(c.taskFile, "utf8").trim();
}
