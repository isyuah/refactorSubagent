import type { InjectionSpec } from "../runtime/inject.js";

export type CliFormat = "human" | "json";
export type CliVerbosity = "detailed" | "summary";
export type CliUi = "auto" | "tui" | "plain";
export type CliProgress = "auto" | "plain" | "off";

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

export interface TestsCommand {
  kind: "tests"; action: "prepare" | "review"; repo: string; scope: string | null; from: string | null;
  out: string | null; session: string | null; sessionRoot: string | null;
  ui: CliUi; configure: boolean; verbosity: CliVerbosity; format: CliFormat; color: boolean; noInteractive: boolean;
}
export interface RunCommand {
  ui: CliUi;
  configure: boolean;
  tests: string | null;
  verbosity: CliVerbosity;
  progress: CliProgress;
  color: boolean;
  /** Disable terminal prompts even when stdin/stderr are interactive. */
  noInteractive: boolean;
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
  /**
   * Judgement material copied into both worktrees after the candidate commit
   * and before verification: `<source>=<dest-inside-worktree>` pairs.
   */
  injections: readonly InjectionSpec[];
  /** Aborted session id to resume from its stage checkpoints (null = fresh run). */
  resume: string | null;
  /**
   * Maximum feedback repairs for one run, including attempts before --resume.
   * Continue the responsible conversation (or launch a build repair session).
   * 0 disables repairs; default 3.
   */
  autoRetry: number;
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
  | RunCommand
  | TestsCommand;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** All other run arguments have been checked before asking for the missing task. */
export class RunTaskRequiredError extends CliUsageError {
  constructor(readonly command: Omit<RunCommand, "task">) {
    super("run requires --task <text>; omit it only in an interactive terminal");
    this.name = "RunTaskRequiredError";
  }
}

export function parseCliArgs(argv: readonly string[], allowIncomplete = false): CliCommand {
  const args = [...argv];
  const command = args.shift();
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help" };
  }
  if (command === "preflight") return parsePreflight(args);
  if (command === "run") return parseRun(args, allowIncomplete);
  if (command === "tests") return parseTests(args, allowIncomplete);
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

function parseRun(args: string[], allowIncomplete: boolean): RunCommand {
  let ui: CliUi = "auto";
  let configure = false;
  let verbosity: CliVerbosity = "detailed";
  let progress: CliProgress = "auto";
  let color = true;
  let noInteractive = false;
  let repo = ".";
  let task: string | null = null;
  let tests: string | null = null;
  let session: string | null = null;
  let sessionRoot: string | null = null;
  let worktreeRoot: string | null = null;
  const injections: { source: string; dest: string }[] = [];
  let resume: string | null = null;
  let autoRetry = 3;
  let format: CliFormat = "human";
  let sawRepo = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--verbosity") {
      const value = nextValue(args, ++index, arg);
      if (value !== "detailed" && value !== "summary") throw new CliUsageError("--verbosity must be detailed or summary");
      verbosity = value;
      continue;
    }
    if (arg === "--progress") {
      const value = nextValue(args, ++index, arg);
      if (value !== "auto" && value !== "plain" && value !== "off") throw new CliUsageError("--progress must be auto, plain or off");
      progress = value;
      continue;
    }
    if (arg === "--ui") { ui = parseUi(nextValue(args, ++index, arg)); continue; }
    if (arg === "--configure") { configure = true; continue; }
    if (arg === "--no-color") { color = false; continue; }
    if (arg === "--no-interactive") { noInteractive = true; continue; }
    if (arg === "--tests") { tests = nextValue(args, ++index, arg); continue; }
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
    if (arg === "--inject") {
      const pair = nextValue(args, ++index, "--inject");
      const at = pair.indexOf("=");
      if (at <= 0 || at === pair.length - 1) {
        throw new CliUsageError(`--inject expects <source>=<dest>, got '${pair}'`);
      }
      injections.push({ source: pair.slice(0, at), dest: pair.slice(at + 1) });
      continue;
    }
    if (arg === "--resume") {
      resume = nextValue(args, ++index, "--resume");
      continue;
    }
    if (arg === "--auto-retry") {
      autoRetry = parseNonNegativeInteger(nextValue(args, ++index, "--auto-retry"), "--auto-retry");
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
  const command = { kind: "run" as const, ui, configure, tests, repo, session, sessionRoot, worktreeRoot, injections, resume, autoRetry, format, verbosity, progress, color, noInteractive };
  if (!allowIncomplete && (task === null || !task.trim())) throw new RunTaskRequiredError(command);
  return { ...command, task: task ?? "" };
}

function parseTests(args: string[], allowIncomplete: boolean): TestsCommand {
  const action = args.shift();
  if (action !== "prepare" && action !== "review") throw new CliUsageError("tests requires prepare or review");
  const result: TestsCommand = { kind: "tests", action, repo: ".", scope: null, from: null, out: null, session: null,
    sessionRoot: null, ui: "auto", configure: false, verbosity: "detailed", format: "human", color: true, noInteractive: false };
  let sawRepo = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--configure") { result.configure = true; continue; }
    if (arg === "--no-color") { result.color = false; continue; }
    if (arg === "--no-interactive") { result.noInteractive = true; continue; }
    if (arg === "--scope") { result.scope = nextValue(args, ++i, arg); continue; }
    if (arg === "--from") { result.from = nextValue(args, ++i, arg); continue; }
    if (arg === "--out") { result.out = nextValue(args, ++i, arg); continue; }
    if (arg === "--session") { result.session = nextValue(args, ++i, arg); continue; }
    if (arg === "--session-root") { result.sessionRoot = nextValue(args, ++i, arg); continue; }
    if (arg === "--format") { result.format = parseFormat(nextValue(args, ++i, arg)); continue; }
    if (arg === "--ui") {
      const ui = nextValue(args, ++i, arg);
      if (ui !== "auto" && ui !== "tui" && ui !== "plain") throw new CliUsageError("--ui must be auto, tui or plain");
      result.ui = ui; continue;
    }
    if (arg === "--verbosity") {
      const value = nextValue(args, ++i, arg);
      if (value !== "detailed" && value !== "summary") throw new CliUsageError("--verbosity must be detailed or summary");
      result.verbosity = value; continue;
    }
    if (arg.startsWith("--")) throw new CliUsageError(`unknown tests option '${arg}'`);
    if (sawRepo) throw new CliUsageError("tests accepts at most one repository path");
    result.repo = arg; sawRepo = true;
  }
  if (!allowIncomplete && action === "review" && result.from === null) throw new CliUsageError("tests review requires --from <test plan directory>");
  if (action === "prepare" && result.from !== null) throw new CliUsageError("use tests review to open --from");
  if (action === "review" && result.scope !== null) throw new CliUsageError("review uses the saved scope; change it through feedback");
  return result;
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

/** Like parsePositiveInteger but accepts 0 (e.g. --auto-retry 0 disables retrying). */
function parseNonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliUsageError(`${option} must be a non-negative integer`);
  }
  return parsed;
}

