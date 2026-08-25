import { z } from "zod";
import { RelPath } from "./common.js";

/**
 * Patch Record — what the refactor agent actually produced, kept as a commit
 * reference inside the candidate worktree so acceptance = fast-forward/merge,
 * rejection = drop worktree. The diff itself never lands on the base branch
 * until ACCEPTED.
 */
export const PatchRecord = z.object({
  kind: z.literal("patch-record"),
  version: z.literal(1),

  /** Candidate git worktree branch holding the refactoring commit(s). */
  branch: z.string().min(1),
  /** HEAD sha of the candidate at submission time. */
  commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  base_commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/),

  /** Files touched; orchestrator re-checks against ScopeManifest.editable_files. */
  changed_files: z.array(RelPath).min(1),

  summary: z.string().min(1),
});

export type PatchRecord = z.infer<typeof PatchRecord>;
