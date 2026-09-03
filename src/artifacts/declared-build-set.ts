import { z } from "zod";
import { RelPath, Sha256Hex } from "./common.js";

/**
 * DeclaredBuildSet — the declaration-set resolution artifact for the
 * subagent-driven flow (方案甲：单凭证承载整个声明集).
 *
 * The test-writer session declared N build workflow dependencies via
 * declareDependency. This artifact records that single resolution decision:
 * every declared build's identity, source entry, source hash and whether it is
 * run-local (generated this run) or library-persisted. The host executes every
 * entry (baseline + candidate) before running the test workflow.
 */

export const DeclaredBuildSetEntry = z.object({
  /** Declared build workflow id (run-local or library). */
  id: z.string().min(1),
  /** Repo-relative workflow source entry. */
  entry: RelPath,
  source_hash: Sha256Hex,
  /** True when generated this run (run-local); false = persisted library. */
  run_local: z.boolean(),
});
export type DeclaredBuildSetEntry = z.infer<typeof DeclaredBuildSetEntry>;

export const DeclaredBuildSet = z.object({
  kind: z.literal("declared-build-set"),
  version: z.literal(1),
  /** Session/test workflow identity this set serves. */
  test_workflow_id: z.string().min(1),
  test_workflow_revision: z.number().int().positive(),
  builds: z.array(DeclaredBuildSetEntry),
  /** Stable hash of the ordered declaration (id+revision+entry) for audit. */
  source_hash: Sha256Hex,
});
export type DeclaredBuildSet = z.infer<typeof DeclaredBuildSet>;
