import { DEFAULT_AGENT_FORBIDDEN_GLOBS, DEFAULT_AGENT_READABLE_GLOBS, extractJson, runAgent } from "./driver.js";
import { z } from "zod";

export const WorkflowSelection = z.object({
  decision: z.enum(["use", "generate"]),
  candidate_index: z.number().int().nonnegative().nullable(),
  reason: z.string().min(1),
}).superRefine((value, context) => {
  if (value.decision === "use" && value.candidate_index === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidate_index"],
      message: "use decision requires candidate_index",
    });
  }
  if (value.decision === "generate" && value.candidate_index !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidate_index"],
      message: "generate decision must not select a candidate",
    });
  }
});
export type WorkflowSelection = z.infer<typeof WorkflowSelection>;

export interface WorkflowSelectionCandidate {
  readonly id: string;
  readonly revision: number;
  readonly source: "provided" | "existing";
  readonly entry: string;
  readonly status: string;
  readonly reasons: readonly string[];
}

const SELECTION_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["use", "generate"] },
      candidate_index: { type: ["integer", "null"] },
      reason: { type: "string" },
    },
    required: ["decision", "candidate_index", "reason"],
    additionalProperties: false,
  },
};

/** Let Claude choose among already validated candidates or request generation. */
export async function selectWorkflow(options: {
  readonly repoDir: string;
  readonly workflowKind: "build" | "test";
  readonly candidates: readonly WorkflowSelectionCandidate[];
  readonly taskContext?: string;
}): Promise<WorkflowSelection> {
  const prompt = [
    `Choose a ${options.workflowKind} workflow for the current C project.`,
    "Return JSON only.",
    "Use a candidate only when its status is valid or draft and its reasons are empty.",
    "Choose generate when no candidate is demonstrably suitable; never invent a candidate index.",
    `Candidates:\n${JSON.stringify(options.candidates, null, 2)}`,
    options.taskContext ? `Task context:\n${options.taskContext}` : "",
  ].filter((part) => part.length > 0).join("\n\n");

  const run = await runAgent({
    cwd: options.repoDir,
    prompt,
    systemPrompt:
      "You are a conservative workflow selection module. The host validates your JSON and executes the final choice. " +
      "Do not claim a workflow is valid when the supplied facts do not support it.",
    allowedTools: ["Read", "Glob", "Grep"],
    readableGlobs: [...DEFAULT_AGENT_READABLE_GLOBS],
    forbiddenGlobs: [...DEFAULT_AGENT_FORBIDDEN_GLOBS],
    outputFormat: SELECTION_OUTPUT_FORMAT,
    maxTurns: 12,
  });
  let raw: unknown;
  try {
    raw = run.structuredOutput ?? extractJson(run.result);
  } catch (error) {
    throw new Error(`workflow selection returned no JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const selection = WorkflowSelection.parse(raw);
  if (selection.decision === "use") {
    const index = selection.candidate_index;
    if (index === null || index >= options.candidates.length) {
      throw new Error(`workflow selection chose an invalid candidate index: ${String(index)}`);
    }
    const candidate = options.candidates[index];
    if (candidate === undefined || (candidate.status !== "valid" && candidate.status !== "draft") || candidate.reasons.length > 0) {
      throw new Error(`workflow selection chose an unusable candidate: ${String(index)}`);
    }
  }
  return selection;
}
