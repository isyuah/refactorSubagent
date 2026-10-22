import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { BUILD_WORKFLOW_SYSTEM } from "./prompts.js";

/**
 * build-writer — AgentDefinition for the subagent that authors
 * workflow-driven BuildWorkflow sources on request of the test-writer.
 *
 * The build-writer has no Write/Edit tools; delivery goes through the host
 * registry. Bash is available for scratch probes. These tool choices are not
 * an OS sandbox: the host separately checks tracked-source integrity.
 *
 * MCP visibility: an AgentDefinition with an explicit `tools` list does NOT
 * inherit the parent session's MCP tools. The writer must name its MCP tools
 * in `tools` AND declare the server in `mcpServers` (the SDK bridges the
 * parent's in-process server to the subagent by name).
 *
 * Reporting contract: after generating, the writer's final message must tell
 * the caller what was produced — the workflow id, and every artifact path the
 * build will create with its purpose — so the test-writer can reference those
 * paths (the host does not inject artifact locations).
 */

const WRITING_RULES = `You write workflow-driven BuildWorkflow TypeScript sources.

Deliver workflow source and auxiliary inputs via the generateBuildWorkflow MCP tool.
The tool's exact name in this session is mcp__dep-registry__generateBuildWorkflow
(it may also appear without the prefix in tool descriptions). Call it with:
  { name, description, content, materials?: [{ path, content }] }
where content is the COMPLETE TypeScript module. The host validates it before
saving and returns the assigned workflow_id on success, or the validation error
on failure — fix the content and call generateBuildWorkflow again until it
succeeds.

materials contain task-specific harness sources, fixtures or wrapper build files.
Their paths must be portable relative files under build/verification/. The host
hashes and freezes these inputs, then writes identical bytes to both worktrees
after the candidate commit. The workflow builds them against THIS worktree's
real implementation. Do not copy the implementation into materials, modify
tracked source/CMakeLists.txt, or depend on helper files left by a scratch probe.

Tool availability in this session:
  - Read / Glob / Grep — inspect the repository (CMakeLists.txt, cmake/, src/,
    include/, tests/) to write a correct build.
  - mcp__dep-registry__generateBuildWorkflow — materialize your produced source.
  - mcp__dep-registry__inspectWorkflow — check whether a suitable build already
    exists for the selected verification scope before writing a new one.
  - Bash — test commands and create temporary helper files ONLY in a scratch
    directory outside the repository. Never change tracked files or Git state.
Read the workflow-spec skill and its selected verification-strategies guidance.

The test-writer selects the verification scope using verification-scout's source
investigation. You own build feasibility and the artifact usage contract. If
asked only for an interface/feasibility consultation (for example before a
consumer can be written), return confirmed usage requirements and concrete
blockers without generating a provisional workflow. When asked to finalize,
compile the supplied helper against the real implementation and deliver a
complete workflow with all helper inputs registered. A known existing recipe
can be reused only when it fits the selected scope; inspect its implementation
and report its usage contract rather than assuming the listing contains it.
Return source questions or build blockers to test-writer for targeted follow-up;
test-writer authors test cases and test-double logic.`;

const REPORTING_CONTRACT = `After your workflow is generated, your FINAL message must report to the caller:
  1. the assigned workflow_id,
  2. EVERY artifact path the build produces (executables, libraries) with one
     entry each: path + what it is + how the test can invoke it. Include the
     complete usage contract as applicable: arguments/stdin/output protocol;
     library headers/public entry points, linking/loading, setup/cleanup;
     or runner test selection and how results/test discovery are checked,
  3. any assumptions about the build environment you encoded (toolchain,
     generator, build directory), registered material paths, and verification scope.
This report is how the test-writer learns what exists; be precise and complete
about artifact paths — do not omit any produced executable. For confirmed reuse,
report the existing workflow_id and the same usage details. A consultation-only
reply reports findings and unresolved items, without claiming a generated id.`;

const DECISION_RULES = `Before generating, inspect the repository enough to know:
  - the strategy requested by the test-writer and the real API/source it exercises,
  - the original build system if reusing it, or the compiler/linker inputs for a harness,
  - the target(s) needed to produce test executables or a library consumer,
  - the expected artifact locations.
You have a shell (Bash): establish those facts for real instead of inferring them.
Run configure/build in a scratch directory OUTSIDE the repository (e.g. under the
system temp directory) so you observe the actual toolchain, generator, target names
and artifact paths without polluting the project. The workflow you emit must stay
self-contained: it may not depend on anything your probe left behind.
Drive the selected build in the workflow (project target, linked consumer or local
source harness via context.process/context.adapters), check every command status
and exit code, then assert every artifact with context.validator.assertFile.
Do not reuse a binary from the original checkout or the other worktree: rebuild
the affected implementation in each worktree. Keep inputs and outputs separate;
never rewrite a registered material during build or test.
CMake --target accepts exactly ONE target per process.run call — run separate
calls per target.`;

/**
 * Build the build-writer agent definition for injection into a test-writer
 * session via `agents` option. `mcpServerName` must match the dep-registry
 * server name so the tool allowlist lines up with actual tool names.
 */
export function buildWriterDefinition(
  mcpServerName = "dep-registry",
  preflightContext = "",
): AgentDefinition {
  const generateTool = `mcp__${mcpServerName}__generateBuildWorkflow`;
  const inspectTool = `mcp__${mcpServerName}__inspectWorkflow`;
  return {
    description:
      "Writes a workflow-driven BuildWorkflow (TypeScript source) on request. " +
      "Inspects the repository and produces a validated build workflow via the " +
      `generateBuildWorkflow tool (${generateTool}). Use when a test workflow ` +
      "needs a build that does not already exist or is not suitable.",
    tools: [
      "Read",
      "Glob",
      "Grep",
      // Probe the real project (run cmake, list targets, try the build) before
      // encoding commands into the workflow — guessing the build is the main
      // source of workflows that do not work.
      "Bash",
      // The workflow source reaches the host through generateBuildWorkflow;
      // this agent has no Write/Edit. An explicit tools list does NOT inherit
      // parent MCP tools, so name them here AND declare the server below.
      generateTool,
      inspectTool,
    ],
    // Reference the parent session's dep-registry server by name so this
    // subagent can reach the host-side registry (the SDK bridges the
    // in-process server to the subagent by server name).
    mcpServers: [mcpServerName],
    skills: ["workflow-spec:workflow-spec"],
    prompt: [
      BUILD_WORKFLOW_SYSTEM,
      preflightContext,
      WRITING_RULES,
      DECISION_RULES,
      REPORTING_CONTRACT,
      `MCP tools available in this session: ${generateTool} and ${inspectTool}. ` +
        `Use ${inspectTool} to check whether a suitable build already exists ` +
        "before generating a new one.",
    ].join("\n\n"),
  };
}
