/**
 * Suite model: discovered cases plus the shared resources they reference.
 *
 * A case is a directory under `cases/` holding `case.json` (behaviour:
 * expectations, stage sources, requirements) and `prepare.ts` (environment).
 * Shared content — workflow sources, patches, judge material, source pins —
 * lives under `resources/` and is referenced by name, so a case never restates
 * what another case already owns, and the environment a case gets can be
 * checked before anything runs.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { readJson } from "./util.js";

export type Subject = string;

const RequiresFile = z
  .object({
    tools: z.array(z.string().min(1)).default([]),
    recipe: z.string().min(1).nullish(),
  })
  .strict();

const RubricFile = z
  .object({ rubric: z.string().min(1), reference: z.string().min(1).nullish() })
  .strict();

const ExpectFile = z
  .object({
    method: z.enum(["verdict", "verdict+attribution", "verdict+rubric", "part"]),
    state: z.string().min(1).optional(),
    failuresRequired: z.array(z.string()).optional(),
    failuresForbidden: z.array(z.string()).optional(),
    failuresExact: z.array(z.string()).nullish(),
    injectedStages: z.array(z.string()).optional(),
    authoritative: z.boolean().optional(),
    provisional: z.boolean().optional(),
    note: z.string().optional(),
    requireFiles: z.array(z.string()).optional(),
    /** Injection destinations that must already hold a different file (tamper attempts). */
    replacedFiles: z.array(z.string()).optional(),
    rubric: RubricFile.optional(),
  })
  .strict();

const StageFile = z.record(z.string(), z.record(z.string(), z.unknown()));

const CaseFile = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
    tags: z.array(z.string()).default([]),
    kind: z.enum(["pipeline", "upstream-part"]).default("pipeline"),
    requires: RequiresFile.optional(),
    prepare: z.string().min(1).nullish(),
    repo: z.string().min(1).default("."),
    task: z.string().min(1).optional(),
    part: z.string().min(1).optional(),
    stages: StageFile.default({}),
    inject: z.array(z.object({ source: z.string().min(1), dest: z.string().min(1) }).strict()).default([]),
    limits: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
    timeoutMs: z.number().int().positive().optional(),
    expect: ExpectFile,
    evaluate: z.object({ command: z.string().min(1).nullish() }).strict().optional(),
  })
  .strict();

const WorkflowManifest = z
  .object({
    builds: z.array(
      z.object({
        id: z.string().min(1),
        entry: z.string().min(1),
        workflowId: z.string().min(1).optional(),
        revision: z.number().int().positive().optional(),
      }).strict(),
    ).min(1),
    testEntry: z.string().min(1),
    workflowId: z.string().min(1).optional(),
    revision: z.number().int().positive().optional(),
  })
  .strict();

export interface Requires {
  readonly tools: readonly string[];
  /** Named probe (see probe.ts) for checks a tool list cannot express. */
  readonly recipe: string | null;
}

export interface RubricSpec {
  readonly rubric: string;
  readonly reference: string | null;
}

export type Expectation = Omit<z.infer<typeof ExpectFile>, "failuresExact" | "rubric"> & {
  readonly failuresExact?: readonly string[] | null;
  readonly rubric?: RubricSpec;
};

/** Judge material copied into both worktrees before verification. */
export interface Injection {
  readonly source: string;
  readonly dest: string;
}

export interface SuiteCase {
  readonly id: string;
  readonly title: string;
  readonly subject: Subject;
  readonly tags: readonly string[];
  readonly kind: "pipeline" | "upstream-part";
  /** Absolute case directory. */
  readonly dir: string;
  /** Absolute prepare script, or null when the case needs no environment. */
  readonly prepare: string | null;
  readonly requires: Requires;
  /** Repository path inside the prepared environment directory. */
  readonly repo: string;
  /** Absolute task brief, pipeline cases only. */
  readonly taskFile: string | null;
  /** Pipeline stages with every path already resolved (absolute). */
  readonly stages: Readonly<Record<string, Record<string, unknown>>>;
  readonly inject: readonly Injection[];
  readonly limits: Readonly<Record<string, string | number | null>>;
  readonly timeoutMs: number | null;
  readonly expect: Expectation;
  readonly evaluate: { readonly command: string | null } | null;
  /** Absolute part definition, upstream-part cases only. */
  readonly part: string | null;
}

