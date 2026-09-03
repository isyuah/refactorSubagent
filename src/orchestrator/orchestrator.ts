import type {
  AnyArtifact,
  ObservationTrace,
  PatchRecord,
  WorkflowResolution,
  CTestBaseline,
  CTestCandidate,
  CTestComparisonResult,
  ExpectationBaseline,
  ExpectationCandidate,
  ExpectationComparisonResult,
} from "../artifacts/index.js";
import { matchGlob } from "../artifacts/scope-manifest.js";
import { SessionStore, type SessionState } from "./store.js";

/**
 * Orchestrator — the only component allowed to move a session forward.
 *
 * The legacy TestSpec path and the Workflow-backed CTest path share the same
 * fail-closed gates. Models may propose artifacts; they cannot select a
 * terminal state or bypass a workflow/test stage.
 */

const TERMINAL: ReadonlySet<string> = new Set([
  "ACCEPTED",
  "REJECTED",
  "ABORTED",
]);

interface TransitionRule {
  readonly to: SessionState;
  readonly artifactKind: AnyArtifact["kind"];
}

/** Legacy transitions plus the two explicit Workflow stages. */
const PIPELINE: Partial<Record<SessionState, TransitionRule>> = {
  INIT: { to: "CONTRACT_READY", artifactKind: "behavior-contract" },
  CONTRACT_READY: { to: "SCOPE_READY", artifactKind: "scope-manifest" },
  SCOPE_READY: { to: "DEPENDENCY_READY", artifactKind: "dependency-manifest" },
  DEPENDENCY_READY: { to: "TESTS_READY", artifactKind: "test-spec" },
  // TESTS_READY also accepts build workflow resolution; see expectedTransition.
  TESTS_READY: { to: "ENV_READY", artifactKind: "environment-spec" },
  BUILD_WORKFLOW_READY: {
    to: "TEST_WORKFLOW_READY",
    artifactKind: "workflow-resolution",
  },
  TEST_WORKFLOW_READY: { to: "ENV_READY", artifactKind: "environment-spec" },
  ENV_READY: { to: "BASELINE_READY", artifactKind: "observation-trace" },
  BASELINE_READY: { to: "PATCH_CREATED", artifactKind: "patch-record" },
  PATCH_CREATED: {
    to: "VERIFICATION_RUNNING",
    artifactKind: "observation-trace",
  },
  VERIFICATION_RUNNING: { to: "ACCEPTED", artifactKind: "comparison-result" },
};

export type SubmitResult =
  | { ok: true; from: SessionState; to: SessionState }
  | { ok: false; reason: string };

export class Orchestrator {
  constructor(private readonly store: SessionStore) {}

  /** Advance the session using an artifact; domain violations never throw. */
  submit(raw: unknown): SubmitResult {
    const current = this.store.state;
    const rule = PIPELINE[current];
    if (!rule) {
      return {
        ok: false,
        reason: TERMINAL.has(current)
          ? `terminal state ${current} is immutable (R7)`
          : `no transition defined from ${current}`,
      };
    }

    let artifact: AnyArtifact;
    try {
      // R2: parse before inspecting kind or semantics.
      artifact = this.store.saveArtifact(raw);
    } catch (error) {
      return { ok: false, reason: `artifact rejected by schema: ${msg(error)}` };
    }

    const transition = expectedTransition(current, artifact, rule);
    if (transition.error !== null) {
      return { ok: false, reason: transition.error };
    }

    const semantic = this.checkSemantic(current, artifact);
    if (semantic !== null) return { ok: false, reason: semantic };

    // R6: terminal state is derived from a program-checked comparison.
    const to = artifact.kind === "comparison-result" && artifact.overall === "inconsistent"
      ? "REJECTED"
      : artifact.kind === "ctest-comparison-result" && artifact.overall === "inconsistent"
        ? "REJECTED"
        : artifact.kind === "expectation-comparison-result" && artifact.overall === "inconsistent"
          ? "REJECTED"
          : transition.to;

    this.store.commitTransition(to, artifact.kind);
    return { ok: true, from: current, to };
  }

