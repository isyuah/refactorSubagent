import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CLI_HELP,
  CliUsageError,
  type CliCommand,
  type ConfigCommand,
  type LimitsCommand,
  type PreflightCommand,
  type RunCommand,
  type WorkflowBuildCommand,
  type WorkflowListCommand,
} from "../src/cli/args.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { resolveBuildWorkflow } from "../src/workflow/build-workflow.js";
import {
  discoverBuildWorkflows,
  saveBuildWorkflow,
  type BuildWorkflowCandidate,
} from "../src/workflow/registry.js";
import { readJsonInput, runWorkflow } from "../src/workflow/runner.js";
import type { WorkflowRunResult } from "../src/workflow/types.js";
import { extractLimitArgs, resolveLimits } from "../src/config/limits.js";
import type { LayerOverrides } from "../src/config/layers.js";
import {
  buildStageFlow,
  describePipeline,
  extractPipelineArgs,
  resolvePipeline,
} from "../src/config/pipeline.js";
import { StageFlowFinalizationError, type StageFlowResult } from "../src/runtime/stage-flow.js";
import { installOwnedProcessSignalHandlers } from "../shared/owned-process.js";
import { RunDisplay, formatRunReport } from "../src/cli/display.js";
import { styled, TerminalStyle } from "../src/cli/terminal.js";
import { CliInputCancelled, createRunSessionId, resolveCliInput } from "../src/cli/input.js";
import { runFeedbackStageFlow } from "../src/runtime/feedback/run.js";

try {
  const { overrides, remaining } = extractLimitArgs(Bun.argv.slice(2));
  const { overrides: pipelineOverrides, remaining: argv } = extractPipelineArgs(remaining);
  const command = await resolveCliInput(argv);
  installOwnedProcessSignalHandlers();
  const exitCode = await execute(command, overrides, pipelineOverrides);
  if (exitCode !== 0) process.exitCode ??= exitCode;
} catch (cause) {
  if (cause instanceof CliInputCancelled) {
    console.error(cause.message);
    process.exitCode ??= cause.exitCode;
  } else if (cause instanceof CliUsageError) {
    console.error(`error: ${cause.message}\n\n${CLI_HELP}`);
    process.exitCode ??= 2;
  } else {
    console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
    process.exitCode ??= 1;
  }
}

async function execute(
  command: CliCommand,
  overrides: LayerOverrides,
  pipelineOverrides: LayerOverrides,
): Promise<number> {
  if (command.kind === "help") {
    console.log(CLI_HELP);
    return 0;
  }
  if (command.kind === "preflight") return executePreflight(command, overrides);
  if (command.kind === "run") return executeRun(command, overrides, pipelineOverrides);
  if (command.kind === "workflow-build") return executeWorkflowBuild(command, overrides);
  if (command.kind === "workflow-list") return executeWorkflowList(command, overrides);
  if (command.kind === "config") return executeConfig(command);
  if (command.kind === "limits") return executeLimits(command, overrides);
  if (command.kind !== "workflow-run") return 2;

  const limits = resolveLimits({ repoRoot: resolve(command.cwd), overrides }).limits;
  const input = command.inputFile === null
    ? command.inputJson === null
      ? null
      : JSON.parse(command.inputJson)
    : readJsonInput(command.inputFile);
  const result = await runWorkflow({
    entry: command.entry,
    cwd: command.cwd,
    input,
    timeoutMs: command.timeoutMs ?? limits.commands.processMs ?? undefined,
  });
  if (command.format === "json") console.log(JSON.stringify(result, null, 2));
  else printWorkflowResult(result);
  return result.status === "pass" ? 0 : 1;
}

/** Print the limits that would apply to this repo, with their sources. */
function executeLimits(command: LimitsCommand, overrides: LayerOverrides): number {
  const repo = resolve(command.repo);
  const resolved = resolveLimits({ repoRoot: repo, overrides });
  if (command.format === "json") {
    console.log(JSON.stringify({ repo, ...resolved }, null, 2));
    return 0;
  }
  console.log(`repo: ${repo}`);
  for (const source of resolved.sources) console.log(`layer: ${source}`);
  for (const path of resolved.missing) console.log(`absent: ${path}`);
  if (resolved.sources.length === 0) console.log("layer: (built-in defaults only)");
  console.log(JSON.stringify(resolved.limits, null, 2));
  return 0;
}

function executePreflight(command: PreflightCommand, overrides: LayerOverrides): number {
  const repo = resolve(command.repo);
  const limits = resolveLimits({ repoRoot: repo, overrides }).limits;
  const host = probeHost(repo, { toolTimeoutMs: limits.probes.hostMs });
  const project = detectCProject(repo);
  const value = { repo, host, project };
  if (command.format === "json") console.log(JSON.stringify(value, null, 2));
  else {
    console.log(`repo: ${repo}`);
    console.log(`platform: ${host.platform}/${host.arch}`);
    console.log(`primary build system: ${project.primary_build_system ?? "none"}`);
    console.log(`adapter: ${project.adapter}`);
    console.log(`status: ${project.status}`);
    console.log(`reason: ${project.reason}`);
  }
  return project.status === "detected" ? 0 : 1;
}

