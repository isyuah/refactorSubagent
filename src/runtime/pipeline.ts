import {
  HostPreflight,
  type BehaviorContract,
  type DependencyManifest,
  type EnvironmentSpec,
  type PatchRecord,
  type ScopeManifest,
  type SanitizerResult,
  type TestSpec,
} from "../artifacts/index.js";
import { captureTrace } from "./runner.js";
import { runSanitizers } from "./sanitizer-runner.js";
import { Orchestrator, type SubmitResult } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import { buildWorktree } from "./builder.js";
import { probeHost } from "./host-preflight.js";
import { createWorktrees, resolveHead, type WorktreePair } from "./worktree.js";
import { compare } from "./comparator.js";

export interface VerifyRequest {
  /** Repo containing the C project (already has the candidate branch). */
  repoPath: string;
  candidateBranch: string;
  /** Pre-created pair (agent pipeline refactors in the candidate before verifying). */
  worktrees?: WorktreePair;
  /** Measured once before analysis; reused for both builds. */
  host?: HostPreflight;
  contract: BehaviorContract;
  scope: ScopeManifest;
  deps: DependencyManifest;
  tests: TestSpec;
  env: EnvironmentSpec;
  patch: Omit<PatchRecord, "kind" | "version" | "base_commit_sha">;
}

export interface VerifyOutcome {
  state: string;
  results: SubmitResult[];
}

/**
 * Pipeline — drives one full verification attempt through the orchestrator:
 * contract → scope → deps → tests → env → baseline → patch → candidate
 * → comparison. Every gate is enforced by Orchestrator; this function only
 * produces artifacts from real builds and runs. First rejection stops the run.
 *
 * Requested sanitizers are an independent safety gate. Their results are
 * persisted as build-scoped audit artifacts and never reduced to stderr diffs.
 */
export function runVerification(
  store: SessionStore,
  req: VerifyRequest,
): VerifyOutcome {
  const orch = new Orchestrator(store);
  const results: SubmitResult[] = [];

  const submit = (raw: unknown): boolean => {
    const result = orch.submit(raw);
    results.push(result);
    return result.ok;
  };

  if (
    !submit(req.contract) ||
    !submit(req.scope) ||
    !submit(req.deps) ||
    !submit(req.tests) ||
    !submit(req.env)
  ) {
    return finish(store, results);
  }

  const host = resolveVerificationHost(store, req);
  const baseSha = resolveHead(req.repoPath);
  const worktrees = req.worktrees ?? createWorktrees(
    req.repoPath,
    store.sessionDir,
    req.candidateBranch,
  );

  try {
    const baselineBuild = buildWorktree(worktrees.baselineDir, req.env, host);
    const baselineSanitizer = saveSanitizerResult(
      store,
      worktrees.baselineDir,
      req,
      "baseline",
      "env-baseline-sanitized",
      host,
      baselineBuild,
    );

    if (!baselineBuild.ok) {
      results.push(orch.abort(baselineSanitizer
        ? `baseline sanitizer ${baselineSanitizer.status}: ${failureText(baselineSanitizer)}`
        : `baseline build failed:\n${baselineBuild.log}`));
      return finish(store, results);
    }
    if (baselineSanitizer !== null && baselineSanitizer.status !== "pass") {
      results.push(orch.abort(
        `baseline sanitizer ${baselineSanitizer.status}: ${failureText(baselineSanitizer)}`,
      ));
      return finish(store, results);
    }

    if (!submit(captureTrace(
      worktrees.baselineDir,
      req.env,
      req.tests,
      "baseline",
      "env-baseline",
    ))) {
      return finish(store, results); // R3 rejected an unexplained baseline failure.
    }

    if (!submit({
      kind: "patch-record",
      version: 1,
      ...req.patch,
      base_commit_sha: baseSha,
    })) {
      return finish(store, results); // R4 rejected an out-of-scope patch.
    }

    const candidateBuild = buildWorktree(worktrees.candidateDir, req.env, host);
    const candidateSanitizer = saveSanitizerResult(
      store,
      worktrees.candidateDir,
      req,
      "candidate",
      "env-candidate-sanitized",
      host,
      candidateBuild,
    );

    if (!candidateBuild.ok) {
      results.push(orch.abort(candidateSanitizer
        ? `candidate sanitizer ${candidateSanitizer.status}: ${failureText(candidateSanitizer)}`
        : `candidate build failed:\n${candidateBuild.log}`));
      return finish(store, results);
    }
    if (candidateSanitizer !== null && candidateSanitizer.status !== "pass") {
      results.push(orch.abort(
        `candidate sanitizer ${candidateSanitizer.status}: ${failureText(candidateSanitizer)}`,
      ));
      return finish(store, results);
    }

    const candidateTrace = captureTrace(
      worktrees.candidateDir,
      req.env,
      req.tests,
      "candidate",
      "env-candidate",
    );
    if (!submit(candidateTrace)) return finish(store, results); // R5 gate.

    const baselineTrace = store.trace("baseline");
    if (baselineTrace === null) {
      results.push(orch.abort("baseline trace disappeared before comparison"));
      return finish(store, results);
    }
    submit(compare(req.contract, baselineTrace, candidateTrace)); // R6 decides terminal state.
    return finish(store, results);
  } finally {
    worktrees.cleanup();
  }
}

function saveSanitizerResult(
  store: SessionStore,
  worktreeDir: string,
  req: VerifyRequest,
  build: "baseline" | "candidate",
  envId: string,
  host: HostPreflight | undefined,
  buildResult: ReturnType<typeof buildWorktree>,
): SanitizerResult | null {
  if (req.env.sanitizers.length === 0) return null;
  if (host === undefined) {
    throw new Error("sanitizer verification requires measured HostPreflight");
  }
  const result = runSanitizers({
    worktreeDir,
    env: req.env,
    spec: req.tests,
    build,
    envId,
    host,
    buildResult,
  });
  store.saveArtifact(result);
  return result;
}

function failureText(result: SanitizerResult): string {
  return result.failure?.explanation ?? "no failure explanation";
}

function resolveVerificationHost(
  store: SessionStore,
  req: VerifyRequest,
): HostPreflight | undefined {
  if (req.env.sanitizers.length === 0) return req.host ?? store.hostPreflight() ?? undefined;

  const stored = store.hostPreflight();
  const existing = req.host ?? stored ?? undefined;
  const complete = existing !== undefined && req.env.sanitizers.every(
    (kind) => existing.sanitizers[kind] !== undefined,
  );
  if (complete) {
    store.saveHostPreflight(existing);
    return existing;
  }

  const measured = probeHost(req.repoPath, { probeSanitizers: true });
  const enriched = existing === undefined
    ? measured
    : HostPreflight.parse({ ...existing, sanitizers: measured.sanitizers });
  store.saveHostPreflight(enriched);
  return enriched;
}

function finish(store: SessionStore, results: SubmitResult[]): VerifyOutcome {
  return { state: store.state, results };
}