function parseFormat(value: string): CliFormat {
  if (value === "human" || value === "json") return value;
  throw new CliUsageError(`format must be 'human' or 'json', got '${value}'`);
}

export const CLI_HELP = `Test preparation:
  tests prepare <repo> --scope <behavior> [--ui auto|tui|plain] [--out <plan parent>]
  tests review <repo> --from <plan directory> [--ui auto|tui|plain]
  run <repo> --task <refactor task> --tests <plan directory>
  Tests commands also accept --session, --session-root, --verbosity, --format,
  --configure, --no-color and --no-interactive. Non-interactive preparation saves and exits.

Usage:
  refactor-subagent preflight [repo] [--format human|json]
  refactor-subagent run [repo] [--task <text>] [--session <id>] [--session-root <dir>]
                            [--worktree-root <dir>] [--inject <src>=<dest>]
                            [--resume <aborted-session-id>] [--auto-retry <max>]
                            [--format human|json] [--verbosity detailed|summary]
                            [--ui auto|tui|plain] [--configure]
                            [--progress auto|plain|off] [--no-color] [--no-interactive]
  refactor-subagent workflow run <entry.ts> [options]
  refactor-subagent workflow build <entry.ts> --id <id> --revision <n> [options]
  refactor-subagent workflow list [--cwd <dir>] [--format human|json]
  refactor-subagent config [--project | --user]
  refactor-subagent limits [repo] [--format human|json]

The run command executes the whole pipeline: host preflight facts, the
test-writer's verification strategy, the candidate worktrees, the refactor session,
then differential build + test execution and the verdict. Where each stage's
INPUT comes from is configuration (see "Stage sources" below); by default every
authoring/refactor stage is AI-driven.

Interactive terminal UI (OpenTUI; Windows and Linux):
  No arguments               Choose run, prepare tests or review a saved plan
  --ui auto                  TUI for interactive stdin/stderr; plain in CI/JSON (default)
  --ui tui                   Require the TUI; incompatible with --progress plain/off
  --ui plain                 Ordinary text, including the existing task prompt
  --configure                Review/edit complete settings before starting
Missing task/scope/plan inputs open the configuration wizard in TUI mode.
Complete arguments start directly. Wizard edits affect this launch only;
project defaults require an explicit save and show a diff before writing.
Tab/Shift+Tab moves focus; arrows select; Enter opens/activates; 1-9 switches
sections; PgUp/PgDn scrolls details; Q exits or offers cancellation.

Run display:
  --verbosity detailed       AI text, tool activity, native output and full report (default)
  --verbosity summary        Important activity and results, without AI text or native output
  --progress auto            TUI on interactive terminals; plain lines elsewhere; off for JSON (default)
  --progress plain           Plain live events on stderr, also with --format json
  --progress off             Final report only
  --no-color                 Disable colors (NO_COLOR is also respected)
Progress goes to stderr; the final human/JSON report goes to stdout.
Detailed display does not require RFR_LOG_LEVEL=trace. The durable report is
saved as artifacts/run-summary.json.

Run input:
  --task <text>              Required task; when omitted/blank, a terminal prompts
                             for the task and offers start, edit, or cancel.
  --session <id>             Optional custom name. By default a timestamp + random
                             UUID is generated for each new run (including resume).
                             Custom names must be unique and never overwrite a run.
  --no-interactive           Never prompt. Use --task in scripts and CI.
Prompts require interactive stdin AND stderr and are disabled in CI.
They go to stderr, including in JSON mode; stdout remains a single JSON report.
Ctrl+C, Ctrl+D, /cancel, or the cancel choice exits before starting a run.
Complete arguments start directly unless --configure is requested. A session id is not a resume command.

Resume (checkpoint restart):
  --resume <id>               Resume an ABORTED session from its stage
                              checkpoints instead of re-running everything.
                              Completed stages whose facts still verify on disk
                              (workflow sources, candidate branch, unchanged
                              repo HEAD) are reused; verification always re-runs.
                              --session sets the new execution id; otherwise
                              a new run id is generated.

Feedback repairs:
  --auto-retry <max>          Total repair attempts for this run (default 3).
                              Behavior mismatches and candidate code failures
                              continue the original refactor conversation.
                              Test script errors continue the original writer;
                              baseline build errors start a build repair agent.
                              Repairs retain the latest complete workflow set.
                              --resume retains attempts already spent and the
                              original conversations; it does not reset the total.
                              Stops on ACCEPTED, exhausted attempts, unchanged
                              content and failure, or an unrepairable failure.
                              0 disables automatic repairs.
                              Live status shows the round, repair owner, cause,
                              remaining attempts and what will be re-run/reused.
                              report.feedback records this invocation's rounds;
                              per-round evidence is kept in round-summary.json.

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

function parseUi(value: string): CliUi {
  if (value !== "auto" && value !== "tui" && value !== "plain") throw new CliUsageError("--ui must be auto, tui or plain");
  return value;
}
