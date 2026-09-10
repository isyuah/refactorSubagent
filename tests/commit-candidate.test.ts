import { describe, expect, test, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCandidateChanges, createWorktrees, resolveHead } from "../src/runtime/worktree.js";

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

let repo: string;
let candidate: string;
let baseSha: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rfr-candidate-"));
  gitIn(repo, ["init", "-q"]);
  gitIn(repo, ["config", "user.email", "t@example.com"]);
  gitIn(repo, ["config", "user.name", "Test"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "main.c"), "int main(void){return 0;}\n");
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "-qm", "base"]);
  baseSha = resolveHead(repo);
  gitIn(repo, ["branch", "refactor/test", baseSha]);
  const pair = createWorktrees(repo, mkdtempSync(join(tmpdir(), "rfr-candidate-session-")), "refactor/test", baseSha);
  candidate = pair.candidateDir;
});

describe("commitCandidateChanges", () => {
  test("reports nothing when the session changed nothing", () => {
    expect(commitCandidateChanges(candidate, baseSha, "no-op")).toEqual([]);
  });

  test("commits unstaged edits and lists them", () => {
    writeFileSync(join(candidate, "src", "main.c"), "int main(void){return 1;}\n");
    writeFileSync(join(candidate, "src", "extra.c"), "int extra(void){return 2;}\n");

    expect(commitCandidateChanges(candidate, baseSha, "refactor trim")).toEqual([
      "src/extra.c",
      "src/main.c",
    ]);
    // The host commit exists and the tree is clean afterwards.
    expect(gitIn(candidate, ["status", "--porcelain"])).toBe("");
    expect(gitIn(candidate, ["log", "-1", "--format=%s"])).toBe("refactor trim");
  });

  // Regression: sessions have a shell, so an agent may commit its own work. The
  // old check ("working tree dirty?") called that "no changes" and aborted.
  test("detects work the session committed itself", () => {
    writeFileSync(join(candidate, "src", "main.c"), "int main(void){return 3;}\n");
    gitIn(candidate, ["add", "-A"]);
    gitIn(candidate, ["commit", "-qm", "agent commit"]);

    expect(commitCandidateChanges(candidate, baseSha, "host summary")).toEqual(["src/main.c"]);
    // The agent's own commit stands; no empty host commit is stacked on top.
    expect(gitIn(candidate, ["log", "-1", "--format=%s"])).toBe("agent commit");
  });

  test("includes what the session committed and what it left uncommitted", () => {
    writeFileSync(join(candidate, "src", "a.c"), "int a(void){return 1;}\n");
    gitIn(candidate, ["add", "-A"]);
    gitIn(candidate, ["commit", "-qm", "agent commit"]);
    writeFileSync(join(candidate, "src", "b.c"), "int b(void){return 2;}\n");

    expect(commitCandidateChanges(candidate, baseSha, "host summary")).toEqual([
      "src/a.c",
      "src/b.c",
    ]);
    expect(gitIn(candidate, ["status", "--porcelain"])).toBe("");
  });
});