export interface Suite {
  readonly root: string;
  readonly cases: readonly SuiteCase[];
  readonly problems: readonly MaterialProblem[];
  readonly subjects: Readonly<Record<string, string>>;
}

export interface PartPolicy {
  readonly kind: "strict" | "calibrate";
  readonly repeats: number;
  readonly expectExit: number;
  readonly expectTap: string;
  readonly onFail: string;
}

export interface Part {
  readonly version: number;
  readonly id: string;
  readonly title: string;
  readonly policy: PartPolicy;
  readonly cases: readonly string[];
}

export interface Selection {
  readonly only: readonly string[];
  readonly exclude: readonly string[];
  readonly subjects: readonly string[];
  readonly tags: readonly string[];
  readonly filter: string | null;
}

export interface MaterialProblem {
  readonly caseId: string;
  readonly problem: string;
}

/** Root-relative by default; "./x" stays inside the case directory. */
function resolveResource(root: string, caseDir: string, value: string): string {
  if (isAbsolute(value)) return value;
  if (value.startsWith("./")) return resolve(caseDir, value.slice(2));
  return resolve(root, value);
}

/** Expand a case's stage block into the pipeline file's stage sources. */
function resolveStages(
  raw: z.infer<typeof StageFile>,
  root: string,
  caseDir: string,
  id: string,
  problems: MaterialProblem[],
): Record<string, Record<string, unknown>> {
  const stages: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const mode = value["mode"];
    const resource = value["resource"];
    const patchFile = value["patchFile"];
    if (key === "workflows" && mode === "preset" && typeof resource === "string") {
      const resourceDir = resolve(root, `resources/${resource}`);
      const manifestPath = join(resourceDir, "manifest.json");
      if (!existsSync(manifestPath)) {
        problems.push({ caseId: id, problem: `workflow resource not found: ${manifestPath}` });
        stages[key] = value;
        continue;
      }
      const manifest = WorkflowManifest.parse(readJson<unknown>(manifestPath));
      const builds = manifest.builds.map((build) => ({
        id: build.id,
        entry: join(resourceDir, build.entry),
        ...(build.workflowId !== undefined ? { workflowId: build.workflowId } : {}),
        ...(build.revision !== undefined ? { revision: build.revision } : {}),
      }));
      stages[key] = {
        mode: "preset",
        entryRoot: root,
        builds,
        testEntry: join(resourceDir, manifest.testEntry),
        ...(manifest.workflowId !== undefined ? { workflowId: manifest.workflowId } : {}),
        ...(manifest.revision !== undefined ? { revision: manifest.revision } : {}),
      };
      for (const entry of [manifest.testEntry, ...manifest.builds.map((build) => build.entry)]) {
        if (!existsSync(join(resourceDir, entry))) {
          problems.push({ caseId: id, problem: `workflow entry not found: ${join(resourceDir, entry)}` });
        }
      }
      continue;
    }
    if (typeof patchFile === "string" && (key === "refactor" || key === "prepare")) {
      const resolved = resolveResource(root, caseDir, patchFile);
      stages[key] = { ...value, patchFile: resolved };
      if (!existsSync(resolved)) problems.push({ caseId: id, problem: `patch not found: ${resolved}` });
      continue;
    }
    stages[key] = value;
  }
  return stages;
}

