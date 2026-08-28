import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { analyzeRepo, proposalArtifacts, type AnalysisResult } from "../agents/analyze.js";
import { runRefactor } from "../agents/refactor.js";
import { resolveWorkflows, type ResolvedWorkflows, type WorkflowRequest } from "../workflow/resolve-workflows.js";
import { E2ELogger } from "./e2e-log.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import { detectCProject } from "./project-detector.js";
import { probeHost } from "./host-preflight.js";
import { runWorkflowVerification, type WorkflowVerificationOutcome } from "./workflow-pipeline.js";
import { createWorktrees, resolveHead, type WorktreePair } from "./worktree.js";

export interface AgentWorkflowPipelineRequest {
  /** Git repository containing the base C project. */
  readonly repoPath: string;
  /** Natural-language refactoring task given to Analyze and Refactor agents. */
  readonly task: string;
  /** Root under which the durable session is created. */
  readonly sessionRoot: string;
  readonly sessionId: string;
  /** Optional provided Workflow candidates; non-forced entries go through Claude selection. */
  readonly build?: WorkflowRequest;
  readonly test?: WorkflowRequest;
  /** Optional project policy; declared editable scope must stay within this set. */
  readonly allowedEditableFiles?: readonly string[];
  readonly workflowTimeoutMs?: number;
  readonly buildTimeoutMs?: number;
  readonly ctestTimeoutMs?: number;
  readonly knownEnvironmentPatterns?: readonly RegExp[];
  readonly logger?: E2ELogger;
}

export interface AgentWorkflowPipelineResult {
  readonly store: SessionStore;
  readonly state: string;
  readonly refactorSummary: string;
  readonly scopeDenials: string[];
  readonly analysis: AnalysisResult | null;
  readonly workflows: ResolvedWorkflows | null;
  readonly verification: WorkflowVerificationOutcome | null;
  readonly logDir: string;
}

/**
 * Full Claude-backed Workflow pipeline.
 *
 * Claude proposes artifacts, selects/refines the workflow and edits only the
 * candidate worktree. The host measures, persists, executes and decides.
 */
