import { join } from "node:path";
import {
  type BuildWorkflowOutput as BuildWorkflowOutputValue,
  type HostPreflight,
  type ProjectDetection,
  type TestWorkflow as TestWorkflowValue,
} from "../artifacts/index.js";
import { generateWorkflowSource } from "./workflow-generator.js";
import { resolveTestWorkflow } from "../workflow/test-workflow.js";

export interface ProposeTestWorkflowOptions {
  readonly repoDir: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly buildWorkflow: BuildWorkflowOutputValue;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly taskContext?: string;
}

/**
 * Ask Claude to write a TypeScript TestWorkflow, then execute and validate it.
 * The returned object is the host-side parsed result, not the agent's source.
 */
export async function proposeTestWorkflow(
  options: ProposeTestWorkflowOptions,
): Promise<TestWorkflowValue | null> {
  const entry = generatedEntry(options.repoDir, options.workflowId, options.revision);
  await generateWorkflowSource({
    cwd: options.repoDir,
    outputPath: entry,
    workflowKind: "test",
    workflowId: options.workflowId,
    revision: options.revision,
    selectedBuildWorkflow: JSON.stringify(options.buildWorkflow, null, 2),
    taskContext: options.taskContext,
    measuredHost: JSON.stringify(options.host, null, 2),
    measuredProject: JSON.stringify(options.project, null, 2),
  });
  const resolution = await resolveTestWorkflow({
    entry,
    entryRoot: options.repoDir,
    workspaceRoot: options.repoDir,
    workflowId: options.workflowId,
    revision: options.revision,
    buildWorkflow: options.buildWorkflow,
    host: options.host,
    project: options.project,
  });
  return resolution.workflow;
}

function generatedEntry(root: string, id: string, revision: number): string {
  const safeId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  return join(root, ".refactor", "generated-workflows", "test", `${safeId}-r${String(revision)}.ts`);
}
