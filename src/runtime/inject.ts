import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Injection — copy judgement material into worktrees after the candidate has
 * been committed and before verification runs.
 *
 * The refactor session must never see what it is judged by: pins, oracles and
 * other judgement material live outside the prepared environment and are put
 * back only for the verification stage. The copy is host-side and happens
 * after `commitCandidateChanges()`, so it cannot show up in the measured
 * change set, and it never replaces the verification stage, so the verdict
 * stays authoritative.
 *
 * Every copied file is hashed into the run journal: what the judge actually
 * read is evidence, not an assumption.
 */

export interface InjectionSpec {
  /** Source directory or file, absolute or relative to the process cwd. */
  readonly source: string;
  /** Destination inside each worktree root, e.g. "refactor-task/oracle". */
  readonly dest: string;
}

export interface InjectedFile {
  /** Path relative to the worktree root. */
  readonly path: string;
  readonly sha256: string;
  /** True when a different file already existed at the destination. */
  readonly replaced: boolean;
}

export interface InjectionReport {
  readonly source: string;
  readonly dest: string;
  readonly worktree: string;
  readonly files: readonly InjectedFile[];
  /** Files that existed before the injection and differed from the source. */
  readonly preExisting: readonly string[];
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, "");
  return out;
}

/**
 * Apply every injection to every worktree root. Fail-closed: a missing source
 * throws (the judge material is part of the judgement, not an optimisation).
 */
export function applyInjections(
  worktreeRoots: readonly string[],
  injections: readonly InjectionSpec[],
): InjectionReport[] {
  const reports: InjectionReport[] = [];
  for (const spec of injections) {
    const source = resolve(spec.source);
    if (!existsSync(source)) throw new Error(`injection source is missing: ${source}`);
    const isDir = statSync(source).isDirectory();
    const relFiles = isDir ? filesUnder(source) : [""];
    for (const root of worktreeRoots) {
      const files: InjectedFile[] = [];
      const preExisting: string[] = [];
      for (const rel of relFiles) {
        const from = isDir ? join(source, rel) : source;
        const targetRel = isDir ? (spec.dest === "" ? rel : `${spec.dest}/${rel}`) : spec.dest;
        const to = join(root, targetRel);
        const hash = createHash("sha256").update(readFileSync(from)).digest("hex");
        if (existsSync(to)) {
          const current = createHash("sha256").update(readFileSync(to)).digest("hex");
          if (current !== hash) preExisting.push(targetRel);
        }
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(from));
        files.push({ path: targetRel, sha256: hash, replaced: preExisting.includes(targetRel) });
      }
      reports.push({ source, dest: spec.dest, worktree: root, files, preExisting });
    }
  }
  return reports;
}
