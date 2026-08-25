import type {
  AnyArtifact,
  ObservationTrace,
  PatchRecord,
} from "../artifacts/index.js";
import { matchGlob } from "../artifacts/scope-manifest.js";
import { SessionStore, type SessionState } from "./store.js";

/**
 * Orchestrator — the ONLY component allowed to move a session forward.
 *
 * Fail-closed rules encoded here (never left to a model):
 *   R1 linear progression: only the artifact expected by the current state is
 *      accepted; skipping or reordering is rejected.
 *   R2 artifacts must parse against their zod schema.
 *   R3 baseline failures may proceed ONLY when classified as preexisting
 *      behavior, or environment-related AND unrelated to scope.
 *   R4 the patch may touch only files listed in ScopeManifest.editable_files.
 *   R5 the candidate trace must cover exactly the baseline's case ids.
 *   R6 comparison verdict decides ACCEPTED vs REJECTED — never the model.
 *   R7 terminal states are immutable; ABORTED reachable otherwise.
 */

const TERMINAL: ReadonlySet<string> = new Set([
  "ACCEPTED",
  "REJECTED",
  "ABORTED",
]);

interface TransitionRule {
  to: SessionState;
  artifactKind: AnyArtifact["kind"];
}

/** Ordered pipeline: current state → what advances it. */
const PIPELINE: Partial<Record<SessionState, TransitionRule>> = {
  INIT: { to: "CONTRACT_READY", artifactKind: "behavior-contract" },
  CONTRACT_READY: { to: "SCOPE_READY", artifactKind: "scope-manifest" },
  SCOPE_READY: { to: "DEPENDENCY_READY", artifactKind: "dependency-manifest" },
  DEPENDENCY_READY: { to: "TESTS_READY", artifactKind: "test-spec" },
  TESTS_READY: { to: "ENV_READY", artifactKind: "environment-spec" },
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

  /** Advance the session using an artifact; domain violations return reasons, never throw. */
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
      // R2: schema validation before anything else.
      artifact = this.store.saveArtifact(raw);
    } catch (e) {
      return { ok: false, reason: `artifact rejected by schema: ${msg(e)}` };
    }

    if (artifact.kind !== rule.artifactKind) {
      return {
        ok: false,
        reason: `R1 violation: ${current} requires '${rule.artifactKind}', got '${artifact.kind}'`,
      };
    }

    const semantic = this.checkSemantic(current, artifact);
    if (semantic) return { ok: false, reason: semantic };

    // R6: at VERIFICATION_RUNNING the comparison verdict picks the terminal state.
    const to =
      artifact.kind === "comparison-result" && artifact.overall === "inconsistent"
        ? "REJECTED"
        : rule.to;

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

  private checkSemantic(
    from: SessionState,
    artifact: AnyArtifact,
  ): string | null {
    if (from === "ENV_READY") return checkBaseline(artifact);
    if (from === "BASELINE_READY") return checkPatchScope(this.store, artifact);
    if (from === "PATCH_CREATED") return checkCandidate(this.store, artifact);
    return null;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** R3: unexplained / scope-related baseline failures block progression. */
function checkBaseline(artifact: AnyArtifact): string | null {
  if (artifact.kind !== "observation-trace") return null; // R1 already reported
  if (artifact.build !== "baseline") {
    return `expected a baseline build trace, got '${artifact.build}'`;
  }
  for (const f of artifact.failures) {
    const provablyUnrelated =
      f.category === "preexisting_behavior" ||
      (f.category === "environment" && !f.related_to_scope);
    if (!provablyUnrelated) {
      return (
        `R3 violation: baseline failure on '${f.case_id}' (${f.category}) ` +
        `cannot be proven unrelated to the modification scope`
      );
    }
  }
  return null;
}
/** R4: patch must stay inside Modification Scope. */
function checkPatchScope(store: SessionStore, artifact: AnyArtifact): string | null {
  if (artifact.kind !== "patch-record") return null;
  const scope = store.artifact("scope-manifest");
  if (!scope) return "scope manifest missing — cannot verify patch scope";
  const editablePaths = scope.editable_files.map((t) => t.file);
  const outside = artifact.changed_files.filter(
    (f) => !matchGlob(f, editablePaths),
  );
  if (outside.length > 0) {
    return (
      `R4 violation: patch touches non-editable files: ` +
      outside.join(", ")
    );
  }
  return null;
}

/** R5: candidate trace covers exactly the baseline case ids. */
function checkCandidate(store: SessionStore, artifact: AnyArtifact): string | null {
  if (artifact.kind !== "observation-trace") return null;
  if (artifact.build !== "candidate") {
    return `expected a candidate build trace, got '${artifact.build}'`;
  }
  const baseline = store.trace("baseline");
  if (!baseline) {
    return "baseline trace missing — cannot compare case coverage";
  }
  const baseIds = new Set(baseline.observations.map((o) => o.case_id));
  const candIds = new Set(artifact.observations.map((o) => o.case_id));
  const missing = [...baseIds].filter((id) => !candIds.has(id));
  const extra = [...candIds].filter((id) => !baseIds.has(id));
  if (missing.length > 0 || extra.length > 0) {
    return (
      `R5 violation: case set drift — missing=[${missing.join(", ")}] ` +
      `extra=[${extra.join(", ")}]`
    );
  }
  return null;
}

