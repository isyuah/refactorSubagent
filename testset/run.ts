#!/usr/bin/env bun
/**
 * Suite runner — parallel, selectable, with a live table.
 *
 *   bun testset/run.ts --list
 *   bun testset/run.ts --dry-run --subject judgement
 *   bun testset/run.ts --tag offline --concurrency 4
 *   bun testset/run.ts --only refactor-t1-strtok,refactor-t3-inet
 *   bun testset/run.ts --self-test            # validates the runner itself
 *
 * Every pipeline case gets its own clone of the pinned baseline, its own session
 * root and its own session id, so cases never share mutable state and the
 * baseline checkout in libuv/ is never touched (the harness creates its branches
 * and worktrees inside the clone).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Term, ensureDir, fmtDuration, isTty, nowIso, timestamp, writeJson } from "./runner/util.js";
import {
  loadPart, loadSuite, materializePipeline, selectCases, verifyMaterial,
  type Part, type Selection, type Suite, type SuiteCase,
} from "./runner/suite.js";
import {
  dropClone, preserveWritten, runPartCase, runPipelineCase,
  type HarnessSummary, type JobContext, type PartRunResult, type PipelineRunResult,
} from "./runner/drivers.js";
import { evaluatePart, evaluatePipeline, type CaseEvaluation } from "./runner/evaluate.js";
import { runRubric, type RubricOutcome } from "./runner/rubric.js";
import { LiveDisplay, type Row } from "./runner/display.js";

interface Options {
  suitePath: string;
  out: string | null;
  concurrency: number;
  buildCache: boolean;
  /** Overrides suite.baseline.commit (a reconstructed checkout has its own sha). */
  baselineCommit: string | null;
  /** Root of the persistent worker slots used by --build-cache. */
  cacheDir: string | null;
  list: boolean;
  dryRun: boolean;
  selfTest: boolean;
  calibrate: boolean;
  repeats: number;
  rebuild: boolean;
  keepClones: boolean;
  json: boolean;
  color: boolean;
  rubricCommand: string | null;
  /** null = the rubric score is advisory (it is reported, not enforced). */
  rubricMin: number | null;
  partFilter: string | null;
  /** freeze expectations from a finished (or interrupted) run directory. */
  freeze: string | null;
  /** re-judge stored results against the current expectations (no execution). */
  reevaluate: string | null;
  selection: Selection;
}

const HELP = `Usage: bun testset/run.ts [options]

Selection:
  --only a,b            run exactly these case ids
  --exclude <substr>    drop case ids containing the substring (repeatable)
  --subject judgement   subjects: judgement | refactor | writer | e2e | corpus (repeatable/comma list)
  --tag offline         tag filter (repeatable/comma list)
  --filter <text>       free text over id/title/tags
  --part-filter <text>  corpus only: sub-case name filter

Calibration:
  --calibrate           report attribution gaps instead of failing on them
  --freeze <dir>        freeze expectations from a run directory's per-case results,
                        then exit (no case is executed)
  --reevaluate <dir>    re-judge stored per-case results against the current
                        expectations, then exit (no case is executed)

Modes:
  --list                print the selected cases and exit
  --dry-run             print exactly what would run (clones, configs, commands)
  --self-test           run the scheduler against a synthetic suite (no real tests)

Execution:
  --concurrency N       parallel cases (default cpu/2, 2..8)
  --out <dir>           result root (default runs/suite-<timestamp>)
  --repeats N           override the corpus repeat count
  --rebuild             corpus: rebuild the runner even if present
  --keep-clones         keep the per-case clones (default: drop them, artifacts stay)
  --build-cache         reuse one persistent clone + worktree pair per worker for
                        judgement/refactor cases (warm cmake/ninja tree; ~5x faster
                        per case). writer/e2e stay isolated.
  --cache-dir <dir>     where those worker slots live, so they survive a batch
                        (default <suiteRoot>/.cache; first batch pays the cold build)
  --baseline-commit <ref>  checkout this ref instead of the pinned sha (use on a
                        checkout rebuilt from testset/baseline/overlay)
  --calibrate           report attribution gaps instead of failing on them
  --rubric-cmd "<cmd>"   score writer cases with an external rubric scorer
  --rubric-min <score>   fail a writer case below this score
                        (default: advisory only — rubric scores vary run to run)
  --json                machine-readable list/summary output
  --no-color            plain output
`;

