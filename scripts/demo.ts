/**
 * End-to-end smoke: walk a fake C-refactoring session through every state,
 * then demonstrate fail-closed rejections.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { SessionStore } from "../src/orchestrator/store.js";
import {
  happyPath,
  trace,
  patch,
  comparison,
} from "../tests/fixtures.js";

const root = mkdtempSync(join(tmpdir(), "refactor-demo-"));
const store = SessionStore.create(root, "demo-001");
const orch = new Orchestrator(store);

console.log(`session: ${store.id}  (${store.sessionDir})\n`);

for (const artifact of happyPath()) {
  const r = orch.submit(structuredClone(artifact));
  const tag = r.ok ? "✓" : "✗";
  console.log(
    `${tag} submit ${artifact.kind}` +
      (r.ok ? ` → ${r.to}` : ` — REJECTED: ${"reason" in r && r.reason}`),
  );
}

console.log(`\nfinal state: ${store.state}`);
console.log("history:");
for (const h of store.history) {
  console.log(`  ${h.from} → ${h.to}  [${h.artifact_kind ?? "abort"}]`);
}

// --- fail-closed demonstrations on a fresh session ---
console.log("\n--- fail-closed checks ---");
const store2 = SessionStore.create(root, "demo-002");
const orch2 = new Orchestrator(store2);

const skip = orch2.submit(patch()); // patch at INIT
console.log(`skip stage:        ${skip.ok ? "ACCEPTED?!" : skip.reason}`);

orch2.submit(happyPath()[0]!);
orch2.submit(happyPath()[1]!);

const outOfScope = orch2.submit({
  ...happyPath()[2]!,
  dependencies: [
    { name: "system()", kind: "concurrency", strategy: "reject", evidence: [], notes: "" },
  ],
});
console.log(`dep manifest v2:   ${outOfScope.ok ? "ok → " + outOfScope.to : outOfScope.reason}`);
console.log(`state remains:     ${store2.state}`);
