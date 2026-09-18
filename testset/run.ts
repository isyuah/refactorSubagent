/**
 * Test set runner: discovery → probe → gate → prepare → execute → evaluate.
 *
 * Every case is a directory (`cases/<id>/case.json` + `prepare.ts`). The runner
 * discovers them, probes the host once, skips the ones whose `requires` this
 * host does not meet (blocked, not failed), gives each runnable case its own
 * environment directory prepared by the case's own script, then runs the
 * harness with the stage sources from `case.json`. Results are summarised like
 * they always were: one table plus summary.json.
 *
 * The runner never touches the harness checkout outside a case's environment
 * directory, and it never imports application source: it drives the harness
 * through `scripts/cli.ts`.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Term, ensureDir, fmtDuration, isTty, nowIso, readJson, timestamp, writeJson } from "./runner/util.js";
import {
  loadPart, loadSuite, materializePipeline, selectCases, verifyMaterial,
  type Part, type Selection, type Suite, type SuiteCase,
} from "./runner/suite.js";
import { describeProbe, evaluateRequirement, probeEnvironment, type ProbeReport } from "./runner/probe.js";
import { prepareEnvironment } from "./runner/env.js";
import {
  dropEnvironment, readTask, runPartCase, runPipelineCase,
  type JobContext, type PartRunResult, type PipelineRunResult,
} from "./runner/drivers.js";
import { evaluateBlocked, evaluatePart, evaluatePipeline, type CaseEvaluation } from "./runner/evaluate.js";
import { programmaticEvidence, runRubric, type RubricOutcome } from "./runner/rubric.js";
import { LiveDisplay, type Row } from "./runner/display.js";

interface Options {
  /** Test set root (holds cases/ and resources/). */
  suitePath: string;
  out: string | null;
  concurrency: number;
  list: boolean;
  dryRun: boolean;
  selfTest: boolean;
  calibrate: boolean;
  repeats: number;
  rebuild: boolean;
  /** Delete each case's environment after it finishes (default: keep it). */
  dropEnv: boolean;
  /** Treat blocked cases as failures instead of skips. */
  strictEnv: boolean;
  /** Erase a previous attempt's output directory for each selected case. */
  force: boolean;
  json: boolean;
  color: boolean;
  rubricCommand: string | null;
  rubricMin: number | null;
  partFilter: string | null;
  frozen: string | null;
  reevaluate: string | null;
  selection: Selection;
}

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage: bun testset/run.ts [options]

Selection:
  --only a,b            run exactly these case ids
  --exclude <substr>    drop case ids containing the substring (repeatable)
  --subject judgement   subjects: judgement | refactor | writer | e2e | corpus
  --tag offline         tag filter (repeatable/comma list)
  --filter <text>       free text over id/title/tags
  --part-filter <text>  corpus only: sub-case name filter

Modes:
  --list                print the discovered cases and exit
  --dry-run             print exactly what would run
  --self-test           run the scheduler against a synthetic test set

Calibration:
  --calibrate           report attribution gaps instead of failing on them
  --freeze <dir>        freeze expectations from a run directory into case.json
  --reevaluate <dir>    re-judge stored per-case results (no execution)

