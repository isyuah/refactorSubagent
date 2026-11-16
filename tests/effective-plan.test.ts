import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectivePlanPath, loadEffectivePlan, planFromCheckpointView,
  replaceBuild, saveEffectivePlan, workflowContentHash,
} from "../src/runtime/feedback/effective-plan.js";
import { loadReusableWorkflowsStageFromView, type WorkflowsCheckpointView } from "../src/runtime/stage-resume.js";
import { freezeVerificationMaterials, materialHash, serializeVerificationMaterials } from "../src/workflow/verification-materials.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rfr-plan-"));
  roots.push(root);
  const source = "export default async () => {};\n";
  mkdirSync(join(root, "workflows"));
  for (const file of ["test", "a", "b", "fixed-a", "fixed-b"]) {
    writeFileSync(join(root, "workflows", `${file}.ts`), source);
  }
  const view: WorkflowsCheckpointView = {
    entryRoot: root, testEntry: "workflows/test.ts", testSourceHash: materialHash(source),
    workflowId: "exam", workflowRevision: 1,
    builds: ["a", "b"].map((id) => ({
      id, entry: `workflows/${id}.ts`, sourceHash: materialHash(source), runLocal: true, materials: [],
    })),
  };
  return { root, view, source };
}

describe("effective feedback plan", () => {
  test("successive build repairs retain all repaired slots through save/load", () => {
    const { root, view } = fixture();
    const first = replaceBuild(planFromCheckpointView(view, root), { id: "a-r2", entry: "workflows/fixed-a.ts" }, "a", root)!;
    const second = replaceBuild(first, { id: "b-r3", entry: "workflows/fixed-b.ts" }, "b", root)!;
    saveEffectivePlan(root, second);
    const loaded = loadEffectivePlan(root)!;
    expect(loaded.builds.map(({ id, entry }) => ({ id, entry }))).toEqual([
      { id: "a-r2", entry: join(root, "workflows", "fixed-a.ts") },
      { id: "b-r3", entry: join(root, "workflows", "fixed-b.ts") },
    ]);
    expect(loadReusableWorkflowsStageFromView(root, loaded)).not.toBeNull();
    expect(loaded.testEntry).toBe(join(root, "workflows", "test.ts"));
    expect(loaded.baseline).toBeNull();
  });

  test("an unmapped build in a multi-build set cannot replace another slot", () => {
    const { root, view } = fixture();
    expect(replaceBuild(planFromCheckpointView(view, root), { id: "fixed", entry: "missing.ts" }, "unknown", root)).toBeNull();
  });

  test("an absent plan is distinct from a damaged saved plan", () => {
    const { root } = fixture();
    expect(loadEffectivePlan(root)).toBeNull();
    writeFileSync(effectivePlanPath(root), "{not json");
    expect(() => loadEffectivePlan(root)).toThrow();
    writeFileSync(effectivePlanPath(root), JSON.stringify({ builds: [] }));
    expect(() => loadEffectivePlan(root)).toThrow("invalid effective feedback plan");
  });

  test("content identity ignores generated ids and paths, but includes sources and material pins", () => {
    const { root, view } = fixture();
    const plan = planFromCheckpointView(view, root);
    const redelivered = { ...plan, builds: plan.builds.map((build) => ({ ...build, id: `${build.id}-r2`, entry: `different/${build.id}.ts` })) };
    expect(workflowContentHash(redelivered)).toBe(workflowContentHash(plan));
    expect(workflowContentHash({ ...plan, testSourceHash: "changed" })).not.toBe(workflowContentHash(plan));
    expect(workflowContentHash({ ...plan, builds: [{ ...plan.builds[0]!, sourceHash: "changed" }, plan.builds[1]!] })).not.toBe(workflowContentHash(plan));
    const materials = [{ path: "build/verification/input.c", sha256: materialHash("input") }];
    expect(workflowContentHash({ ...plan, builds: [{ ...plan.builds[0]!, materials }, plan.builds[1]!] })).not.toBe(workflowContentHash(plan));
  });

  test("changing, adding, removing or corrupting auxiliary material invalidates workflow reuse", () => {
    const { root, view } = fixture();
    const entry = join(root, "workflows", "a.ts");
    const inputs = freezeVerificationMaterials([{ path: "build/verification/harness.c", content: "original harness" }]);
    writeFileSync(`${entry}.materials.json`, serializeVerificationMaterials(inputs));
    const pinned = { ...view, builds: [{ ...view.builds[0]!, materials: inputs.map(({ path, sha256 }) => ({ path, sha256 })) }] };
    expect(loadReusableWorkflowsStageFromView(root, pinned)).not.toBeNull();
    for (const materials of [
      freezeVerificationMaterials([{ path: inputs[0]!.path, content: "changed harness" }]),
      freezeVerificationMaterials([...inputs, { path: "build/verification/data.json", content: "[]" }]),
      [],
    ]) {
      writeFileSync(`${entry}.materials.json`, serializeVerificationMaterials(materials));
      expect(loadReusableWorkflowsStageFromView(root, pinned)).toBeNull();
    }
    writeFileSync(`${entry}.materials.json`, "{broken json");
    expect(loadReusableWorkflowsStageFromView(root, pinned)).toBeNull();
  });
});
