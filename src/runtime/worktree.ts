import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Worktree Manager — physical isolation of the two builds under observation.
 *
 *   <session-root>/wt-baseline/  checked out at base commit
 *   <session-root>/wt-candidate/ checked out at the refactor branch
 *
 * The orchestrator's own checkout is never touched by test runs.
 */

export interface WorktreePair {
  baselineDir: string;
  candidateDir: string;
  baseSha: string;
  /** Drop both worktrees (safe to call repeatedly). */
  cleanup(): void;
}

function git(repo: string, args: string[], what: string): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} failed (${what}): ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

export function resolveHead(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"], "rev-parse");
}

export function hasBranch(repo: string, branch: string): boolean {
  return (
    spawnSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
      cwd: repo,
    }).status === 0
  );
}

/**
 * Create the worktree pair. `candidateBranch` must already hold the
 * refactoring commits; it is NOT created here (the refactor agent owns that
 * step). Baseline always checks out the recorded base commit.
 */
export function createWorktrees(
  repo: string,
  sessionRoot: string,
  candidateBranch: string,
  baseSha = resolveHead(repo),
): WorktreePair {
  const wtRoot = join(sessionRoot, "worktrees");
  mkdirSync(wtRoot, { recursive: true });

  const baselineDir = join(wtRoot, "baseline");
  const candidateDir = join(wtRoot, "candidate");

  if (!existsSync(baselineDir)) {
    // Worktrees cannot be re-attached to a detached commit twice; use a temp
    // local branch per session for the baseline.
    const baseBranch = `refactor-session/base-${baseSha.slice(0, 12)}`;
    if (!hasBranch(repo, baseBranch)) {
      git(repo, ["branch", baseBranch, baseSha], "branch base");
    }
    git(repo, ["worktree", "add", "--detach", baselineDir, baseBranch], "add baseline");
  }
  if (!hasBranch(repo, candidateBranch)) {
    throw new Error(`candidate branch not found: ${candidateBranch}`);
  }
  if (!existsSync(candidateDir)) {
    git(repo, ["worktree", "add", candidateDir, candidateBranch], "add candidate");
  }

  return {
    baselineDir,
    candidateDir,
    baseSha,
    cleanup() {
      for (const dir of [baselineDir, candidateDir]) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
      git(repo, ["worktree", "prune"], "prune");
    },
  };
}
