/**
 * Evaluators — one per evaluation method the suite uses. This is the place where
 * "different tests get different verdicts" is actually implemented:
 *
 *   verdict / verdict+attribution : programme decides, from the harness artifacts
 *   verdict+rubric                : programme decides, then the rubric scorer grades
 *                                   the artefacts the programme cannot score
 *   part                          : strict corpus cases must pass; candidate
 *                                   parts are only classified (stable/flaky)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fmtDuration } from "./util.js";
import type { Part, SuiteCase } from "./suite.js";
import type { PartRunResult, PipelineRunResult } from "./drivers.js";
import type { RubricOutcome } from "./rubric.js";

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CaseEvaluation {
  readonly status: "passed" | "failed" | "error" | "pending-rubric" | "blocked";
  readonly checks: readonly Check[];
  readonly observed: Readonly<Record<string, unknown>>;
  readonly rubric: RubricOutcome | null;
}

/** A case this host cannot run: skipped with a reason, never counted as failed. */
export function evaluateBlocked(c: SuiteCase, reason: string): CaseEvaluation {
  return {
    status: "blocked",
    checks: [{ name: "environment", ok: false, detail: reason }],
    observed: { blockedReason: reason },
    rubric: null,
  };
}

function check(name: string, ok: boolean, detail: string): Check {
  return { name, ok, detail };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export interface EvaluateOptions {
  /** calibration runs report attribution gaps instead of failing on them. */
  readonly calibrate: boolean;
}

export function evaluatePipeline(
  c: SuiteCase,
  run: PipelineRunResult,
  options: EvaluateOptions,
  rubricOutcome: RubricOutcome | null,
): CaseEvaluation {
  const checks: Check[] = [];
  const expect = c.expect;
  const expectedExit = expect.state === "ACCEPTED" ? 0 : 1;

  checks.push(check("run-completed", run.status === "exited",
    run.status === "exited"
      ? `harness exited ${String(run.exitCode)} in ${fmtDuration(run.elapsedMs)}`
      : `${run.status}: ${run.error ?? (run.stderrText.trim().slice(-300) || "no stderr")}`));

  if (run.summary === null) {
    checks.push(check("summary-parsed", false, run.stdoutText.trim().slice(-300) || "no harness JSON on stdout"));
  } else {
    checks.push(check("summary-parsed", true, `state=${run.summary.state} comparison=${String(run.summary.comparison)}`));
  }

  const summary = run.summary;
  checks.push(check("exit-code", run.exitCode === expectedExit,
    `exit=${String(run.exitCode)} expected=${String(expectedExit)} (state ${String(expect.state)})`));

  checks.push(check("state", summary !== null && summary.state === expect.state,
    `state=${String(summary?.state)} expected=${String(expect.state)}`));

  if (expect.injectedStages !== undefined) {
    const actual = summary?.injected_stages ?? [];
    const ok = sameSet(actual, expect.injectedStages);
    checks.push(check("injected-stages", ok,
      `injected=[${actual.join(",")}] expected=[${expect.injectedStages.join(",")}]`));
  }

  if (expect.authoritative !== undefined) {
    const actual = summary?.verification_authoritative ?? null;
    checks.push(check("verification-authoritative", actual === expect.authoritative,
      `authoritative=${String(actual)} expected=${String(expect.authoritative)}`));
  }

  const required = expect.failuresRequired ?? [];
  const missing = required.filter((name) => !run.mismatches.includes(name));
  checks.push(check("attribution-required", missing.length === 0,
    missing.length === 0
      ? `${String(required.length)} required mismatch(es) all observed`
      : `missing: ${missing.join(", ")} (observed ${String(run.mismatches.length)}: ${run.mismatches.slice(0, 6).join(", ")})`));

  const forbidden = expect.failuresForbidden ?? [];
  const hit = forbidden.filter((name) => run.mismatches.includes(name));
  checks.push(check("attribution-forbidden", hit.length === 0,
    hit.length === 0 ? "no forbidden mismatch" : `unexpected: ${hit.join(", ")}`));

  if (run.comparisonErrors.length > 0) {
    checks.push(check("comparison-errors", false, run.comparisonErrors.join(" | ").slice(0, 300)));
  }

  if (expect.failuresExact !== null && expect.failuresExact !== undefined) {
    const ok = sameSet(run.mismatches, expect.failuresExact);
    checks.push(check("attribution-exact", ok,
      ok ? `${String(expect.failuresExact.length)} mismatches exactly as calibrated`
         : `observed=[${run.mismatches.join(",")}] frozen=[${expect.failuresExact.join(",")}]`));
  }

  for (const rel of expect.requireFiles ?? []) {
    const substituted = rel.replace("{session}", run.sessionId);
    // Run-local workflow sources live under the session root; a case may also
    // name a file inside the prepared repository. Check both, session first.
    const candidates = [join(run.sessionRoot, substituted), join(run.repoDir, substituted)];
    const found = candidates.find((path) => existsSync(path)) ?? null;
    checks.push(check(`file:${rel.replace("{session}", "<session>")}`, found !== null,
      found !== null ? `present: ${found}` : `missing: ${candidates.join(" | ")}`));
  }

  if (expect.replacedFiles !== undefined) {
    const expected = [...expect.replacedFiles].sort();
    const actual = [...run.injectionReplaced].sort();
    const ok = sameSet(expected, actual);
    checks.push(check("injection-replaced", ok,
      ok ? `injection overwrote ${String(actual.length)} pre-existing file(s): ${actual.join(", ")}`
         : `expected=[${expected.join(",")}] observed=[${actual.join(",")}]`));
  }

  // The rubric scorer only exists for "verdict+rubric" cases; a missing score is
  // command is a pending score — not a failure, and not a pass either.
  if (expect.method === "verdict+rubric") {
    if (rubricOutcome === null) checks.push(check("rubric", false, "no rubric score was produced"));
    else if (rubricOutcome.status === "failed") checks.push(check("rubric", false, rubricOutcome.detail));
    else if (rubricOutcome.status === "scored") checks.push(check("rubric", true, rubricOutcome.detail));
  }

  const hard = checks.filter((x) => x.name !== "attribution-exact" && x.name !== "attribution-required");
  const attributionOk = options.calibrate
    ? true
    : checks.filter((x) => x.name === "attribution-required").every((x) => x.ok);
  const rubricPending = expect.method === "verdict+rubric" && rubricOutcome !== null && rubricOutcome.status === "pending";
  const failed = hard.some((x) => !x.ok) || !attributionOk;
  const status: CaseEvaluation["status"] = failed ? "failed" : rubricPending ? "pending-rubric" : "passed";

  return {
    status,
    checks,
    observed: {
      state: summary?.state ?? null,
      comparison: summary?.comparison ?? null,
      injected: summary?.injected_stages ?? [],
      authoritative: summary?.verification_authoritative ?? null,
      mismatches: run.mismatches,
      mismatchCount: run.mismatches.length,
      baselineBuild: summary?.baseline_build ?? null,
      candidateBuild: summary?.candidate_build ?? null,
      session: run.sessionId,
      logDir: run.logDir,
    },
    rubric: rubricOutcome,
  };
}

export function evaluatePart(
  c: SuiteCase,
  part: Part,
  run: PartRunResult,
): CaseEvaluation {
  const checks: Check[] = [];
  checks.push(check("build", run.status !== "build-failed",
    run.status === "build-failed"
      ? `build failed: ${run.error ?? ""}`
      : `runner built in ${fmtDuration(run.buildMs)}`));

  const counts = run.counts;
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${String(v)}`).join(" ");
  checks.push(check("cases-ran", run.cases.length > 0, `${String(run.cases.length)} case(s): ${summary}`));

  if (part.policy.kind === "strict") {
    const bad = run.cases.filter((r) => r.classification !== "stable-ok");
    checks.push(check("strict-cases", bad.length === 0,
      bad.length === 0 ? "every case exit 0 with the expected TAP line"
                       : bad.map((r) => `${r.name}(${r.classification})`).join(", ")));
  } else {
    const errored = run.cases.filter((r) => r.classification === "error");
    checks.push(check("calibration-completed", errored.length === 0,
      errored.length === 0
        ? `classified ${String(run.cases.length)} case(s) over ${String(run.cases[0]?.repeats ?? 0)} repeat(s)`
        : errored.map((r) => r.name).join(", ")));
  }

  const failed = checks.some((x) => !x.ok);
  return {
    status: failed ? "failed" : "passed",
    checks,
    observed: {
      part: part.id,
      policy: part.policy.kind,
      counts,
      cases: run.cases.map((r) => ({ name: r.name, classification: r.classification, detail: r.detail })),
      buildMs: run.buildMs,
    },
    rubric: null,
  };
}
