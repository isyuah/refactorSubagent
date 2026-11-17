import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LayerOverrides } from "../config/layers.js";
import { resolveLimits, type Limits } from "../config/limits.js";
import { probeHost } from "../runtime/host-preflight.js";
import { detectCProject } from "../runtime/project-detector.js";
import { resolveHead } from "../runtime/worktree.js";
import { E2ELogger } from "../runtime/e2e-log.js";
import { FileSessionStore } from "../runtime/session-store.js";
import { TrackedRepositoryGuard, VerificationIntegrity } from "../runtime/verification-integrity.js";
import { runDeclaredResolution } from "../runtime/author-workflows.js";
import { executeBuildFor, runObservedTest, runSuite } from "../runtime/workflow-side.js";
import { materializePlan } from "./stage.js";
import { resolveDeclaredWorkflows } from "../workflow/resolve-declared.js";
import { buildDeclaredResolution, type DeclaredAgentResolution } from "../runtime/stage-flow.js";
import { readVerificationMaterials } from "../workflow/verification-materials.js";
import { materializeTestWorkflow } from "../workflow/test-workflow.js";
import type { WorkflowSessionOptions } from "../agents/workflow-session.js";
import { LocalDependencyRegistry } from "../agents/dep-registry.js";
import { composeBuildRepairBrief, runBuildWriterRepairSession } from "../runtime/feedback/repair.js";
import type { runAgent } from "../agents/driver.js";
import { VerificationAnalysisInput } from "../agents/verification-analysis.js";
import type { ProgressObserver } from "../runtime/progress.js";
import { ReviewDocument, emptyTrial, type LocalDialogue, type PlanContent, type PreparationView, type TrialResult } from "./types.js";
import { loadTestPlan, loadLocalDialogue, saveTestPlan, type LoadedTestPlan } from "./bundle.js";

