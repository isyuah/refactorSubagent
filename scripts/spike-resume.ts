/**
 * Phase 0 spike — does SDK conversation resume actually work?
 *
 * Round 1: tell the model a secret phrase, capture the conversation id.
 * Round 2: RESUME that conversation and ask it to recall the phrase.
 *
 * Go criteria: round 2 recalls the phrase AND reports the SAME session id.
 */
import { runAgent } from "../src/agents/driver.js";
import { FileSessionStore } from "../src/runtime/session-store.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SECRET = `紫色河马-${Date.now().toString(36)}`;
const store = new FileSessionStore(join("D:\\tmp", "spike-sessions"));
mkdirSync(join("D:\\tmp", "spike-sessions", "sessions"), { recursive: true });

console.log("=== Round 1: tell the secret ===");
const first = await runAgent({
  cwd: process.cwd(),
  prompt: `请记住这个暗号：${SECRET}。从现在起它很重要。只回复"收到"两个字。`,
  allowedTools: [],
  maxTurns: 2,
  timeoutMs: 120_000,
  stallTimeoutMs: 60_000,
  sessionStore: store,
});
console.log("result:", first.result);
console.log("isError:", first.isError);
console.log("sessionId:", first.sessionId);

if (first.sessionId === undefined || first.isError) {
  console.error("FAIL: round 1 did not produce a usable session id");
  process.exit(1);
}

console.log("\n=== Round 2: resume and recall ===");
const second = await runAgent({
  cwd: process.cwd(),
  prompt: "我刚才让你记住的暗号是什么？只回复暗号本身，不要其他内容。",
  allowedTools: [],
  maxTurns: 2,
  timeoutMs: 120_000,
  stallTimeoutMs: 60_000,
  sessionStore: store,
  resumeSessionId: first.sessionId,
});
console.log("result:", second.result);
console.log("isError:", second.isError);
console.log("sessionId:", second.sessionId, "(expected:", first.sessionId + ")");
console.log("resumeMismatch:", second.resumeMismatch ?? false);

const recalled = second.result.includes(SECRET);
const sameId = second.sessionId === first.sessionId;
console.log("\n=== VERDICT ===");
console.log("recalled secret:", recalled);
console.log("same session id:", sameId);
console.log(recalled && sameId && !second.resumeMismatch
  ? "GO: conversation resume works — the feedback loop can build on this."
  : "NO-GO: resume did not continue the original conversation.");
process.exit(recalled && sameId ? 0 : 1);
