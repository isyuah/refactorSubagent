import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackedRepositoryGuard } from "../src/runtime/verification-integrity.js";

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: "pipe" });
}

function commitRepo(root: string): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "base"]);
}

test("original-checkout integrity preserves existing dirty bytes and detects later edits", () => {
  const root = mkdtempSync(join(tmpdir(), "rfr-integrity-"));
  const source = join(root, "source.c");
  writeFileSync(source, "/* base */\n");
  commitRepo(root);
  writeFileSync(source, "/* user-owned uncommitted edit */\n");
  const guard = new TrackedRepositoryGuard(root);
  expect(() => guard.assertUnchanged("original checkout")).not.toThrow();
  writeFileSync(source, "/* writer changed it */\n");
  expect(() => guard.assertUnchanged("after writer")).toThrow("tracked source changed");
}, 30_000);

test("tracked submodules protect real nested sources while unused empty gitlinks stay usable", () => {
  const root = mkdtempSync(join(tmpdir(), "rfr-integrity-module-"));
  const module = join(root, "dep");
  mkdirSync(module);
  writeFileSync(join(module, "module.c"), "/* dependency */\n");
  commitRepo(module);
  writeFileSync(join(root, "main.c"), "int main(void) { return 0; }\n");
  commitRepo(root);
  const guard = new TrackedRepositoryGuard(root);
  expect(() => guard.assertUnchanged("nested sources")).not.toThrow();
  const worktree = join(root, "detached");
  git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const emptyGuard = new TrackedRepositoryGuard(worktree);
  expect(() => emptyGuard.assertUnchanged("unused submodule")).not.toThrow();
  expect(emptyGuard.isTracked("dep/injected.c")).toBe(true);
  writeFileSync(join(module, "module.c"), "/* changed dependency */\n");
  expect(() => guard.assertUnchanged("nested sources")).toThrow("tracked source changed");
}, 30_000);
