import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CLI_HELP,
  CliUsageError,
  parseCliArgs,
  type CliCommand,
  type PreflightCommand,
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

try {
  const command = parseCliArgs(Bun.argv.slice(2));
  const exitCode = await execute(command);
  if (exitCode !== 0) process.exitCode = exitCode;
} catch (cause) {
  if (cause instanceof CliUsageError) {
    console.error(`error: ${cause.message}\n\n${CLI_HELP}`);
    process.exitCode = 2;
  } else {
    console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
    process.exitCode = 1;
  }
}

async function execute(command: CliCommand): Promise<number> {
  if (command.kind === "help") {
    console.log(CLI_HELP);
    return 0;
  }
  if (command.kind === "preflight") return executePreflight(command);
  if (command.kind === "workflow-build") return executeWorkflowBuild(command);
  if (command.kind === "workflow-list") return executeWorkflowList(command);

  const input = command.inputFile === null
    ? command.inputJson === null
      ? null
      : JSON.parse(command.inputJson)
    : readJsonInput(command.inputFile);
  const result = await runWorkflow({
    entry: command.entry,
    cwd: command.cwd,
    input,
    timeoutMs: command.timeoutMs,
  });
  if (command.format === "json") console.log(JSON.stringify(result, null, 2));
  else printWorkflowResult(result);
  return result.status === "pass" ? 0 : 1;
}

function executePreflight(command: PreflightCommand): number {
  const repo = resolve(command.repo);
  const host = probeHost(repo);
  const project = detectCProject(repo, host);
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
  return project.status === "ready" ? 0 : 1;
}

async function executeWorkflowBuild(command: WorkflowBuildCommand): Promise<number> {
  const cwd = resolve(command.cwd);
  const host = probeHost(cwd);
  const project = detectCProject(cwd, host);
  const resolution = await resolveBuildWorkflow({
    entry: command.entry,
    workflowId: command.workflowId,
    revision: command.revision,
    cwd,
    host,
    project,
    timeoutMs: command.timeoutMs,
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

function executeWorkflowList(command: WorkflowListCommand): number {
  const repo = resolve(command.cwd);
  const host = probeHost(repo);
  const project = detectCProject(repo, host);
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
