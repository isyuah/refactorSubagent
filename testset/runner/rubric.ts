/**
 * Test-side rubric scorer (the 裁判 of the suite; not part of the harness).
 *
 * It is deliberately NOT part of the harness: it is evaluation
 * infrastructure that only exists while running the suite. It consumes the
 * artefacts a run already produced (the workflow sources the writer wrote) plus
 * a hidden reference, and returns a structured score with reasons.
 *
 * No model is invoked unless the caller passes --rubric-cmd; the runner always
 * writes rubric-prompt.md so the same rubric can be scored by hand or later.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./exec.js";
import { ensureDir } from "./util.js";

export interface RubricCriterion {
  readonly name: string;
  readonly score: number;
  readonly reason: string;
}

export interface RubricOutcome {
  readonly status: "pending" | "scored" | "failed";
  readonly score: number | null;
  readonly detail: string;
  readonly promptPath: string;
  readonly criteria: readonly RubricCriterion[];
}

export interface RubricOptions {
  readonly command: readonly string[] | null;
  readonly caseId: string;
  readonly caseDir: string;
  /** Session root the runner handed the harness (`.refactor/runs` lives here). */
  readonly sessionRoot: string;
  readonly sessionId: string;
  readonly rubricPath: string;
  readonly referencePath: string | null;
  readonly timeoutMs: number;
  /** null = advisory: the score is reported, it does not fail the case. */
  readonly minScore: number | null;
}

const PROMPT_HEADER = `# Rubric scorer — libuv refactor suite

You are scoring ONE candidate: the test/build workflows that a model wrote during a
"writer" run of the refactoring harness. Score against the rubric below and return
JSON only.

Rules:
- You are NOT scored on style. Score what the artefacts actually do.
- The reference implementation (shown under "Hidden reference") is one way to do it,
  not the only one. A different but complete solution scores full marks.
- Every criterion needs a reason, including the ones you award full marks to.
- Keep each reason under ~200 characters and on ONE line, and do not use ASCII
  double quotes inside a reason (use 「」 or single quotes): the score is parsed
  as JSON and stray quotes break it.
- Output the JSON block only, nothing after it.
- Output schema:
  {"score": 0.0-1.0, "criteria": [{"name": "...", "score": 0.0-1.0, "reason": "..."}], "summary": "..."}
`;

function listing(dir: string, limit = 4000): string {
  if (!existsSync(dir)) return "(missing)";
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, `${prefix}${entry}/`);
        continue;
      }
      out.push(`${prefix}${entry}  ${String(stat.size)}B`);
    }
  };
  walk(dir, "");
  const text = out.join("\n");
  return text.length > limit ? text.slice(0, limit) + "\n(truncated)" : text;
}

function contents(path: string, limit = 20000): string {
  if (!existsSync(path)) return `(missing: ${path})`;
  const text = readFileSync(path, "utf8");
  return text.length > limit ? text.slice(0, limit) + "\n/* (truncated) */\n" : text;
}

/** Everything the writer produced, wherever the harness persisted it. */
export function writerArtifacts(sessionRoot: string, sessionId: string): { testSource: string; buildSources: string[] } {
  // The harness persists run-local workflows under
  // `<sessionRoot>/.refactor/runs/<session>/workflows/{test,build}`.
  const workflowsRoot = join(sessionRoot, ".refactor", "runs", sessionId, "workflows");
  const testDir = join(workflowsRoot, "test");
  // Run-local build workflows live next to the test workflow (one .ts plus a
  // .description.json sidecar per entry).
  const buildDirs = [
    join(workflowsRoot, "build"),
    join(sessionRoot, ".refactorsa", "build-workflows"),
    join(sessionRoot, ".refactor", "build-workflows"),
  ];
  const buildSources: string[] = [];
  for (const dir of buildDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const candidate = join(dir, entry, "workflow.ts");
      if (existsSync(candidate)) buildSources.push(candidate);
      const direct = join(dir, entry);
      if (direct.endsWith(".ts") && statSync(direct).isFile()) buildSources.push(direct);
    }
  }
  return { testSource: join(testDir, "test-workflow.ts"), buildSources };
}

