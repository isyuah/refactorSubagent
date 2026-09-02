import type { ExpectationDeclaration, ExpectationRelation } from "./types.js";

/**
 * Compare baseline vs candidate expectation declarations by position.
 *
 * The workflow runs twice (once per worktree) and declares expectations in
 * the same order both times. The host pairs declarations by index and applies
 * the relation semantics:
 *
 *   equal            → baseline.value === candidate.value
 *   not-equal        → baseline.value !== candidate.value
 *   baseline-greater → baseline.value > candidate.value
 *   baseline-less    → baseline.value < candidate.value
 *   both-matches     → both values match the declaration's pattern
 *
 * Positional pairing requires the workflow to declare expectations in a
 * deterministic order with the same count on both sides. The generator
 * prompt instructs the model accordingly.
 */
export interface ExpectationComparisonOutcome {
  readonly overall: "consistent" | "inconsistent";
  /** Declarations whose relation held on both sides. */
  readonly matched: ReadonlyArray<{
    readonly declaration: ExpectationDeclaration;
    readonly baselineValue: unknown;
    readonly candidateValue: unknown;
  }>;
  /** Declarations whose relation did not hold (with reason). */
  readonly mismatched: ReadonlyArray<{
    readonly declaration: ExpectationDeclaration;
    readonly baselineValue: unknown;
    readonly candidateValue: unknown;
    readonly reason: string;
  }>;
  /** Structural problems: count mismatch, missing pattern, … */
  readonly errors: string[];
}

export function compareExpectations(
  baseline: readonly ExpectationDeclaration[],
  candidate: readonly ExpectationDeclaration[],
): ExpectationComparisonOutcome {
  const matched: ExpectationComparisonOutcome["matched"] = [];
  const mismatched: ExpectationComparisonOutcome["mismatched"] = [];
  const errors: string[] = [];
  // Local mutable accumulation then freeze at return.
  const matchedMutable: Array<(typeof matched)[number]> = [];
  const mismatchedMutable: Array<(typeof mismatched)[number]> = [];
  const matchedRef = matchedMutable;
  const mismatchedRef = mismatchedMutable;

  if (baseline.length !== candidate.length) {
    errors.push(
      `expectation count mismatch: baseline declared ${String(baseline.length)}, candidate declared ${String(candidate.length)}`,
    );
    // Compare what pairs up; the rest are structural errors.
  }

  const paired = Math.min(baseline.length, candidate.length);
  for (let i = 0; i < paired; i++) {
    const b = baseline[i]!;
    const c = candidate[i]!;
    if (b.name !== c.name) {
      errors.push(`expectation name mismatch at index ${i}: baseline '${b.name}' vs candidate '${c.name}'`);
      continue;
    }
    if (b.relation !== c.relation) {
      errors.push(`expectation relation mismatch at index ${i} ('${b.name}'): baseline '${b.relation}' vs candidate '${c.relation}'`);
      continue;
    }
    const check = evaluateRelation(b, c);
    const entry = {
      declaration: b,
      baselineValue: b.value,
      candidateValue: c.value,
    };
    if (check.ok) {
      matchedRef.push(entry);
    } else {
      mismatchedRef.push({ ...entry, reason: check.reason });
    }
  }

  return {
    overall: errors.length > 0 || mismatchedRef.length > 0 ? "inconsistent" : "consistent",
    matched: matchedRef,
    mismatched: mismatchedRef,
    errors,
  };
}

function evaluateRelation(
  baseline: ExpectationDeclaration,
  candidate: ExpectationDeclaration,
): { ok: true } | { ok: false; reason: string } {
  const relation = baseline.relation as ExpectationRelation;
  switch (relation) {
    case "equal": {
      const ok = looseEqual(baseline.value, candidate.value);
      return ok
        ? { ok: true }
        : { ok: false, reason: `values differ: baseline=${stringify(baseline.value)} candidate=${stringify(candidate.value)}` };
    }
    case "not-equal": {
      const ok = !looseEqual(baseline.value, candidate.value);
      return ok
        ? { ok: true }
        : { ok: false, reason: `values are equal (${stringify(baseline.value)}), expected different` };
    }
    case "baseline-greater": {
      const b = toNumber(baseline.value);
      const c = toNumber(candidate.value);
      if (b === null || c === null) {
        return { ok: false, reason: `non-numeric values for baseline-greater: baseline=${stringify(baseline.value)} candidate=${stringify(candidate.value)}` };
      }
      return b > c
        ? { ok: true }
        : { ok: false, reason: `baseline ${String(b)} is not greater than candidate ${String(c)}` };
    }
    case "baseline-less": {
      const b = toNumber(baseline.value);
      const c = toNumber(candidate.value);
      if (b === null || c === null) {
        return { ok: false, reason: `non-numeric values for baseline-less: baseline=${stringify(baseline.value)} candidate=${stringify(candidate.value)}` };
      }
      return b < c
        ? { ok: true }
        : { ok: false, reason: `baseline ${String(b)} is not less than candidate ${String(c)}` };
    }
    case "both-matches": {
      const pattern = baseline.pattern;
      if (pattern === undefined || pattern.length === 0) {
        return { ok: false, reason: `both-matches requires a pattern (got none)` };
      }
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (cause) {
        return { ok: false, reason: `invalid pattern '${pattern}': ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      const bOk = typeof baseline.value === "string" && regex.test(baseline.value);
      const cOk = typeof candidate.value === "string" && regex.test(candidate.value);
      return bOk && cOk
        ? { ok: true }
        : { ok: false, reason: `pattern '${pattern}' did not match both sides (baseline ${bOk ? "ok" : "no"}, candidate ${cOk ? "ok" : "no"})` };
    }
    default:
      return { ok: false, reason: `unsupported relation: ${String(relation)}` };
  }
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a) === String(b);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