  /** Abort from any non-terminal state. */
  abort(reason: string): SubmitResult {
    const from = this.store.state;
    if (TERMINAL.has(from)) {
      return { ok: false, reason: `terminal state ${from} is immutable (R7)` };
    }
    this.store.commitTransition("ABORTED", null, reason);
    return { ok: true, from, to: "ABORTED" };
  }

  private checkSemantic(from: SessionState, artifact: AnyArtifact): string | null {
    if (from === "TESTS_READY" && artifact.kind === "workflow-resolution") {
      if (artifact.workflow_kind !== "build" || artifact.build_workflow !== null) {
        return "BuildWorkflow resolution has an invalid dependency record";
      }
    }
    if (from === "BUILD_WORKFLOW_READY" && artifact.kind === "workflow-resolution") {
      if (artifact.workflow_kind !== "test") {
        return "TestWorkflow resolution has an invalid BuildWorkflow dependency";
      }
      if (artifact.mode === "declared") {
        // Declared-mode test workflows are self-driven: build dependencies live
        // in the DeclaredBuildSet artifact, not a single static reference.
        const set = this.store.artifact("declared-build-set");
        if (set === null) {
          return "DeclaredBuildSet missing — cannot audit TestWorkflow dependency";
        }
      } else {
        if (artifact.build_workflow === null) {
          return "TestWorkflow resolution has an invalid BuildWorkflow dependency";
        }
        const build = this.store.workflowResolution("build");
        if (build === null || build.workflow_kind !== "build") {
          return "BuildWorkflow resolution missing — cannot audit TestWorkflow dependency";
        }
        if (
          artifact.build_workflow.id !== build.workflow_id ||
          artifact.build_workflow.revision !== build.workflow_revision
        ) {
          return "TestWorkflow resolution references a different BuildWorkflow";
        }
      }
    }
    if (from === "ENV_READY") {
      if (artifact.kind === "observation-trace") return checkBaseline(artifact);
      if (artifact.kind === "ctest-baseline") return checkCTestBaseline(artifact);
      if (artifact.kind === "expectation-baseline") {
        // Baseline side must have run cleanly (workflow_passed is enforced
        // by the schema literal true).
        return null;
      }
    }
    if (from === "BASELINE_READY" && artifact.kind === "patch-record") {
      return checkPatchScope(this.store, artifact);
    }
    if (from === "PATCH_CREATED") {
      if (artifact.kind === "observation-trace") return checkCandidate(this.store, artifact);
      if (artifact.kind === "ctest-candidate") return checkCTestCandidate(this.store, artifact);
    }
    if (from === "VERIFICATION_RUNNING" && artifact.kind === "ctest-comparison-result") {
      return checkCTestComparison(this.store, artifact);
    }
    if (from === "VERIFICATION_RUNNING" && artifact.kind === "expectation-comparison-result") {
      return checkExpectationComparison(this.store, artifact);
    }
    return null;
  }
}

interface ExpectedTransition {
  readonly to: SessionState;
  readonly error: string | null;
}

