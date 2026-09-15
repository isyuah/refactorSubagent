import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * source-policy — the host's hard boundary on workflow source.
 *
 * The host executes workflow modules, so a value import or a host global would
 * hand the model's code the real filesystem/process instead of the injected
 * capabilities. The check must be precise in BOTH directions: it may not miss
 * code that reaches a host API, and it may not reject prose that merely
 * mentions one — a comment ending `oracles, per process.` used to reject a
 * valid TestWorkflow outright (the pattern matched the full stop).
 *
 * Implementation: one lexer pass blanks comment bodies, and a second blanks
 * literal bodies too. Both keep length and line structure, so offsets and
 * reported snippets map back to the original source. Matches are then taken
 * from code alone; template interpolations `${...}` stay code, and an import
 * specifier must open at a literal position seen by the lexer (so a string
 * that merely contains `from "node:fs"` cannot trip the policy).
 */

/** Bare specifiers that expose the host outside injected capabilities. */
const FORBIDDEN_MODULES: Readonly<Record<string, true>> = {
  fs: true,
  child_process: true,
  worker_threads: true,
  net: true,
  http: true,
  https: true,
  os: true,
  process: true,
};

/** Host globals reachable without an import. `process.run` etc. are capabilities. */
const HOST_GLOBALS: readonly { readonly pattern: RegExp; readonly detail: string }[] = [
  { pattern: /(?<![\w.])process\s*\.(?!run\b|start\b|wait\b|stop\b)/, detail: "process." },
  { pattern: /(?<![\w.])Bun\s*\./, detail: "Bun." },
  { pattern: /(?<![\w.])globalThis\s*\.\s*process\b/, detail: "globalThis.process" },
  { pattern: /(?<![\w.])globalThis\s*\.\s*Bun\b/, detail: "globalThis.Bun" },
];

