/**
 * E2E demo with REAL Claude calls: analyze → refactor → verify.
 * Requires a logged-in claude CLI on this machine.
 *
 *   bun run scripts/demo-agents.ts
 */
import { cpSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentVerification } from "../src/runtime/agent-pipeline.js";

const BASE = join(import.meta.dir, "..", "examples", "trim-app", "base");

const root = mkdtempSync(join(tmpdir(), "refactor-agents-"));
const repo = join(root, "repo");
cpSync(BASE, repo, { recursive: true });
execSync("git init -b main", { cwd: repo, stdio: "pipe" });
execSync('git -c user.email=demo@local -c user.name=demo add -A', {
  cwd: repo, stdio: "pipe",
});
execSync(
  'git -c user.email=demo@local -c user.name=demo commit -m base',
  { cwd: repo, stdio: "pipe" },
);

console.log(`repo: ${repo}\nanalyzing + refactoring with Claude…\n`);

const out = await runAgentVerification({
  repoPath: repo,
  task:
    "把 trim() 中的循环逻辑提取为 util.c 内的 static 辅助函数，消除重复。" +
    "严格保持外部可观察行为不变（stdout、退出码逐字节一致）。",
  sessionRoot: root,
  sessionId: "agent-demo-001",
});

console.log(`\n=== result ===`);
console.log(`final state: ${out.state}`);
console.log(`scope denials (hook-enforced): ${JSON.stringify(out.scopeDenials)}`);
console.log(`\nrefactor agent summary:\n${out.refactorSummary}`);

for (const h of out.store.history) {
  console.log(`  ${h.from} → ${h.to}  [${h.artifact_kind ?? "abort"}]`);
}
