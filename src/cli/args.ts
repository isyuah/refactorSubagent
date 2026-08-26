export type CliFormat = "human" | "json";

export interface PreflightCommand {
  kind: "preflight";
  repo: string;
  format: CliFormat;
}

export interface WorkflowRunCommand {
  kind: "workflow-run";
  entry: string;
  cwd: string;
  inputJson: string | null;
  inputFile: string | null;
  timeoutMs: number;
  format: CliFormat;
}

export interface WorkflowBuildCommand {
  kind: "workflow-build";
  entry: string;
  workflowId: string;
  revision: number;
  cwd: string;
  manifestOut: string | null;
  save: boolean;
  timeoutMs: number;
  format: CliFormat;
}

export interface WorkflowListCommand {
  kind: "workflow-list";
  cwd: string;
  format: CliFormat;
}

export type CliCommand =
  | { kind: "help" }
  | PreflightCommand
  | WorkflowRunCommand
  | WorkflowBuildCommand
  | WorkflowListCommand;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const args = [...argv];
  const command = args.shift();
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help" };
  }
  if (command === "preflight") return parsePreflight(args);
  if (command === "workflow") return parseWorkflow(args);
  throw new CliUsageError(`unknown command '${command}'`);
}

function parsePreflight(args: string[]): PreflightCommand {
  let repo = ".";
  let format: CliFormat = "human";
  let sawRepo = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    if (arg.startsWith("--")) throw new CliUsageError(`unknown preflight option '${arg}'`);
    if (sawRepo) throw new CliUsageError("preflight accepts at most one repository path");
    repo = arg;
    sawRepo = true;
  }
  return { kind: "preflight", repo, format };
}

function parseWorkflow(args: string[]): WorkflowRunCommand | WorkflowBuildCommand | WorkflowListCommand {
  const subcommand = args.shift();
  if (subcommand === "run") return parseWorkflowRun(args);
  if (subcommand === "build") return parseWorkflowBuild(args);
  if (subcommand === "list") return parseWorkflowList(args);
  throw new CliUsageError("workflow requires the 'run', 'build', or 'list' subcommand");
}

function parseWorkflowRun(args: string[]): WorkflowRunCommand {
  const entry = requiredEntry(args);
  let cwd = process.cwd();
  let inputJson: string | null = null;
  let inputFile: string | null = null;
  let timeoutMs = 60_000;
  let format: CliFormat = "human";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--cwd") {
      cwd = nextValue(args, ++index, "--cwd");
      continue;
    }
    if (arg === "--input-json") {
      if (inputFile !== null) throw new CliUsageError("--input-json and --input-file are mutually exclusive");
      inputJson = nextValue(args, ++index, "--input-json");
      continue;
    }
    if (arg === "--input-file") {
      if (inputJson !== null) throw new CliUsageError("--input-json and --input-file are mutually exclusive");
      inputFile = nextValue(args, ++index, "--input-file");
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(nextValue(args, ++index, "--timeout-ms"), "--timeout-ms");
      continue;
    }
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    throw new CliUsageError(`unknown workflow run option '${arg}'`);
  }
  return { kind: "workflow-run", entry, cwd, inputJson, inputFile, timeoutMs, format };
}

function parseWorkflowBuild(args: string[]): WorkflowBuildCommand {
  const entry = requiredEntry(args);
  let workflowId: string | null = null;
  let revision: number | null = null;
  let cwd = process.cwd();
  let manifestOut: string | null = null;
  let save = false;
  let timeoutMs = 60_000;
  let format: CliFormat = "human";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--id") {
      workflowId = nextValue(args, ++index, "--id");
      continue;
    }
    if (arg === "--revision") {
      revision = parsePositiveInteger(nextValue(args, ++index, "--revision"), "--revision");
      continue;
    }
    if (arg === "--cwd") {
      cwd = nextValue(args, ++index, "--cwd");
      continue;
    }
    if (arg === "--manifest-out") {
      manifestOut = nextValue(args, ++index, "--manifest-out");
      continue;
    }
    if (arg === "--save") {
      save = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(nextValue(args, ++index, "--timeout-ms"), "--timeout-ms");
      continue;
    }
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    throw new CliUsageError(`unknown workflow build option '${arg}'`);
  }
  if (workflowId === null) throw new CliUsageError("workflow build requires --id");
  if (revision === null) throw new CliUsageError("workflow build requires --revision");
  return { kind: "workflow-build", entry, workflowId, revision, cwd, manifestOut, save, timeoutMs, format };
}

function parseWorkflowList(args: string[]): WorkflowListCommand {
  let cwd = process.cwd();
  let format: CliFormat = "human";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--cwd") {
      cwd = nextValue(args, ++index, "--cwd");
      continue;
    }
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    throw new CliUsageError(`unknown workflow list option '${arg}'`);
  }
  return { kind: "workflow-list", cwd, format };
}

function requiredEntry(args: string[]): string {
  const entry = args.shift();
  if (entry === undefined || entry.startsWith("-")) {
    throw new CliUsageError("workflow command requires an entry .ts file");
  }
  return entry;
}

function nextValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new CliUsageError(`${option} requires a value`);
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CliUsageError(`${option} must be a positive integer`);
  return parsed;
}

function parseFormat(value: string): CliFormat {
  if (value === "human" || value === "json") return value;
  throw new CliUsageError(`format must be 'human' or 'json', got '${value}'`);
}

export const CLI_HELP = `Usage:
  refactor-subagent preflight [repo] [--format human|json]
  refactor-subagent workflow run <entry.ts> [options]
  refactor-subagent workflow build <entry.ts> --id <id> --revision <n> [options]
  refactor-subagent workflow list [--cwd <dir>] [--format human|json]

Workflow run options:
  --cwd <dir>                 Working directory for the workflow process
  --input-json <json>         JSON input passed to the workflow
  --input-file <file>         Read JSON input from a file
  --timeout-ms <n>            Maximum workflow duration (default: 60000)
  --format human|json         Output format (default: human)

Workflow build options:
  --id <id>                   Stable workflow identifier
  --revision <n>              Positive workflow revision
  --cwd <dir>                 Project working directory
  --manifest-out <path>       Save the generated manifest as JSON
  --save                      Persist source, output, and manifest under .refactorsa
  --timeout-ms <n>            Maximum workflow duration (default: 60000)
  --format human|json         Output format (default: human)

The workflow host currently provides process-level execution and source-policy
checks. Capability-based filesystem/process access is added in the next phase.`;
