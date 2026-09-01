import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BUILD_WORKFLOW_SYSTEM, TEST_WORKFLOW_SYSTEM } from "./prompts.js";
import { WORKFLOW_TYPES } from "./workflow-types.js";
import { DEFAULT_AGENT_FORBIDDEN_GLOBS, DEFAULT_AGENT_READABLE_GLOBS, runAgent } from "./driver.js";
export interface GenerateWorkflowSourceOptions {
  readonly cwd: string;
  /** Absolute or cwd-relative destination. Parent directories are created by the host. */
  readonly outputPath: string;
  readonly workflowKind: "build" | "test";
  readonly workflowId: string;
  readonly revision: number;
  readonly taskContext?: string;
  readonly measuredHost?: string;
  readonly measuredProject?: string;
  readonly selectedBuildWorkflow?: string;
  /** Host deadline for the Claude source-writing query. */
  readonly timeoutMs?: number;
}

export interface WorkflowAgentScope {
  readonly readableGlobs: string[];
  readonly forbiddenGlobs: string[];
}

export function workflowAgentScope(kind: "build" | "test"): WorkflowAgentScope {
  const readableGlobs = kind === "test"
    ? [...DEFAULT_AGENT_READABLE_GLOBS, "test/**", "tests/**"]
    : [...DEFAULT_AGENT_READABLE_GLOBS];
  const forbiddenGlobs = DEFAULT_AGENT_FORBIDDEN_GLOBS.filter((glob) =>
    glob !== ".refactor/**" && (kind !== "test" || (glob !== "test/**" && glob !== "tests/**")),
  );
  return { readableGlobs, forbiddenGlobs };
}

/**
 * Ask Claude to write a reusable workflow module. The only writable path is
 * outputPath; the host validates and executes the file after this function.
 */
export async function generateWorkflowSource(
  options: GenerateWorkflowSourceOptions,
): Promise<{ summary: string; outputPath: string }> {
  const outputPath = options.outputPath;
  mkdirSync(dirname(outputPath), { recursive: true });
  if (existsSync(outputPath)) unlinkSync(outputPath);
  // Host-provided types: the model imports these instead of declaring its own
  // interfaces (type-only import; erased at runtime).
  const typesPath = join(dirname(outputPath), "types.d.ts");
  writeFileSync(typesPath, WORKFLOW_TYPES, "utf8");
  const editable = relative(options.cwd, outputPath).split("\\").join("/");
  // The workflow-spec skill is force-dispatched: its full content loads into
  // context, giving the model the exact API/schema without constant
  // prompt bloat and without dependence on project tree read access.
  const prompt = [
    "The workflow-spec skill is loaded in this session. Follow it exactly; the host rejects any deviation.",
    `Write the complete TypeScript source module to exactly this absolute path: ${outputPath}.`,
        `Hard-code these exact identity literals in the returned object; do not read them from WorkflowContext: workflow_id = "${options.workflowId}", workflow_revision = ${String(options.revision)}.`,
    `The module must default-export a function receiving WorkflowContext. Its runtime context is exactly context.apiVersion, context.workspaceRoot, context.input, context.facts.host, context.facts.project, and injected capabilities; there are no top-level workflow_id or host_preflight fields.`,
    `Import the host-provided types from the sibling file: import type { WorkflowContext, ProcessResult } from "./types"; Do NOT declare your own interfaces/types for the context, capabilities, process results, or plans. The types.d.ts file sits next to your output path and is already written. Type-only imports are erased at runtime, so they are safe.`,
    "This is a source-writing task: write the .ts file; do not reply with JSON instead of the file.",
    "Do not import node:, bun:, fs, child_process, process, or network modules.",
    "Do not run git and do not modify any other file.",
    options.workflowKind === "build"
            ? `The workflow function DRIVES the build itself (workflow-driven): declare export const workflowKind = "workflow-driven" at the top and make the default-exported function return nothing (void). Do NOT return a BuildWorkflowOutput object and do NOT declare an artifact paths constant — the host no longer consumes either. Drive the build with context.process.run / context.fs / context.adapters, then assert every produced executable with context.validator.assertFile(path, description) (throws when missing → fail-closed). CMake's --target accepts exactly ONE target; run separate process.run calls per target.`
            : `Return a complete TestWorkflow with top-level kind "test-workflow", version 1, the exact test identity literals above, and build_workflow_id/build_workflow_revision copied exactly from the selected BuildWorkflow. Never use top-level kind "test".`,
    "You may declare observable steps with context.plan: const [id] = await plan.declare([{ title, children? }]); then await plan.begin(id)/plan.complete(id)/plan.fail(id, error). Root ids are returned; children use parentId.index.",
    options.selectedBuildWorkflow ? `Selected BuildWorkflow:
${options.selectedBuildWorkflow}` : "",
    options.measuredHost ? `Measured HostPreflight:
${options.measuredHost}` : "",
    options.measuredProject ? `Measured ProjectDetection:
${options.measuredProject}` : "",
    options.taskContext ? `Task context:
${options.taskContext}` : "",
    "The host will reject malformed output, unsupported tools, guessed fields, absolute paths, and writes outside the requested file.",
  ].filter((part) => part.length > 0).join("\n\n");
  // The generated source deliberately lives under .refactor; its single
  // editable target remains the write boundary. TestWorkflow additionally
  // receives read-only access to test trees so it can discover established suites.
  const scope = workflowAgentScope(options.workflowKind);
  const run = await runAgent({
    cwd: options.cwd,
    prompt,
    skills: ["workflow-spec:workflow-spec"],
    systemPrompt: options.workflowKind === "build" ? BUILD_WORKFLOW_SYSTEM : TEST_WORKFLOW_SYSTEM,
        allowedTools: ["Read", "Glob", "Grep", "Write", "Edit"],
    readableGlobs: scope.readableGlobs,
    forbiddenGlobs: scope.forbiddenGlobs,
    editableFiles: [editable],
        maxTurns: 24,
    timeoutMs: options.timeoutMs,
  });
  if (run.timedOut) {
    throw new Error(
      `workflow author timed out generating ${editable}${run.result.length > 0 ? `: ${run.result}` : ""}`,
    );
  }
  if (run.isError) {
    throw new Error(
      `workflow author failed generating ${editable}${run.result.length > 0 ? `: ${run.result}` : ""}`,
    );
  }
  if (!existsSync(outputPath)) {
    throw new Error(
      `workflow author did not create ${editable}${run.result.length > 0 ? `: ${run.result}` : ""}`,
    );
  }
  return { summary: run.result, outputPath };
}
