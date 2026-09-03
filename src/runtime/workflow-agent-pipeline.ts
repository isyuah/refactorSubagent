import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { curateBuildWorkflow, loadAliases } from "../workflow/curator.js";
import { analyzeRepo, type AnalysisResult } from "../agents/analyze.js";
import { runRefactor } from "../agents/refactor.js";
import { E2ELogger } from "./e2e-log.js";
import { FileSessionStore } from "./session-store.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import { detectCProject } from "./project-detector.js";
import { probeHost } from "./host-preflight.js";
import { runWorkflowVerification, type WorkflowVerificationOutcome } from "./workflow-pipeline.js";
import { createWorktrees, resolveHead, type WorktreePair } from "./worktree.js";
import { runWorkflowSession } from "../agents/workflow-session.js";
import { LocalDependencyRegistry } from "../agents/dep-registry.js";
import { resolveDeclaredWorkflows } from "../workflow/resolve-declared.js";
import type {
  BehaviorContract,
  DeclaredBuildSet as DeclaredBuildSetValue,
  DependencyManifest,
  TestSpec,
  WorkflowResolution,
} from "../artifacts/index.js";
import type { TestWorkflowResolution } from "../workflow/test-workflow.js";
import type { BuildWorkflowResolution } from "../workflow/build-workflow.js";

export interface AgentWorkflowPipelineRequest {
  /** Git repository containing the base C project. */
  readonly repoPath: string;
  /** Natural-language refactoring task given to Analyze and Refactor agents. */
  readonly task: string;
  /** Root under which the durable session is created. */
  readonly sessionRoot: string;
  readonly sessionId: string;
  /** Optional project policy; declared editable scope must stay within this set. */
  readonly allowedEditableFiles?: readonly string[];
  readonly workflowTimeoutMs?: number;
  /** When false, skip PreToolUse scope enforcement for all agent sessions. */
  readonly enforceScope?: boolean;
  readonly buildTimeoutMs?: number;
  readonly ctestTimeoutMs?: number;
  readonly knownEnvironmentPatterns?: readonly RegExp[];
  readonly logger?: E2ELogger;
}

export interface DeclaredAgentResolution {
  /** DeclaredBuildSet artifact carrying the whole declaration. */
  readonly declaredSet: DeclaredBuildSetValue;
  readonly testResolution: TestWorkflowResolution;
  /** Resolved build workflows, in declaration order. */
  readonly buildResolutions: readonly BuildWorkflowResolution[];
  readonly testSource: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
}

export interface AgentWorkflowPipelineResult {
  readonly store: SessionStore;
  readonly state: string;
  readonly refactorSummary: string;
  readonly scopeDenials: string[];
  readonly analysis: AnalysisResult | null;
  readonly declared: DeclaredAgentResolution | null;
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
  // Mirror every AI session transcript (tool calls, subagent text, results)
  // under the run dir so slow runs can be analyzed at full fidelity without
  // raising the run.jsonl log level. One adapter per run; the SDK key is
  // {projectKey, sessionId} so each session lands in its own file.
  const sessionStore = new FileSessionStore(logger.runDir);
  let analysis: AnalysisResult | null = null;
  let declared: DeclaredAgentResolution | null = null;
  let verification: WorkflowVerificationOutcome | null = null;
  let refactorSummary = "";
  let scopeDenials: string[] = [];
  let worktrees: WorktreePair | null = null;

