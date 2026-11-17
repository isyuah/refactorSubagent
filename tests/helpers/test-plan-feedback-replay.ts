/** Check imported-plan repair in its own process so SDK mocks cannot leak. */
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { DriverOptions, DriverRun } from "../../src/agents/driver.js";
import { cliFixture } from "./cli-fixture.js";
import { preparationReplay } from "./test-preparation.js";
import { TestPreparation } from "../../src/testing/preparation.js";
import { testPlanWorkflowsStage } from "../../src/testing/stage.js";
import { patchRefactorStage } from "../../src/runtime/stage-presets.js";

const [parent, mode] = Bun.argv.slice(2); assert(parent && (mode === "portable" || mode === "local"));
mkdirSync(resolve(parent), { recursive: true });
const f = cliFixture("accept", resolve(parent));
const prep = new TestPreparation({ repo: f.repo, sessionRoot: f.sessionRoot, session: "draft", scope: "Protect the real function result and clock replacement",
  runAgentFn: preparationReplay({ brokenTest: true, singleBuild: true }).author });
let directory: string;
try { await prep.author(); assert.equal(prep.view().content.metadata.trial.failure?.category, "test"); directory = prep.save().directory; }
finally { prep.close(); }
const { loadLocalDialogue } = await import("../../src/testing/bundle.js");
const dialogue = mode === "local" ? loadLocalDialogue(join(f.repo, ".refactor", "test-plan-dialogues"), "draft") : null;
const replay = preparationReplay({ singleBuild: true });
const calls: { resume: string | null; prompt: string }[] = [];
mock.module("../../src/agents/driver.js", () => ({ runAgent: async (o: DriverOptions): Promise<DriverRun> => {
  const server = o.mcpServers?.["dep-registry"]; assert(server?.type === "sdk");
  calls.push({ resume: o.resumeSessionId ?? null, prompt: o.prompt });
  return replay.author({ ...o, allowedTools: o.allowedTools, extraAllowedTools: o.extraAllowedTools ?? [],
    agents: o.agents ?? {}, mcpServers: { "dep-registry": server }, skills: o.skills ?? [], maxTurns: o.maxTurns ?? null });
} }));
const { runFeedbackStageFlow } = await import("../../src/runtime/feedback/run.js");
const outcome = await runFeedbackStageFlow({ repoPath: f.repo, task: "Extract validation without changing behavior", sessionRoot: f.sessionRoot, sessionId: "formal",
  workflowContext: { scope: "Protect the real function result and clock replacement", ...(dialogue ? { dialogue } : {}) },
  flow: { workflows: testPlanWorkflowsStage(directory!), refactor: patchRefactorStage(join(f.root, "change.patch")) } }, { budget: 1, resumeFrom: null });
writeFileSync(join(resolve(parent), "outcome.json"), JSON.stringify({ state: outcome.result.state, stopped: outcome.stoppedBecause, calls, rounds: outcome.rounds.length,
  feedback: outcome.result.report.feedback }));
assert.equal(outcome.result.state, "ACCEPTED");
assert.equal(calls[0]?.resume, mode === "local" ? "preparation-dialogue" : null);