export async function runAgentWorkflowVerification(
  req: AgentWorkflowPipelineRequest,
): Promise<AgentWorkflowPipelineResult> {
  const store = SessionStore.create(req.sessionRoot, req.sessionId);
  const orch = new Orchestrator(store);
  const logger = req.logger ?? new E2ELogger(
    join(req.sessionRoot, ".refactor", "e2e"),
    req.sessionId,
  );
  let analysis: AnalysisResult | null = null;
  let workflows: ResolvedWorkflows | null = null;
  let verification: WorkflowVerificationOutcome | null = null;
  let refactorSummary = "";
  let scopeDenials: string[] = [];
  let worktrees: WorktreePair | null = null;

  try {
    logger.phase("PREFLIGHT");
    const host = probeHost(req.repoPath);
    store.saveHostPreflight(host);
    logger.artifact("host-preflight.json", host);

    const project = detectCProject(req.repoPath, host);
    store.saveProjectDetection(project);
    logger.artifact("project-detection.json", project);
    logger.info("C project preflight completed", {
      status: project.status,
      primary_build_system: project.primary_build_system,
      adapter: project.adapter,
      source_file_count: project.source_files.length,
    });
    if (project.status !== "ready") {
      abort(orch, logger, `project build detection blocked: ${project.reason}`);
      return result(store, logger, analysis, workflows, verification, refactorSummary, scopeDenials);
    }

    logger.phase("ANALYSIS");
    analysis = await analyzeRepo(req.repoPath, req.task, host, project);
    for (const artifact of proposalArtifacts(analysis)) {
      logger.artifact(`analysis-${artifact.kind}.json`, artifact);
    }
    enforceEditablePolicy(analysis, req.allowedEditableFiles);
    logger.info("Claude analysis accepted by host schemas", {
      editable_files: analysis.scope.editable_files.map((target) => target.file),
      test_case_count: analysis.tests.cases.length,
    });

    logger.phase("WORKFLOW_RESOLUTION");
    logger.info("generating and validating TypeScript BuildWorkflow and TestWorkflow sources");
    logger.startHeartbeat(5_000);
    try {
      workflows = await resolveWorkflows({
        workspaceRoot: req.repoPath,
        sessionRoot: store.sessionDir,
        host,
        project,
        taskContext: req.task,
        workflowTimeoutMs: req.workflowTimeoutMs,
        build: req.build,
        test: req.test,
      });
    } finally {
      logger.stopHeartbeat();
    }
    logger.artifact("workflow-resolution-build.json", workflows.buildResolution);
    logger.artifact("workflow-resolution-test.json", workflows.testResolution);
    logger.artifact("build-workflow-output.json", workflows.build.output);
    logger.artifact("test-workflow.json", workflows.test.workflow);
    logger.logFile("build-workflow.ts", readFileSync(workflows.build.entry, "utf8"));
    logger.logFile("test-workflow.ts", readFileSync(workflows.test.entry, "utf8"));
    logger.info("AI-generated TypeScript workflows validated", {
      build_source: workflows.build.entry,
      test_source: workflows.test.entry,
      build_mode: workflows.buildResolution.mode,
      test_mode: workflows.testResolution.mode,
    });

    const baseSha = resolveHead(req.repoPath);
    const branch = `refactor/agent-${req.sessionId}`;
    gitIn(req.repoPath, ["branch", branch, baseSha]);
    worktrees = createWorktrees(req.repoPath, store.sessionDir, branch, baseSha);
    logger.info("isolated baseline and candidate worktrees created", {
      base_sha: baseSha,
      branch,
      baseline_dir: worktrees.baselineDir,
      candidate_dir: worktrees.candidateDir,
    });

    logger.phase("REFACTOR");
    const editable = analysis.scope.editable_files.map((target) => target.file);
    const refactor = await runRefactor(worktrees.candidateDir, req.task, analysis.scope);
    refactorSummary = refactor.summary;
    scopeDenials = refactor.denials;
    logger.artifact("refactor-summary.json", {
      summary: refactor.summary,
      scope_denials: refactor.denials,
    });
    logger.info("Claude refactor agent completed", {
      scope_denial_count: refactor.denials.length,
    });

    const status = gitIn(worktrees.candidateDir, ["status", "--porcelain"]);
    if (status.trim().length === 0) {
      abort(orch, logger, "refactor agent made no changes");
      return result(store, logger, analysis, workflows, verification, refactorSummary, scopeDenials);
    }
    gitIn(worktrees.candidateDir, ["add", "-A"]);
    const summaryLine = firstSummaryLine(refactor.summary) ?? req.task;
    gitIn(worktrees.candidateDir, ["commit", "-m", summaryLine.slice(0, 200)]);
    const changedFiles = gitIn(worktrees.candidateDir, [
      "diff",
      "--name-only",
      `${baseSha}..HEAD`,
    ])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    logger.artifact("patch-candidate.json", {
      branch,
      commit_sha: gitIn(worktrees.candidateDir, ["rev-parse", "HEAD"]),
      base_commit_sha: baseSha,
      changed_files: changedFiles,
      summary: summaryLine.slice(0, 500),
    });

    logger.phase("VERIFICATION");
    verification = await runWorkflowVerification({
      repoPath: req.repoPath,
      worktrees,
      store,
      logger,
      host,
      project,
      contract: analysis.contract,
      scope: analysis.scope,
      deps: analysis.deps,
      tests: analysis.tests,
      buildResolution: workflows.buildResolution,
      testResolution: workflows.testResolution,
      build: workflows.build,
      test: workflows.test,
      patch: {
        branch,
        commit_sha: gitIn(worktrees.candidateDir, ["rev-parse", "HEAD"]),
        changed_files: changedFiles,
        summary: summaryLine.slice(0, 500),
      },
      buildTimeoutMs: req.buildTimeoutMs,
      ctestTimeoutMs: req.ctestTimeoutMs,
      knownEnvironmentPatterns: req.knownEnvironmentPatterns,
    });
    return result(store, logger, analysis, workflows, verification, refactorSummary, scopeDenials);
  } catch (error) {
    const reason = errorMessage(error);
    abort(orch, logger, reason);
    return result(store, logger, analysis, workflows, verification, refactorSummary, scopeDenials);
  } finally {
    worktrees?.cleanup();
    if (store.state === "ACCEPTED") logger.finish("accepted", "workflow verification accepted candidate");
    else if (store.state === "REJECTED") logger.finish("rejected", "workflow verification rejected candidate");
    else if (store.state === "ABORTED") logger.finish("aborted", "workflow verification aborted");
    logger.close();
  }
}

function enforceEditablePolicy(
  analysis: AnalysisResult,
  allowed: readonly string[] | undefined,
): void {
  if (allowed === undefined) return;
  const declared = analysis.scope.editable_files.map((target) => target.file);
  const outside = declared.filter((file) => !allowed.includes(file));
  const missing = allowed.filter((file) => !declared.includes(file));
  if (outside.length > 0 || missing.length > 0) {
    throw new Error(
      `analysis editable scope does not match host policy: ` +
      `outside=[${outside.join(", ")}] missing=[${missing.join(", ")}]`,
    );
  }
}

function abort(orch: Orchestrator, logger: E2ELogger, reason: string): void {
  logger.error(reason);
  orch.abort(reason);
}

function result(
  store: SessionStore,
  logger: E2ELogger,
  analysis: AnalysisResult | null,
  workflows: ResolvedWorkflows | null,
  verification: WorkflowVerificationOutcome | null,
  refactorSummary: string,
  scopeDenials: string[],
): AgentWorkflowPipelineResult {
  return {
    store,
    state: store.state,
    refactorSummary,
    scopeDenials,
    analysis,
    workflows,
    verification,
    logDir: logger.runDir,
  };
}

function firstSummaryLine(summary: string): string | null {
  return summary.split(/\r?\n/).find((line) => line.trim().length > 0) ?? null;
}

function gitIn(dir: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