function expectedTransition(
  current: SessionState,
  artifact: AnyArtifact,
  rule: TransitionRule,
): ExpectedTransition {
  // New path: test intent → build workflow → test workflow → environment.
  if (current === "TESTS_READY" && artifact.kind === "declared-build-set") {
    return { to: "BUILD_WORKFLOW_READY", error: null };
  }
  if (current === "TESTS_READY" && artifact.kind === "workflow-resolution") {
    return artifact.workflow_kind === "build"
      ? { to: "BUILD_WORKFLOW_READY", error: null }
      : {
          to: rule.to,
          error: "R1 violation: TESTS_READY requires a build workflow resolution first",
        };
  }
  if (current === "BUILD_WORKFLOW_READY" && artifact.kind === "workflow-resolution") {
    return artifact.workflow_kind === "test"
      ? { to: "TEST_WORKFLOW_READY", error: null }
      : {
          to: rule.to,
          error: "R1 violation: BUILD_WORKFLOW_READY requires a test workflow resolution",
        };
  }

  // New path: the actual CTest suite is an execution artifact, not an
  // ObservationTrace pretending to be a test suite.
  if (current === "ENV_READY" && artifact.kind === "ctest-baseline") {
    return { to: "BASELINE_READY", error: null };
  }
  if (current === "PATCH_CREATED" && artifact.kind === "ctest-candidate") {
    return { to: "VERIFICATION_RUNNING", error: null };
  }
  if (current === "VERIFICATION_RUNNING" && artifact.kind === "ctest-comparison-result") {
    return { to: "ACCEPTED", error: null };
  }
  if (current === "ENV_READY" && artifact.kind === "expectation-baseline") {
    return { to: "BASELINE_READY", error: null };
  }
  if (current === "PATCH_CREATED" && artifact.kind === "expectation-candidate") {
    return { to: "VERIFICATION_RUNNING", error: null };
  }
  if (current === "VERIFICATION_RUNNING" && artifact.kind === "expectation-comparison-result") {
    return { to: "ACCEPTED", error: null };
  }

  if (artifact.kind !== rule.artifactKind) {
    return {
      to: rule.to,
      error: `R1 violation: ${current} requires '${rule.artifactKind}', got '${artifact.kind}'`,
    };
  }
  return { to: rule.to, error: null };
}

