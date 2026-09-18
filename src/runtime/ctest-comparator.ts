import {
  CTestBaseline,
  CTestCandidate,
  CTestComparisonResult,
  type CTestFailureClassification,
  type CTestSuiteResult,
} from "../artifacts/index.js";

export function classifyCTestBaseline(
  result: CTestSuiteResult,
  options: {
    readonly knownEnvironmentPatterns?: readonly RegExp[];
  } = {},
): CTestBaseline {
  const failures = result.failed_tests.length > 0
    ? result.failed_tests
    : result.status === "pass"
      ? []
      : [{ name: "__suite__", output: result.failure?.explanation ?? "CTest suite failed" }];

  const classifications: CTestFailureClassification[] = failures.map((failure) => ({
    test: failure.name,
    category: classifyFailure(failure.output, options.knownEnvironmentPatterns),
    explanation: explainFailure(failure.output),
  }));

  return CTestBaseline.parse({
    kind: "ctest-baseline",
    version: 1,
    result,
    failure_classifications: classifications,
    notes: [
      "Classification is evidence for fail-closed baseline gating; it does not turn a failed suite into a pass.",
    ],
  });
}

export function createCTestCandidate(result: CTestSuiteResult): CTestCandidate {
  return CTestCandidate.parse({
    kind: "ctest-candidate",
    version: 1,
    result,
    notes: ["Candidate ran the same program-materialized CTestSuiteSpec as baseline."],
  });
}

export function compareCTestSuites(
  baseline: CTestBaseline,
  candidate: CTestCandidate,
): CTestComparisonResult {
  const baselineFailures = failureNames(baseline.result);
  const candidateFailures = failureNames(candidate.result);
  const added = difference(candidateFailures, baselineFailures);
  const removed = difference(baselineFailures, candidateFailures);
  const topLevelMatch = sameSet(
    new Set(baseline.result.top_level_tests),
    new Set(candidate.result.top_level_tests),
  );
  const statusMatch = baseline.result.status === candidate.result.status;
  const overall = topLevelMatch && added.length === 0 && removed.length === 0 && statusMatch
    ? "consistent"
    : "inconsistent";
  const warnings = ctestComparisonWarnings(
    baseline.result.status,
    candidate.result.status,
    overall,
  );

  return CTestComparisonResult.parse({
    kind: "ctest-comparison-result",
    version: 1,
    baseline_status: baseline.result.status,
    candidate_status: candidate.result.status,
    baseline_top_level_tests: [...baseline.result.top_level_tests],
    candidate_top_level_tests: [...candidate.result.top_level_tests],
    baseline_failed_tests: [...baselineFailures],
    candidate_failed_tests: [...candidateFailures],
    added_failures: added,
    removed_failures: removed,
    overall,
    warnings,
    reason: overall === "consistent"
      ? "candidate has the same CTest status, top-level targets, and failure set as baseline"
      : `CTest drift: added=[${added.join(", ")}] removed=[${removed.join(", ")}] ` +
        `top_level_match=${String(topLevelMatch)} status_match=${String(statusMatch)}`,
  });
}

/**
 * A matching failure is behaviorally consistent, but it is not a healthy test
 * run. Keep that distinction visible without turning the comparison into a
 * rejection.
 */
export function ctestComparisonWarnings(
  baselineStatus: CTestSuiteResult["status"],
  candidateStatus: CTestSuiteResult["status"],
  overall: CTestComparisonResult["overall"],
): string[] {
  if (
    overall === "consistent" &&
    baselineStatus !== "pass" &&
    candidateStatus !== "pass"
  ) {
    return [
      `baseline and candidate CTest suites both ended with status '${baselineStatus}'; ` +
        "the result is accepted because the failure behavior is consistent",
    ];
  }
  return [];
}

function classifyFailure(output: string, patterns: readonly RegExp[] | undefined): CTestFailureClassification["category"] {
  if (patterns?.some((pattern) => pattern.test(output)) || /IPv6|UDP|DNS|timeout|short path|unavailable|refused/i.test(output)) {
    return "environment";
  }
  return "unknown";
}

function explainFailure(output: string): string {
  const normalized = output.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, 1000) : "CTest reported a failure without diagnostic output";
}

function failureNames(result: CTestSuiteResult): Set<string> {
  const names = new Set(result.failed_tests.map((failure) => failure.name));
  if (names.size === 0 && result.status !== "pass") names.add("__suite__");
  return names;
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