function parseCase(root: string, dir: string, problems: MaterialProblem[]): SuiteCase {
  const raw = CaseFile.parse(readJson<unknown>(join(dir, "case.json")));
  const id = raw.id ?? dir.split(/[\\/]/).slice(-1)[0]!;
  const where = `case ${id}`;

  let prepare: string | null = null;
  const prepareRel = raw.prepare === undefined ? "prepare.ts" : raw.prepare;
  if (prepareRel !== null) {
    const path = resolve(dir, prepareRel);
    if (existsSync(path)) prepare = path;
    else problems.push({ caseId: id, problem: `prepare script not found: ${path}` });
  }

  let taskFile: string | null = null;
  if (raw.kind === "pipeline") {
    const path = resolveResource(root, dir, raw.task ?? "task.txt");
    if (existsSync(path)) taskFile = path;
    else problems.push({ caseId: id, problem: `task brief not found: ${path}` });
  }

  let part: string | null = null;
  if (raw.kind === "upstream-part") {
    if (raw.part === undefined) throw new Error(`${where}: upstream-part needs 'part'`);
    part = resolveResource(root, dir, raw.part);
    if (!existsSync(part)) {
      problems.push({ caseId: id, problem: `part definition not found: ${part}` });
      part = null;
    }
  }

  const inject: Injection[] = raw.inject.map((entry) => {
    const source = resolveResource(root, dir, entry.source);
    if (!existsSync(source)) problems.push({ caseId: id, problem: `injection source not found: ${source}` });
    return { source, dest: entry.dest };
  });

  const expect = raw.expect;
  if (expect.rubric !== undefined && expect.method !== "verdict+rubric") {
    throw new Error(`${where}: expect.rubric needs method 'verdict+rubric'`);
  }

  return {
    id,
    title: raw.title ?? id,
    subject: raw.subject ?? "uncategorised",
    tags: raw.tags,
    kind: raw.kind,
    dir,
    prepare,
    requires: { tools: raw.requires?.tools ?? [], recipe: raw.requires?.recipe ?? null },
    repo: raw.repo,
    taskFile,
    stages: resolveStages(raw.stages, root, dir, id, problems),
    inject,
    limits: raw.limits,
    timeoutMs: raw.timeoutMs ?? null,
    expect: {
      ...expect,
      ...(expect.rubric !== undefined
        ? {
            rubric: {
              rubric: resolveResource(root, dir, expect.rubric.rubric),
              reference: expect.rubric.reference === undefined || expect.rubric.reference === null
                ? null
                : resolveResource(root, dir, expect.rubric.reference),
            },
          }
        : {}),
    },
    evaluate: raw.evaluate === undefined ? null : { command: raw.evaluate.command ?? null },
    part,
  };
}

/**
 * Discover the suite: every `cases/<id>/case.json` under the test set root.
 * Malformed configuration throws (a typo must not silently drop a case); a
 * missing referenced file is a material problem the caller reports before any
 * case runs.
 */
export function loadSuite(rootInput: string): { suite: Suite; root: string } {
  const root = resolve(rootInput);
  const casesRoot = join(root, "cases");
  if (!existsSync(casesRoot)) throw new Error(`test set cases directory not found: ${casesRoot}`);
  const problems: MaterialProblem[] = [];
  const cases: SuiteCase[] = [];
  for (const entry of readdirSync(casesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(casesRoot, entry.name);
    if (!existsSync(join(dir, "case.json"))) continue;
    cases.push(parseCase(root, dir, problems));
  }
  const subjectsPath = join(root, "subjects.json");
  const subjects = existsSync(subjectsPath) ? readJson<Record<string, string>>(subjectsPath) : {};
  return { suite: { root, cases, problems, subjects }, root };
}

export function loadPart(path: string): Part {
  return readJson<Part>(path);
}

export function selectCases(suite: Suite, selection: Selection): SuiteCase[] {
  return suite.cases.filter((c) => {
    if (selection.only.length > 0 && !selection.only.includes(c.id)) return false;
    if (selection.exclude.some((part) => c.id.includes(part))) return false;
    if (selection.subjects.length > 0 && !selection.subjects.includes(c.subject)) return false;
    if (selection.tags.length > 0 && !selection.tags.some((tag) => c.tags.includes(tag))) return false;
    if (selection.filter !== null) {
      const haystack = `${c.id} ${c.title} ${c.tags.join(" ")}`.toLowerCase();
      if (!haystack.includes(selection.filter.toLowerCase())) return false;
    }
    return true;
  });
}

/** Cases already carry resolved stage sources; this is the pipeline file body. */
export function materializePipeline(_suite: Suite, c: SuiteCase): Record<string, unknown> {
  return { version: 1, stages: c.stages };
}

/** Material problems collected during discovery, reported before anything runs. */
export function verifyMaterial(suite: Suite, _root: string): MaterialProblem[] {
  return [...suite.problems];
}
