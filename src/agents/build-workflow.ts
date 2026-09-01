import { join } from "node:path";
import { type HostPreflight, type ProjectDetection, type BuildWorkflowOutput as BuildWorkflowOutputValue } from "../artifacts/index.js";
import { generateWorkflowSource } from "./workflow-generator.js";
import { resolveBuildWorkflow } from "../workflow/build-workflow.js";

export interface ProposeBuildWorkflowOptions {
  readonly repoDir: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly taskContext?: string;
}

/**
 * Ask Claude to write a TypeScript BuildWorkflow, then execute and validate it.
 * The returned object is the host-side parsed result, not the agent's source.
 */
export async function proposeBuildWorkflow(
  options: ProposeBuildWorkflowOptions,
): Promise<BuildWorkflowOutputValue | null> {
  const entry = generatedEntry(options.repoDir, "build", options.workflowId, options.revision);
  await generateWorkflowSource({
    cwd: options.repoDir,
    outputPath: entry,
    workflowKind: "build",
    workflowId: options.workflowId,
    revision: options.revision,
    taskContext: options.taskContext,
    measuredHost: JSON.stringify(options.host, null, 2),
    measuredProject: JSON.stringify(options.project, null, 2),
  });
  const resolution = await resolveBuildWorkflow({
    entry,
    cwd: options.repoDir,
    entryRoot: options.repoDir,
    workspaceRoot: options.repoDir,
    workflowId: options.workflowId,
    revision: options.revision,
    host: options.host,
    project: options.project,
  });
  // workflow-driven workflows have no static output at propose time.
  return resolution.output;
}

function generatedEntry(root: string, kind: "build", id: string, revision: number): string {
  const safeId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  return join(root, ".refactor", "generated-workflows", kind, `${safeId}-r${String(revision)}.ts`);
}
