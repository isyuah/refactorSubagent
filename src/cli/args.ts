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

export type CliCommand =
  | { kind: "help" }
  | PreflightCommand
  | WorkflowRunCommand;

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

function parseWorkflow(args: string[]): WorkflowRunCommand {
  const subcommand = args.shift();
  if (subcommand !== "run") {
    throw new CliUsageError("workflow requires the 'run' subcommand");
  }

  const entry = args.shift();
  if (entry === undefined || entry.startsWith("-")) {
    throw new CliUsageError("workflow run requires an entry .ts file");
  }

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
      const raw = nextValue(args, ++index, "--timeout-ms");
      timeoutMs = Number(raw);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new CliUsageError("--timeout-ms must be a positive integer");
      }
      continue;
    }
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    throw new CliUsageError(`unknown workflow option '${arg}'`);
  }

  return { kind: "workflow-run", entry, cwd, inputJson, inputFile, timeoutMs, format };
}

function nextValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${option} requires a value`);
  }
  return value;
}

function parseFormat(value: string): CliFormat {
  if (value === "human" || value === "json") return value;
  throw new CliUsageError(`format must be 'human' or 'json', got '${value}'`);
}

export const CLI_HELP = `Usage:
  refactor-subagent preflight [repo] [--format human|json]
  refactor-subagent workflow run <entry.ts> [options]

Workflow options:
  --cwd <dir>                 Working directory for the workflow process
  --input-json <json>         JSON input passed to the workflow
  --input-file <file>         Read JSON input from a file
  --timeout-ms <n>            Maximum workflow duration (default: 60000)
  --format human|json         Output format (default: human)

The workflow host currently provides process-level execution and source-policy
checks. Capability-based filesystem/process access is added in the next phase.`;
