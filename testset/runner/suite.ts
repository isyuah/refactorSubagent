/**
 * Suite model: the runnable case matrix of the libuv refactor test set.
 *
 * A case says WHAT to run (driver, task, stage sources, patch) and HOW the result is evaluated
 * the result (expectation method). The runner materialises every pipeline case
 * into its own clone + session root, so cases are isolated and can run in
 * parallel.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJson } from "./util.js";

export type Subject = "judgement" | "refactor" | "writer" | "e2e" | "corpus";

/** subjects are opaque to the runner; suite.subjects documents the known ones. */
export type SubjectName = Subject | string;

export interface StageSources {
  readonly workflows?: "judgement" | { readonly mode: string } | Record<string, unknown>;
  readonly prepare?: Record<string, unknown>;
  readonly refactor?: Record<string, unknown>;
}

export interface Expectation {
  /** programme-side evaluation method; "verdict*" cases also carry attribution fields. */
  readonly method: "verdict" | "verdict+attribution" | "verdict+rubric" | "part";
  readonly state?: "ACCEPTED" | "REJECTED" | "ABORTED";
  /** declaration names that MUST appear in the mismatch list. */
  readonly failuresRequired?: readonly string[];
  /** declaration names that MUST NOT appear in the mismatch list. */
  readonly failuresForbidden?: readonly string[];
  /** exact mismatch set; unset until a calibration run froze it. */
  readonly failuresExact?: readonly string[] | null;
  /** provenance.injected must equal this list (set comparison, order-insensitive). */
  readonly injectedStages?: readonly string[];
  /** provenance.verification_authoritative must equal this. */
  readonly authoritative?: boolean;
  /** files that must exist inside the clone after the run ("{session}" is substituted). */
  readonly requireFiles?: readonly string[];
  readonly rubric?: { readonly rubric: string; readonly reference?: string };
  /** true = the expected values are inferred, not measured; reported, never hidden. */
  readonly provisional: boolean;
  readonly note?: string;
}

export interface SuiteCase {
  readonly id: string;
  readonly subject: SubjectName;
  readonly title: string;
  readonly tags: readonly string[];
  readonly kind?: "pipeline" | "upstream-part";
  /** pipeline cases: task text file, relative to the testset root. */
  readonly task?: string;
  readonly stages?: StageSources;
  readonly clone?: { readonly remove?: readonly string[]; readonly commit?: boolean };
  /** corpus cases: part definition, relative to the testset root. */
  readonly part?: string;
  readonly expect: Expectation;
  readonly limits?: Readonly<Record<string, number | null>>;
  readonly timeoutMs?: number;
  readonly repeats?: number;
}

export interface Suite {
  readonly version: number;
  readonly generatedFor: string;
  readonly baseline: { readonly repo: string; readonly branch: string; readonly commit: string; readonly note?: string };
  readonly harness: { readonly dir: string; readonly runtime: string; readonly cli: string };
  readonly presets: Readonly<Record<string, unknown>>;
  readonly subjects: Readonly<Record<string, string>>;
  readonly cases: readonly SuiteCase[];
}

export interface PartPolicy {
  readonly kind: "strict" | "calibrate";
  readonly repeats: number;
  /** "ok 1 - {case}" — {case} is substituted with the case name. */
  readonly expectTap: string;
  readonly expectExit: number;
  readonly onFail: "fail-case" | "classify";
}

export interface Part {
  readonly version: number;
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly policy: PartPolicy;
  readonly status: "pinned" | "candidate";
  readonly cases: readonly string[];
}

export interface Selection {
  readonly only: readonly string[];
  readonly exclude: readonly string[];
  readonly subjects: readonly string[];
  readonly tags: readonly string[];
  readonly filter: string | null;
}

export function loadSuite(path: string): { suite: Suite; root: string } {
  const suite = readJson<Suite>(path);
  const root = resolve(dirname(path));
  if (suite.version !== 1) throw new Error(`unsupported suite version ${String(suite.version)}`);
  for (const c of suite.cases) {
    if (c.kind === "upstream-part") {
      if (c.part === undefined) throw new Error(`case ${c.id}: upstream-part without "part"`);
      if (!existsSync(join(root, c.part))) throw new Error(`case ${c.id}: part file missing: ${c.part}`);
    } else {
      if (c.task === undefined) throw new Error(`case ${c.id}: pipeline case without "task"`);
      if (!existsSync(join(root, c.task))) throw new Error(`case ${c.id}: task file missing: ${c.task}`);
      if (c.stages === undefined) throw new Error(`case ${c.id}: pipeline case without "stages"`);
    }
  }
  return { suite, root };
}