/** `globalThis["process"]` — the key is a literal, so it survives masking. */
const COMPUTED_HOST_GLOBAL =
  /(?<![\w.])globalThis\s*\[\s*(?<q>["'])(?<key>[^"'\n]*?)\k<q>\s*\]/gd;

const COMPUTED_KEYS: Readonly<Record<string, true>> = { process: true, Bun: true };

/** Import forms, each capturing the specifier's opening quote offset in group `q`. */
const IMPORT_FORMS: readonly { readonly pattern: RegExp; readonly as: string }[] = [
  { pattern: /(?<![\w$.])(?:from|import)\s*(?<q>["'])(?<spec>[^"'\n]+?)\k<q>/gd, as: "from" },
  { pattern: /(?<![\w$.])import\s*\(\s*(?<q>["'])(?<spec>[^"'\n]+?)\k<q>/gd, as: "import(" },
  { pattern: /(?<![\w$.])require\s*\(\s*(?<q>["'])(?<spec>[^"'\n]+?)\k<q>/gd, as: "require(" },
];

/** Characters after which a `/` opens a regex literal instead of dividing. */
const REGEX_PRECEDERS: Readonly<Record<string, true>> = {
  "": true,
  "(": true,
  ",": true,
  "=": true,
  ":": true,
  "[": true,
  "!": true,
  "&": true,
  "|": true,
  "?": true,
  "{": true,
  "}": true,
  ";": true,
  "+": true,
  "-": true,
  "*": true,
  "%": true,
  "~": true,
  "^": true,
  "<": true,
  ">": true,
};

export type WorkflowSourceRule = "host-import" | "host-global";

export interface WorkflowSourceViolation {
  readonly rule: WorkflowSourceRule;
  /** What was found, e.g. `from "node:fs"` or `process.`. */
  readonly detail: string;
  /** 1-based line of the offending code. */
  readonly line: number;
  /** 1-based column of the offending code. */
  readonly column: number;
  /** The source line as written (trimmed, truncated). */
  readonly snippet: string;
}

export interface WorkflowSourceCheck {
  readonly ok: boolean;
  readonly source: string;
  readonly reason: string | null;
  /** Set when the failure is a fixable source-policy violation. */
  readonly violation: WorkflowSourceViolation | null;
}

/**
 * A rejected workflow source. Carries the violation so the host can send the
 * offending line back to the writer instead of aborting the run.
 */
export class WorkflowPolicyError extends Error {
  constructor(
    readonly entry: string,
    readonly violation: WorkflowSourceViolation,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowPolicyError";
  }
}

export function checkWorkflowSource(entry: string): WorkflowSourceCheck {
  const absolute = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
  const source = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  if (source === null) {
    return {
      ok: false,
      source: "",
      reason: `workflow entry does not exist: ${entry}`,
      violation: null,
    };
  }
  if (!/\.(?:ts|tsx|js|jsx)$/.test(entry)) {
    return {
      ok: false,
      source,
      reason: "workflow entry must be a TypeScript or JavaScript module",
      violation: null,
    };
  }
  return checkWorkflowSourceText(source);
}

/** Policy check on an in-memory source (no file required). */
export function checkWorkflowSourceText(source: string): WorkflowSourceCheck {
  const code = maskNonCode(source, true);
  const proseFree = maskNonCode(source, false);

  const imported = findHostImport(proseFree, source);
  if (imported !== null) return reject(source, imported);
  const global = findHostGlobal(code.text, source);
  if (global !== null) return reject(source, global);
  const computed = findComputedHostGlobal(proseFree, source);
  if (computed !== null) return reject(source, computed);

  try {
    new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  } catch (error) {
    return {
      ok: false,
      source,
      reason: `workflow syntax/type-preserving transpilation failed: ${errorMessage(error)}`,
      violation: null,
    };
  }
  return { ok: true, source, reason: null, violation: null };
}

/** Throw the typed policy error for a rejected source (else a plain Error). */
export function throwWorkflowSourceError(entry: string, check: WorkflowSourceCheck): never {
  if (check.violation !== null) {
    throw new WorkflowPolicyError(entry, check.violation, check.reason ?? "workflow source rejected");
  }
  throw new Error(check.reason ?? `workflow source rejected: ${entry}`);
}

/** The comment-free source, for checks that must read string contents. */
export function stripComments(source: string): string {
  return maskNonCode(source, false).text;
}

function reject(source: string, violation: WorkflowSourceViolation): WorkflowSourceCheck {
  const where = `line ${violation.line}, column ${violation.column}: ${violation.detail}`;
  const reason =
    violation.rule === "host-import"
      ? `workflow directly imports a host API; use injected capabilities instead (${where})`
      : `workflow source accesses a host API directly; use injected capabilities instead (${where})`;
  return { ok: false, source, reason, violation };
}

/** Host modules reached through an import/require specifier. */
function findHostImport(
  scanned: MaskedSource,
  original: string,
): WorkflowSourceViolation | null {
  for (const form of IMPORT_FORMS) {
    form.pattern.lastIndex = 0;
    let match = form.pattern.exec(scanned.text);
    while (match !== null) {
      const specifier = match.groups?.spec ?? "";
      const quoteAt = match.indices?.groups?.q?.[0] ?? -1;
      // Only a specifier that opens where the lexer saw a literal is an import;
      // text inside another literal (`'from "node:fs"'`) is prose.
      if (quoteAt >= 0 && scanned.literalStarts.has(quoteAt) && isHostSpecifier(specifier)) {
        return violationAt(original, match.index, "host-import", `${form.as} "${specifier}"`);
      }
      match = form.pattern.exec(scanned.text);
    }
  }
  return null;
}

/** Host globals reached without an import (process, Bun, globalThis.*). */
function findHostGlobal(code: string, original: string): WorkflowSourceViolation | null {
  for (const entry of HOST_GLOBALS) {
    const match = entry.pattern.exec(code);
    if (match !== null) {
      return violationAt(original, match.index, "host-global", entry.detail);
    }
  }
  return null;
}

/** `globalThis["process"]`: the key must be a literal the lexer saw in code. */
function findComputedHostGlobal(
  scanned: MaskedSource,
  original: string,
): WorkflowSourceViolation | null {
  COMPUTED_HOST_GLOBAL.lastIndex = 0;
  let match = COMPUTED_HOST_GLOBAL.exec(scanned.text);
  while (match !== null) {
    const key = match.groups?.key ?? "";
    const quoteAt = match.indices?.groups?.q?.[0] ?? -1;
    if (quoteAt >= 0 && scanned.literalStarts.has(quoteAt) && COMPUTED_KEYS[key] === true) {
      return violationAt(original, match.index, "host-global", `globalThis["${key}"]`);
    }
    match = COMPUTED_HOST_GLOBAL.exec(scanned.text);
  }
  return null;
}

/** `node:fs`, `bun:path`, `fs/promises` are host modules; anything else is ours. */
function isHostSpecifier(specifier: string): boolean {
  if (/^(?:node|bun):/.test(specifier)) return true;
  const head = specifier.split("/")[0] ?? "";
  return FORBIDDEN_MODULES[head] === true;
}

function violationAt(
  source: string,
  index: number,
  rule: WorkflowSourceRule,
  detail: string,
): WorkflowSourceViolation {
  const lines = source.split("\n");
  let line = 1;
  let lineStart = 0;
  for (let at = 0; at < index; at += 1) {
    if (source[at] === "\n") {
      line += 1;
      lineStart = at + 1;
    }
  }
  const text = (lines[line - 1] ?? "").trim();
  return {
    rule,
    detail,
    line,
    column: index - lineStart + 1,
    snippet: text.length > 120 ? `${text.slice(0, 117)}...` : text,
  };
}

interface MaskedSource {
  /** Source with comment bodies (and optionally literal bodies) blanked out. */
  readonly text: string;
  /** Offsets of string/template opening quotes that start in code position. */
  readonly literalStarts: ReadonlySet<number>;
}

type MaskState =
  | { readonly kind: "code"; readonly braces: number }
  | { readonly kind: "line-comment" }
  | { readonly kind: "block-comment" }
  | { readonly kind: "string"; readonly quote: string }
  | { readonly kind: "template" }
  | { readonly kind: "regex"; readonly inClass: boolean };

/**
 * Replace comment bodies with spaces; when `hideLiterals` is set, string,
 * template and regex bodies too. Output length and line structure match the
 * input, so offsets/snippets map back to the original source.
 */
function maskNonCode(source: string, hideLiterals: boolean): MaskedSource {
  const out = source.split("");
  const literalStarts = new Set<number>();
  const hide = (index: number): void => {
    if (out[index] !== "\n") out[index] = " ";
  };
  const stack: MaskState[] = [{ kind: "code", braces: 0 }];
  let previous = "";
  let index = 0;
  while (index < source.length) {
    const state = stack[stack.length - 1]!;
    const char = source[index]!;
    switch (state.kind) {
      case "line-comment": {
        if (char === "\n") stack.pop();
        else hide(index);
        index += 1;
        break;
      }
      case "block-comment": {
        if (char === "*" && source[index + 1] === "/") {
          hide(index);
          hide(index + 1);
          index += 2;
          stack.pop();
        } else {
          hide(index);
          index += 1;
        }
        break;
      }
      case "string": {
        if (char === "\\") {
          if (hideLiterals) hide(index);
          if (hideLiterals) hide(index + 1);
          index += 2;
          break;
        }
        if (char === state.quote) {
          index += 1;
          stack.pop();
          previous = state.quote;
          break;
        }
        if (hideLiterals) hide(index);
        index += 1;
        break;
      }
      case "template": {
        if (char === "\\") {
          if (hideLiterals) hide(index);
          if (hideLiterals) hide(index + 1);
          index += 2;
          break;
        }
        if (char === "`") {
          index += 1;
          stack.pop();
          previous = "`";
          break;
        }
        if (char === "$" && source[index + 1] === "{") {
          if (hideLiterals) hide(index);
          if (hideLiterals) hide(index + 1);
          // Interpolation is code: keep matching inside it.
          stack.push({ kind: "code", braces: 0 });
          index += 2;
          break;
        }
        if (hideLiterals) hide(index);
        index += 1;
        break;
      }
      case "regex": {
        if (char === "\\") {
          if (hideLiterals) hide(index);
          if (hideLiterals) hide(index + 1);
          index += 2;
          break;
        }
        if (char === "[") {
          stack[stack.length - 1] = { kind: "regex", inClass: true };
          index += 1;
          break;
        }
        if (char === "]" && state.inClass) {
          stack[stack.length - 1] = { kind: "regex", inClass: false };
          index += 1;
          break;
        }
        if (char === "/" && !state.inClass) {
          index += 1;
          stack.pop();
          previous = "/";
          break;
        }
        if (hideLiterals) hide(index);
        index += 1;
        break;
      }
      case "code": {
        if (char === "/" && source[index + 1] === "/") {
          stack.push({ kind: "line-comment" });
          index += 2;
          break;
        }
        if (char === "/" && source[index + 1] === "*") {
          stack.push({ kind: "block-comment" });
          index += 2;
          break;
        }
        if (char === "'" || char === '"') {
          literalStarts.add(index);
          stack.push({ kind: "string", quote: char });
          index += 1;
          break;
        }
        if (char === "`") {
          literalStarts.add(index);
          stack.push({ kind: "template" });
          index += 1;
          break;
        }
        if (char === "/" && REGEX_PRECEDERS[previous] === true) {
          stack.push({ kind: "regex", inClass: false });
          index += 1;
          break;
        }
        if (char === "}") {
          // A closing brace at interpolation depth 0 ends the nested code run.
          if (state.braces === 0 && stack.length > 1) {
            stack.pop();
            index += 1;
            break;
          }
          stack[stack.length - 1] = { kind: "code", braces: state.braces - 1 };
          index += 1;
          break;
        }
        if (char === "{") {
          stack[stack.length - 1] = { kind: "code", braces: state.braces + 1 };
          index += 1;
          break;
        }
        if (!/\s/.test(char)) previous = char;
        index += 1;
        break;
      }
    }
  }
  return { text: out.join(""), literalStarts };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
