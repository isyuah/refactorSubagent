import { BUILD_WORKFLOW_SYSTEM } from "./prompts.js";

/**
 * build-writer — AgentDefinition for the subagent that authors
 * workflow-driven BuildWorkflow sources on request of the test-writer.
 *
 * Security model: the build-writer has NO Write/Edit/Bash tools. It can only
 * read the repo (Read/Glob/Grep) and hand its produced source to the host via
 * the generateBuildWorkflow MCP tool. The host validates the source before
 * materializing it under the run directory; the writer can never touch the
 * repository itself. This is enforced by the agent's `tools` allowlist — tools
 * are NOT inherited (the definition lists exactly what the writer may use).
 *
 * Reporting contract: after generating, the writer's final message must tell
 * the caller what was produced — the workflow id, and every artifact path the
 * build will create with its purpose — so the test-writer can reference those
 * paths (the host does not inject artifact locations).
 */

/** Shape accepted by SDK query `agents` option. */
export interface AgentDefinition {
  readonly description: string;
  readonly tools?: readonly string[];
  readonly prompt: string;
}

const WRITING_RULES = `You write workflow-driven BuildWorkflow TypeScript sources.

Write via the generateBuildWorkflow tool — you have no file-write tools. Call it with:
  { name, description, content }
where content is the COMPLETE TypeScript module. The host validates it before
saving and returns the assigned workflow_id on success, or the validation error
on failure — fix the content and call generateBuildWorkflow again until it
succeeds.

Tool availability in this session:
  - Read / Glob / Grep — inspect the repository (CMakeLists.txt, cmake/, src/,
    include/, tests present under the project) to write a correct build.
  - generateBuildWorkflow — materialize your produced workflow source.
You cannot write files, run shell commands, or edit the repository.`;

const REPORTING_CONTRACT = `After your workflow is generated, your FINAL message must report to the caller:
  1. the assigned workflow_id,
  2. EVERY artifact path the build produces (executables, libraries) with one
     line each: path + what it is + how the test can invoke it,
  3. any assumptions about the build environment you encoded (toolchain,
     generator, build directory).
This report is how the test-writer learns what exists; be precise and complete
about artifact paths — do not omit any produced executable.`;

const DECISION_RULES = `Before generating, inspect the repository enough to know:
  - the primary build system (CMakeLists.txt / Makefile / configure),
  - the target(s) needed to produce test executables,
  - the expected artifact locations.
Drive the real build in the workflow (configure + build via context.process.run
in the source), then assert every artifact with context.validator.assertFile.
CMake --target accepts exactly ONE target per process.run call — run separate
calls per target.`;

/**
 * Build the build-writer agent definition for injection into a test-writer
 * session via `agents` option. `mcpServerName` must match the dep-registry
 * server name so the tool allowlist lines up with actual tool names.
 */
export function buildWriterDefinition(
  mcpServerName = "dep-registry",
): AgentDefinition {
  const generateTool = `mcp__${mcpServerName}__generateBuildWorkflow`;
  return {
    description:
      "Writes a workflow-driven BuildWorkflow (TypeScript source) on request. " +
      "Inspects the repository and produces a validated build workflow via the " +
      `generateBuildWorkflow tool (${generateTool}). Use when a test workflow ` +
      "needs a build that does not already exist or is not suitable.",
    tools: ["Read", "Glob", "Grep"],
    prompt: [
      BUILD_WORKFLOW_SYSTEM,
      WRITING_RULES,
      DECISION_RULES,
      REPORTING_CONTRACT,
      `MCP tools available in this session (inherited from the caller): ` +
        `${generateTool}, and inspectWorkflow. Prefer inspectWorkflow to check ` +
        `whether a suitable build already exists before generating a new one.`,
    ].join("\n\n"),
  };
}
