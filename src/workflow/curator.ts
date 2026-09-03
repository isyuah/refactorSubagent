import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { resolveBuildWorkflow } from "./build-workflow.js";
import { saveBuildWorkflow } from "./registry.js";

/**
 * curator — promotes run-local build workflows to the persisted library after
 * a successful run, recording an alias from the run-local id to the stable
 * library id so future sessions can resolve either.
 *
 * Runs AFTER the host verified (ACCEPTED): the build workflow demonstrably
 * worked, so promoting it is safe. The curator decides stable ids; it never
 * rewrites the run-local source (the library copy is authoritative for reuse).
 */

export interface CuratorOptions {
  /** Repo root (contains .refactorsa library). */
  readonly repoRoot: string;
  /** Run-local workflow source entry (absolute). */
  readonly entry: string;
  /** Run-local id (as declared during the run). */
  readonly runLocalId: string;
  /** Optional stable library id; derived from the source when omitted. */
  readonly libraryId?: string;
  /** Description of what this build produces; persisted in the library manifest. */
  readonly description?: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
}

export interface CurateResult {
  readonly libraryId: string;
  readonly revision: number;
  readonly aliasFile: string;
  readonly promoted: boolean;
  readonly reason: string;
}

/** Alias file lives at the repo root, next to the registry dir. */
const ALIAS_FILE = join(".refactorsa", "build-workflow-aliases.json");

interface AliasMap {
  /** run-local id → stable library id */
  readonly aliases: Record<string, string>;
}

export function loadAliases(repoRoot: string): AliasMap {
  const path = join(resolve(repoRoot), ALIAS_FILE);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AliasMap>;
    return { aliases: parsed.aliases ?? {} };
  } catch {
    return { aliases: {} };
  }
}

export function aliasLibraryId(repoRoot: string, runLocalId: string): string | null {
  return loadAliases(repoRoot).aliases[runLocalId] ?? null;
}

export function saveAlias(repoRoot: string, runLocalId: string, libraryId: string): void {
  const root = resolve(repoRoot);
  const map = loadAliases(root);
  map.aliases[runLocalId] = libraryId;
  const dir = join(root, ".refactorsa");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, ALIAS_FILE),
    JSON.stringify({ aliases: map.aliases }, null, 2) + "\n",
    "utf8",
  );
}

/** Derive a stable library id from a workflow source's own manifest id. */
function stableIdFromSource(runLocalId: string): string {
  // Run-local ids look like "<slug>-<session>"; strip the session suffix.
  return runLocalId.replace(/-[A-Za-z0-9]+$/, "");
}

/**
 * Promote one run-local build workflow into the library. Idempotent: if the
 * derived library id already exists with identical source, only the alias is
 * added.
 */
export async function curateBuildWorkflow(
  options: CuratorOptions,
): Promise<CurateResult> {
  const repoRoot = resolve(options.repoRoot);
  const libraryId = options.libraryId ?? stableIdFromSource(options.runLocalId);

  if (!existsSync(options.entry)) {
    return { libraryId, revision: 0, aliasFile: ALIAS_FILE, promoted: false, reason: "run-local source missing" };
  }

  const resolution = await resolveBuildWorkflow({
    entry: options.entry,
    workflowId: libraryId,
    revision: 1,
    cwd: repoRoot,
    entryRoot: repoRoot,
    workspaceRoot: repoRoot,
    host: options.host,
    project: options.project,
  });

  const stored = saveBuildWorkflow(repoRoot, resolution, options.description ?? "");
  saveAlias(repoRoot, options.runLocalId, libraryId);
  return {
    libraryId,
    revision: stored.manifest.revision,
    aliasFile: ALIAS_FILE,
    promoted: true,
    reason: `run-local '${options.runLocalId}' promoted as '${libraryId}'`,
  };
}
