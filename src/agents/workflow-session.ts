import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { buildWriterDefinition } from "./build-writer.js";
import { LocalDependencyRegistry } from "./dep-registry.js";
import { createDependencyMcpServer } from "./dep-registry-server.js";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { runAgent, type DriverRun } from "./driver.js";
import { TEST_WORKFLOW_SYSTEM } from "./prompts.js";
import type { Logger } from "../runtime/log.js";
import { DEFAULT_LIMITS, type SessionLimits } from "../config/limits.js";
import { workflowPreflightContext } from "./workflow-facts.js";
import { VerificationAnalysisStore } from "./verification-analysis.js";
import { verificationScoutDefinition } from "./verification-scout.js";

/**
 * workflow-session — orchestrates a test-writer Claude session that produces
 * a TestWorkflow source and a dependency declaration set.
 *
 * The test-writer can:
 *   - delegate source investigation to verification-scout, which submits an
 *     advisory report through submitVerificationAnalysis,
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
  /** Session budgets; defaults to DEFAULT_LIMITS.sessions.testWriter. */
  readonly limits?: SessionLimits;
  /** Injected capabilities seam for tests; defaults to runAgent. */
  readonly runAgentFn?: (options: WorkflowSessionAgentOptions) => Promise<DriverRun>;
  /** Run-scoped logger for session-level events (mirrored to driver). */
  readonly logger?: Logger;
  /** Mirror the full AI session transcript to this store. */
  readonly sessionStore?: SessionStore;
}

/** Options handed to the underlying agent runner (narrowed for testability). */
export interface WorkflowSessionAgentOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly extraAllowedTools: readonly string[];
  readonly agents: Record<string, unknown>;
  readonly mcpServers: Record<string, unknown>;
  readonly skills: readonly string[];
  readonly maxTurns: number | null;
  /** Model name/id for the session CLI; null = CLI default. */
  readonly model?: string | null;
  readonly timeoutMs?: number;
  readonly stallTimeoutMs?: number | null;
  /** Run-scoped logger; session events are mirrored by the runner. */
  readonly logger?: Logger;
  /** Mirror the full AI session transcript to this store. */
  readonly sessionStore?: SessionStore;
}

export interface WorkflowSessionResult {
  readonly ok: boolean;
  /** Final assistant text. */
  readonly summary: string;
  /** Declared build workflow ids (final state of declareDependency). */
  readonly declaredBuilds: readonly string[];
  /** True when the produced test workflow source exists at testEntry. */
  readonly testEntryExists: boolean;
  /** Host-saved advisory report, or null if none was submitted this session. */
  readonly verificationAnalysisPath: string | null;
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
  "Bash",
] as const;

const SESSION_PROMPT = (
  task: string,
  testEntry: string,
  preflight: string,
): string => `You are the TestWorkflow writer for a behavior-preserving C refactoring system.

Task under test:
${task}

${preflight}

Read the workflow-spec skill. Delegate source investigation to verification-scout
before designing tests; it has its own focused skill and receives these preflight
facts and the original task. You own the final strategy and concrete test cases.
Use the scout's conclusions rather than repeating its full repository exploration;
read individual interfaces as needed to write correct tests. Read the selected
workflow-spec implementation guidance, including verification-strategies.md.

You must produce THREE deliverables before the session ends:
  1. A source investigation report, accepted by submitVerificationAnalysis. The
     verification-scout submits it through the host and returns the accepted
     report. An old file or an unsubmitted prose report does not count.
  2. A dependency declaration — call declareDependency with the COMPLETE set
     of build workflow ids your test depends on. ALWAYS call it. This pipeline
     requires at least one declared build (a preparation workflow may validate
     existing per-worktree artifacts when compilation is unnecessary). The host executes every
     declared build (baseline and candidate) BEFORE running your test workflow,
     so declare every build whose artifacts your test references. Missing or
     malformed declarations fail the session.
  3. A self-driven TestWorkflow TypeScript module, written to exactly:
       ${testEntry}
     (absolute output path supplied by the host)

Workflow of the session:
  1. Call inspectWorkflow (kind: "build") to see what build workflows exist:
     library entries (status library-verified/library-draft, with descriptions)
     and entries generated earlier this run (status run-local).
  2. Invoke verification-scout via Task with the behavior to verify, constraints,
     available recipe summaries, and any specific unresolved question. It
     investigates implementation semantics and dependencies, recommends a scope
     and dependency treatment, and submits its report. It does not supply
     artifact usage instructions. WAIT for its accepted report.
  3. Select a reliable scope from that report: relevant existing tests, a library
     consumer, a focused real-source harness, or a combination. Reliability and
     semantic coverage come before cost; a focused harness does not require an
     expensive full build to be justified. Resolve critical unknowns with
     targeted follow-ups or stop if no reliable scope can be established.
  4. Delegate construction to build-writer when a new build is needed or an
     existing recipe's artifact usage is unclear. Supply the selected scope,
     scout report, required real implementation, and auxiliary source content.
     - For reuse, have build-writer confirm suitability and the artifact usage
       contract when it is not already established. Recipe listings alone are
       not a complete usage contract.
     - If helper code needs library/runner usage details first, ask build-writer
       for an interface/feasibility consultation before writing that code. It
       should return findings without registering a provisional build. Then
       author the helper and request the final complete build.
     - You own helper/test-double code; build-writer owns compilation, linking,
       real scratch probes, accurate artifact paths and complete usage details
       (arguments/stdin, public library entry points and setup/cleanup, or test
       selection/results as applicable). It returns the assigned workflow_id
       for a generated build, or the confirmed existing id for reuse.
     - It must register all helper code as materials [{path, content}] under
       build/verification/ in generateBuildWorkflow. Pass helper content in
       the delegation; keep scratch files outside the original repository.
       Compile each side's real implementation, without copying that code into
       helpers. The host pins materials and distributes identical bytes to both
       worktrees only after the candidate patch is committed.
     - A concrete build blocker can justify a targeted scout follow-up and a
       revised strategy during authoring. Explain the change and have the scout
       update the report. Preserve the frozen test and materials during later
       verification; a candidate failure is not a reason to weaken them.
     Run every delegated agent in the FOREGROUND (run_in_background: false).
     WAIT for one report before dispatching the next agent or finishing.
  5. Call declareDependency with the final complete set.
  6. Write the test workflow file. Your test workflow:
     - MUST NOT rebuild anything — the host already built every declared build
       in this worktree before your function runs. Reference the artifact paths
       the build-writer reported (or that you know from the repo) directly and
       assert them with context.validator.assertFile — if an artifact is
       missing, fail (do NOT fall back to building it yourself).
     - Runs once per worktree (baseline, then candidate) with the SAME source;
       you cannot tell which side you are on. Declare expectations with
       ctx.expect(...) — same declarations, same order, on both runs.
     - Require a valid test run BEFORE comparing behavior: inspect status and
       exitCode, throw for a crash/timeout/unexpected failure, and emit at least
       one observation of the actual implementation. Two identical failures
       do not establish equivalent behavior. Negative cases need an explicit
       expected failure contract, not merely equal nonzero exit codes.

Use Bash only for targeted facts still needed to author the test; coordinate
with build-writer instead of duplicating its compilation probes. Never
modify tracked files in the repository and never run git commands that change
state - the host owns the worktrees. Probe builds must happen OUTSIDE the repo
(for example under the system temp directory), because anything you leave inside
the repo becomes part of the run.

If the build-writer reports a failure or the generated workflow is rejected,
use the concrete blocker for a targeted follow-up and have build-writer confirm
the revised scope or a suitable existing recipe. If no reliable build can be
established, stop and explain what is missing — the host will fail the session
rather than run a broken test.

Explain the selected strategy, any departure from the scout's recommendation,
covered behaviors and integration limits in your final report. The host checks
the submitted analysis, test workflow file and declaration after the session;
all three must be complete before you finish.`;

