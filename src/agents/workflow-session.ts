import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { buildWriterDefinition } from "./build-writer.js";
import { LocalDependencyRegistry } from "./dep-registry.js";
import { createDependencyMcpServer } from "./dep-registry-server.js";
import { runAgent, type DriverRun } from "./driver.js";
import { TEST_WORKFLOW_SYSTEM } from "./prompts.js";

/**
 * workflow-session — orchestrates a test-writer Claude session that produces
 * a TestWorkflow source and a dependency declaration set.
 *
 * The test-writer can:
 *   - inspectWorkflow: list persisted library + run-local build workflows,
 *   - declareDependency: declare which builds this test depends on (full set,
 *     empty = none),
 *   - spawn the build-writer subagent to author a new BuildWorkflow via
 *     generateBuildWorkflow when the library has no suitable build.
 *
 * The host drives execution AFTER the session: resolve every declared build,
 * run them (baseline/candidate), then run the produced test workflow.
 */

export interface WorkflowSessionOptions {
  /** Absolute repo root (source under test). */
  readonly repoDir: string;
  /** Absolute session root where run-local artifacts live. */
  readonly sessionRoot: string;
  readonly sessionId: string;
  /** Natural-language task describing what behavior to verify. */
  readonly task: string;
  /** Absolute path where the produced TestWorkflow source must be written. */
  readonly testEntry: string;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  /** Host deadline for the whole session. */
  readonly timeoutMs?: number;
  /** Max agent turns. */
  readonly maxTurns?: number;
  /** Repo-relative globs the test-writer may read. Defaults to source view. */
  readonly readableGlobs?: readonly string[];
  /** Repo-relative hard denials (defaults: repo internals/tests). */
  readonly forbiddenGlobs?: readonly string[];
  /** Injected capabilities seam for tests; defaults to runAgent. */
  readonly runAgentFn?: (options: WorkflowSessionAgentOptions) => Promise<DriverRun>;
}

/** Options handed to the underlying agent runner (narrowed for testability). */
export interface WorkflowSessionAgentOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly extraAllowedTools: readonly string[];
  readonly readableGlobs: readonly string[];
  readonly forbiddenGlobs: readonly string[];
  readonly editableFiles: readonly string[];
  readonly agents: Record<string, unknown>;
  readonly mcpServers: Record<string, unknown>;
  readonly skills: readonly string[];
  readonly maxTurns: number;
  readonly timeoutMs?: number;
}

export interface WorkflowSessionResult {
  readonly ok: boolean;
  /** Final assistant text. */
  readonly summary: string;
  /** Tool denials surfaced by the scope hook. */
  readonly denials: readonly string[];
  /** Declared build workflow ids (final state of declareDependency). */
  readonly declaredBuilds: readonly string[];
  /** True when the produced test workflow source exists at testEntry. */
  readonly testEntryExists: boolean;
  /** Session timed out. */
  readonly timedOut: boolean;
  /** Why the session outcome is not usable (when ok is false). */
  readonly failure: string | null;
}

export const TEST_WRITER_AGENT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Task",
] as const;

const DEFAULT_READABLE = [
  "CMakeLists.txt",
  "cmake/**",
  "config/**",
  "include/**",
  "src/**",
  "*.c",
  "*.h",
] as const;

const DEFAULT_FORBIDDEN = [
  "baseline/**",
  ".refactor/**",
  "node_modules/**",
  "test/**",
  "tests/**",
] as const;

const SESSION_PROMPT = (
  task: string,
  testEntry: string,
  editableRel: string,
): string => `You are the TestWorkflow writer for a behavior-preserving C refactoring system.

Task under test:
${task}

You must produce TWO deliverables before the session ends:
  1. A dependency declaration — call declareDependency with the COMPLETE set
     of build workflow ids your test depends on. ALWAYS call it, even with an
     empty array [] (meaning: no build needed). The host executes every
     declared build (baseline and candidate) BEFORE running your test workflow,
     so declare every build whose artifacts your test references. Missing or
     malformed declarations fail the session.
  2. A self-driven TestWorkflow TypeScript module, written to exactly:
       ${testEntry}
     (repo-relative editable path: ${editableRel})

Workflow of the session:
  1. Call inspectWorkflow (kind: "build") to see what build workflows exist:
     library entries (status library-verified/library-draft, with descriptions)
     and entries generated earlier this run (status run-local).
  2. Decide: reuse a suitable library build, or author a new one.
     - Reuse: use its id in declareDependency.
     - New: spawn the build-writer subagent via the Task tool. It writes the
       BuildWorkflow source through the host (generateBuildWorkflow) and reports
       the assigned workflow_id plus EVERY artifact path the build produces and
       how to invoke each. After it reports, call generateBuildWorkflow
       yourself only if you must adjust; otherwise declare its workflow_id.
  3. Call declareDependency with the final complete set.
  4. Write the test workflow file. Your test workflow:
     - MUST NOT rebuild anything — the host already built every declared build
       in this worktree before your function runs. Reference the artifact paths
       the build-writer reported (or that you know from the repo) directly and
       assert them with context.validator.assertFile — if an artifact is
       missing, fail (do NOT fall back to building it yourself).
     - Runs once per worktree (baseline, then candidate) with the SAME source;
       you cannot tell which side you are on. Declare expectations with
       ctx.expect(...) — same declarations, same order, on both runs.

If the build-writer reports a failure or the generated workflow is rejected,
do not guess: either fall back to an existing library build (declare its id) or
stop and explain what is missing in your final message — the host will fail the
session rather than run a broken test.

The host validates your test workflow file and your declaration after the
session; both must be complete before you finish.`;

