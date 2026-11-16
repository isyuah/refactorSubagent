import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { WorkflowsCheckpointView } from "../stage-resume.js";
import { readVerificationMaterials } from "../../workflow/verification-materials.js";

const MaterialPin = z.object({ path: z.string(), sha256: z.string() });
const PlanFile = z.object({
  entryRoot: z.string().nullable(),
  testEntry: z.string(),
  testSourceHash: z.string(),
  workflowId: z.string(),
  workflowRevision: z.number().int().positive(),
  builds: z.array(z.object({
    id: z.string(), entry: z.string(), sourceHash: z.string(),
    runLocal: z.boolean(), materials: z.array(MaterialPin),
  })),
  baseline: z.object({ sessionId: z.string(), baseSha: z.string(), planHash: z.string() }).nullable(),
});

/** The current full plan, never re-selected from round one after a repair.
 * Paths are absolute; a baseline stamp identifies the exact measurement that
 * can be reused, including the base commit, workflows and auxiliary inputs. */
export interface EffectivePlan extends WorkflowsCheckpointView {
  readonly baseline: { readonly sessionId: string; readonly baseSha: string; readonly planHash: string } | null;
}

export function effectivePlanPath(stateDir: string): string {
  return join(stateDir, "effective-plan.json");
}

export function loadEffectivePlan(stateDir: string): EffectivePlan | null {
  const path = effectivePlanPath(stateDir);
  if (!existsSync(path)) return null;
  const parsed = PlanFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`invalid effective feedback plan: ${path}`);
  return parsed.data;
}

export function saveEffectivePlan(stateDir: string, plan: EffectivePlan): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(effectivePlanPath(stateDir), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

/** Generated ids and paths identify deliveries, not changes to their content. */
export function workflowContentHash(view: Pick<WorkflowsCheckpointView, "testSourceHash" | "builds">): string {
  return createHash("sha256").update(JSON.stringify({
    test: view.testSourceHash,
    builds: view.builds.map((build) => ({
      source: build.sourceHash,
      materials: [...build.materials].sort((a, b) => a.path.localeCompare(b.path)),
    })),
  })).digest("hex");
}

export function planFromCheckpointView(view: WorkflowsCheckpointView, repoRoot: string): EffectivePlan {
  const entryRoot = resolve(view.entryRoot ?? repoRoot);
  return {
    ...view,
    entryRoot,
    testEntry: resolve(entryRoot, view.testEntry),
    builds: view.builds.map((build) => ({ ...build, entry: resolve(entryRoot, build.entry) })),
    baseline: null,
  };
}

/** Replace only the failed slot; all other delivered repairs remain in force. */
export function replaceBuild(
  plan: EffectivePlan,
  fixedBuild: { readonly id: string; readonly entry: string },
  failedBuildId: string | null,
  repoRoot: string,
): EffectivePlan | null {
  const index = plan.builds.length === 1 ? 0 : plan.builds.findIndex((build) => build.id === failedBuildId);
  if (index < 0) return null;
  const entry = resolve(repoRoot, fixedBuild.entry);
  const repaired = {
    id: fixedBuild.id, entry,
    sourceHash: createHash("sha256").update(readFileSync(entry, "utf8")).digest("hex"),
    runLocal: true,
    materials: readVerificationMaterials(entry).map(({ path, sha256 }) => ({ path, sha256 })),
  };
  return {
    ...plan,
    builds: plan.builds.map((build, position) => position === index ? repaired : build),
    baseline: null,
  };
}
