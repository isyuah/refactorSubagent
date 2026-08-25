import type {
  BehaviorContract,
  DependencyManifest,
  EnvironmentSpec,
  PatchRecord,
  ScopeManifest,
  TestSpec,
} from "../artifacts/index.js";
import type { HostPreflight } from "../artifacts/index.js";
import { captureTrace } from "./runner.js";
import { Orchestrator, type SubmitResult } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import { buildWorktree } from "./builder.js";
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
 */
export function runVerification(
  store: SessionStore,
  req: VerifyRequest,
): VerifyOutcome {
  const orch = new Orchestrator(store);
  const results: SubmitResult[] = [];

  const submit = (raw: unknown): boolean => {
    const r = orch.submit(raw);
    results.push(r);
    return r.ok;
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
  const baseSha = resolveHead(req.repoPath);
  const wt =
    req.worktrees ??
    createWorktrees(req.repoPath, store.sessionDir, req.candidateBranch);

  try {
    const baseBuild = buildWorktree(wt.baselineDir, req.env, req.host);
    if (!baseBuild.ok) {
      results.push(orch.abort(`baseline build failed:\n${baseBuild.log}`));
      return finish(store, results);
    }
    if (!submit(captureTrace(wt.baselineDir, req.env, req.tests, "baseline", "env-baseline"))) {
      return finish(store, results); // R3 gate refused an unexplained baseline failure
    }

    const patchOk = submit({
      kind: "patch-record",
      version: 1,
      ...req.patch,
      base_commit_sha: baseSha,
    });
    if (!patchOk) return finish(store, results); // R4 gate

    const candBuild = buildWorktree(wt.candidateDir, req.env, req.host);
    if (!candBuild.ok) {
      results.push(orch.abort(`candidate build failed:\n${candBuild.log}`));
      return finish(store, results);
    }
    const candTrace = captureTrace(
      wt.candidateDir,
      req.env,
      req.tests,
      "candidate",
      "env-candidate",
    );
    if (!submit(candTrace)) return finish(store, results); // R5 gate

    const baseline = store.trace("baseline")!;
    submit(compare(req.contract, baseline, candTrace)); // R6 decides terminal state

    return finish(store, results);
  } finally {
    wt.cleanup();
  }
}

function finish(state: SessionStore, results: SubmitResult[]): VerifyOutcome {
  return { state: state.state, results };
}
