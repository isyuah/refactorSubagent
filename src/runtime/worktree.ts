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

/**
 * Freeze the candidate session's work into one commit and report what changed
 * relative to the base commit.
 *
 * The session has a shell, so two assumptions of the old one-liner no longer
 * hold: a clean working tree does NOT mean "no changes" (the agent may have
 * committed its own work), and an uncommitted tree is not the only shape the
 * change can take. Stage everything, measure against the base commit, and add a
 * host commit only when something is still uncommitted. Returns [] when the
 * session changed nothing.
 */
export function commitCandidateChanges(
  candidateDir: string,
  baseSha: string,
  message: string,
): string[] {
  git(candidateDir, ["add", "-A"], "stage candidate changes");
  const changedFiles = git(candidateDir, ["diff", "--cached", "--name-only", baseSha], "candidate diff")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (changedFiles.length === 0) return [];
  const uncommitted = git(candidateDir, ["diff", "--cached", "--name-only", "HEAD"], "uncommitted diff");
  if (uncommitted.trim().length > 0) {
    git(candidateDir, ["commit", "-m", message.slice(0, 200)], "commit candidate");
  }
  return changedFiles;
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