/**
 * Run a test-writer session. Returns the session outcome; the caller decides
 * whether to loop (missing declaration/file) or abort.
 */
export async function runWorkflowSession(
  options: WorkflowSessionOptions,
): Promise<WorkflowSessionResult> {
  const limits = options.limits ?? DEFAULT_LIMITS.sessions.testWriter;
  const repoDir = options.repoDir;
  const relativeTestEntry = relative(repoDir, options.testEntry).split("\\").join("/");
  const registry = new LocalDependencyRegistry({
    workspaceRoot: repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    host: options.host,
    project: options.project,
  });
  const verificationAnalysis = new VerificationAnalysisStore(
    join(repoDir, ".refactor", "runs", options.sessionId, "workflows", "verification-analysis.json"),
    options.task,
  );
  const mcpServer = createDependencyMcpServer({ registry, verificationAnalysis });
  const serverName = "dep-registry";
  const mcpToolPrefix = `mcp__${serverName}__`;
  const mcpTools = [
    `${mcpToolPrefix}inspectWorkflow`,
    `${mcpToolPrefix}declareDependency`,
    `${mcpToolPrefix}generateBuildWorkflow`,
    `${mcpToolPrefix}submitVerificationAnalysis`,
  ];

  const preflight = workflowPreflightContext(options.host, options.project);
  const agents: Record<string, unknown> = {
    "build-writer": buildWriterDefinition(serverName, preflight),
    "verification-scout": verificationScoutDefinition(serverName, `Task under test:\n${options.task}\n\n${preflight}`),
  };
  const prompt = SESSION_PROMPT(options.task, options.testEntry, preflight);

  const runner = options.runAgentFn ?? defaultRunAgent;
  let run: DriverRun;
  try {
    run = await runner({
      cwd: repoDir,
      prompt,
      systemPrompt: TEST_WORKFLOW_SYSTEM,
      allowedTools: [...TEST_WRITER_AGENT_TOOLS],
      extraAllowedTools: mcpTools,
      agents,
      mcpServers: { [serverName]: mcpServer },
      skills: ["workflow-spec:workflow-spec"],
      maxTurns: limits.maxTurns,
      model: limits.model,
      timeoutMs: limits.deadlineMs ?? undefined,
      stallTimeoutMs: limits.stallMs,
      logger: options.logger,
      sessionStore: options.sessionStore,
    });
  } finally {
    verificationAnalysis.close();
  }

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
  } else if (!verificationAnalysis.hasSubmission()) {
    failure = "test-writer finished without a submitted verification analysis; delegate to verification-scout";
  }

  return {
    ok: failure === null,
    summary: run.result,
    declaredBuilds,
    testEntryExists,
    verificationAnalysisPath: verificationAnalysis.hasSubmission() ? verificationAnalysis.path : null,
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
    agents: o.agents as never,
    mcpServers: o.mcpServers as never,
    skills: [...o.skills],
    maxTurns: o.maxTurns,
    model: o.model,
    timeoutMs: o.timeoutMs,
    stallTimeoutMs: o.stallTimeoutMs,
    logger: o.logger,
    sessionStore: o.sessionStore,
  });
}