function checkExpectationComparison(
  store: SessionStore,
  artifact: ExpectationComparisonResult,
): string | null {
  const baseline = store.artifact("expectation-baseline");
  const candidate = store.artifact("expectation-candidate");
  if (baseline === null || candidate === null) {
    return "expectation baseline/candidate artifact missing — cannot compare";
  }
  if (artifact.overall === "consistent") {
    if (artifact.declarations.some((decl) => !decl.matched)) {
      return "expectation comparison marked consistent but has unmatched declarations";
    }
    if (artifact.errors.length > 0) {
      return "expectation comparison marked consistent but has structural errors";
    }
  }
  return null;
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** R3 for the legacy invocation-level baseline trace. */
function checkBaseline(artifact: ObservationTrace): string | null {
  if (artifact.build !== "baseline") {
    return `expected a baseline build trace, got '${artifact.build}'`;
  }
  for (const failure of artifact.failures) {
    const provablyUnrelated =
      failure.category === "preexisting_behavior" ||
      (failure.category === "environment" && !failure.related_to_scope);
    if (!provablyUnrelated) {
      return (
        `R3 violation: baseline failure on '${failure.case_id}' (${failure.category}) ` +
        "cannot be proven unrelated to the modification scope"
      );
    }
  }
  return null;
}

/** R3 for a complete CTest suite. Unknown and scope-related failures stop. */
function checkCTestBaseline(artifact: CTestBaseline): string | null {
  const failedNames = ctestFailureNames(artifact);
  const classifiedNames = new Set(
    artifact.failure_classifications.map((failure) => failure.test),
  );
  for (const name of failedNames) {
    if (!classifiedNames.has(name)) {
      return `R3 violation: CTest baseline failure '${name}' has no classification`;
    }
  }
  for (const classification of artifact.failure_classifications) {
    if (!failedNames.has(classification.test)) {
      return `R3 violation: classification has no corresponding CTest failure '${classification.test}'`;
    }
    if (
      classification.category === "unknown" ||
      classification.category === "scope_related" ||
      classification.related_to_scope
    ) {
      return (
        `R3 violation: CTest baseline failure '${classification.test}' ` +
        `is ${classification.category} or scope-related`
      );
    }
  }
  return null;
}

function ctestFailureNames(artifact: CTestBaseline | CTestCandidate): Set<string> {
  const names = new Set(artifact.result.failed_tests.map((failure) => failure.name));
  if (names.size === 0 && artifact.result.status !== "pass") names.add("__suite__");
  return names;
}

/** R4: patch must stay inside Modification Scope. */
function checkPatchScope(store: SessionStore, artifact: PatchRecord): string | null {
  const scope = store.artifact("scope-manifest");
  if (scope === null) return "scope manifest missing — cannot verify patch scope";
  const editablePaths = scope.editable_files.map((target) => target.file);
  const outside = artifact.changed_files.filter((file) => !matchGlob(file, editablePaths));
  if (outside.length > 0) {
    return `R4 violation: patch touches non-editable files: ${outside.join(", ")}`;
  }
  return null;
}

/** R5 for the legacy invocation-level candidate trace. */
function checkCandidate(store: SessionStore, artifact: ObservationTrace): string | null {
  if (artifact.build !== "candidate") {
    return `expected a candidate build trace, got '${artifact.build}'`;
  }
  const baseline = store.trace("baseline");
  if (baseline === null) return "baseline trace missing — cannot compare case coverage";
  const baseIds = new Set(baseline.observations.map((observation) => observation.case_id));
  const candidateIds = new Set(artifact.observations.map((observation) => observation.case_id));
  const missing = [...baseIds].filter((id) => !candidateIds.has(id));
  const extra = [...candidateIds].filter((id) => !baseIds.has(id));
  if (missing.length > 0 || extra.length > 0) {
    return `R5 violation: case set drift — missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`;
  }
  return null;
}

function checkCTestCandidate(store: SessionStore, artifact: CTestCandidate): string | null {
  const baseline = store.artifact("ctest-baseline");
  if (baseline === null) return "CTest baseline missing — cannot compare candidate suite";
  if (artifact.result.top_level_tests.length === 0) {
    return "R5 violation: candidate CTest observed no top-level tests";
  }
  return null;
}

/** Recompute all CTest comparison fields from persisted baseline/candidate evidence. */
function checkCTestComparison(
  store: SessionStore,
  artifact: CTestComparisonResult,
): string | null {
  const baseline = store.artifact("ctest-baseline");
  const candidate = store.artifact("ctest-candidate");
  if (baseline === null || candidate === null) {
    return "CTest baseline/candidate artifact missing — cannot compare suites";
  }

  const baseFailures = ctestFailureNames(baseline);
  const candidateFailures = ctestFailureNames(candidate);
  const added = setDifference(candidateFailures, baseFailures);
  const removed = setDifference(baseFailures, candidateFailures);
  const sameTopLevel = sameSet(
    new Set(baseline.result.top_level_tests),
    new Set(candidate.result.top_level_tests),
  );
  const sameFailures = added.length === 0 && removed.length === 0;
  const sameStatus = baseline.result.status === candidate.result.status;
  const expectedOverall = sameTopLevel && sameFailures && sameStatus
    ? "consistent"
    : "inconsistent";

  if (artifact.baseline_status !== baseline.result.status) return "CTest comparison baseline status drift";
  if (artifact.candidate_status !== candidate.result.status) return "CTest comparison candidate status drift";
  if (!sameArray(artifact.baseline_top_level_tests, baseline.result.top_level_tests)) {
    return "CTest comparison baseline top-level test set drift";
  }
  if (!sameArray(artifact.candidate_top_level_tests, candidate.result.top_level_tests)) {
    return "CTest comparison candidate top-level test set drift";
  }
  if (!sameArray(artifact.baseline_failed_tests, [...baseFailures])) {
    return "CTest comparison baseline failure set drift";
  }
  if (!sameArray(artifact.candidate_failed_tests, [...candidateFailures])) {
    return "CTest comparison candidate failure set drift";
  }
  if (!sameArray(artifact.added_failures, added) || !sameArray(artifact.removed_failures, removed)) {
    return "CTest comparison delta drift";
  }
  if (artifact.overall !== expectedOverall) {
    return `R6 violation: program recomputed CTest verdict is ${expectedOverall}`;
  }
  return null;
}

function setDifference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return sameSet(new Set(left), new Set(right));
}
