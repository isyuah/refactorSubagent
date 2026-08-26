import { BuildWorkflowOutput, type BuildWorkflowOutput as BuildWorkflowOutputValue, type HostPreflight, type ProjectDetection } from "../artifacts/index.js";
import { extractJson, runAgent } from "./driver.js";
import { BUILD_WORKFLOW_SYSTEM, buildWorkflowPrompt } from "./prompts.js";

const BUILD_WORKFLOW_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", const: "build-workflow-output" },
      version: { type: "integer", const: 1 },
      workflow_id: { type: "string" },
      workflow_revision: { type: "integer" },
      environment: { type: "object" },
      artifact: { type: "object" },
    },
    required: ["kind", "version", "workflow_id", "workflow_revision", "environment", "artifact"],
    additionalProperties: false,
  },
};

export interface ProposeBuildWorkflowOptions {
  readonly repoDir: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly taskContext?: string;
}

/**
 * Ask Claude for a build declaration only. The orchestrator still validates the
 * complete artifact and executes it through the capability broker afterwards.
 */
export async function proposeBuildWorkflow(
  options: ProposeBuildWorkflowOptions,
): Promise<BuildWorkflowOutputValue> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildWorkflowPrompt(
      options.workflowId,
      options.revision,
      JSON.stringify(options.host, null, 2),
      JSON.stringify(options.project, null, 2),
      options.taskContext,
    ) + (lastError.length === 0 ? "" : `\n\nPrevious proposal rejected:\n${lastError}\nReturn corrected JSON only.`);
    const run = await runAgent({
      cwd: options.repoDir,
      prompt,
      systemPrompt: BUILD_WORKFLOW_SYSTEM,
      allowedTools: ["Read", "Glob", "Grep"],
      outputFormat: BUILD_WORKFLOW_OUTPUT_FORMAT,
      maxTurns: 20,
    });
    let raw: unknown;
    try {
      raw = run.structuredOutput ?? extractJson(run.result);
    } catch {
      lastError = "response was not parsable as JSON";
      continue;
    }
    const parsed = BuildWorkflowOutput.safeParse(raw);
    if (parsed.success) {
      if (parsed.data.workflow_id !== options.workflowId) {
        lastError = `workflow_id must be ${options.workflowId}`;
        continue;
      }
      if (parsed.data.workflow_revision !== options.revision) {
        lastError = `workflow_revision must be ${String(options.revision)}`;
        continue;
      }
      return parsed.data;
    }
    lastError = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
  }
  throw new Error(`BuildWorkflow proposal failed schema validation after retry:\n${lastError}`);
}
