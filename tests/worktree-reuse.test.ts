import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktrees } from "../src/runtime/worktree.js";

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** A repo with one commit plus a .gitignore that hides build output. */
function createRepo(): { repo: string; baseSha: string } {
  const repo = mkdtempSync(join(tmpdir(), "rfr-reuse-repo-"));
  gitIn(repo, ["init", "-q"]);
  gitIn(repo, ["config", "user.email", "t@example.com"]);
  gitIn(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, ".gitignore"), "build/\n", "utf8");
  writeFileSync(join(repo, "a.c"), "int a(void) { return 1; }\n", "utf8");
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  return { repo, baseSha: gitIn(repo, ["rev-parse", "HEAD"]) };
}

describe("createWorktrees with a caller-owned root", () => {
  test("resets a reused pair in place and keeps build outputs", () => {
    const { repo, baseSha } = createRepo();
    const root = mkdtempSync(join(tmpdir(), "rfr-reuse-root-"));
    const branch = "refactor/agent-sess-1";
    gitIn(repo, ["branch", branch, baseSha]);

    const first = createWorktrees(repo, root, branch, baseSha, { reuse: true, keep: true });
    // A finished case leaves a dirty candidate worktree and warm build output.
    writeFileSync(join(first.candidateDir, "a.c"), "int a(void) { return 2; }\n", "utf8");
    writeFileSync(join(first.candidateDir, "stray.txt"), "leftover\n", "utf8");
    mkdirSync(join(first.candidateDir, "build"), { recursive: true });
    writeFileSync(join(first.candidateDir, "build", "artifact.o"), "warm\n", "utf8");
    first.cleanup();
    expect(existsSync(first.candidateDir)).toBe(true);

    const second = createWorktrees(repo, root, branch, baseSha, { reuse: true, keep: true });
    expect(second.baselineDir).toBe(first.baselineDir);
    // Tracked edits and stray files are gone; the warm build tree survived.
    expect(execFileSync("git", ["show", "HEAD:a.c"], { cwd: second.candidateDir, encoding: "utf8" }))
      .toBe("int a(void) { return 1; }\n");
    expect(existsSync(join(second.candidateDir, "stray.txt"))).toBe(false);
    expect(existsSync(join(second.candidateDir, "build", "artifact.o"))).toBe(true);
    // The candidate worktree still sits on its branch, at the base commit.
    expect(gitIn(second.candidateDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch);
    expect(gitIn(second.candidateDir, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(readdirSync(join(root, "worktrees")).sort()).toEqual(["baseline", "candidate"]);
  }, 120_000);

  test("deletes the pair when the root is not caller-owned", () => {
    const { repo, baseSha } = createRepo();
    const root = mkdtempSync(join(tmpdir(), "rfr-reuse-root-"));
    const branch = "refactor/agent-sess-2";
    gitIn(repo, ["branch", branch, baseSha]);

    const pair = createWorktrees(repo, root, branch, baseSha);
    pair.cleanup();
    expect(existsSync(pair.baselineDir)).toBe(false);
    expect(existsSync(pair.candidateDir)).toBe(false);
  }, 120_000);
});