export async function runRubric(options: RubricOptions): Promise<RubricOutcome> {
  const promptPath = join(options.caseDir, "rubric-prompt.md");
  const artifacts = writerArtifacts(options.sessionRoot, options.sessionId);
  const body: string[] = [PROMPT_HEADER, "## Rubric", options.rubricPath === "" ? "(none)" : contents(options.rubricPath, 40000)];
  body.push("## Candidate: declared test workflow");
  body.push("```ts\n" + contents(artifacts.testSource) + "\n```");
  body.push("## Candidate: declared build workflow(s)");
  for (const path of artifacts.buildSources) body.push(`### ${path}\n\`\`\`ts\n${contents(path)}\n\`\`\``);
  if (artifacts.buildSources.length === 0) body.push("(none persisted)");
  if (options.referencePath !== null) {
    body.push("## Hidden reference (not visible to the candidate)");
    body.push(listing(options.referencePath));
    const entry = join(options.referencePath, "test-workflow.ts");
    if (existsSync(entry)) body.push("```ts\n" + contents(entry, 20000) + "\n```");
  }
  ensureDir(options.caseDir);
  writeFileSync(promptPath, body.join("\n\n"), "utf8");

  if (options.command === null || options.command.length === 0) {
    return {
      status: "pending",
      score: null,
      detail: `rubric prompt written (${promptPath}); pass --rubric-cmd to score automatically`,
      promptPath,
      criteria: [],
    };
  }

  // The prompt goes in on stdin: that is what `claude -p` (and most scriptable
  // model CLIs) read, and it keeps the command line free of quoting games.
  const result = await exec({
    program: options.command[0]!,
    args: [...options.command.slice(1)],
    cwd: options.caseDir,
    timeoutMs: options.timeoutMs,
    stdin: readFileSync(promptPath, "utf8"),
    // A user-supplied command line goes through the shell: on Windows the model
    // CLI is a .cmd shim, which spawn() cannot execute directly.
    shell: true,
    env: { RUBRIC_PROMPT_FILE: promptPath, RUBRIC_CASE: options.caseId },
  });
  writeFileSync(join(options.caseDir, "rubric.stdout.txt"), result.stdout, "utf8");
  writeFileSync(join(options.caseDir, "rubric.stderr.txt"), result.stderr, "utf8");
  if (result.status !== "exited" || result.exitCode !== 0) {
    return {
      status: "failed", score: null,
      detail: `rubric command failed: ${result.status} exit=${String(result.exitCode)} ` +
        `${(result.error ?? result.stderr ?? result.stdout).trim().slice(-300)}`,
      promptPath, criteria: [],
    };
  }
  const parsed = extractScoring(result.stdout);
  if (parsed === null) {
    return {
      status: "failed", score: null,
      detail: `rubric produced no parseable JSON (first 200 chars: ${result.stdout.trim().slice(0, 200)})`,
      promptPath, criteria: [],
    };
  }
  const score = typeof parsed.score === "number" ? parsed.score : null;
  if (score === null) {
    return { status: "failed", score: null, detail: "rubric JSON has no numeric score", promptPath, criteria: [] };
  }
  return {
    status: "scored",
    score,
    detail: `score ${score.toFixed(2)}${parsed.how === "json" ? "" : ` (parsed: ${parsed.how})`}` +
      (options.minScore === null ? " (advisory)" : ` (min ${options.minScore.toFixed(2)})`) +
      (parsed.summary === undefined ? "" : ` — ${parsed.summary.slice(0, 200)}`),
    promptPath,
    criteria: parsed.criteria ?? [],
  };
}

/**
 * Model output is prose + fenced JSON, and it often echoes the schema before the
 * real answer, so "slice from the first brace" is wrong. Try, in order: every
 * fenced block (last first), then every balanced object (last first), then the
 * whole text.
 */
export interface Scoring {
  readonly score: number;
  readonly criteria?: RubricCriterion[];
  readonly summary?: string;
  /** how the answer was recovered: exact JSON, repaired JSON, or salvaged fields. */
  readonly how: "json" | "repaired" | "salvaged";
}

export function extractScoring(text: string): Scoring | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const candidates = [...fences.reverse(), ...balancedObjects(text).reverse(), text];
  for (const candidate of candidates) {
    const parsed = tryParseScoring(candidate);
    if (parsed !== null) return { ...parsed, how: "json" };
    // Model JSON routinely has raw newlines or unescaped inner quotes in the
    // reason strings; repairing those recovers scores that are otherwise lost.
    const repaired = tryParseScoring(repairJson(candidate));
    if (repaired !== null) return { ...repaired, how: "repaired" };
  }
  // Last resort: the structure is broken (unbalanced braces) but the fields are
  // still readable. The score is advisory, so a salvaged read beats losing it.
  const salvaged = salvageScoring(text);
  return salvaged === null ? null : { ...salvaged, how: "salvaged" };
}

function salvageScoring(text: string): { score: number; criteria?: RubricCriterion[]; summary?: string } | null {
  const criteriaIndex = text.indexOf('"criteria"');
  const head = criteriaIndex >= 0 ? text.slice(0, criteriaIndex) : text;
  const scoreMatch = /"score"\s*:\s*(-?[0-9]*\.?[0-9]+)/.exec(head);
  if (scoreMatch === null) return null;
  const score = Number(scoreMatch[1]);
  if (!Number.isFinite(score) || score < 0 || score > 1) return null;
  const criteria: RubricCriterion[] = [];
  const pattern = /\{\s*"name"\s*:\s*"([^"]{0,200})"[\s\S]{0,80}?"score"\s*:\s*(-?[0-9]*\.?[0-9]+)\s*,\s*"reason"\s*:\s*"([\s\S]{0,400}?)"\s*\}/g;
  for (const match of text.matchAll(pattern)) {
    criteria.push({ name: match[1] ?? "", score: Number(match[2] ?? "0"), reason: match[3] ?? "" });
  }
  const summaryMatch = /"summary"\s*:\s*"([\s\S]{0,600}?)"\s*\}\s*$/.exec(text);
  return { score, criteria: criteria.length > 0 ? criteria : undefined, summary: summaryMatch?.[1] };
}

function tryParseScoring(candidate: string): { score: number; criteria?: RubricCriterion[]; summary?: string } | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  try {
    const value = JSON.parse(trimmed) as { score?: unknown; criteria?: RubricCriterion[]; summary?: string };
    if (typeof value.score === "number") return { ...value, score: value.score };
  } catch {
    /* caller tries the next candidate */
  }
  return null;
}

/** Close strings the model left open, escape stray quotes, drop trailing commas. */
export function repairJson(text: string): string {
  const nextSignificant = (from: number): string | null => {
    for (let i = from; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
      return ch;
    }
    return null;
  };
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") continue;
      if (ch === '"') {
        const next = nextSignificant(i + 1);
        if (next === null || ",:}]".includes(next)) { out += ch; inString = false; continue; }
        out += '\\"';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ",") {
      const next = nextSignificant(i + 1);
      if (next === "}" || next === "]") continue;
    }
    out += ch;
  }
  return out;
}

/** Every top-level `{...}` slice, ignoring braces inside string literals. */
function balancedObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) { found.push(text.slice(start, i + 1)); start = -1; }
      if (depth < 0) depth = 0;
    }
  }
  return found;
}
