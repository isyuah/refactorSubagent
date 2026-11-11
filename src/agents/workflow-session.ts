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
import { verificationPlanningPrompt } from "./verification-planning.js";
import { workflowSkillContext } from "./workflow-skills.js";

/**
 * workflow-session — orchestrates a test-writer Claude session that produces
 * a TestWorkflow source and a dependency declaration set.
 *
 * The test-writer can:
 *   - investigate source behavior and submit its verification plan through
 *     submitVerificationAnalysis in the same conversation that authors tests,
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
  /**
   * Continue a prior authoring conversation instead of starting a new one
   * (feedback-repair lane for script-shaped test-workflow failures). The
   * feedback message replaces the authoring prompt; the deliverable gates
   * below still apply unchanged (file written this session, fresh
   * declareDependency, fresh analysis submission).
   */
  readonly resume?: {
    readonly dialogueId: string;
    readonly feedback: string;
  };
}

/** Options handed to the underlying agent runner (narrowed for testability). */
export interface WorkflowSessionAgentOptions {
  readonly cwd: string;
  readonly prompt: string;
  /** Authoring system prompt. Absent on resume (the stored conversation
   *  carries its own; combining both is an untested SDK path). */
  readonly systemPrompt?: string;
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
  /** Run-scoped logger for session-level events (mirrored by driver). */
  readonly logger?: Logger;
  /** Mirror the full AI session transcript to this store. */
  readonly sessionStore?: SessionStore;
  /** Continue this prior conversation (SDK resume) instead of a new chat. */
  readonly resumeDialogueId?: string;
}

/**
 * Structured attribution for an unusable session outcome — replaces the old
 * single reason string so callers classify (model-session vs resolution),
 * judge retryability and read detail fields without parsing prose.
 */
export interface WorkflowSessionFailure {
  /** "model-session": the session itself failed (error/stall/deadline);
   *  "resolution": the session ended but a deliverable is missing. */
  readonly category: "model-session" | "resolution";
  readonly reason: string;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;
}

/** A failure may carry structured attribution or a plain reason string
 *  (legacy checks that predate the attribution contract normalize to the
 *  "resolution" category with retry disabled). */
export type WorkflowSessionFailureLike = WorkflowSessionFailure | string;

/** Normalize any failure shape into the structured attribution form. */
export function asWorkflowSessionFailure(
  failure: WorkflowSessionFailureLike | null,
): WorkflowSessionFailure | null {
  if (failure === null) return null;
  if (typeof failure === "string") {
    return { category: "resolution", reason: failure, retryable: false, detail: {} };
  }
  return failure;
}

export interface WorkflowSessionResult {
  readonly ok: boolean;
  /** Final assistant text. */
  readonly summary: string;
  /** SDK conversation id; the feedback loop continues THIS dialogue when the
   *  exam itself needs a script-error repair. */
  readonly dialogueId?: string;
  /** Declared build workflow ids (final state of declareDependency). */
  readonly declaredBuilds: readonly string[];
  /** True when the produced test workflow source exists at testEntry. */
  readonly testEntryExists: boolean;
  /** Host-saved advisory report, or null if none was submitted this session. */
  readonly verificationAnalysisPath: string | null;
  /** Session timed out. */
  readonly timedOut: boolean;
  /** Why the session outcome is not usable (when ok is false). */
  readonly failure: WorkflowSessionFailureLike | null;
}

// Temporarily omit Bash. Restore it here if authoring shell access is enabled again.
export const TEST_WRITER_AGENT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Task",
] as const;

