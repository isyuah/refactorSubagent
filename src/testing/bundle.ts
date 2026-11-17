import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { PlanMetadata, LocalDialogue, TrialResult, type PlanContent } from "./types.js";

const Entry = z.string().min(1).refine(p => !isAbsolute(p) && !p.includes("\\") &&
  p.split("/").every(s => s !== ".." && s !== "." && s !== "" && !/[\x00-\x1f<>:"|?*]/.test(s) &&
    !/[ .]$/.test(s) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)), "expected contained portable relative path");
const Manifest = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-zA-Z0-9_-]+$/), revision: z.number().int().positive(),
  created_at: z.string(), metadata: PlanMetadata, history: z.array(TrialResult), evidence: z.array(Entry),
  test: z.object({ entry: Entry, workflowId: z.string(), revision: z.number().int().positive() }).nullable(),
  builds: z.array(z.object({ id: z.string(), entry: Entry, workflowId: z.string(), revision: z.number().int().positive(), description: z.string() })),
  files: z.record(Entry, z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();
export type TestPlanManifest = z.infer<typeof Manifest>;
export interface LoadedTestPlan {
  directory: string; manifest: TestPlanManifest; content: PlanContent;
  history: TrialResult[]; evidenceDirs: string[];
}
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** Bundle import is a filesystem boundary: every declared file must stay in it. */
export function bundleFile(directory: string, entry: string): string {
  Entry.parse(entry);
  const root = realpathSync(directory);
  const file = realpathSync(resolve(root, entry));
  const rel = relative(root, file);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !statSync(file).isFile()) throw new Error(`test plan file escapes its directory: ${entry}`);
  return file;
}
function mapTrial(trial: TrialResult, mapPath: (path: string) => string): TrialResult {
  return { ...trial, evidence_dir: trial.evidence_dir === null ? null : mapPath(trial.evidence_dir),
    builds: trial.builds.map(b => ({ ...b, evidence_path: b.evidence_path === null ? null : mapPath(b.evidence_path) })) };
}
export function loadTestPlan(directory: string): LoadedTestPlan {
  const root = resolve(directory);
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(root, "plan.json"), "utf8")));
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (hash(readFileSync(bundleFile(root, path))) !== expected) throw new Error(`test plan file changed: ${path}`);
  }
  const source = (entry: string): string => {
    if (manifest.files[entry] === undefined) throw new Error(`test plan has an unregistered file: ${entry}`);
    return readFileSync(bundleFile(root, entry), "utf8");
  };
  const evidencePath = (path: string): string => {
    Entry.parse(path);
    if (!manifest.evidence.some(dir => path === dir || path.startsWith(`${dir}/`))) throw new Error(`unregistered evidence path: ${path}`);
    return join(root, path);
  };
  if (new Set(manifest.builds.map(b => b.id)).size !== manifest.builds.length) throw new Error("test plan has duplicate build ids");
  const content: PlanContent = { metadata: { ...manifest.metadata, trial: mapTrial(manifest.metadata.trial, evidencePath) },
    test: manifest.test === null ? null : { workflowId: manifest.test.workflowId, revision: manifest.test.revision, source: source(manifest.test.entry) },
    builds: manifest.builds.map(b => ({ id: b.id, workflowId: b.workflowId, revision: b.revision, description: b.description,
      source: source(b.entry), materials: manifest.files[`${b.entry}.materials.json`] === undefined ? null : source(`${b.entry}.materials.json`) })),
  };
  return { directory: root, manifest, content, history: manifest.history.map(t => mapTrial(t, evidencePath)), evidenceDirs: manifest.evidence.map(evidencePath) };
}

export function saveTestPlan(options: {
  parent: string; id: string; content: PlanContent; history: readonly TrialResult[]; evidenceDirs: readonly string[];
  dialogue: LocalDialogue | null; localStateDir: string;
}): LoadedTestPlan {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.id)) throw new Error("invalid test plan id");
  const parent = resolve(options.parent);
  mkdirSync(parent, { recursive: true });
  const revisions = readdirSync(parent).filter(n => /^r[1-9][0-9]*$/.test(n)).map(n => Number(n.slice(1)));
  const revision = Math.max(0, ...revisions) + 1;
  const destination = join(parent, `r${revision}`);
  const staging = join(parent, `.saving-${randomUUID()}`);
  mkdirSync(staging);
  try {
    const files: Record<string, string> = {};
    const write = (path: string, data: string | Buffer): void => {
      Entry.parse(path); const target = join(staging, path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data); files[path] = hash(data);
    };
    const test = options.content.test;
    if (test !== null) write("workflows/test.ts", test.source);
    const builds = options.content.builds.map((b, i) => {
      const entry = `workflows/build-${i + 1}.ts`; write(entry, b.source);
      if (b.materials !== null) write(`${entry}.materials.json`, b.materials);
      return { id: b.id, entry, workflowId: b.workflowId, revision: b.revision, description: b.description };
    });
    const copyEvidence = (dir: string, prefix: string): void => {
      mkdirSync(join(staging, prefix), { recursive: true });
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // Local model transcripts are deliberately separate from portable test evidence.
        if (entry.name === "sessions") continue;
        if (entry.isSymbolicLink()) throw new Error("evidence must not contain symlinks");
        const from = join(dir, entry.name); const to = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) copyEvidence(from, to);
        else if (entry.isFile()) write(to, readFileSync(from));
      }
    };
    const directories = [...new Set(options.evidenceDirs.map(dir => resolve(dir)))];
    const evidence = directories.map((dir, i) => {
      const entry = `evidence/${i + 1}`; copyEvidence(dir, entry); return entry;
    });
    const portablePath = (path: string): string => {
      for (const [i, dir] of directories.entries()) {
        const rel = relative(dir, resolve(path));
        if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) return rel ? `${evidence[i]}/${rel.split(sep).join("/")}` : evidence[i]!;
      }
      throw new Error(`evidence was not collected: ${path}`);
    };
    const manifest = Manifest.parse({ version: 1, id: options.id, revision, created_at: new Date().toISOString(),
      metadata: { ...options.content.metadata, trial: mapTrial(options.content.metadata.trial, portablePath) },
      history: options.history.map(t => mapTrial(t, portablePath)), evidence,
      test: test === null ? null : { entry: "workflows/test.ts", workflowId: test.workflowId, revision: test.revision }, builds, files });
    writeFileSync(join(staging, "plan.json"), JSON.stringify(manifest, null, 2) + "\n");
    renameSync(staging, destination);
    // Conversation pointers stay local and are never part of the portable bundle.
    if (options.dialogue !== null) {
      mkdirSync(options.localStateDir, { recursive: true });
      writeFileSync(join(options.localStateDir, `${options.id}.json`), JSON.stringify(options.dialogue) + "\n");
    }
    return loadTestPlan(destination);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true });
  }
}

export function loadLocalDialogue(localStateDir: string, id: string): LocalDialogue | null {
  const file = join(localStateDir, `${id}.json`);
  if (!existsSync(file)) return null;
  const result = LocalDialogue.parse(JSON.parse(readFileSync(file, "utf8")));
  const transcript = join(result.root, "sessions", result.id, "main.jsonl");
  return existsSync(transcript) && statSync(transcript).isFile() && statSync(transcript).size > 0 ? result : null;
}