function parseArgs(argv: readonly string[]): Options {
  const here = dirname(fileURLToPath(import.meta.url));
  const options: Options = {
    suitePath: join(here, "suite.json"),
    out: null,
    concurrency: Math.max(2, Math.min(8, Math.floor((navigator.hardwareConcurrency || 8) / 2))),
    buildCache: false,
    baselineCommit: null,
    cacheDir: null,
    list: false,
    dryRun: false,
    selfTest: false,
    calibrate: false,
    repeats: 0,
    rebuild: false,
    keepClones: false,
    json: false,
    color: true,
    rubricCommand: null,
    rubricMin: null,
    partFilter: null,
    freeze: null,
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
    if (arg === "--suite") options.suitePath = resolve(value());
    else if (arg === "--out") options.out = resolve(value());
    else if (arg === "--concurrency") options.concurrency = Math.max(1, Number(value()));
    else if (arg === "--build-cache") options.buildCache = true;
    else if (arg === "--baseline-commit") options.baselineCommit = value();
    else if (arg === "--cache-dir") options.cacheDir = value();
    else if (arg === "--only") options.selection = { ...options.selection, only: list(value()) };
    else if (arg === "--exclude") options.selection = { ...options.selection, exclude: [...options.selection.exclude, value()] };
    else if (arg === "--subject") options.selection = { ...options.selection, subjects: [...options.selection.subjects, ...list(value())] };
    else if (arg === "--tag") options.selection = { ...options.selection, tags: [...options.selection.tags, ...list(value())] };
    else if (arg === "--filter") options.selection = { ...options.selection, filter: value() };
    else if (arg === "--part-filter") options.partFilter = value();
    else if (arg === "--freeze") options.freeze = resolve(value());
    else if (arg === "--reevaluate") options.reevaluate = resolve(value());
    else if (arg === "--list") options.list = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--calibrate") options.calibrate = true;
    else if (arg === "--repeats") options.repeats = Math.max(1, Number(value()));
    else if (arg === "--rebuild") options.rebuild = true;
    else if (arg === "--keep-clones") options.keepClones = true;
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

async function executeCase(c: SuiteCase, ctx: JobContext, suite: Suite, options: Options): Promise<CaseOutcome> {
  const caseDir = ctx.caseDir;
  if (c.kind === "upstream-part") {
    const part: Part = loadPart(ctx.suiteRoot, c.part!);
    const run: PartRunResult = await runPartCase(ctx, c, part, options.partFilter);
    writeJson(join(caseDir, "part-result.json"), run);
    return {
      evaluation: evaluatePart(c, part, run),
      caseDir,
      logDir: null,
      comparisonPath: null,
      extra: { part: part.id, checkout: run.checkoutPath, status: run.status },
    };
  }

  const pipeline = materializePipeline(suite, c);
  const task = readFileSync(join(ctx.suiteRoot, c.task!), "utf8").trim();
  const run: PipelineRunResult = await runPipelineCase(ctx, c, pipeline, task);
  writeJson(join(caseDir, "run-result.json"), {
    status: run.status,
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    summary: run.summary,
    mismatches: run.mismatches,
    comparisonErrors: run.comparisonErrors,
    clonePath: run.clonePath,
    logDir: run.logDir,
    comparisonPath: run.comparisonPath,
    pipelinePath: run.pipelinePath,
    error: run.error,
  });

  let rubric = null;
  if (c.expect.method === "verdict+rubric") {
    const expectRubric = c.expect.rubric;
    rubric = await runRubric({
      command: options.rubricCommand === null ? null : options.rubricCommand.split(" ").filter((v) => v !== ""),
      caseId: c.id,
      caseDir,
      clonePath: run.clonePath,
      sessionId: run.sessionId,
      rubricPath: expectRubric === undefined ? "" : join(ctx.suiteRoot, expectRubric.rubric),
      referencePath: expectRubric?.reference === undefined ? null : join(ctx.suiteRoot, expectRubric.reference),
      timeoutMs: 900000,
      minScore: options.rubricMin,
    });
    if (options.rubricMin !== null && rubric.status === "scored" && rubric.score !== null && rubric.score < options.rubricMin) {
      rubric = { ...rubric, status: "failed" as const, detail: `${rubric.detail} — below --rubric-min` };
    }
  }

  const evaluation = evaluatePipeline(c, run, { calibrate: options.calibrate }, rubric);
  // Evidence that lives inside the clone (the workflows a writer session wrote)
  // is copied out before the clone is dropped; harness artifacts are already in
  // the case directory (the session root).
  if (ctx.slotDir !== null) {
    // The clone *is* the warm cache; copy the produced workflows out and keep it.
    const preserved = preserveWritten(run.clonePath, caseDir, run.sessionId);
    if (preserved !== null) ctx.onPhase("preserved", preserved);
  } else if (!options.keepClones) {
    const preserved = dropClone(run.clonePath, caseDir, run.sessionId);
    if (preserved !== null) ctx.onPhase("preserved", preserved);
  }
  return {
    evaluation,
    caseDir,
    logDir: run.logDir,
    comparisonPath: run.comparisonPath,
    extra: {
      pipeline: run.pipelinePath,
      clone: run.clonePath,
      session: run.sessionId,
      exitCode: run.exitCode,
      harnessStatus: run.status,
    },
  };
}

/** Bounded-concurrency scheduler over the selected cases. */
async function runSuite(
  suite: Suite,
  suiteRoot: string,
  cases: readonly SuiteCase[],
  outDir: string,
  options: Options,
  term: Term,
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

  const harnessDir = resolve(suiteRoot, suite.harness.dir);
  const baselineRepo = resolve(suiteRoot, suite.baseline.repo);
  let cursor = 0;

  const worker = async (slot: number): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= cases.length) return;
      const c = cases[index]!;
      const row = byId.get(c.id)!;
      const caseDir = ensureDir(join(outDir, c.id));
      // Only pinned-recipe cases share a worker slot: writer/e2e cases have the
      // model author the build recipe, and a warm tree would hide a broken one.
      const cacheable = options.buildCache && (c.subject === "judgement" || c.subject === "refactor");
      const slotDir = cacheable
        ? ensureDir(join(options.cacheDir ?? join(suiteRoot, ".cache"), `slot-${String(slot)}`))
        : null;
      row.status = "running";
      row.startedAt = Date.now();
      row.phase = "start";
      display.log(term.paint(`▶ ${c.id}`, "cyan") + term.paint(`  ${c.title}`, "dim"));
      const ctx: JobContext = {
        caseDir, slotDir, suiteRoot, baselineRepo, baselineCommit: suite.baseline.commit,
        harnessDir, harnessCli: resolve(harnessDir, suite.harness.cli), bun: process.execPath,
        repeats: options.repeats, rebuild: options.rebuild, keepClones: options.keepClones,
        onPhase: (phase, detail) => { row.phase = phase; row.detail = detail ?? ""; },
      };
      try {
        const outcome = await executeCase(c, ctx, suite, options);
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

  const workers = Array.from(
    { length: Math.min(options.concurrency, cases.length) },
    (_, slot) => worker(slot),
  );
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
  startedAt: string,
): Record<string, unknown> {
  const counts = { passed: 0, failed: 0, pendingRubric: 0, errored: 0 };
  const entries = cases.map((c) => {
    const row = rows.find((r) => r.id === c.id)!;
    const outcome = outcomes.get(c.id);
    if (row.error !== null) counts.errored++;
    else if (outcome?.evaluation.status === "failed") counts.failed++;
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
    suite: { version: suite.version, baselineCommit: suite.baseline.commit, for: suite.generatedFor },
    startedAt,
    endedAt: nowIso(),
    counts,
    cases: entries,
  };
}

function printList(cases: readonly SuiteCase[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(cases.map((c) => ({
      id: c.id, subject: c.subject, title: c.title, tags: c.tags,
      method: c.expect.method, state: c.expect.state ?? null,
      provisional: c.expect.provisional, note: c.expect.note ?? null,
    })), null, 2) + "\n");
    return;
  }
  let subject = "";
  for (const c of cases) {
    if (c.subject !== subject) {
      subject = c.subject;
      process.stdout.write(`\n${subject}\n`);
    }
    const flags = [c.expect.provisional ? "provisional" : null, ...c.tags].filter((v) => v !== null).join(" ");
    process.stdout.write(`  ${Term.fit(c.id, 28)} ${Term.fit(c.expect.method, 20)} ${Term.fit(String(c.expect.state ?? "-"), 9)} ${flags}\n`);
    process.stdout.write(`  ${" ".repeat(28)} ${c.title}\n`);
  }
  process.stdout.write(`\n${String(cases.length)} case(s)\n`);
}

function printDryRun(suite: Suite, suiteRoot: string, cases: readonly SuiteCase[], options: Options, outDir: string): void {
  const harnessDir = resolve(suiteRoot, suite.harness.dir);
  process.stdout.write(`baseline  ${resolve(suiteRoot, suite.baseline.repo)} @ ${suite.baseline.commit}\n`);
  process.stdout.write(`harness   ${harnessDir}  (bun ${resolve(harnessDir, suite.harness.cli)})\n`);
  process.stdout.write(`out       ${outDir}\n`);
  process.stdout.write(`parallel  ${String(Math.min(options.concurrency, cases.length))} of ${String(cases.length)} case(s)\n\n`);
  for (const c of cases) {
    const caseDir = join(outDir, c.id);
    process.stdout.write(`▶ ${c.id}  [${c.subject}] ${c.expect.method}\n`);
    process.stdout.write(`  cwd     ${caseDir}\n`);
    if (c.kind === "upstream-part") {
      const part = loadPart(suiteRoot, c.part!);
      process.stdout.write(`  corpus  git clone ${suite.baseline.repo} ${join(caseDir, "corpus")} --no-checkout → checkout --detach ${suite.baseline.commit.slice(0, 8)}\n`);
      process.stdout.write(`  build   cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=ON\n`);
      process.stdout.write(`          cmake --build build --target uv_run_tests_a -j 8\n`);
      process.stdout.write(`  cases   ${String(part.cases.length)} case(s) × ${String(options.repeats > 0 ? options.repeats : part.policy.repeats)} repeat(s), policy=${part.policy.kind}\n`);
      process.stdout.write(`  expect  ${part.policy.kind === "strict" ? "every case exit 0 + expected TAP" : "classify stable-ok / stable-fail / flaky"}\n\n`);
      continue;
    }
    const pipelinePath = join(caseDir, "pipeline.json");
    process.stdout.write(`  repo    git clone ${suite.baseline.repo} ${join(caseDir, "repo")} --no-checkout → checkout --detach ${suite.baseline.commit.slice(0, 8)}\n`);
    for (const rel of c.clone?.remove ?? []) process.stdout.write(`  hide    ${rel}\n`);
    process.stdout.write(`  config  ${pipelinePath}\n`);
    process.stdout.write(`          ${JSON.stringify(materializePipeline(suite, c).stages)}\n`);
    process.stdout.write(`  task    ${c.task} (${String(readFileSync(join(suiteRoot, c.task!), "utf8").trim().length)} chars)\n`);
    process.stdout.write(`  run     bun ${suite.harness.cli} run <clone> --session ${c.id}-s1 --session-root ${caseDir} --pipeline-file ${pipelinePath} --format json\n`);
    for (const [key, value] of Object.entries(c.limits ?? {})) {
      process.stdout.write(`          --limit ${key}=${String(value)}\n`);
    }
    process.stdout.write(`  expect  state=${String(c.expect.state)} injected=[${(c.expect.injectedStages ?? []).join(",")}] requiredFailures=[${(c.expect.failuresRequired ?? []).join(",")}]\n`);
    if (c.expect.provisional) process.stdout.write(`  note    provisional: ${c.expect.note ?? ""}\n`);
    process.stdout.write("\n");
  }
}


/**
 * Freeze expectations from a run directory.
 *
 * Reads `<dir>/<case>/run-result.json` (per-case results survive an interrupted
 * batch, a summary.json does not) and turns the observed mismatch set into the
 * case's frozen `failuresExact`, clears `provisional` and rewrites the note.
 * A case whose observed state differs from the expected state is reported and
 * left untouched: that is a finding about the expectation, not a mechanical fix.
 */
function freezeExpectations(suitePath: string, runDir: string, term: Term): number {
  const { suite } = loadSuite(suitePath);
  const perCase = new Map<string, { state: string | null; mismatches: string[]; exitCode: number | null }>();
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const resultPath = join(runDir, entry.name, "run-result.json");
    if (!existsSync(resultPath)) continue;
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
      exitCode: number | null;
      summary: { state?: string } | null;
      mismatches: string[];
    };
    perCase.set(entry.name, {
      state: result.summary?.state ?? null,
      mismatches: result.mismatches ?? [],
      exitCode: result.exitCode,
    });
  }
  if (perCase.size === 0) {
    process.stderr.write(`no per-case run-result.json found under ${runDir}\n`);
    return 2;
  }

  let frozen = 0;
  const skipped: string[] = [];
  const cases = suite.cases.map((c) => {
    const observed = perCase.get(c.id);
    if (observed === undefined) return c;
    if (c.expect.state !== undefined && observed.state !== c.expect.state) {
      skipped.push(`${c.id}: state ${String(observed.state)} ≠ expected ${String(c.expect.state)}`);
      return c;
    }
    frozen++;
    const set = [...observed.mismatches].sort();
    return {
      ...c,
      expect: {
        ...c.expect,
        failuresExact: set,
        provisional: false,
        note: `实测冻结（${new Date().toISOString().slice(0, 10)}，${observed.mismatches.length} 条失配）` +
          (c.expect.note === undefined ? "" : ` — 原预测：${c.expect.note}`),
      },
    };
  });
  writeJson(suitePath, { ...suite, cases });
  for (const c of cases) {
    const observed = perCase.get(c.id);
    if (observed === undefined) continue;
    const mark = observed.state === c.expect.state ? term.paint("frozen", "green") : term.paint("CHECK", "red");
    process.stdout.write(`  ${mark} ${c.id}  state=${String(observed.state)} failures=${String((c.expect.failuresExact ?? []).length)}\n`);
  }
  if (skipped.length > 0) {
    process.stdout.write(term.paint("needs a human decision:", "red") + "\n");
    for (const line of skipped) process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write(`\n${String(frozen)} case(s) frozen into ${suitePath}\n`);
  return skipped.length === 0 ? 0 : 1;
}


/** Set by the re-judge path: relocates file checks to the preserved copy. */
let layoutOverride: { prefix: string; replacement: string } | null = null;

/**
 * Re-judge a finished run directory against the CURRENT suite expectations.
 *
 * Stored `run-result.json` files carry everything the evaluator needs except the
 * clone; checks that need it (requireFiles) fall back to the preserved
 * `<case>/written/**` tree. Use this after correcting an expectation instead of
 * paying for the runs again — results are written to `summary.reevaluated.json`
 * so the original evidence is never overwritten.
 */
async function reevaluateRun(suitePath: string, runDir: string, term: Term, options: Options): Promise<number> {
  const { suite } = loadSuite(suitePath);
  const rows: Row[] = [];
  const counts = { passed: 0, failed: 0, pendingRubric: 0, unverifiable: 0 };
  // The same selection flags as a real run, so a re-judge can target a subset.
  for (const c of selectCases(suite, options.selection)) {
    const caseDir = join(runDir, c.id);
    layoutOverride = null;
    const resultPath = join(caseDir, "run-result.json");
    if (!existsSync(resultPath)) continue;
    const stored = JSON.parse(readFileSync(resultPath, "utf8")) as {
      status: PipelineRunResult["status"];
      exitCode: number | null;
      elapsedMs: number;
      summary: HarnessSummary | null;
      mismatches: string[];
      comparisonErrors: string[];
      clonePath: string;
      logDir: string | null;
      comparisonPath: string | null;
      pipelinePath: string;
      error: string | null;
    };
    const sessionId = stored.summary?.session ?? `${c.id}-s1`;
    // The clone is dropped after a run; point file checks at the preserved copy.
    const clonePath = existsSync(stored.clonePath)
      ? stored.clonePath
      : join(caseDir, "written").replace("\\", "\\");
    // A preserved copy strips the leading `.refactor/runs/`, so file checks that
    // target the writer's output resolve there instead of the (dropped) clone.
    const preserved = !existsSync(stored.clonePath);
    if (preserved && c.expect.requireFiles !== undefined) {
      layoutOverride = {
        // Strip only the `.refactor/runs/` prefix: the `{session}` placeholder
        // stays in place so the evaluator substitutes it into `written/<session>/`.
        prefix: ".refactor/runs/",
        replacement: "",
      };
    }
    const run: PipelineRunResult = {
      status: stored.status,
      exitCode: stored.exitCode,
      elapsedMs: stored.elapsedMs,
      summary: stored.summary,
      stdoutText: stored.summary === null ? "" : JSON.stringify(stored.summary),
      stderrText: "",
      clonePath,
      sessionId,
      logDir: stored.logDir,
      comparisonPath: stored.comparisonPath,
      mismatches: stored.mismatches,
      comparisonErrors: stored.comparisonErrors,
      pipelinePath: stored.pipelinePath,
      error: stored.error,
    };
    let rubric: RubricOutcome | null = null;
    if (c.expect.method === "verdict+rubric") {
      const expectRubric = c.expect.rubric;
      rubric = await runRubric({
        command: options.rubricCommand === null ? null : options.rubricCommand.split(" ").filter((v) => v !== ""),
        caseId: c.id,
        caseDir,
        clonePath,
        sessionId,
        rubricPath: expectRubric === undefined ? "" : join(dirname(suitePath), expectRubric.rubric),
        referencePath: expectRubric?.reference === undefined ? null : join(dirname(suitePath), expectRubric.reference),
        timeoutMs: 900000,
        minScore: options.rubricMin,
      });
      if (options.rubricMin !== null && rubric.status === "scored" && rubric.score !== null && rubric.score < options.rubricMin) {
        rubric = { ...rubric, status: "failed" as const, detail: `${rubric.detail} — below --rubric-min` };
      }
      writeJson(join(caseDir, "rubric.reevaluated.json"), rubric);
    }
    const forEval: SuiteCase = layoutOverride === null || c.expect.requireFiles === undefined ? c : {
      ...c,
      expect: {
        ...c.expect,
        requireFiles: c.expect.requireFiles.map((rel) =>
          rel.startsWith(layoutOverride!.prefix) ? layoutOverride!.replacement + rel.slice(layoutOverride!.prefix.length) : rel),
      },
    };
    const evaluation = evaluatePipeline(forEval, run, { calibrate: false }, rubric);
    if (evaluation.status === "passed") counts.passed++;
    else if (evaluation.status === "pending-rubric") counts.pendingRubric++;
    else counts.failed++;
    rows.push({
      id: c.id, subject: c.subject, status: "settled", phase: "", detail: "",
      startedAt: 0, elapsedMs: stored.elapsedMs, evaluation, error: stored.error,
    });
  }
  if (rows.length === 0) {
    process.stderr.write(`no per-case run-result.json found under ${runDir}\n`);
    return 2;
  }
  const display = new LiveDisplay(term, isTty() && !options_jsonOutput());
  display.finish(rows, runDir);
  writeJson(join(runDir, "summary.reevaluated.json"), {
    reevaluatedAt: nowIso(),
    suite: suitePath,
    counts,
    cases: rows.map((r) => ({ id: r.id, status: r.evaluation?.status ?? null, checks: r.evaluation?.checks ?? [] })),
  });
  process.stdout.write(`${String(rows.length)} case(s) re-judged; ${String(counts.passed)} pass / ${String(counts.failed)} fail\n`);
  return counts.failed === 0 ? 0 : 1;
}

function options_jsonOutput(): boolean {
  return process.argv.includes("--json");
}

/* ------------------------------------------------------------------ */
/* self-test: the runner's own scheduler, evaluators and display       */
/* ------------------------------------------------------------------ */

async function selfTest(options: Options, term: Term): Promise<number> {
  const stubSuite: Suite = {
    version: 1,
    generatedFor: "runner self-test (synthetic)",
    baseline: { repo: ".", branch: "-", commit: "0000000" },
    harness: { dir: ".", runtime: "bun", cli: "none" },
    presets: {},
    subjects: { stub: "synthetic cases" },
    cases: [
      { id: "stub-accept", subject: "judgement", title: "synthetic ACCEPTED", tags: ["stub"], kind: "pipeline", task: "x", stages: {}, expect: { method: "verdict", state: "ACCEPTED", provisional: false } },
      { id: "stub-attribution", subject: "judgement", title: "synthetic REJECTED + attribution match", tags: ["stub"], kind: "pipeline", task: "x", stages: {}, expect: { method: "verdict+attribution", state: "REJECTED", failuresRequired: ["oracle_x.exit"], provisional: false } },
      { id: "stub-attribution-miss", subject: "judgement", title: "synthetic attribution mismatch (must fail)", tags: ["stub"], kind: "pipeline", task: "x", stages: {}, expect: { method: "verdict+attribution", state: "REJECTED", failuresRequired: ["oracle_never_fails.exit"], provisional: false } },
      { id: "stub-timeout", subject: "refactor", title: "synthetic timeout (must fail)", tags: ["stub"], kind: "pipeline", task: "x", stages: {}, expect: { method: "verdict", state: "ACCEPTED", provisional: false } },
    ],
  };
  const outDir = ensureDir(options.out ?? resolve(dirname(options.suitePath), "..", "runs", `selftest-${timestamp()}`));
  const display = new LiveDisplay(term, isTty() && !options.json);
  const rows: Row[] = stubSuite.cases.map((c) => ({
    id: c.id, subject: c.subject, status: "queued", phase: "", detail: "",
    startedAt: 0, elapsedMs: 0, evaluation: null, error: null,
  }));
  const outcomes = new Map<string, CaseOutcome>();
  display.log(term.paint("runner self-test — synthetic cases, no project is touched", "magenta"));

  const fake = (id: string): PipelineRunResult => {
    const rejected = id === "stub-attribution" || id === "stub-attribution-miss";
    const timedOut = id === "stub-timeout";
    const state = rejected ? "REJECTED" : "ACCEPTED";
    return {
      status: timedOut ? "timeout" : "exited",
      exitCode: timedOut ? null : rejected ? 1 : 0,
      elapsedMs: 5,
      summary: timedOut ? null : {
        state, session: `${id}-s1`, log_dir: join(outDir, id, "log"), pipeline: "stub",
        injected_stages: ["workflows", "refactor"], verification_authoritative: true,
        declared_builds: ["stub"], baseline_build: "pass", candidate_build: "pass",
        comparison: rejected ? "inconsistent" : "consistent", refactor_summary: "",
      },
      stdoutText: JSON.stringify({ state }),
      stderrText: timedOut ? "simulated timeout" : "",
      clonePath: join(outDir, id, "repo"),
      sessionId: `${id}-s1`,
      logDir: join(outDir, id, "log"),
      comparisonPath: null,
      mismatches: id === "stub-attribution" ? ["oracle_x.exit", "oracle_x.summary"]
        : rejected ? ["oracle_other.exit"] : [],
      comparisonErrors: [],
      pipelinePath: join(outDir, id, "pipeline.json"),
      error: timedOut ? "timed out after 5 ms" : null,
    };
  };

  await Promise.all(stubSuite.cases.map(async (c, index) => {
    const row = rows[index]!;
    row.status = "running";
    row.startedAt = Date.now();
    row.phase = "synthetic";
    await new Promise((r) => setTimeout(r, 60 + index * 40));
    const run = fake(c.id);
    const evaluation = evaluatePipeline(c, run, { calibrate: options.calibrate }, null);
    row.evaluation = evaluation;
    row.elapsedMs = Date.now() - row.startedAt;
    row.status = "settled";
    outcomes.set(c.id, { evaluation, caseDir: join(outDir, c.id), logDir: run.logDir, comparisonPath: null, extra: {} });
    display.update(rows);
  }));

  display.finish(rows, outDir);
  const summary = summarize(stubSuite, stubSuite.cases, rows, outcomes, nowIso());
  writeJson(join(outDir, "summary.json"), summary);
  const counts = summary["counts"] as { passed: number; failed: number };
  const expected = { passed: 2, failed: 2 };
  const ok = counts.passed === expected.passed && counts.failed === expected.failed;
  process.stdout.write(`self-test ${ok ? term.paint("PASS", "green") : term.paint("FAIL", "red")}: expected pass=${String(expected.passed)} fail=${String(expected.failed)}, got pass=${String(counts.passed)} fail=${String(counts.failed)}\n`);
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const term = new Term(options.color && process.env["NO_COLOR"] === undefined);
  if (options.freeze !== null) return freezeExpectations(options.suitePath, options.freeze, term);
  if (options.reevaluate !== null) return await reevaluateRun(options.suitePath, options.reevaluate, term, options);
  if (options.selfTest) return await selfTest(options, term);

  const { suite: loadedSuite, root } = loadSuite(options.suitePath);
  // A checkout rebuilt from testset/baseline/overlay has its own commit sha;
  // --baseline-commit lets it stand in for the pinned one.
  const suite = options.baselineCommit === null
    ? loadedSuite
    : { ...loadedSuite, baseline: { ...loadedSuite.baseline, commit: options.baselineCommit } };
  const problems = verifyMaterial(suite, root);
  if (problems.length > 0) {
    process.stderr.write(term.paint(`material check failed (${String(problems.length)}):`, "red") + "\n");
    for (const p of problems) process.stderr.write(`  ${p.caseId}: ${p.problem}\n`);
    return 2;
  }
  const cases = selectCases(suite, options.selection);
  if (cases.length === 0) {
    process.stderr.write("no case matches the selection (--list shows what exists)\n");
    return 2;
  }
  if (options.list) {
    printList(cases, options.json);
    return 0;
  }
  const outDir = options.out ?? resolve(root, "..", "runs", `suite-${timestamp()}`);
  if (options.dryRun) {
    printDryRun(suite, root, cases, options, outDir);
    return 0;
  }

  ensureDir(outDir);
  process.stdout.write(term.paint(`suite: ${String(cases.length)} case(s) from ${options.suitePath}`, "bold") + "\n");
  process.stdout.write(term.paint(
    `baseline ${suite.baseline.commit.slice(0, 12)} · concurrency ${String(Math.min(options.concurrency, cases.length))} · out ${outDir}`, "dim") + "\n\n");

  const startedAt = nowIso();
  const { rows, outcomes } = await runSuite(suite, root, cases, outDir, options, term);
  const summary = summarize(suite, cases, rows, outcomes, startedAt);
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
          partCases: observed["cases"] ?? null,
        };
      }),
    });
  }

  const display = new LiveDisplay(term, isTty() && !options.json);
  display.finish(rows, outDir);
  if (options.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  const counts = summary["counts"] as { passed: number; failed: number; pendingRubric: number; errored: number };
  return counts.failed === 0 && counts.errored === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`runner error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(3);
  });