export function loadPart(root: string, relPath: string): Part {
  return readJson<Part>(join(root, relPath));
}

export function selectCases(suite: Suite, selection: Selection): SuiteCase[] {
  const only = selection.only.length === 0 ? null : new Set(selection.only);
  return suite.cases.filter((c) => {
    if (only !== null && !only.has(c.id)) return false;
    if (selection.exclude.some((needle) => c.id.includes(needle))) return false;
    if (selection.subjects.length > 0 && !selection.subjects.includes(c.subject)) return false;
    if (selection.tags.length > 0 && !selection.tags.some((t) => c.tags.includes(t))) return false;
    if (selection.filter !== null) {
      const haystack = `${c.id} ${c.title} ${c.tags.join(" ")}`.toLowerCase();
      if (!haystack.includes(selection.filter.toLowerCase())) return false;
    }
    return true;
  });
}

/**
 * Expand the case's stage sources into a pipeline file. "judgement" is a named
 * preset from the suite header; anything else is passed through verbatim, so the
 * suite never restates what testset/pipeline/*.json already documents.
 */
export function materializePipeline(suite: Suite, c: SuiteCase): Record<string, unknown> {
  const stages: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(c.stages ?? {})) {
    if (typeof value === "string") {
      const preset = suite.presets[value];
      if (preset === undefined) throw new Error(`case ${c.id}: unknown preset '${value}'`);
      stages[key] = preset;
    } else if (value !== undefined) {
      stages[key] = value;
    }
  }
  return { version: 1, stages };
}

export interface MaterialProblem {
  readonly caseId: string;
  readonly problem: string;
}

/**
 * Fail before burning a long run: every piece of material a case names must
 * exist in the baseline — patches, preset workflow entries, corpus case names.
 */
export function verifyMaterial(suite: Suite, root: string): MaterialProblem[] {
  const problems: MaterialProblem[] = [];
  const baseline = resolve(root, suite.baseline.repo);
  const listPath = join(baseline, "test", "test-list.h");
  const known = new Set(
    existsSync(listPath)
      ? [...readFileSync(listPath, "utf8").matchAll(/TEST_DECLARE\s+\(([a-z0-9_]+)\)/g)].map((m) => m[1]!)
      : [],
  );
  if (known.size === 0) {
    problems.push({ caseId: "-", problem: `baseline checkout not usable: ${listPath} missing or has no TEST_DECLARE entries` });
  }
  for (const c of suite.cases) {
    if (c.kind === "upstream-part") {
      for (const name of loadPart(root, c.part!).cases) {
        if (known.size > 0 && !known.has(name)) problems.push({ caseId: c.id, problem: `unknown upstream case '${name}'` });
      }
      continue;
    }
    const stages = c.stages ?? {};
    const refactor = stages.refactor as { readonly patchFile?: string } | undefined;
    if (refactor?.patchFile !== undefined && !existsSync(join(baseline, refactor.patchFile))) {
      problems.push({ caseId: c.id, problem: `patch not in baseline: ${refactor.patchFile}` });
    }
    if (typeof stages.workflows === "string") {
      const preset = suite.presets[stages.workflows] as { readonly testEntry?: string } | undefined;
      if (preset === undefined) problems.push({ caseId: c.id, problem: `unknown preset '${stages.workflows}'` });
      else if (preset.testEntry !== undefined && !existsSync(join(baseline, preset.testEntry))) {
        problems.push({ caseId: c.id, problem: `preset test workflow not in baseline: ${preset.testEntry}` });
      }
    }
    for (const rel of c.clone?.remove ?? []) {
      if (!existsSync(join(baseline, rel))) problems.push({ caseId: c.id, problem: `clone preparation target not in baseline: ${rel}` });
    }
    if (c.expect.rubric !== undefined) {
      if (!existsSync(join(root, c.expect.rubric.rubric))) {
        problems.push({ caseId: c.id, problem: `rubric not found: ${c.expect.rubric.rubric}` });
      }
      const reference = c.expect.rubric.reference;
      if (reference !== undefined && !existsSync(join(root, reference))) {
        problems.push({ caseId: c.id, problem: `rubric reference not found: ${reference}` });
      }
    }
    if (c.expect.method === "verdict+rubric" && c.expect.requireFiles === undefined) {
      problems.push({ caseId: c.id, problem: "verdict+rubric case without requireFiles (no evidence the writer produced anything)" });
    }
  }
  return problems;
}