Execution:
  --root <dir>          test set root (default: this file's directory)
  --concurrency N       parallel cases (default cpu/4, 1..4)
  --out <dir>           result root (default runs/suite-<timestamp>)
  --repeats N           override the corpus repeat count
  --rebuild             corpus: rebuild the runner even if present
  --drop-env            delete each case's environment directory after the case
  --strict-env          blocked cases count as failures
  --force               erase a previous attempt in each selected case's output dir
  --rubric-cmd "<cmd>"  evaluation command, overrides evaluate.command in case.json
  --rubric-min <score>  fail a case below this rubric score (default: advisory)
  --json                machine-readable list/summary output
  --no-color            plain output
`;

function defaultConcurrency(): number {
  const cpu = navigator.hardwareConcurrency || 8;
  // Each case may build with -j8; keep the machine from being oversubscribed.
  return Math.max(1, Math.min(4, Math.floor(cpu / 4)));
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    suitePath: HERE,
    out: null,
    concurrency: defaultConcurrency(),
    list: false,
    dryRun: false,
    selfTest: false,
    calibrate: false,
    repeats: 0,
    rebuild: false,
    dropEnv: false,
    strictEnv: false,
    force: false,
    json: false,
    color: true,
    rubricCommand: null,
    rubricMin: null,
    partFilter: null,
    frozen: null,
    reevaluate: null,
    selection: { only: [], exclude: [], subjects: [], tags: [], filter: null },
  };
  const list = (value: string): string[] => value.split(",").map((v) => v.trim()).filter((v) => v !== "");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--root" || arg === "--suite") options.suitePath = resolve(value());
    else if (arg === "--out") options.out = resolve(value());
    else if (arg === "--concurrency") options.concurrency = Math.max(1, Number(value()));
    else if (arg === "--only") options.selection = { ...options.selection, only: list(value()) };
    else if (arg === "--exclude") options.selection = { ...options.selection, exclude: [...options.selection.exclude, value()] };
    else if (arg === "--subject") options.selection = { ...options.selection, subjects: [...options.selection.subjects, ...list(value())] };
    else if (arg === "--tag") options.selection = { ...options.selection, tags: [...options.selection.tags, ...list(value())] };
    else if (arg === "--filter") options.selection = { ...options.selection, filter: value() };
    else if (arg === "--part-filter") options.partFilter = value();
    else if (arg === "--freeze") options.frozen = resolve(value());
    else if (arg === "--reevaluate") options.reevaluate = resolve(value());
    else if (arg === "--list") options.list = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--calibrate") options.calibrate = true;
    else if (arg === "--repeats") options.repeats = Math.max(1, Number(value()));
    else if (arg === "--rebuild") options.rebuild = true;
    else if (arg === "--drop-env") options.dropEnv = true;
    else if (arg === "--strict-env") options.strictEnv = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-color") options.color = false;
    else if (arg === "--rubric-cmd") options.rubricCommand = value();
    else if (arg === "--rubric-min") options.rubricMin = Number(value());
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`unknown option '${arg}' (try --help)`);
  }
  return options;
}

interface CaseOutcome {
  readonly evaluation: CaseEvaluation;
  readonly caseDir: string;
  readonly logDir: string | null;
  readonly comparisonPath: string | null;
  readonly extra: Record<string, unknown>;
}

/** Names the runner writes into a case result directory; anything else means the directory is not ours to erase. */
const RUNNER_OUTPUTS = [
  "env", "session", "prepare.json", "pipeline.json", "part-result.json",
  "run-result.json", "harness.stdout.txt", "harness.stderr.txt",
  "rubric-prompt.md", "rubric.stdout.txt", "rubric.stderr.txt", "rubric.json",
];

/**
 * A case writes into `<out>/<case-id>/` next to its environment. Reusing a directory
 * that still holds a previous attempt would leave that attempt's judge material
 * (rubric prompt with the hidden reference, previous verdicts) inside the tree the
 * agents read while they run, so a dirty directory is an error until `--force`.
 */
function claimCaseDir(outDir: string, caseId: string, force: boolean): string | null {
  const dir = join(outDir, caseId);
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir);
  if (entries.length === 0) return null;
  const foreign = entries.filter((name) => !RUNNER_OUTPUTS.includes(name));
  if (foreign.length > 0) {
    return `${dir} holds files the runner did not write (${foreign.join(", ")}) — move them away or pick a fresh --out`;
  }
  if (!force) {
    return `${dir} still holds a previous attempt (${entries.join(", ")}) — pass --force to erase it, or pick a fresh --out; a reused directory leaks judge material into the tree the agents read`;
  }
  rmSync(dir, { recursive: true, force: true });
  return null;
}

function blockedOutcome(c: SuiteCase, caseDir: string, reason: string): CaseOutcome {
  writeJson(join(caseDir, "run-result.json"), {
    status: "blocked", reason, state: null, exitCode: null, elapsedMs: 0,
    summary: null, mismatches: [], comparisonErrors: [], envDir: null,
    logDir: null, comparisonPath: null, pipelinePath: null, error: null,
  });
  return { evaluation: evaluateBlocked(c, reason), caseDir, logDir: null, comparisonPath: null, extra: { blocked: reason } };
}

async function rubricFor(
  c: SuiteCase,
  options: Options,
  run: PipelineRunResult,
  caseDir: string,
  onPhase: (phase: string, detail?: string) => void,
): Promise<RubricOutcome | null> {
  if (c.expect.method !== "verdict+rubric") return null;
  const command = options.rubricCommand ?? c.evaluate?.command ?? null;
  onPhase("rubric", command === null ? "writing prompt (no scorer)" : `scoring with ${command}`);
  let rubric = await runRubric({
    command: command === null ? null : command.split(" ").filter((v) => v !== ""),
    caseId: c.id,
    caseDir,
    sessionRoot: run.sessionRoot,
    sessionId: run.sessionId,
    rubricPath: c.expect.rubric?.rubric ?? "",
    referencePath: c.expect.rubric?.reference ?? null,
    timeoutMs: 900_000,
    evidence: programmaticEvidence(c, run),
    minScore: options.rubricMin,
  });
  if (options.rubricMin !== null && rubric.status === "scored" && rubric.score !== null && rubric.score < options.rubricMin) {
    rubric = { ...rubric, status: "failed", detail: `${rubric.detail} — below --rubric-min` };
  }
  return rubric;
}

async function executeCase(c: SuiteCase, ctx: JobContext, options: Options): Promise<CaseOutcome> {
  const caseDir = ctx.caseDir;
  ctx.onPhase("prepare", c.prepare === null ? "(none)" : c.prepare.split(/[\\/]/).slice(-2).join("/"));
  const prepared = await prepareEnvironment(c, caseDir, {
    timeoutMs: 1_800_000,
    testRoot: ctx.testRoot,
    onOutput: () => ctx.onPhase("prepare", `${String(Math.round((Date.now() - ctx.startedAt) / 1000))}s`),
  });
  writeJson(join(caseDir, "prepare.json"), {
    status: prepared.status, reason: prepared.reason, envDir: prepared.envDir,
    repoDir: prepared.repoDir, exitCode: prepared.exitCode, elapsedMs: prepared.elapsedMs,
  });
  if (prepared.status === "blocked") return blockedOutcome(c, caseDir, prepared.reason ?? "environment not met");
  if (prepared.status !== "prepared") throw new Error(`prepare failed: ${prepared.reason ?? "unknown"}`);

  if (c.kind === "upstream-part") {
    if (c.part === null) throw new Error(`case ${c.id}: part definition missing`);
    const part: Part = loadPart(c.part);
    const run: PartRunResult = await runPartCase(ctx, c, part, options.partFilter);
    writeJson(join(caseDir, "part-result.json"), run);
    return {
      evaluation: evaluatePart(c, part, run),
      caseDir,
      logDir: null,
      comparisonPath: null,
      extra: { part: part.id, checkout: run.repoDir, status: run.status },
    };
  }

  const run = await runPipelineCase(ctx, c, readTask(c));
  writeJson(join(caseDir, "run-result.json"), {
    status: run.status,
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    summary: run.summary,
    mismatches: run.mismatches,
    comparisonErrors: run.comparisonErrors,
    envDir: run.envDir,
    logDir: run.logDir,
    comparisonPath: run.comparisonPath,
    pipelinePath: run.pipelinePath,
    harnessPhase: run.harnessPhase,
    error: run.error,
  });

  const rubric = await rubricFor(c, options, run, caseDir, (phase, detail) => ctx.onPhase(phase, detail));
  const evaluation = evaluatePipeline(c, run, { calibrate: options.calibrate }, rubric);
  if (options.dropEnv) dropEnvironment(run);
  return {
    evaluation,
    caseDir,
    logDir: run.logDir,
    comparisonPath: run.comparisonPath,
    extra: {
      pipeline: run.pipelinePath,
      env: run.envDir,
      session: run.sessionId,
      exitCode: run.exitCode,
      harnessStatus: run.status,
    },
  };
}

async function runSuite(
  suite: Suite,
  cases: readonly SuiteCase[],
  outDir: string,
  options: Options,
  term: Term,
  probe: ProbeReport,
  harnessOverride?: { readonly dir: string; readonly cli: string },
): Promise<{ rows: Row[]; outcomes: Map<string, CaseOutcome> }> {
  const display = new LiveDisplay(term, isTty() && !options.json);
  const rows: Row[] = cases.map((c) => ({
    id: c.id, subject: c.subject, status: "queued", phase: "", detail: "",
    startedAt: 0, elapsedMs: 0, evaluation: null, error: null,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const outcomes = new Map<string, CaseOutcome>();
  const drawer = setInterval(() => {
    const now = Date.now();
    for (const row of rows) {
      if (row.status === "running") row.elapsedMs = now - row.startedAt;
    }
    display.update(rows);
  }, 400);

  const harnessDir = harnessOverride?.dir ?? resolve(suite.root, "..");
  const harnessCli = harnessOverride?.cli ?? join(harnessDir, "scripts", "cli.ts");
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= cases.length) return;
      const c = cases[index]!;
      const row = byId.get(c.id)!;
      row.status = "running";
      row.startedAt = Date.now();

      const requirement = evaluateRequirement(c.requires, probe);
      if (!requirement.ok) {
        row.status = "settled";
        row.elapsedMs = 0;
        const caseDir = ensureDir(join(outDir, c.id));
        const outcome = blockedOutcome(c, caseDir, requirement.reason ?? "environment not met");
        outcomes.set(c.id, outcome);
        row.evaluation = outcome.evaluation;
        display.log(term.paint("⊘ ", "yellow") + c.id + term.paint(`  blocked: ${requirement.reason ?? ""}`, "dim"));
        continue;
      }

      const caseDir = ensureDir(join(outDir, c.id));
      display.log(term.paint(`▶ ${c.id}`, "cyan") + term.paint(`  ${c.title}`, "dim"));
      const ctx: JobContext = {
        caseDir,
        testRoot: suite.root,
        harnessDir,
        harnessCli,
        bun: process.execPath,
        repeats: options.repeats,
        rebuild: options.rebuild,
        startedAt: row.startedAt,
        onPhase: (phase, detail) => { row.phase = phase; row.detail = detail ?? ""; },
      };
      try {
        const outcome = await executeCase(c, ctx, options);
        outcomes.set(c.id, outcome);
        row.evaluation = outcome.evaluation;
        row.elapsedMs = Date.now() - row.startedAt;
        row.status = "settled";
        row.phase = ""; row.detail = "";
        const mark = outcome.evaluation.status === "failed" ? term.paint("✗ ", "red") : term.paint("✓ ", "green");
        display.log(mark + c.id + term.paint(`  ${outcome.evaluation.status} (${fmtDuration(row.elapsedMs)})`, "dim"));
      } catch (error) {
        row.status = "settled";
        row.error = error instanceof Error ? error.message : String(error);
        row.elapsedMs = Date.now() - row.startedAt;
        display.log(term.paint("✗ ", "red") + c.id + term.paint(`  ${row.error}`, "red"));
      }
    }
  };

  const workers = Array.from({ length: Math.min(options.concurrency, cases.length) }, () => worker());
  try {
    await Promise.all(workers);
  } finally {
    clearInterval(drawer);
  }
  return { rows, outcomes };
}

function summarize(
  suite: Suite,
  cases: readonly SuiteCase[],
  rows: readonly Row[],
  outcomes: Map<string, CaseOutcome>,
  probe: ProbeReport,
  startedAt: string,
): Record<string, unknown> {
  const counts = { passed: 0, failed: 0, blocked: 0, pendingRubric: 0, errored: 0 };
  const entries = cases.map((c) => {
    const row = rows.find((r) => r.id === c.id)!;
    const outcome = outcomes.get(c.id);
    if (row.error !== null) counts.errored++;
    else if (outcome?.evaluation.status === "failed") counts.failed++;
    else if (outcome?.evaluation.status === "blocked") counts.blocked++;
    else if (outcome?.evaluation.status === "pending-rubric") counts.pendingRubric++;
    else if (outcome?.evaluation.status === "passed") counts.passed++;
    return {
      id: c.id,
      subject: c.subject,
      title: c.title,
      tags: c.tags,
      status: row.error !== null ? "error" : (outcome?.evaluation.status ?? "not-run"),
      elapsedMs: row.elapsedMs,
      checks: outcome?.evaluation.checks ?? [],
      observed: outcome?.evaluation.observed ?? null,
      rubric: outcome?.evaluation.rubric ?? null,
      error: row.error,
      artifacts: {
        caseDir: outcome?.caseDir ?? null,
        logDir: outcome?.logDir ?? null,
        comparison: outcome?.comparisonPath ?? null,
        extra: outcome?.extra ?? {},
      },
    };
  });
  return {
    suite: { root: suite.root, cases: cases.length },
    probe: { host: probe.host, recipes: probe.recipes },
    startedAt,
    endedAt: nowIso(),
    counts,
    cases: entries,
  };
}

function printList(suite: Suite, cases: readonly SuiteCase[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(cases.map((c) => ({
      id: c.id, subject: c.subject, title: c.title, tags: c.tags, kind: c.kind,
      method: c.expect.method, state: c.expect.state ?? null,
      provisional: c.expect.provisional ?? false, note: c.expect.note ?? null,
      requires: c.requires,
    })), null, 2) + "\n");
    return;
  }
  let subject = "";
  for (const c of cases) {
    if (c.subject !== subject) {
      subject = c.subject;
      const description = suite.subjects[subject];
      process.stdout.write(`\n${subject}${description === undefined ? "" : ` — ${description}`}\n`);
    }
    const flags = [c.expect.provisional === true ? "provisional" : null, ...c.tags].filter((v) => v !== null).join(" ");
    process.stdout.write(`  ${Term.fit(c.id, 30)} ${Term.fit(c.expect.method, 20)} ${Term.fit(String(c.expect.state ?? "-"), 9)} ${flags}\n`);
    process.stdout.write(`  ${" ".repeat(30)} ${c.title}\n`);
  }
  process.stdout.write(`\n${String(cases.length)} case(s)\n`);
}

function printDryRun(suite: Suite, cases: readonly SuiteCase[], options: Options, outDir: string): void {
  process.stdout.write(`root      ${suite.root}\n`);
  process.stdout.write(`harness   ${resolve(suite.root, "..")}  (bun ${join(resolve(suite.root, ".."), "scripts", "cli.ts")})\n`);
  process.stdout.write(`out       ${outDir}\n`);
  process.stdout.write(`parallel  ${String(Math.min(options.concurrency, cases.length))} of ${String(cases.length)} case(s)\n`);
  if (options.dropEnv) process.stdout.write(`env       dropped after each case\n`);
  process.stdout.write("\n");
  for (const c of cases) {
    const caseDir = join(outDir, c.id);
    process.stdout.write(`▶ ${c.id}  [${c.subject}] ${c.expect.method}${c.expect.provisional === true ? "  (provisional)" : ""}\n`);
    process.stdout.write(`  requires ${c.requires.tools.join(",") || "(none)"}${c.requires.recipe === null ? "" : ` recipe=${c.requires.recipe}`}\n`);
    process.stdout.write(`  prepare  bun ${c.prepare ?? "(none)"} ${join(caseDir, "env")}\n`);
    if (c.kind === "upstream-part") {
      process.stdout.write(`  part     ${c.part ?? "(missing)"}\n\n`);
      continue;
    }
    process.stdout.write(`  repo     ${join(caseDir, "env", c.repo)}\n`);
    process.stdout.write(`  config   ${join(caseDir, "pipeline.json")}\n`);
    process.stdout.write(`           ${JSON.stringify(materializePipeline(suite, c).stages)}\n`);
    for (const injection of c.inject) {
      process.stdout.write(`  inject   ${injection.source} → <worktree>/${injection.dest}\n`);
    }
    for (const [key, value] of Object.entries(c.limits)) {
      process.stdout.write(`  limit    ${key}=${String(value)}\n`);
    }
    process.stdout.write(`  expect   state=${String(c.expect.state)} injected=[${(c.expect.injectedStages ?? []).join(",")}] requiredFailures=[${(c.expect.failuresRequired ?? []).join(",")}]\n`);
    if (c.expect.provisional === true) process.stdout.write(`  note     provisional: ${c.expect.note ?? ""}\n`);
    process.stdout.write("\n");
  }
}

/* ------------------------------------------------------------------ */
/* calibration helpers                                                 */
/* ------------------------------------------------------------------ */

function caseConfigPath(c: SuiteCase): string {
  return join(c.dir, "case.json");
}

/** Freeze expectations from a finished (or interrupted) run directory. */
function freezeExpectations(suiteRoot: string, runDir: string, term: Term): number {
  const { suite } = loadSuite(suiteRoot);
  const observed = new Map<string, { state: string | null; mismatches: string[]; blocked: boolean }>();
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const resultPath = join(runDir, entry.name, "run-result.json");
    if (!existsSync(resultPath)) continue;
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
      status?: string;
      summary: { state?: string } | null;
      mismatches?: string[];
    };
    observed.set(entry.name, {
      state: result.summary?.state ?? null,
      mismatches: result.mismatches ?? [],
      blocked: result.status === "blocked",
    });
  }
  if (observed.size === 0) {
    process.stderr.write(`no per-case run-result.json found under ${runDir}\n`);
    return 2;
  }

  let frozen = 0;
  const skipped: string[] = [];
  for (const c of suite.cases) {
    const seen = observed.get(c.id);
    if (seen === undefined || seen.blocked) continue;
    if (c.expect.state !== undefined && seen.state !== c.expect.state) {
      skipped.push(`${c.id}: state ${String(seen.state)} ≠ expected ${String(c.expect.state)}`);
      continue;
    }
    const raw = readJson<Record<string, unknown>>(caseConfigPath(c));
    const expect = (raw["expect"] ?? {}) as Record<string, unknown>;
    expect["failuresExact"] = [...seen.mismatches].sort();
    expect["provisional"] = false;
    expect["note"] = `实测冻结（${new Date().toISOString().slice(0, 10)}，${String(seen.mismatches.length)} 条失配）` +
      (typeof expect["note"] === "string" ? ` — 原预测：${expect["note"]}` : "");
    raw["expect"] = expect;
    writeJson(caseConfigPath(c), raw);
    frozen++;
    process.stdout.write(`  ${term.paint("frozen", "green")} ${c.id}  state=${String(seen.state)} failures=${String(seen.mismatches.length)}\n`);
  }
  if (skipped.length > 0) {
    process.stdout.write(term.paint("needs a human decision:", "red") + "\n");
    for (const line of skipped) process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write(`\n${String(frozen)} case(s) frozen into cases/*/case.json\n`);
  return skipped.length === 0 ? 0 : 1;
}

/** Re-judge stored results against the current case expectations. */
async function reevaluateRun(suiteRoot: string, runDir: string, term: Term, options: Options): Promise<number> {
  const { suite } = loadSuite(suiteRoot);
  const rows: Row[] = [];
  const counts = { passed: 0, failed: 0, blocked: 0, pendingRubric: 0, errored: 0 };
  for (const c of selectCases(suite, options.selection)) {
    const caseDir = join(runDir, c.id);
    const resultPath = join(caseDir, "run-result.json");
    if (!existsSync(resultPath)) continue;
    const stored = JSON.parse(readFileSync(resultPath, "utf8")) as {
      status: PipelineRunResult["status"] | "blocked";
      reason?: string;
      exitCode: number | null;
      elapsedMs: number;
      summary: PipelineRunResult["summary"];
      mismatches: string[];
      comparisonErrors: string[];
      envDir: string | null;
      logDir: string | null;
      comparisonPath: string | null;
      pipelinePath: string | null;
      error: string | null;
    };
    if (stored.status === "blocked") {
      const outcome = blockedOutcome(c, caseDir, stored.reason ?? "blocked");
      counts.blocked++;
      rows.push({ id: c.id, subject: c.subject, status: "settled", phase: "", detail: "", startedAt: 0, elapsedMs: 0, evaluation: outcome.evaluation, error: null });
      continue;
    }
    const envDir = stored.envDir !== null && existsSync(stored.envDir) ? stored.envDir : join(caseDir, "written");
    const run: PipelineRunResult = {
      status: stored.status,
      exitCode: stored.exitCode,
      elapsedMs: stored.elapsedMs,
      summary: stored.summary,
      stdoutText: "",
      stderrText: "",
      envDir,
      repoDir: join(envDir, c.repo),
      sessionRoot: join(caseDir, "session"),
      sessionId: stored.summary?.session ?? `${c.id}-s1`,
      logDir: stored.logDir,
      comparisonPath: stored.comparisonPath,
      mismatches: stored.mismatches,
      comparisonErrors: stored.comparisonErrors,
      pipelinePath: stored.pipelinePath ?? join(caseDir, "pipeline.json"),
      error: stored.error,
    };
    const evaluation = evaluatePipeline(c, run, { calibrate: options.calibrate }, null);
    if (evaluation.status === "failed") counts.failed++;
    else if (evaluation.status === "blocked") counts.blocked++;
    else if (evaluation.status === "pending-rubric") counts.pendingRubric++;
    else counts.passed++;
    rows.push({ id: c.id, subject: c.subject, status: "settled", phase: "", detail: "", startedAt: 0, elapsedMs: 0, evaluation, error: null });
  }
  const summary = { suite: { root: suite.root }, startedAt: nowIso(), endedAt: nowIso(), counts, cases: rows.map((row) => ({ id: row.id, subject: row.subject, status: row.evaluation?.status ?? "not-run", checks: row.evaluation?.checks ?? [] })) };
  writeJson(join(runDir, "summary.reevaluated.json"), summary);
  const display = new LiveDisplay(term, isTty() && !options.json);
  display.finish(rows, join(runDir, "summary.reevaluated.json"));
  return counts.failed === 0 && counts.errored === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* self-test: the scheduler against a synthetic test set               */
/* ------------------------------------------------------------------ */

const STUB_HARNESS = `
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const repo = args[1];
const sessionIndex = args.indexOf("--session");
const session = args[sessionIndex + 1];
const rootIndex = args.indexOf("--session-root");
const sessionRoot = args[rootIndex + 1];
const state = existsSync(join(repo, "state.txt")) ? readFileSync(join(repo, "state.txt"), "utf8").trim() : "ACCEPTED";
const logDir = join(sessionRoot, ".refactor", "e2e", session);
mkdirSync(join(logDir, "artifacts"), { recursive: true });
writeFileSync(join(logDir, "artifacts", "expectation-comparison-result.json"), JSON.stringify({ declarations: [], errors: [] }));
console.log(JSON.stringify({
  state, session, log_dir: logDir, comparison: "consistent", injected_stages: [], verification_authoritative: true,
  baseline_build: "pass", candidate_build: "pass", declared_builds: [],
}));
process.exit(state === "ACCEPTED" ? 0 : 1);
`;

function prepareStub(state: string | null): string {
  const lines = [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const envDir = process.argv[2];",
    'mkdirSync(join(envDir, "repo"), { recursive: true });',
  ];
  if (state !== null) lines.push(`writeFileSync(join(envDir, "repo", "state.txt"), ${JSON.stringify(state + "\n")});`);
  lines.push("");
  return lines.join("\n");
}

async function selfTest(term: Term): Promise<number> {
  const root = join(process.env["TEMP"] ?? process.env["TMP"] ?? ".", `rfr-selftest-${timestamp()}`);
  const cases: { id: string; state: string | null; requires: string[]; expectState: string }[] = [
    { id: "synth-pass", state: "ACCEPTED", requires: [], expectState: "ACCEPTED" },
    { id: "synth-fail", state: "REJECTED", requires: [], expectState: "ACCEPTED" },
    { id: "synth-blocked", state: "ACCEPTED", requires: ["definitely-not-a-tool-xyz"], expectState: "ACCEPTED" },
  ];
  for (const c of cases) {
    const dir = ensureDir(join(root, "cases", c.id));
    writeJson(join(dir, "case.json"), {
      id: c.id, title: `synthetic ${c.id}`, subject: "synthetic",
      requires: { tools: c.requires },
      prepare: "prepare.ts",
      repo: "repo",
      task: "./task.txt",
      stages: { workflows: { mode: "ai" } },
      expect: { method: "verdict", state: c.expectState },
    });
    writeFileSync(join(dir, "prepare.ts"), prepareStub(c.state), "utf8");
    writeFileSync(join(dir, "task.txt"), "synthetic task\n", "utf8");
  }
  writeFileSync(join(root, "stub-harness.ts"), STUB_HARNESS, "utf8");

  const { suite } = loadSuite(root);
  const problems = verifyMaterial(suite, root);
  if (problems.length > 0) {
    process.stderr.write(`self-test: material problems: ${JSON.stringify(problems)}\n`);
    return 1;
  }
  const outDir = join(root, "out");
  const options: Options = {
    suitePath: root, out: outDir, concurrency: 2, list: false, dryRun: false, selfTest: false,
    calibrate: false, repeats: 0, rebuild: false, dropEnv: false, strictEnv: false, force: false, json: true,
    color: false, rubricCommand: null, rubricMin: null, partFilter: null, frozen: null, reevaluate: null,
    selection: { only: [], exclude: [], subjects: [], tags: [], filter: null },
  };
  const probe = probeEnvironment(["definitely-not-a-tool-xyz"], []);
  const { rows, outcomes } = await runSuite(suite, suite.cases, outDir, options, term, probe,
    { dir: root, cli: join(root, "stub-harness.ts") });
  const summary = summarize(suite, suite.cases, rows, outcomes, probe, nowIso());
  const counts = summary["counts"] as { passed: number; failed: number; blocked: number };
  const ok = counts.passed === 1 && counts.failed === 1 && counts.blocked === 1;
  process.stdout.write(
    `self-test ${ok ? term.paint("PASS", "green") : term.paint("FAIL", "red")}: ` +
    `expected pass=1 fail=1 blocked=1, got pass=${String(counts.passed)} fail=${String(counts.failed)} blocked=${String(counts.blocked)}\n`,
  );
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const term = new Term(options.color && process.env["NO_COLOR"] === undefined);
  if (options.frozen !== null) return freezeExpectations(options.suitePath, options.frozen, term);
  if (options.reevaluate !== null) return await reevaluateRun(options.suitePath, options.reevaluate, term, options);
  if (options.selfTest) return await selfTest(term);

  const { suite } = loadSuite(options.suitePath);
  const problems = verifyMaterial(suite, suite.root);
  if (problems.length > 0) {
    process.stderr.write(term.paint(`material check failed (${String(problems.length)}):`, "red") + "\n");
    for (const problem of problems) process.stderr.write(`  ${problem.caseId}: ${problem.problem}\n`);
    return 2;
  }
  const cases = selectCases(suite, options.selection);
  if (cases.length === 0) {
    process.stderr.write("no case matches the selection (--list shows what exists)\n");
    return 2;
  }
  if (options.list) {
    printList(suite, cases, options.json);
    return 0;
  }
  const outDir = options.out ?? resolve(suite.root, "..", "runs", `suite-${timestamp()}`);
  if (options.dryRun) {
    printDryRun(suite, cases, options, outDir);
    return 0;
  }

  ensureDir(outDir);
  for (const c of cases) {
    const problem = claimCaseDir(outDir, c.id, options.force);
    if (problem !== null) {
      process.stderr.write(term.paint("stale output: ", "red") + problem + "\n");
      return 2;
    }
  }
  const tools = cases.flatMap((c) => [...c.requires.tools]);
  const recipes = cases.flatMap((c) => (c.requires.recipe === null ? [] : [c.requires.recipe]));
  const probe = probeEnvironment(tools, recipes);
  process.stdout.write(term.paint(`suite: ${String(cases.length)} case(s) from ${suite.root}`, "bold") + "\n");
  process.stdout.write(term.paint(
    `probe ${describeProbe(probe)} · concurrency ${String(Math.min(options.concurrency, cases.length))} · out ${outDir}`, "dim") + "\n\n");

  const startedAt = nowIso();
  const { rows, outcomes } = await runSuite(suite, cases, outDir, options, term, probe);
  const summary = summarize(suite, cases, rows, outcomes, probe, startedAt);
  writeJson(join(outDir, "summary.json"), summary);

  if (options.calibrate) {
    writeJson(join(outDir, "calibration.json"), {
      generatedAt: nowIso(),
      cases: cases.map((c) => {
        const observed = outcomes.get(c.id)?.evaluation.observed ?? {};
        return {
          id: c.id,
          expectedState: c.expect.state ?? null,
          expectedFailures: c.expect.failuresRequired ?? [],
          observedState: observed["state"] ?? null,
          observedFailures: observed["mismatches"] ?? [],
        };
      }),
    });
  }

  const display = new LiveDisplay(term, isTty() && !options.json);
  display.finish(rows, outDir);
  if (options.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  const counts = summary["counts"] as { passed: number; failed: number; blocked: number; errored: number };
  const failed = counts.failed + (options.strictEnv ? counts.blocked : 0);
  if (failed > 0 || counts.errored > 0) return 1;
  if (counts.passed + counts.pendingRubric + counts.blocked === 0) return 2;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`runner error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(3);
  });
