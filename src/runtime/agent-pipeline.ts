import { spawnSync } from "node:child_process";
import { analyzeRepo } from "../agents/analyze.js";
import { runRefactor } from "../agents/refactor.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import {
  createWorktrees,
  resolveHead,
  type WorktreePair,
} from "./worktree.js";
import { probeHost } from "./host-preflight.js";
import { detectCProject } from "./project-detector.js";
import { runVerification } from "./pipeline.js";

export interface AgentPipelineRequest {
  /** Repo containing the C project at its base state. */
  repoPath: string;
  /** What the refactoring should do (natural language). */
  task: string;
  /** Root under which `.refactor/sessions/<id>` is kept. */
  sessionRoot: string;
  sessionId: string;
}

function gitIn(dir: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

/**
 * Agent Pipeline — Claude proposes and refactors; the program validates,
 * commits, builds, runs and decides.
 *
 *   analyzeRepo()          → artifact proposals (zod-validated, 1 retry)
 *   createWorktrees()      → physical isolation
 *   runRefactor()          → edits candidate worktree, scope-enforced by hook
 *   program git commit     → the agent never touches git
 *   runVerification()      → baseline/candidate differential, R6 verdict
 */
export async function runAgentVerification(
  req: AgentPipelineRequest,
): Promise<{
  store: SessionStore;
  state: string;
  refactorSummary: string;
  scopeDenials: string[];
}> {
  const store = SessionStore.create(req.sessionRoot, req.sessionId);
  const orch = new Orchestrator(store);

  const host = probeHost(req.repoPath);
  store.saveHostPreflight(host);
  const project = detectCProject(req.repoPath, host);
  store.saveProjectDetection(project);
  if (project.status !== "ready") {
    orch.abort(`project build detection blocked: ${project.reason}`);
    return {
      store,
      state: store.state,
      refactorSummary: "",
      scopeDenials: [],
    };
  }

  // Analysis receives measured host and project facts.
  const analysis = await analyzeRepo(req.repoPath, req.task, host, project);
  // 2. Candidate branch at current HEAD; agent edits land in its worktree.
  const branch = `refactor/agent-${req.sessionId}`;
  const headBefore = resolveHead(req.repoPath);
  gitIn(req.repoPath, ["branch", branch, headBefore]);
  const wt: WorktreePair = createWorktrees(
    req.repoPath,
    store.sessionDir,
    branch,
    headBefore,
  );

  try {
    const editable = analysis.scope.editable_files.map((t) => t.file);

    // 3. Refactor inside the candidate worktree (hook-enforced scope).
    const refactor = await runRefactor(wt.candidateDir, req.task, editable);

    // 4. Program-owned commit of whatever the agent actually changed.
    const status = gitIn(wt.candidateDir, ["status", "--porcelain"]);
    if (status.trim().length === 0) {
      orch.abort("refactor agent made no changes");
      return {
        store,
        state: store.state,
        refactorSummary: refactor.summary,
        scopeDenials: refactor.denials,
      };
    }
    gitIn(wt.candidateDir, ["add", "-A"]);
    const msgLine =
      refactor.summary.split("\n").find((l) => l.trim().length > 0) ??
      req.task;
    gitIn(wt.candidateDir, ["commit", "-m", msgLine.slice(0, 200)]);

    const changedFiles = gitIn(wt.candidateDir, [
      "diff",
      "--name-only",
      `${headBefore}..HEAD`,
    ])
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // 5. Verification: every orchestrator gate still applies.
    const outcome = runVerification(store, {
      repoPath: req.repoPath,
      candidateBranch: branch,
      worktrees: wt,
      host,
      contract: analysis.contract,
      scope: analysis.scope,
      deps: analysis.deps,
      tests: analysis.tests,
      env: analysis.env,
      patch: {
        branch,
        commit_sha: gitIn(wt.candidateDir, ["rev-parse", "HEAD"]),
        changed_files: changedFiles,
        summary: msgLine.slice(0, 500),
      },
    });

    return {
      store,
      state: outcome.state,
      refactorSummary: refactor.summary,
      scopeDenials: refactor.denials,
    };
  } finally {
    wt.cleanup();
  }
}
