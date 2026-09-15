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
  /** null = fall back to the resolved limits (commands.processMs). */
  timeoutMs: number | null;
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
  /** null = fall back to the resolved limits (commands.processMs). */
  timeoutMs: number | null;
  format: CliFormat;
}

export interface LimitsCommand {
  kind: "limits";
  /** Repository whose .refactor/limits.json participates in the merge. */
  repo: string;
  format: CliFormat;
}

export interface WorkflowListCommand {
  kind: "workflow-list";
  cwd: string;
  format: CliFormat;
}

export interface ConfigCommand {
  kind: "config";
  /** Where to install the tool skill: project .claude/skills or user ~/.claude/skills. */
  scope: "project" | "user";
}

export interface RunCommand {
  kind: "run";
  /** Git repository containing the base C project. */
  repo: string;
  /** Natural-language refactoring task handed to the sessions. */
  task: string;
  /** Durable session id; generated when omitted. */
  session: string | null;
  /** Root of `.refactor/`; defaults to the repository itself. */
  sessionRoot: string | null;
  /**
   * Caller-owned worktree root: reuse the baseline/candidate pair across runs
   * (warm build outputs survive) instead of creating and deleting it per run.
   */
  worktreeRoot: string | null;
  format: CliFormat;
}

export type CliCommand =
  | { kind: "help" }
  | PreflightCommand
  | WorkflowRunCommand
  | WorkflowBuildCommand
  | WorkflowListCommand
  | ConfigCommand
  | LimitsCommand
  | RunCommand;

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
  if (command === "run") return parseRun(args);
  if (command === "workflow") return parseWorkflow(args);
  if (command === "config") return parseConfig(args);
  if (command === "limits") return parseLimits(args);
  throw new CliUsageError(`unknown command '${command}'`);
}

function parseConfig(args: string[]): ConfigCommand {
  let scope: ConfigCommand["scope"] = "project";
  for (const arg of args) {
    if (arg === "--user") {
      if (scope !== "project") throw new CliUsageError("config accepts only one of --project/--user");
      scope = "user";
      continue;
    }
    if (arg === "--project") {
      if (scope !== "project") throw new CliUsageError("config accepts only one of --project/--user");
      continue;
    }
    if (arg.startsWith("--")) throw new CliUsageError(`unknown config option '${arg}'`);
    throw new CliUsageError(`config accepts no positional arguments, got '${arg}'`);
  }
  return { kind: "config", scope };
}

function parseLimits(args: string[]): LimitsCommand {
  let repo = process.cwd();
  let format: CliFormat = "human";
  let sawRepo = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    if (arg.startsWith("--")) throw new CliUsageError(`unknown limits option '${arg}'`);
    if (sawRepo) throw new CliUsageError("limits accepts at most one repository path");
    repo = arg;
    sawRepo = true;
  }
  return { kind: "limits", repo, format };
}

function parseRun(args: string[]): RunCommand {
  let repo = ".";
  let task: string | null = null;
  let session: string | null = null;
  let sessionRoot: string | null = null;
  let worktreeRoot: string | null = null;
  let format: CliFormat = "human";
  let sawRepo = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--task") {
      task = nextValue(args, ++index, "--task");
      continue;
    }
    if (arg === "--session") {
      session = nextValue(args, ++index, "--session");
      continue;
    }
    if (arg === "--session-root") {
      sessionRoot = nextValue(args, ++index, "--session-root");
      continue;
    }
    if (arg === "--worktree-root") {
      worktreeRoot = nextValue(args, ++index, "--worktree-root");
      continue;
    }
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    if (arg.startsWith("--")) throw new CliUsageError(`unknown run option '${arg}'`);
    if (sawRepo) throw new CliUsageError("run accepts at most one repository path");
    repo = arg;
    sawRepo = true;
  }
  if (task === null) throw new CliUsageError("run requires --task <text>");
  return { kind: "run", repo, task, session, sessionRoot, worktreeRoot, format };
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
  let timeoutMs: number | null = null;
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
  let timeoutMs: number | null = null;
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
  refactor-subagent run [repo] --task <text> [--session <id>] [--session-root <dir>]
                            [--worktree-root <dir>]
  refactor-subagent workflow run <entry.ts> [options]
  refactor-subagent workflow build <entry.ts> --id <id> --revision <n> [options]
  refactor-subagent workflow list [--cwd <dir>] [--format human|json]
  refactor-subagent config [--project | --user]
  refactor-subagent limits [repo] [--format human|json]

The run command executes the whole pipeline: preflight and analysis on the
host, the test-writer session, the candidate worktrees, the refactor session,
then differential build + test execution and the verdict. Where each stage's
INPUT comes from is configuration (see "Stage sources" below); by default every
stage is AI-driven.

Stage sources (accepted by "run"), later wins:
  --pipeline-file <path>      Extra pipeline layer, merged in order (repeatable)
  --stage <key.path>=<value>  Override one stage source (repeatable)

Resolution order:
  built-in defaults < ~/.refactor/pipeline.json < <repo>/.refactor/pipeline.json
  < --pipeline-file < --stage

Anything not configured keeps its AI implementation. Examples:
  --stage stages.refactor.mode=ai                 back to the refactor session
  --stage stages.prepare.mode=create              fresh candidate branch

Config options:
  --project                   Install workflow-spec skill into ./claude/skills (default)
  --user                      Install workflow-spec skill into ~/.claude/skills

The config command installs the tool's workflow-spec skill (exact API/schema
for workflow generation). The skill is force-injected by the host; it cannot
be triggered manually or by the model.

Limits (timeouts and resource caps), accepted by every command:
  --limits-file <path>        Extra limits layer, merged in order (repeatable)
  --limit <key.path>=<value>  Override one limit; "null" lifts it (repeatable)

Resolution order, later wins:
  built-in defaults < ~/.refactor/limits.json < <repo>/.refactor/limits.json
  < --limits-file < --limit

Time budgets default to null (no deadline); resource caps keep their defaults.
"refactor-subagent limits" prints the effective values and their layers.
Examples:
  --limit stages.buildMs=900000 --limit stages.ctestMs=null
  --limit resources.build.maxProcesses=16

Workflow run options:
  --cwd <dir>                 Working directory for the workflow process
  --input-json <json>         JSON input passed to the workflow
  --input-file <file>         Read JSON input from a file
  --timeout-ms <n>            Maximum workflow duration (default: limits.commands.processMs)
  --format human|json         Output format (default: human)

Workflow build options:
  --id <id>                   Stable workflow identifier
  --revision <n>              Positive workflow revision
  --cwd <dir>                 Project working directory
  --manifest-out <path>       Save the generated manifest as JSON
  --save                      Persist source, output, and manifest under .refactorsa
  --timeout-ms <n>            Maximum workflow duration (default: limits.commands.processMs)
  --format human|json         Output format (default: human)

The workflow host currently provides process-level execution and source-policy
checks. Capability-based filesystem/process access is added in the next phase.`;
