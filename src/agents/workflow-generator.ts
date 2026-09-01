import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Directory of the tool-owned workflow spec documents. */
const SPEC_DIR = join(import.meta.dir, "workflow-specs");

function specFile(name: string): string {
  return readFileSync(join(SPEC_DIR, name), "utf8");
}
import { BUILD_WORKFLOW_SYSTEM, TEST_WORKFLOW_SYSTEM } from "./prompts.js";
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
  const editable = relative(options.cwd, outputPath).split("\\").join("/");
  // Tool-owned spec documents are injected verbatim so the model cannot miss
  // them (no dependence on readableGlobs or the project tree).
  const specDocs = [
    "=== WORKFLOW SPEC (host-injected, mandatory) ===",
    specFile("README.md"),
    "--- workflow-api.md ---",
    specFile("workflow-api.md"),
    options.workflowKind === "build"
      ? "--- build-output.md ---\n" + specFile("build-output.md")
      : "--- test-output.md ---\n" + specFile("test-output.md"),
    options.workflowKind === "build"
      ? "--- cmake.md (read when project is CMake) ---\n" + specFile("cmake.md")
      : "--- ctest.md (read when project uses CTest) ---\n" + specFile("ctest.md"),
    "=== END WORKFLOW SPEC ===",
  ];
  const prompt = [
    specDocs.join("\n"),
    `Write the complete TypeScript source module to exactly this absolute path: ${outputPath}.`,
        `Hard-code these exact identity literals in the returned object; do not read them from WorkflowContext: workflow_id = "${options.workflowId}", workflow_revision = ${String(options.revision)}.`,
    `The module must default-export a function receiving WorkflowContext. Its runtime context is exactly context.apiVersion, context.workspaceRoot, context.input, context.facts.host, context.facts.project, and injected capabilities; there are no top-level workflow_id or host_preflight fields.`,
    "This is a source-writing task: write the .ts file; do not reply with JSON instead of the file.",
    "Do not import node:, bun:, fs, child_process, process, or network modules.",
    "Do not run git and do not modify any other file.",
    options.workflowKind === "build"
            ? `Return a complete BuildWorkflowOutput with top-level kind "build-workflow-output", version 1, the exact identity literals above, environment kind "environment-spec" version 1, and artifact kind "executable" version 1 whose identity exactly matches. The nested environment.build must use the exact schema fields for direct-compiler, cmake, ninja, or workflow-driven; artifact.paths must be an object of logical names to relative paths. Prefer declarative kinds (direct-compiler/cmake/ninja) when the project's build fits them; use workflow-driven when the build needs custom steps (makefiles, multi-target suites) — then drive the build inside the function with context.process / context.fs / context.adapters. Never use top-level kind "build".`
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