export interface PreparationOptions {
  repo: string; session: string; sessionRoot: string; scope?: string; from?: string;
  limitOverrides?: LayerOverrides; onProgress?: ProgressObserver; onChange?: (view: PreparationView) => void;
  /** Offline replay seam: production always uses the existing SDK driver. */
  runAgentFn?: WorkflowSessionOptions["runAgentFn"];
  runBuildAgentFn?: typeof runAgent;
}
function git(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  if (result.error !== undefined) throw new Error(`could not start git ${args[0]}: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** A preparation owns one detached original worktree; it never owns a candidate. */
export class TestPreparation {
  readonly repo: string;
  readonly directory: string;
  readonly limits: Limits;
  readonly limitSources: readonly string[];
  private workspace: string | null = null;
  private workspaceGuard: TrackedRepositoryGuard | null = null;
  private dialogue: LocalDialogue | null = null;
  private content: PlanContent;
  private status: PreparationView["status"] = "idle";
  private revision = 0;
  private trialOrigin: PreparationView["trialOrigin"] = "current";
  private saved: string | null = null;
  private planId: string;
  private previousFiles = new Map<string, string>();
  private history: TrialResult[] = [];
  private evidenceDirs: string[] = [];
  private operation = 0;
  private readonly cancellation = new AbortController();
  cancel = (): void => { this.cancellation.abort(); };
  get cancelled(): boolean { return this.cancellation.signal.aborted; }
  private readonly started = performance.now();
  private readonly guard: TrackedRepositoryGuard;
  private readonly localStateDir: string;
  private readonly listeners = new Set<(view: PreparationView) => void>();
  subscribe(listener: (view: PreparationView) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  constructor(private readonly options: PreparationOptions) {
    this.repo = resolve(options.repo);
    this.directory = join(resolve(options.sessionRoot), ".refactor", "test-preparations", options.session);
    if (!/^[a-zA-Z0-9_-]+$/.test(options.session)) throw new Error("invalid preparation session id");
    if (existsSync(this.directory)) throw new Error(`preparation session already exists: ${options.session}`);
    this.localStateDir = join(this.repo, ".refactor", "test-plan-dialogues");
    this.planId = options.session;
    this.guard = new TrackedRepositoryGuard(this.repo);
    const config = resolveLimits({ repoRoot: this.repo, overrides: options.limitOverrides });
    this.limits = config.limits; this.limitSources = config.sources;
    if (options.from !== undefined) {
      const loaded = loadTestPlan(options.from);
      this.content = structuredClone(loaded.content);
      this.planId = loaded.manifest.id;
      this.saved = loaded.directory;
      this.trialOrigin = "saved";
      this.status = "review";
      this.dialogue = loadLocalDialogue(this.localStateDir, this.planId);
      this.history = loaded.history;
      this.evidenceDirs = loaded.evidenceDirs;
      this.previousFiles = new Map(this.files().map(f => [f.path, f.content]));
    } else {
      if (!options.scope?.trim()) throw new Error("test preparation requires a verification scope");
      this.content = { metadata: { scope: options.scope, delivery: "draft", base_sha: resolveHead(this.repo),
        analysis: null, review: null, host: probeHost(this.repo, { toolTimeoutMs: this.limits.probes.hostMs }), trial: emptyTrial() }, test: null, builds: [] };
    }
    mkdirSync(this.directory, { recursive: true });
    this.persist();
  }

  view(): PreparationView {
    return { session: this.options.session, repo: this.repo, status: this.status, revision: this.revision, trialOrigin: this.trialOrigin, limits: this.limits,
      content: this.content, history: this.history, saved: this.saved,
      files: [...this.files().map(f => ({ ...f, previous: this.previousFiles.get(f.path) ?? null })),
        ...[...this.previousFiles].filter(([path]) => !this.files().some(f => f.path === path)).map(([path, previous]) => ({ path, content: null, previous }))] };
  }
  private files(): { path: string; content: string }[] {
    return [ ...(this.content.metadata.review === null ? [] : [{ path: "scenarios.json", content: JSON.stringify(this.content.metadata.review, null, 2) }]),
      ...(this.content.metadata.analysis === null ? [] : [{ path: "verification-analysis.json", content: JSON.stringify(this.content.metadata.analysis, null, 2) }]),
      ...(this.content.test === null ? [] : [{ path: "workflows/test.ts", content: this.content.test.source }]),
      ...this.content.builds.flatMap((b, i) => [{ path: `workflows/build-${i + 1}.ts`, content: b.source },
        ...(b.materials === null ? [] : [{ path: `workflows/build-${i + 1}.ts.materials.json`, content: b.materials }])]) ];
  }
  private persist(): void {
    writeFileSync(join(this.directory, "preparation.json"), JSON.stringify(this.view(), null, 2) + "\n");
    const view = this.view();
    this.options.onChange?.(view);
    for (const listener of this.listeners) listener(view);
  }
  private ensureWorkspace(): string {
    if (this.workspace !== null) return this.workspace;
    const workspace = join(this.directory, "original");
    const base = resolveHead(this.repo);
    git(this.repo, ["worktree", "add", "--detach", workspace, base]);
    this.workspace = workspace;
    this.workspaceGuard = new TrackedRepositoryGuard(workspace);
    const library = join(this.repo, ".refactorsa");
    if (existsSync(library)) cpSync(library, join(workspace, ".refactorsa"), { recursive: true, filter: p => !p.includes(`${sep}test-plans`) });
    this.content.metadata.base_sha = base;
    this.content.metadata.host = probeHost(workspace, { toolTimeoutMs: this.limits.probes.hostMs });
    this.materialize(workspace);
    return workspace;
  }
  private materialize(workspace: string): { testEntry: string; builds: { id: string; entry: string; runLocal: boolean; workflowId: string; revision: number }[] } {
    return materializePlan(this.content, join(workspace, ".refactor", "review-input"));
  }
  private logger(name: string): E2ELogger {
    const logger = new E2ELogger(join(this.directory, "operations"), `${++this.operation}-${name}`);
    if (this.options.onProgress) logger.subscribe(event => this.options.onProgress!({ ...event, elapsed_ms: Math.round(performance.now() - this.started) }));
    logger.artifact("preparation-config.json", { scope: this.content.metadata.scope, base_sha: this.content.metadata.base_sha,
      host: this.content.metadata.host, limits: this.limits, limit_sources: this.limitSources, limit_overrides: this.options.limitOverrides?.values ?? [] });
    this.evidenceDirs.push(logger.runDir);
    return logger;
  }

  private rememberTrial(): void {
    this.trialOrigin = "current";
    if (this.content.metadata.trial.status !== "not-run") this.history.push(this.content.metadata.trial);
    this.content.metadata.trial = emptyTrial();
  }
  private assertIdle(): void {
    this.cancellation.signal.throwIfAborted();
    if (this.status === "authoring" || this.status === "running" || this.status === "closed") throw new Error("当前准备会话不可修改");
  }
  private assertSources(): void {
    this.guard.assertUnchanged("test preparation");
    this.workspaceGuard!.assertUnchanged("test preparation");
  }

  /** User feedback is an explicit authoring action, never an automatic retry loop. */
  async author(feedback?: string): Promise<void> {
    this.assertIdle();
    const workspace = this.ensureWorkspace();
    const sources = this.materialize(workspace);
    const logger = this.logger("author");
    logger.phase("TEST_PREPARATION");
    const sessionId = `${this.options.session}-edit-${++this.revision}`;
    const reviewEntry = join(workspace, ".refactor", "review-input", `scenarios-${this.revision}.json`);
    this.previousFiles = new Map(this.files().map(f => [f.path, f.content]));
    this.rememberTrial();
    this.content.metadata.delivery = "draft";
    this.content.metadata.analysis = null;
    this.content.metadata.review = null;
    this.status = "authoring"; this.persist();
    const project = detectCProject(workspace);
    const root = this.dialogue?.root ?? logger.runDir;
    const delivered: { ids: readonly string[] } = { ids: [] };
    try {
      if (project.status === "no-c-sources") throw new Error(project.reason);
      const authored = await runDeclaredResolution({ repoDir: workspace, sessionRoot: this.directory,
        sessionId, task: this.content.metadata.scope, testEntryOverride: sources.testEntry,
        host: this.content.metadata.host, project, logger, sessionStore: new FileSessionStore(root), resumeStoreRoot: root,
        limits: this.limits.sessions.testWriter, policyRepairs: 0, adoptBuilds: sources.builds,
        review: { entry: reviewEntry, feedback: `${feedback ?? ""}\nCurrent delivered sources: ${sources.testEntry}; builds: ${sources.builds.map(b => b.entry).join(", ")}.\nThe prior analysis and scenarios, when supplied, are in ${join(workspace, ".refactor", "review-input")}. Read them before revising; write the updated scenarios to the new path requested above.` },
        ...(this.dialogue === null ? {} : { resume: { dialogueId: this.dialogue.id, feedback: feedback ?? "根据当前文件继续完善测试。" } }),
        runAgentFn: this.options.runAgentFn, signal: this.cancellation.signal,
        onSession: session => {
          delivered.ids = session.declaredBuilds;
          if (session.dialogueId !== undefined) this.dialogue = { id: session.dialogueId, root };
          if (session.verificationAnalysisPath !== null) {
            const analysis = JSON.parse(readFileSync(session.verificationAnalysisPath, "utf8"));
            this.content.metadata.analysis = VerificationAnalysisInput.parse(analysis.report);
          }
        },
      });
      this.capture(authored.resolution);
      this.content.metadata.review = ReviewDocument.parse(JSON.parse(readFileSync(reviewEntry, "utf8")));
      this.assertSources();
      this.content.metadata.delivery = "complete";
    } catch (error) {
      // Keep delivered sources even if the session ended before its final declaration/document.
      if (existsSync(sources.testEntry)) this.content.test = { source: readFileSync(sources.testEntry, "utf8"), workflowId: `test-${sessionId}`, revision: 1 };
      const registry = new LocalDependencyRegistry({ workspaceRoot: workspace, sessionRoot: this.directory, sessionId, host: this.content.metadata.host, project, adoptBuilds: sources.builds });
      const ids = delivered.ids.length ? delivered.ids : (await registry.inspect({ kind: "build" })).items.filter(b => b.status === "run-local").map(b => b.id);
      const drafts = [];
      for (const id of ids) {
        const build = await registry.resolveBuildEntry(id);
        if (build !== null) drafts.push({ id, workflowId: id, revision: 1, source: readFileSync(build.entry, "utf8"),
          description: existsSync(`${build.entry}.description.json`) ? JSON.parse(readFileSync(`${build.entry}.description.json`, "utf8")).description : "",
          materials: existsSync(`${build.entry}.materials.json`) ? readFileSync(`${build.entry}.materials.json`, "utf8") : null });
      }
      if (drafts.length) this.content.builds = drafts;
      let reason = error instanceof Error ? error.message : String(error);
      try { this.assertSources(); } catch (integrityError) { reason += `\n${String(integrityError)}`; }
      this.content.metadata.trial = { ...emptyTrial(), status: "failed", failure: { category: "resolution", reason }, evidence_dir: logger.runDir };
      logger.artifact("author-failure.json", this.content.metadata.trial);
    } finally { this.status = "review"; this.persist(); logger.close(); }
    if (!this.cancellation.signal.aborted && this.content.metadata.delivery === "complete") await this.trial();
  }
  private capture(declared: DeclaredAgentResolution): void {
    this.content.test = { source: declared.testSource, workflowId: declared.workflowId, revision: declared.workflowRevision };
    this.content.builds = declared.buildResolutions.map((build, i) => ({
      id: declared.declaredSet.builds[i]!.id, workflowId: build.manifest.id, revision: build.manifest.revision,
      source: readFileSync(build.entry, "utf8"), materials: existsSync(`${build.entry}.materials.json`) ? readFileSync(`${build.entry}.materials.json`, "utf8") : null,
      description: existsSync(`${build.entry}.description.json`)
        ? JSON.parse(readFileSync(`${build.entry}.description.json`, "utf8")).description : build.manifest.description,
    }));
  }
  async trial(): Promise<void> {
    this.assertIdle();
    let workspace = this.ensureWorkspace();
    const logger = this.logger("trial");
    logger.phase("ORIGINAL_TRIAL");
    const started = performance.now();
    this.rememberTrial();
    const trial: TrialResult = { ...emptyTrial(), evidence_dir: logger.runDir };
    this.status = "running"; this.persist();
    let category: "build" | "test" | "resolution" = "resolution";
    let buildId: string | undefined;
    try {
      if (this.content.metadata.delivery !== "complete" || this.content.test === null || this.content.builds.length === 0) throw new Error("尚未交付完整测试脚本和构建方案，请先让 AI 补全。 ");
      this.assertSources();
      // Each trial starts from the pinned source, so removed helpers or old outputs cannot make a revision pass.
      this.releaseWorkspace(); workspace = this.ensureWorkspace();
      const sources = this.materialize(workspace);
      const project = detectCProject(workspace);
      const resolved = await resolveDeclaredWorkflows({ workspaceRoot: workspace, entryRoot: workspace,
        host: this.content.metadata.host, project, testEntry: sources.testEntry,
        testWorkflowId: this.content.test.workflowId, testRevision: this.content.test.revision, builds: sources.builds });
      const declared = buildDeclaredResolution({ repoDir: workspace, testEntry: sources.testEntry,
        workflowId: this.content.test.workflowId, revision: this.content.test.revision, builds: sources.builds, resolved });
      const integrity = new VerificationIntegrity({ originalRepo: this.repo,
        worktrees: [{ root: workspace, commit: this.content.metadata.base_sha }],
        workflows: [{ entry: resolved.test.entry, sourceHash: resolved.test.sourceHash },
          ...resolved.builds.map(b => ({ entry: b.resolution.entry, sourceHash: b.resolution.sourceHash }))], materials: declared.materials });
      const request = { signal: this.cancellation.signal, host: this.content.metadata.host, project, limits: this.limits, test: resolved.test, logger, integrity };
      trial.builds = resolved.builds.map(b => ({ id: b.id, status: "not-run", duration_ms: 0, failure: null, evidence_path: null }));
      for (const [index, build] of resolved.builds.entries()) {
        category = "build"; buildId = build.id;
        const before = performance.now(); const artifactName = `baseline-build-${index + 1}`;
        const outcome = trial.builds[index]!;
        try {
          const result = await executeBuildFor(request, build.resolution, workspace, "baseline", artifactName, build.id);
          outcome.status = result.status === "pass" ? "pass" : "failed";
          outcome.failure = result.failure;
          if (result.status !== "pass") throw new Error(result.failure ?? "构建失败");
        } catch (error) {
          outcome.status = "failed"; outcome.failure = error instanceof Error ? error.message : String(error); throw error;
        } finally {
          outcome.duration_ms = Math.round(performance.now() - before);
          const path = join(logger.artifactsDir, `${artifactName}.json`);
          outcome.evidence_path = existsSync(path) ? path : null;
        }
      }
      category = "test"; buildId = undefined;
      if (resolved.test.workflow === null) {
        const result = await runObservedTest(request, workspace, "baseline");
        trial.observations = result.expectations;
        if (result.status !== "pass") throw new Error(result.failure ?? "测试执行失败");
      } else {
        const suite = materializeTestWorkflow(resolved.test, { timeout_ms: this.limits.stages.ctestMs, parallelism: 1 });
        if (suite === null) throw new Error("不支持的声明式测试执行器");
        trial.ctest = await runSuite(request, workspace, suite, "baseline");
        if (trial.ctest.status !== "pass" || trial.ctest.summary.total === 0) throw new Error(trial.ctest.failure?.explanation ?? "CTest 没有成功执行测试");
      }
      trial.status = "pass";
    } catch (error) {
      trial.status = "failed"; trial.failure = { category, reason: error instanceof Error ? error.message : String(error), ...(buildId === undefined ? {} : { build_id: buildId }) };
    } finally {
      trial.duration_ms = Math.round(performance.now() - started);
      this.content.metadata.trial = trial; this.status = "review";
      logger.artifact("trial-result.json", trial); this.persist(); logger.close();
    }
  }
  async repair(): Promise<void> {
    this.assertIdle();
    const failure = this.content.metadata.trial.failure;
    if (failure === null) throw new Error("当前没有需要修复的执行错误");
    if (failure.category !== "build") {
      await this.author(`人工要求修复原版试跑错误。分类：${failure.category}。\n原因：${failure.reason}\n完整证据：${this.content.metadata.trial.evidence_dir}。只修复本次执行问题，保持现有验证目标。`);
      return;
    }
    const workspace = this.ensureWorkspace();
    const sources = this.materialize(workspace);
    const index = this.content.builds.findIndex(b => b.id === failure.build_id);
    if (index < 0) throw new Error("失败构建不在当前方案中");
    const build = this.content.builds[index]!;
    const logger = this.logger("build-repair");
    logger.phase("BUILD_REPAIR");
    const brief = composeBuildRepairBrief({ summary: failure.reason, side: "baseline", buildId: build.id,
      evidencePaths: this.content.metadata.trial.evidence_dir === null ? [] : [this.content.metadata.trial.evidence_dir] }, {
      round: this.revision + 1, failedBuildId: build.id, failedBuildEntry: sources.builds[index]!.entry, failedBuildSource: build.source,
      materials: readVerificationMaterials(sources.builds[index]!.entry),
      otherSideOutcome: "这是独立测试准备，仅运行原版，不存在候选版。",
    });
    this.previousFiles = new Map(this.files().map(f => [f.path, f.content]));
    this.rememberTrial(); this.revision++; this.status = "authoring"; this.persist();
    let repaired = false;
    try {
      const result = await runBuildWriterRepairSession({ repoDir: workspace, sessionRoot: this.directory,
        sessionId: `${this.options.session}-build-${this.revision}`, task: this.content.metadata.scope,
        host: this.content.metadata.host, project: detectCProject(workspace), brief, dialogueRoot: logger.runDir, logger,
        limits: this.limits.sessions.testWriter, signal: this.cancellation.signal, runAgentFn: this.options.runBuildAgentFn });
      if (result === null) throw new Error("构建角色没有交付修复后的构建方案，请查看本次会话证据。");
      this.assertSources();
      this.content.builds[index] = { ...build, workflowId: result.id, revision: build.revision + 1,
        source: readFileSync(result.entry, "utf8"),
        materials: existsSync(`${result.entry}.materials.json`) ? readFileSync(`${result.entry}.materials.json`, "utf8") : null,
        description: JSON.parse(readFileSync(`${result.entry}.description.json`, "utf8")).description };
      repaired = true;
    } catch (error) {
      this.content.metadata.trial = { ...emptyTrial(), status: "failed", failure: { category: "build", build_id: build.id,
        reason: error instanceof Error ? error.message : String(error) }, evidence_dir: logger.runDir };
      logger.artifact("repair-failure.json", this.content.metadata.trial);
    } finally { this.status = "review"; this.persist(); logger.close(); }
    if (repaired && !this.cancellation.signal.aborted) await this.trial();
  }
  save(parent?: string): LoadedTestPlan {
    const result = saveTestPlan({ parent: parent ?? join(this.repo, ".refactorsa", "test-plans", this.planId),
      id: this.planId, content: this.content, history: this.history, evidenceDirs: this.evidenceDirs,
      dialogue: this.dialogue, localStateDir: this.localStateDir });
    this.saved = result.directory; this.persist(); return result;
  }
  private releaseWorkspace(): void {
    if (this.workspace !== null) {
      const target = resolve(this.workspace); const within = relative(resolve(this.directory), target);
      if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`) || within === "") throw new Error("refusing cleanup outside preparation directory");
      git(this.repo, ["worktree", "remove", "--force", target]); this.workspace = null;
    }
  }
  close(): void {
    if (this.status === "closed") return;
    this.releaseWorkspace();
    this.status = "closed"; this.persist(); this.guard.assertUnchanged("after test preparation");
  }
}