  try {
    logger.phase("PREFLIGHT");
    const host = timed(logger, "host probe", () => {
      const probed = probeHost(req.repoPath);
      store.saveHostPreflight(probed);
      logger.artifact("host-preflight.json", probed);
      return probed;
    });
    const project = timed(logger, "project detection", () => {
      const detected = detectCProject(req.repoPath, host);
      store.saveProjectDetection(detected);
      logger.artifact("project-detection.json", detected);
      return detected;
    });
    logger.info("C project preflight completed", {
      status: project.status,
      primary_build_system: project.primary_build_system,
      adapter: project.adapter,
      source_file_count: project.source_files.length,
    });
    if (project.status !== "ready") {
      abort(orch, logger, `project build detection blocked: ${project.reason}`);
      return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
    }

    logger.phase("ANALYSIS");
    analysis = timed(logger, "host-side analysis probe", () =>
      analyzeRepo({
        repoDir: req.repoPath,
        taskContext: req.task,
        host,
        project,
        allowedEditableFiles: req.allowedEditableFiles,
      }),
    );
    logger.artifact("analysis-report.txt", { report: analysis.report });
    logger.info("project probed; modification scope derived from host policy", {
      editable_files: analysis.scope.editable_files.map((target) => target.file),
    });

    logger.phase("WORKFLOW_SESSION");
    logger.info("running test-writer session (declare build deps, author TestWorkflow)");
    logger.startHeartbeat(5_000);
    const sessionStarted = performance.now();
    try {
      declared = await runDeclaredResolution({
        repoDir: req.repoPath,
        sessionRoot: store.sessionDir,
        sessionId: req.sessionId,
        task: req.task,
        host,
        project,
        logger,
        sessionStore,
        enforceScope: req.enforceScope,
        workflowTimeoutMs: req.workflowTimeoutMs,
      });
    } finally {
      logger.stopHeartbeat();
    }
    logger.info("test-writer session wall time", { duration_ms: Math.round(performance.now() - sessionStarted) });
    logger.artifact("declared-build-set.json", declared.declaredSet);
    logger.artifact("workflow-resolution-test.json", declared.testResolution);
    // testSource is TypeScript source, not JSON — store it as text for audit.
    logger.artifact("test-workflow.json", { kind: "test-workflow-source", source: declared.testSource });
    logger.info("declared build set resolved", {
      build_count: declared.declaredSet.builds.length,
      test_entry: declared.testResolution.entry,
      test_id: declared.workflowId,
    });

    const baseSha = resolveHead(req.repoPath);
    const branch = `refactor/agent-${req.sessionId}`;
    worktrees = timed(logger, "branch + worktree creation", () => {
      gitIn(req.repoPath, ["branch", branch, baseSha]);
      return createWorktrees(req.repoPath, store.sessionDir, branch, baseSha);
    });
    logger.info("isolated baseline and candidate worktrees created", {
      base_sha: baseSha,
      branch,
      baseline_dir: worktrees.baselineDir,
      candidate_dir: worktrees.candidateDir,
    });

    logger.phase("REFACTOR");
    const analysisNow = analysis;
    const editable = analysisNow.scope.editable_files.map((target) => target.file);
    const refactor = await timedAsync(logger, "refactor agent session", () =>
      runRefactor(worktrees!.candidateDir, req.task, analysisNow.scope, {
        logger,
        sessionStore,
      }),
    );
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
      return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
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
    if (declared === null || declared.buildResolutions.length === 0) {
      abort(orch, logger, "declared workflow resolution missing or empty build set");
      return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
    }
    const firstBuild = declared.buildResolutions[0]!;
    logger.info("workflow verification started", { phase_detail: "all builds + ctest both sides" });
    const verificationStarted = performance.now();
    verification = await runWorkflowVerification({
      repoPath: req.repoPath,
      worktrees,
      store,
      logger,
      host,
      project,
      contract: defaultContract(),
      scope: analysis.scope,
      deps: defaultDeps(),
      tests: defaultTests(),
      // Declared mode: DeclaredBuildSet artifact + declared test resolution
      // replace the legacy single build resolution in the state machine.
      buildResolution: {
        kind: "workflow-resolution",
        version: 1,
        workflow_kind: "build",
        mode: "declared",
        workflow_id: "declared-set",
        workflow_revision: 1,
        build_workflow: null,
        entry_root: "workspace",
        root_path: req.repoPath,
        entry: "declared-build-set",
        source_hash: declared.declaredSet.source_hash,
        candidate_entries: [],
        reason: "declared build set",
      },
      testResolution: declaredResolutionArtifact(declared),
      build: firstBuild,
      test: declared.testResolution,
      declaredSet: declared.declaredSet,
      declaredBuilds: declared.buildResolutions,
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
    logger.info("workflow verification completed", { duration_ms: Math.round(performance.now() - verificationStarted) });
    return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
  } catch (error) {
    const reason = errorMessage(error);
    abort(orch, logger, reason);
    return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
  } finally {
    timed(logger, "worktree cleanup", () => {
      worktrees?.cleanup();
    });
    if (store.state === "ACCEPTED") {
      await promoteRunLocalBuilds(declared, req.repoPath, logger);
      logger.finish("accepted", "workflow verification accepted candidate");
    }
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
  declared: DeclaredAgentResolution | null,
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
    declared,
    verification,
    logDir: logger.runDir,
  };
}

/** First non-empty line of an agent summary, used as the commit subject. */
function firstSummaryLine(summary: string): string | null {
  return summary.split(/\r?\n/).find((line) => line.trim().length > 0) ?? null;
}

/** Time one host-side stage; logs completion at info with duration_ms. */
function timed<R>(logger: E2ELogger, what: string, fn: () => R): R {
  const started = performance.now();
  const value = fn();
  logger.info(`${what} completed`, { duration_ms: Math.round(performance.now() - started) });
  return value;
}

async function timedAsync<T>(logger: E2ELogger, what: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await fn();
  logger.info(`${what} completed`, { duration_ms: Math.round(performance.now() - started) });
  return value;
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

/** Hash the ordered declaration (id:entry) for the artifact audit field. */
function declaredSetHash(builds: readonly { id: string; entry: string }[]): string {
  const h = createHash("sha256");
  for (const b of builds) h.update(`${b.id}:${b.entry}\n`);
  return h.digest("hex");
}

/**
 * Run the test-writer session, resolve every declared build, and assemble the
 * DeclaredAgentResolution consumed by the verification stage.
 */
async function runDeclaredResolution(options: {
  readonly repoDir: string;
  readonly sessionRoot: string;
  readonly sessionId: string;
  readonly task: string;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly logger: E2ELogger;
  readonly sessionStore: FileSessionStore;
  readonly enforceScope?: boolean;
  readonly workflowTimeoutMs?: number;
}): Promise<DeclaredAgentResolution> {
  const testRelDir = join(".refactor", "runs", options.sessionId, "workflows", "test");
  const testEntry = join(options.repoDir, testRelDir, "test-workflow.ts");
  const session = await runWorkflowSession({
    repoDir: options.repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    task: options.task,
    testEntry,
    host: options.host,
    project: options.project,
    logger: options.logger,
    sessionStore: options.sessionStore,
    enforceScope: options.enforceScope,
    timeoutMs: options.workflowTimeoutMs,
  });
  if (!session.ok) {
    throw new Error(
      `test-writer session failed: ${session.failure ?? "unknown"}${session.summary.length > 0 ? ` — ${session.summary.slice(0, 400)}` : ""}`,
    );
  }
  options.logger.info("test-writer session completed", {
    declared_builds: session.declaredBuilds.join(", "),
    summary: session.summary.slice(0, 200),
  });

  // Rebuild the registry (run-local files restored from disk) to resolve
  // declared build ids to their workflow entries.
  const registry = new LocalDependencyRegistry({
    workspaceRoot: options.repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    host: options.host,
    project: options.project,
  });
  const buildSources: { id: string; entry: string; runLocal: boolean }[] = [];
  for (const id of session.declaredBuilds) {
    const resolved = await registry.resolveBuildEntry(id);
    if (resolved === null) {
      throw new Error(`declared build workflow '${id}' cannot be resolved to a source`);
    }
    buildSources.push({ id, entry: resolved.entry, runLocal: resolved.runLocal });
  }

  const resolved = await resolveDeclaredWorkflows({
    workspaceRoot: options.repoDir,
    entryRoot: options.repoDir,
    host: options.host,
    project: options.project,
    testEntry,
    testWorkflowId: `test-${options.sessionId}`,
    testRevision: 1,
    builds: buildSources.map((b) => ({ id: b.id, entry: b.entry, runLocal: b.runLocal })),
  });

  const testSource = existsSync(testEntry) ? readFileSync(testEntry, "utf8") : "";
  const declaredSet: DeclaredBuildSetValue = {
    kind: "declared-build-set",
    version: 1,
    test_workflow_id: `test-${options.sessionId}`,
    test_workflow_revision: 1,
    builds: buildSources.map((b) => ({
      id: b.id,
      entry: relative(options.repoDir, b.entry).split("\\").join("/"),
      source_hash: b.runLocal ? sha256File(b.entry) : resolved.builds.find((r) => r.id === b.id)?.resolution.sourceHash ?? "",
      run_local: b.runLocal,
    })),
    source_hash: declaredSetHash(buildSources),
  };

  return {
    declaredSet,
    testResolution: resolved.test,
    buildResolutions: resolved.builds.map((b) => b.resolution),
    testSource,
    workflowId: `test-${options.sessionId}`,
    workflowRevision: 1,
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex");
}

/** Test workflow-resolution artifact (declared mode, no single build ref). */
function declaredResolutionArtifact(declared: DeclaredAgentResolution): WorkflowResolution {
  return {
    kind: "workflow-resolution",
    version: 1,
    workflow_kind: "test",
    mode: "declared",
    workflow_id: declared.workflowId,
    workflow_revision: declared.workflowRevision,
    build_workflow: null,
    entry_root: "workspace",
    root_path: declared.testResolution.entry,
    entry: relative(declared.testResolution.entry, declared.testResolution.entry).length === 0
      ? "test-workflow"
      : declared.testResolution.entry,
    source_hash: declared.testResolution.sourceHash,
    candidate_entries: [],
    reason: "declared test workflow",
  };
}

/** Promote run-local build workflows to the library after an accepted run. */
async function promoteRunLocalBuilds(
  declared: DeclaredAgentResolution | null,
  repoRoot: string,
  logger: E2ELogger,
): Promise<void> {
  if (declared === null) return;
  const existingAliases = loadAliases(repoRoot).aliases;
  for (const build of declared.declaredSet.builds) {
    if (!build.run_local) continue;
    if (existingAliases[build.id] !== undefined) continue; // already promoted
    const entry = join(repoRoot, build.entry);
    if (!existsSync(entry)) {
      logger.warn(`run-local build source missing, skip promotion: ${build.entry}`);
      continue;
    }
    try {
      const description = readDescriptionSidecar(entry);
      const result = await curateBuildWorkflow({
        repoRoot,
        entry,
        runLocalId: build.id,
        description,
      });
      logger.info(`promoted run-local build '${build.id}' -> '${result.libraryId}'`, {
        library_id: result.libraryId,
        revision: result.revision,
      });
    } catch (error) {
      logger.warn(`promotion failed for '${build.id}': ${errorMessage(error)}`);
    }
  }
}

function readDescriptionSidecar(entry: string): string {
  try {
    const parsed = JSON.parse(readFileSync(`${entry}.description.json`, "utf8")) as {
      description?: string;
    };
    return parsed.description ?? "";
  } catch {
    return "";
  }
}

/**
 * Host-constructed default proposal artifacts. In the declared-mode flow the
 * behavior contract, dependency list and test spec are decided inside the AI
 * sessions (test workflow declares expectations; the build/test workflows
 * self-drive). The state machine still requires these artifacts to advance
 * INIT → CONTRACT_READY → SCOPE_READY → DEPENDENCY_READY → TESTS_READY, so the
 * host submits minimal, semantically-neutral placeholders that carry no
 * verification meaning — the real gate is the DeclaredBuildSet + expectation
 * diff that follows.
 */
function defaultContract(): BehaviorContract {
  const ignore = { mode: "ignore" as const };
  return {
    kind: "behavior-contract",
    version: 1,
    channels: {
      exit_code: ignore,
      signals: ignore,
      stdout: ignore,
      stderr: ignore,
      filesystem: ignore,
    },
    allowed_change: { internal_structure: true, execution_time: true },
    notes: ["host-derived placeholder: expectations are declared by the test workflow"],
  };
}

function defaultDeps(): DependencyManifest {
  return {
    kind: "dependency-manifest",
    version: 1,
    dependencies: [
      {
        name: "none-declared",
        kind: "time",
        strategy: "reject",
        evidence: [],
        notes: "host-derived placeholder: no static dependency analysis in declared mode",
      },
    ],
  };
}

function defaultTests(): TestSpec {
  return {
    kind: "test-spec",
    version: 1,
    cases: [
      {
        id: "self-driven",
        kind: "differential",
        argv: [],
        stdin: "",
        fixtures: [],
      },
    ],
  };
}