const SESSION_PROMPT = (
  task: string,
  testEntry: string,
  preflight: string,
): string => `${verificationPlanningPrompt(task, preflight)}

In this session you also implement the verification plan. Keep investigation and
test authoring in this conversation so source findings are available when choosing
inputs and observations. Complete and submit the investigation before writing
test/helper code. Load workflow-generation references after the plan is accepted.

Required deliverables:
  1. Your source investigation, accepted by submitVerificationAnalysis during
     this session. A stale file or a prose summary does not count. Correct and
     resubmit the complete plan if new source evidence changes the chosen scope.
  2. A complete declareDependency call with every build workflow the test uses.
     At least one build is required; a preparation workflow may validate existing
     per-worktree artifacts if compilation is unnecessary.
  3. A self-driven TestWorkflow TypeScript module written to exactly:
       ${testEntry}

After submitting the plan:
  1. Read the host workflow skill and its implementation guidance for the selected
     scope. Reuse source findings already established in this conversation;
     supplement them when a concrete interface or behavior detail is missing.
     ${workflowSkillContext("workflow-spec")}
  2. Design inputs, observations, and any helper or test-double code. Account for
     the plan's important behavior and error paths. Existing tests can cover
     some items; explain material gaps instead of claiming complete coverage.
  3. Use build-writer when a new build is needed or an existing recipe's usage is
     unclear. Supply the selected scope, saved plan path, required real
     implementation, and COMPLETE helper source content.
     - Build-writer authors compilation/linking steps and describes intended
       artifact paths and usage (arguments/stdin/output protocol;
       library entry points, loading and lifecycle; or runner selection/results).
       The host executes the delivered workflows after this authoring session.
     - If helper code requires that usage first, ask for a consultation, then
       write the helper and request the final build. Consultations do not register
       provisional workflows.
     - All helper sources/data/wrapper build files must be registered as
       materials [{path, content}] under build/verification/. The host freezes
       and distributes identical bytes to both worktrees after candidate commit.
       Each side compiles its own real implementation.
     - Handle concrete source or isolation questions yourself. Have build-writer
       encode the selected scope's toolchain/configuration checks in the workflow.
       An unselected alternative's environment does not block the chosen scope.
       Stop for missing decisive source contracts, not merely because a build
       has not yet been executed.
     Run build-writer in the foreground and wait for its result before continuing.
  4. Call declareDependency with the final complete build id set and write the
     TestWorkflow. It MUST NOT rebuild: the host runs declared builds first.
     Assert required artifact paths with context.validator.assertFile; fail if
     absent. Use the same test source and declarations in the same order on both
     worktrees, with no detection of which side is running.
  5. Write execution-validity checks into the TestWorkflow: inspect process
     status/exitCode and relevant test discovery before comparisons. Crashes,
     timeouts, loading failures and zero tests must fail the workflow. Normal
     tests require exit code 0; negative cases need an explicit expected failure
     contract. The workflow emits actual implementation observations through
     ctx.expect when the host runs it.

Authoring produces source from repository reads, supplied preflight facts and
build-writer's usage report. Finish after the plan, dependencies and test source
are delivered. Compilation, execution and execution diagnostics belong to the
host's later steps, not to this session. Do not run compilers, test programs,
syntax probes or simulated workflow contexts. Preserve tracked source/build
files and Git state, and deliver auxiliary code through registered materials.
During formal verification, tests and materials are fixed; candidate failures
never justify weakening them.

Finish with a concise summary referring to the saved plan and test file: selected
scope, important covered behaviors, and material coverage gaps or plan changes.
The host checks the current analysis submission, declared builds and test file.
`;

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
  };
  const prompt = options.resume !== undefined
    ? resumedSessionPrompt(options.resume.feedback, options.testEntry)
    : SESSION_PROMPT(options.task, options.testEntry, preflight);

  const runner = options.runAgentFn ?? defaultRunAgent;
  let run: DriverRun;
  try {
    run = await runner({
      cwd: repoDir,
      prompt,
      // On resume the stored conversation carries its original system prompt;
      // a fresh one alongside resume is an untested SDK combination, so the
      // continuation keeps the session's own prompt.
      ...(options.resume === undefined ? { systemPrompt: TEST_WORKFLOW_SYSTEM } : {}),
      allowedTools: [...TEST_WRITER_AGENT_TOOLS],
      extraAllowedTools: mcpTools,
      agents,
      mcpServers: { [serverName]: mcpServer },
      skills: ["workflow-spec:verification-planning", "workflow-spec:workflow-spec"],
      maxTurns: limits.maxTurns,
      model: limits.model,
      timeoutMs: limits.deadlineMs ?? undefined,
      stallTimeoutMs: limits.stallMs,
      logger: options.logger,
      sessionStore: options.sessionStore,
      ...(options.resume !== undefined ? { resumeDialogueId: options.resume.dialogueId } : {}),
    });
  } finally {
    verificationAnalysis.close();
  }

  const testEntryExists = existsSync(options.testEntry);
  const declaredBuilds = await registry.currentDeclared();
  const declaredExplicitly = await registry.declaredExplicitly();
  let failure: WorkflowSessionFailureLike | null = null;
  if (run.isError && run.result.length === 0) {
    failure = {
      category: "model-session",
      reason: "test-writer session failed without output",
      retryable: true,
      detail: { is_error: true, timed_out: run.timedOut, stalled: run.stalled === true },
    };
  } else if (run.timedOut) {
    failure = {
      category: "model-session",
      reason: run.stalled === true
        ? "test-writer session aborted: agent stream stalled (no message); CLI subprocess likely died"
        : "test-writer session timed out",
      retryable: true,
      detail: { timed_out: true, stalled: run.stalled === true },
    };
  } else if (!testEntryExists) {
    failure = {
      category: "resolution",
      reason: `test-writer did not produce ${relativeTestEntry}`,
      retryable: false,
      detail: { test_entry: relativeTestEntry, declared_builds: [...declaredBuilds] },
    };
  } else if (!declaredExplicitly) {
    failure = {
      category: "resolution",
      reason:
        "test-writer finished without calling declareDependency; it must declare " +
        "the full dependency set (empty allowed only via an explicit declareDependency([]))",
      retryable: false,
      detail: {
        test_entry: relativeTestEntry,
        declared_builds: [...declaredBuilds],
        declared_explicitly: false,
      },
    };
  } else if (!verificationAnalysis.hasSubmission()) {
    failure = "test-writer finished without submitting its verification analysis through submitVerificationAnalysis";
  }

  return {
    ok: failure === null,
    summary: run.result,
    ...(run.sessionId !== undefined ? { dialogueId: run.sessionId } : {}),
    declaredBuilds,
    testEntryExists,
    verificationAnalysisPath: verificationAnalysis.hasSubmission() ? verificationAnalysis.path : null,
    timedOut: run.timedOut,
    failure,
  };
}

/** Feedback prompt appended to a CONTINUED authoring conversation. */
function resumedSessionPrompt(feedback: string, testEntry: string): string {
  return `${feedback}

[续写提醒] 这是你此前出题对话的延续。本轮你只需按上面的反馈修复 TestWorkflow，但交付门槛不变：
  1. 本次会话内重新调用 submitVerificationAnalysis 提交（可沿用上轮结论，内容有变则修正）。
  2. 重新调用 declareDependency 声明完整构建集合。
  3. 把修复后的完整 TestWorkflow 写到原路径：${testEntry}
     覆盖面不得缩水：登记的检查点数量与场景不得少于上一版。`;
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

