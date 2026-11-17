import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PlanContent } from "./types.js";
import { loadTestPlan } from "./bundle.js";
import { presetWorkflowsStage } from "../runtime/stage-presets.js";
import type { WorkflowsStage } from "../runtime/stage-flow.js";

export function materializePlan(content: PlanContent, directory: string) {
  mkdirSync(directory, { recursive: true });
  if (content.metadata.analysis !== null) writeFileSync(join(directory, "verification-analysis.json"), JSON.stringify(content.metadata.analysis, null, 2) + "\n");
  if (content.metadata.review !== null) writeFileSync(join(directory, "scenarios.json"), JSON.stringify(content.metadata.review, null, 2) + "\n");
  const testEntry = join(directory, "test.ts");
  if (content.test !== null) writeFileSync(testEntry, content.test.source);
  const builds = content.builds.map((build, i) => {
    const entry = join(directory, `build-${i + 1}.ts`);
    writeFileSync(entry, build.source);
    writeFileSync(`${entry}.description.json`, JSON.stringify({ description: build.description }) + "\n");
    if (build.materials !== null) writeFileSync(`${entry}.materials.json`, build.materials);
    else rmSync(`${entry}.materials.json`, { force: true });
    return { id: build.id, entry, runLocal: true, workflowId: build.workflowId, revision: build.revision };
  });
  return { testEntry, builds };
}

/** Copy the approved source into this run; repair never edits the saved version. */
export function testPlanWorkflowsStage(directory: string): WorkflowsStage {
  return async (ctx, input) => {
    const loaded = loadTestPlan(directory);
    if (loaded.content.metadata.delivery !== "complete" || loaded.content.test === null || loaded.content.builds.length === 0) throw new Error("测试方案尚未交付完整的测试和构建脚本，请先重新打开并补全。 ");
    const root = join(ctx.repoPath, ".refactor", "runs", ctx.sessionId, "test-plan");
    const sources = materializePlan(loaded.content, root);
    const outcome = await presetWorkflowsStage({ ...sources, entryRoot: root,
      workflowId: loaded.content.test.workflowId, revision: loaded.content.test.revision })(ctx, input);
    if (loaded.content.metadata.analysis !== null) ctx.logger.progress({ type: "strategy", path: join(loaded.directory, "plan.json"), report: loaded.content.metadata.analysis });
    return outcome;
  };
}
