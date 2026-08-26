import { resolve } from "node:path";
import {
  CLI_HELP,
  CliUsageError,
  parseCliArgs,
  type CliCommand,
} from "../src/cli/args.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { probeHost } from "../src/runtime/host-preflight.js";
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
  if (command.kind === "preflight") {
    return executePreflight(command);
  }

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

function executePreflight(command: Extract<CliCommand, { kind: "preflight" }>): number {
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

function printWorkflowResult(result: WorkflowRunResult): void {
  console.log(`status: ${result.status}`);
  console.log(`exit code: ${String(result.exitCode)}`);
  if (result.result !== null) console.log(`result: ${JSON.stringify(result.result)}`);
  if (result.failure !== null) console.log(`failure: ${result.failure}`);
  if (result.stderr.length > 0) console.log(`stderr:\n${result.stderr}`);
}