/** Run the whole pipeline; where each stage's input comes from is config. */
async function executeRun(
  command: RunCommand,
  overrides: LayerOverrides,
  pipelineOverrides: LayerOverrides,
): Promise<number> {
  const repo = resolve(command.repo);
  const resolved = resolvePipeline({ repoRoot: repo, overrides: pipelineOverrides });
  const flow = buildStageFlow(resolved.pipeline);
  const sessionId = command.session ?? createRunSessionId();
  const sessionRoot = command.sessionRoot === null ? repo : resolve(command.sessionRoot);
  const resumeFrom = command.resume;
  const display = new RunDisplay({ format: command.format, verbosity: command.verbosity,
    progress: command.progress, color: command.color });
  const limits = resolveLimits({ repoRoot: repo, overrides });
  const onExit = (): void => { display.stop(); };
  const onInterrupt = (): void => { display.interrupt("SIGINT"); };
  const onTerminate = (): void => { display.interrupt("SIGTERM"); };
  process.once("exit", onExit);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  display.start({ repo, task: command.task, session: sessionId,
    log_dir: join(sessionRoot, ".refactor", "e2e", sessionId), pipeline: describePipeline(resolved.pipeline),
    pipeline_sources: resolved.sources, pipeline_config: resolved.pipeline, pipeline_overrides: pipelineOverrides.values,
    limits: limits.limits, limit_sources: limits.sources, limit_overrides: overrides.values, auto_retry: command.autoRetry });
  try {
    let result: StageFlowResult;
    let autoRetryMeta: { rounds: number; stoppedBecause: string; lastSession: string } | null = null;
    try {
      const request = {
        repoPath: repo,
        task: command.task,
        sessionRoot,
        sessionId,
        flow,
        ...(command.worktreeRoot !== null ? { worktreeRoot: resolve(command.worktreeRoot) } : {}),
        ...(command.injections.length > 0 ? { injections: command.injections } : {}),
        limitOverrides: overrides,
        onProgress: display.receive,
        configuration: { pipeline: resolved.pipeline, sources: resolved.sources, overrides: pipelineOverrides.values ?? [] },
      };
      const outcome = await runFeedbackStageFlow(request, {
        budget: command.autoRetry, resumeFrom,
      });
      result = outcome.result;
      autoRetryMeta = { rounds: outcome.rounds.length, stoppedBecause: outcome.stoppedBecause,
        lastSession: outcome.rounds.at(-1)!.sessionId };
    } catch (error) {
      if (!(error instanceof StageFlowFinalizationError)) throw error;
      result = error.result;
    }
    display.stop();
    const declaredBuilds = result.declared?.declaredSet.builds.map((build) => build.id) ?? [];
    const summary = {
      state: result.state,
      session: sessionId,
      repo,
      log_dir: result.logDir,
      pipeline: resumeFrom !== null ? "resume (checkpoint restart)" : describePipeline(resolved.pipeline),
      pipeline_layers: resolved.sources,
      injected_stages: result.provenance.injected,
      verification_authoritative: result.provenance.verification_authoritative,
      ...(result.provenance.resume !== undefined ? { resumed_from: result.provenance.resume } : {}),
      ...(autoRetryMeta !== null ? { auto_retry: autoRetryMeta } : {}),
      declared_builds: declaredBuilds,
      baseline_build: result.verification?.baselineBuild?.status ?? null,
      candidate_build: result.verification?.candidateBuild?.status ?? null,
      comparison: result.verification?.expectationComparison?.overall ??
        result.verification?.comparison?.overall ?? null,
      refactor_summary: result.refactorSummary.slice(0, 500),
      ...(result.failure !== null
        ? { failure: { stage: result.failure.stage, category: result.failure.category,
            component: result.failure.component, reason: result.failure.reason, retryable: result.failure.retryable } }
        : {}),
      report: result.report,
    };
    if (command.format === "json") {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const style = new TerminalStyle({ color: command.color, output: process.stdout });
      console.log(formatRunReport(result.report, command.verbosity, { color: command.color, output: process.stdout }));
      console.log(style.render([styled("pipeline: ", "accent"), summary.pipeline]));
      for (const layer of resolved.sources) console.log(style.render([styled("pipeline layer: ", "accent"), layer]));
      if (result.provenance.injected.length > 0) {
        const authority = result.provenance.verification_authoritative
          ? ""
          : " (verification replaced: verdict is non-authoritative)";
        console.log(style.render([styled("injected stages: ", "accent"), result.provenance.injected.join(", "), styled(authority, "warning")]));
      }
      if (declaredBuilds.length > 0) console.log(style.render([styled("declared builds: ", "accent"), declaredBuilds.join(", ")]));
    }
    return result.state === "ACCEPTED" && result.report.finalization_error === null ? 0 : 1;
  } finally {
    display.stop();
    process.off("exit", onExit);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

async function executeWorkflowBuild(
  command: WorkflowBuildCommand,
  overrides: LayerOverrides,
): Promise<number> {
  const cwd = resolve(command.cwd);
  const limits = resolveLimits({ repoRoot: cwd, overrides }).limits;
  const host = probeHost(cwd, { toolTimeoutMs: limits.probes.hostMs });
  const project = detectCProject(cwd);
  const resolution = await resolveBuildWorkflow({
    entry: command.entry,
    workflowId: command.workflowId,
    revision: command.revision,
    cwd,
    host,
    project,
    timeoutMs: command.timeoutMs ?? limits.commands.processMs ?? undefined,
  });

  let saved: ReturnType<typeof saveBuildWorkflow> | null = null;
  if (command.save) saved = saveBuildWorkflow(cwd, resolution);
  if (command.manifestOut !== null) {
    const manifestPath = resolve(cwd, command.manifestOut);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(resolution.manifest, null, 2) + "\n");
  }

  const value = {
    manifest: resolution.manifest,
    artifact: resolution.output?.artifact ?? null,
    environment: resolution.output?.environment ?? null,
    source_hash: resolution.sourceHash,
    saved: saved === null
      ? null
      : {
          entry: saved.entry,
          manifest: saved.manifestPath,
          output: saved.outputPath,
        },
  };
  if (command.format === "json") console.log(JSON.stringify(value, null, 2));
  else {
    console.log(`workflow: ${resolution.manifest.id}@${String(resolution.manifest.revision)}`);
    console.log(`source hash: ${resolution.sourceHash}`);
    if (resolution.output === null) {
      console.log("build kind: workflow-driven (no static plan; output produced at execute)");
    } else {
      console.log(`artifact kind: ${resolution.output.artifact.kind}`);
      for (const [name, path] of Object.entries(resolution.output.artifact.paths)) {
        console.log(`artifact ${name}: ${path}`);
      }
    }
    if (command.manifestOut !== null) console.log(`manifest: ${resolve(cwd, command.manifestOut)}`);
    if (saved !== null) console.log(`saved: ${saved.manifestPath}`);
  }
  return 0;
}

/** Install the tool's workflow-spec skill into project or user skills dir. */
function executeConfig(command: ConfigCommand): number {
  const toolSkill = resolve(import.meta.dir, "..", ".claude", "plugins", "workflow-spec", "skills", "workflow-spec");
  if (!existsSync(join(toolSkill, "SKILL.md"))) {
    console.error(`tool skill not found: ${toolSkill}`);
    return 1;
  }
  const target = command.scope === "user"
    ? join(homedir(), ".claude", "skills", "workflow-spec")
    : join(process.cwd(), ".claude", "skills", "workflow-spec");
  // Replace any existing copy atomically-ish: remove then copy.
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(toolSkill, target, { recursive: true });
  const files = readdirSync(target).filter((f) => f !== "SKILL.md");
  console.log(`installed workflow-spec skill → ${target}`);
  console.log(`  SKILL.md (frontmatter: user-invocable=false, disable-model-invocation=true)`);
  for (const file of files) console.log(`  ${file}`);
  console.log("The skill is force-injected by the host during workflow generation;");
  console.log("neither you nor the model can trigger it manually.");
  return 0;
}

function executeWorkflowList(command: WorkflowListCommand, overrides: LayerOverrides): number {
  const repo = resolve(command.cwd);
  const limits = resolveLimits({ repoRoot: repo, overrides }).limits;
  const host = probeHost(repo, { toolTimeoutMs: limits.probes.hostMs });
  const project = detectCProject(repo);
  const candidates = discoverBuildWorkflows(repo, host, project);
  if (command.format === "json") {
    console.log(JSON.stringify({ repo, candidates }, null, 2));
  } else {
    printWorkflowCandidates(candidates);
  }
  return 0;
}

function printWorkflowCandidates(candidates: BuildWorkflowCandidate[]): void {
  if (candidates.length === 0) {
    console.log("no build workflows found");
    return;
  }
  for (const candidate of candidates) {
    const identity = candidate.manifest === null
      ? "unknown"
      : `${candidate.manifest.id}@${String(candidate.manifest.revision)}`;
    console.log(`${identity} [${candidate.status}] ${candidate.manifestPath}`);
    for (const reason of candidate.reasons) console.log(`  reason: ${reason}`);
  }
}

function printWorkflowResult(result: WorkflowRunResult): void {
  console.log(`status: ${result.status}`);
  console.log(`exit code: ${String(result.exitCode)}`);
  if (result.result !== null) console.log(`result: ${JSON.stringify(result.result)}`);
  if (result.failure !== null) console.log(`failure: ${result.failure}`);
  if (result.stderr.length > 0) console.log(`stderr:\n${result.stderr}`);
}
