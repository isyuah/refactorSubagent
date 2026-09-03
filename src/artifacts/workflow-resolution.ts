import { z } from "zod";
import { RelPath } from "./common.js";

export const WorkflowResolutionMode = z.enum(["forced", "selected", "generated", "declared"]);
export type WorkflowResolutionMode = z.infer<typeof WorkflowResolutionMode>;

export const WorkflowResolution = z
  .object({
    kind: z.literal("workflow-resolution"),
    version: z.literal(1),
    workflow_kind: z.enum(["build", "test"]),
    mode: WorkflowResolutionMode,
    workflow_id: z.string().min(1),
    workflow_revision: z.number().int().positive(),
    /** Build identity required by a TestWorkflow; null for BuildWorkflow. */
    build_workflow: z
      .object({ id: z.string().min(1), revision: z.number().int().positive() })
      .nullable()
      .default(null),
    /** Logical root kind used for recovery; root_path records the measured path. */
    entry_root: z.enum(["workspace", "external", "session"]),
    root_path: z.string().min(1),
    entry: RelPath,
    source_hash: z.string().regex(/^[0-9a-f]{64}$/),
    candidate_entries: z.array(RelPath).default([]),
    reason: z.string().min(1),
  })
  .superRefine((value, context) => {
    if (value.workflow_kind === "build" && value.build_workflow !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["build_workflow"],
        message: "BuildWorkflow resolution cannot depend on another BuildWorkflow",
      });
    }
    if (value.workflow_kind === "test" && value.build_workflow === null) {
      // Declared-mode test workflows are self-driven: their build dependencies
      // live in the DeclaredBuildSet artifact, not in a single static reference.
      if (value.mode !== "declared") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["build_workflow"],
          message: "TestWorkflow resolution must record its BuildWorkflow dependency",
        });
      }
    }
  });
export type WorkflowResolution = z.infer<typeof WorkflowResolution>;
