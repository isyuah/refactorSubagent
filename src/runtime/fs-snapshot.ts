import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Recursive snapshot of a directory: rel-path → sha256 (empty for dirs). */
export type Snapshot = Map<string, string>;

export function snapshotDir(root: string): Snapshot {
  const map: Snapshot = new Map();
  walk(root, root, map);
  return map;
}

function walk(root: string, dir: string, out: Snapshot): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(root, full, out);
    } else {
      const rel = relative(root, full).split(sep).join("/");
      out.set(rel, createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  }
}

export type FsEffectOp = "create" | "modify" | "delete";

export interface FsDiff {
  path: string;
  op: FsEffectOp;
  sha256: string | null;
}

/** before → after diff, sorted by path for deterministic output. */
export function diffSnapshots(before: Snapshot, after: Snapshot): FsDiff[] {
  const effects: FsDiff[] = [];
  for (const [path, sha] of after) {
    const prev = before.get(path);
    if (prev === undefined) effects.push({ path, op: "create", sha256: sha });
    else if (prev !== sha) effects.push({ path, op: "modify", sha256: sha });
  }
  for (const [path, sha] of before) {
    if (!after.has(path)) effects.push({ path, op: "delete", sha256: sha });
  }
  effects.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return effects;
}