/**
 * Run a test-writer session. Returns the session outcome; the caller decides
 * whether to loop (missing declaration/file) or abort.
 */
export async function runWorkflowSession(
  options: WorkflowSessionOptions,
): Promise<WorkflowSessionResult> {
  const repoDir = options.repoDir;
  const relativeTestEntry = relative(repoDir, options.testEntry).split("\\").join("/");
  const registry = new LocalDependencyRegistry({
    workspaceRoot: repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    host: options.host,
    project: options.project,
  });
  const mcpServer = createDependencyMcpServer({ registry });
  const serverName = "dep-registry";
  const mcpToolPrefix = `mcp__${serverName}__`;
  const mcpTools = [
    `${mcpToolPrefix}inspectWorkflow`,
    `${mcpToolPrefix}declareDependency`,
    `${mcpToolPrefix}generateBuildWorkflow`,
  ];

  const agents: Record<string, unknown> = {
    "build-writer": buildWriterDefinition(serverName),
  };
  const prompt = SESSION_PROMPT(options.task, options.testEntry, relativeTestEntry);

  const runner = options.runAgentFn ?? defaultRunAgent;
  const run = await runner({
    cwd: repoDir,
    prompt,
    systemPrompt: TEST_WORKFLOW_SYSTEM,
    allowedTools: [...TEST_WRITER_AGENT_TOOLS],
    extraAllowedTools: mcpTools,
    readableGlobs: [...(options.readableGlobs ?? DEFAULT_READABLE)],
    forbiddenGlobs: [...(options.forbiddenGlobs ?? DEFAULT_FORBIDDEN)],
    editableFiles: [relativeTestEntry],
    agents,
    mcpServers: { [serverName]: mcpServer },
    skills: ["workflow-spec:workflow-spec"],
    maxTurns: options.maxTurns ?? 48,
    timeoutMs: options.timeoutMs,
  });

  const testEntryExists = existsSync(options.testEntry);
  const declaredBuilds = await registry.currentDeclared();
  const declaredExplicitly = await registry.declaredExplicitly();
  let failure: string | null = null;
  if (run.isError && run.result.length === 0) {
    failure = "test-writer session failed without output";
  } else if (run.timedOut) {
    failure = "test-writer session timed out";
  } else if (!testEntryExists) {
    failure = `test-writer did not produce ${relativeTestEntry}`;
  } else if (!declaredExplicitly) {
    failure =
      "test-writer finished without calling declareDependency; it must declare " +
      "the full dependency set (empty allowed only via an explicit declareDependency([]))";
  }

  return {
    ok: failure === null,
    summary: run.result,
    denials: run.denials,
    declaredBuilds,
    testEntryExists,
    timedOut: run.timedOut,
    failure,
  };
}

async function defaultRunAgent(
  o: WorkflowSessionAgentOptions,
): Promise<DriverRun> {
  return runAgent({
    cwd: o.cwd,
    prompt: o.prompt,
    systemPrompt: o.systemPrompt,
    allowedTools: [...o.allowedTools],
    extraAllowedTools: [...o.extraAllowedTools],
    readableGlobs: [...o.readableGlobs],
    forbiddenGlobs: [...o.forbiddenGlobs],
    editableFiles: [...o.editableFiles],
    agents: o.agents as never,
    mcpServers: o.mcpServers as never,
    skills: [...o.skills],
    maxTurns: o.maxTurns,
    timeoutMs: o.timeoutMs,
  });
}
