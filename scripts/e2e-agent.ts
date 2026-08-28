import { cpSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentVerification } from "../src/runtime/agent-pipeline.js";

const BASE = join(import.meta.dir, "..", "examples", "trim-app", "base");
const root = mkdtempSync(join(tmpdir(), "refactor-e2e-agent-"));
const repo = join(root, "repo");
cpSync(BASE, repo, { recursive: true });

git(repo, ["init", "-b", "main"]);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-m", "base"]);

console.log(`scenario: targeted-claude-agent`);
console.log(`repo: ${repo}`);
const result = await runAgentVerification({
  repoPath: repo,
  task:
    "把 trim() 中的循环逻辑提取为 util.c 内的 static 辅助函数，消除重复；" +
    "严格保持 stdout、退出码和 trim() 的边界行为不变；如果无法证明安全则不要修改。",
  sessionRoot: root,
  sessionId: "targeted-agent",
});

console.log(JSON.stringify({
  scenario: "targeted-claude-agent",
  state: result.state,
  scope_denials: result.scopeDenials,
  session_dir: result.store.sessionDir,
  history: result.store.history.map((event) => `${event.from} -> ${event.to}`),
}, null, 2));

if (result.state !== "ACCEPTED") process.exitCode = 1;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  }).trim();
}
