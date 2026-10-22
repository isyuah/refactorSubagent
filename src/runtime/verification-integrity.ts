import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VerificationMaterial } from "../workflow/verification-materials.js";
import { validateMaterialPath } from "../workflow/verification-materials.js";

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8", windowsHide: true });
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function trackedFileHash(path: string): string {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink()
      ? `symlink:${readlinkSync(path)}`
      : `${stat.mode & 0o111}:${fileHash(path)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** Pin current tracked bytes, including user-owned dirty changes in the original checkout. */
export class TrackedRepositoryGuard {
  private readonly head: string;
  private readonly index: string;
  private readonly files: ReadonlyMap<string, string>;
  private readonly submodules: readonly { path: string; guard: TrackedRepositoryGuard | null }[];

  constructor(readonly root: string) {
    this.head = git(root, ["rev-parse", "HEAD"]).trim();
    this.index = git(root, ["ls-files", "--stage", "-z"]);
    const records = this.index.split("\0").filter(Boolean);
    const submodulePaths = new Set(records.filter((record) => record.startsWith("160000 "))
      .map((record) => record.slice(record.indexOf("\t") + 1)));
    const paths = new Set(records.map((record) => record.slice(record.indexOf("\t") + 1)));
    this.files = new Map([...paths].filter((path) => !submodulePaths.has(path))
      .map((path) => [path, trackedFileHash(join(root, path))]));
    this.submodules = [...submodulePaths].map((path) => {
      const moduleRoot = join(root, path);
      if (existsSync(join(moduleRoot, ".git"))) {
        return { path, guard: new TrackedRepositoryGuard(moduleRoot) };
      }
      assertEmptySubmodule(moduleRoot);
      return { path, guard: null };
    });
  }

  isTracked(path: string): boolean {
    const key = path.toLowerCase();
    return [...this.files.keys()].some((tracked) => tracked.toLowerCase() === key) ||
      this.submodules.some((module) => key === module.path.toLowerCase() || key.startsWith(`${module.path.toLowerCase()}/`));
  }

  assertUnchanged(label: string): void {
    if (git(this.root, ["rev-parse", "HEAD"]).trim() !== this.head) {
      throw new Error(`${label}: repository HEAD changed: ${this.root}`);
    }
    if (git(this.root, ["ls-files", "--stage", "-z"]) !== this.index) {
      throw new Error(`${label}: tracked index changed: ${this.root}`);
    }
    for (const [path, hash] of this.files) {
      if (trackedFileHash(join(this.root, path)) !== hash) {
        throw new Error(`${label}: tracked source changed: ${path} (${this.root})`);
      }
    }
    for (const module of this.submodules) {
      if (module.guard !== null) module.guard.assertUnchanged(label);
      else assertEmptySubmodule(join(this.root, module.path));
    }
  }
}

export interface IntegrityInput {
  readonly path: string;
  readonly sha256: string;
}

interface VerificationIntegrityOptions {
  readonly originalRepo: string;
  readonly worktrees: readonly { root: string; commit: string }[];
  readonly workflows: readonly { entry: string; sourceHash: string }[];
  readonly materials: readonly VerificationMaterial[];
  /** Trusted host injections can deliberately replace tracked judgement files. */
  readonly injectedFiles?: readonly IntegrityInput[];
}

/** Checks execution integrity; native build tools are still not an OS sandbox. */
export class VerificationIntegrity {
  private readonly repositories: readonly TrackedRepositoryGuard[];
  private readonly originalRepository: TrackedRepositoryGuard;

  constructor(private readonly options: VerificationIntegrityOptions) {
    this.assertWorkflowSources();
    this.originalRepository = new TrackedRepositoryGuard(options.originalRepo);
    const injected = options.injectedFiles ?? [];
    this.repositories = options.worktrees.map(({ root, commit }) => {
      if (git(root, ["rev-parse", "HEAD"]).trim() !== commit) {
        throw new Error(`verification worktree is not at the recorded commit: ${root}`);
      }
      for (const file of injected) {
        if (fileHash(join(root, file.path)) !== file.sha256) {
          throw new Error(`injected verification input changed: ${file.path}`);
        }
      }
      const changes = git(root, ["diff", "--no-ext-diff", "--ignore-submodules=none", "--name-only", "-z", commit, "--", ".",
        ...injected.map((file) => `:(exclude,literal)${file.path}`)]);
      if (changes.length > 0) {
        throw new Error(`verification worktree has unrecorded tracked changes: ${changes.split("\0").filter(Boolean).join(", ")}`);
      }
      return new TrackedRepositoryGuard(root);
    });
    // Validate all destinations before the first write. No material may replace
    // a tracked file or follow a junction/symlink out of its worktree.
    for (const repository of this.repositories) {
      for (const material of options.materials) {
        if (repository.isTracked(material.path)) {
          throw new Error(`verification material would overwrite a tracked file: ${material.path}`);
        }
        materialPath(repository.root, material.path);
      }
    }
    for (const repository of this.repositories) {
      for (const material of options.materials) {
        const target = materialPath(repository.root, material.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, material.content, "utf8");
      }
    }
    this.check("after distributing verification materials");
  }

  check(label: string): void {
    this.assertWorkflowSources();
    this.originalRepository.assertUnchanged(label);
    for (const repository of this.repositories) {
      repository.assertUnchanged(label);
      for (const material of this.options.materials) {
        if (fileHash(materialPath(repository.root, material.path)) !== material.sha256) {
          throw new Error(`${label}: verification material changed: ${material.path} (${repository.root})`);
        }
      }
      for (const file of this.options.injectedFiles ?? []) {
        if (fileHash(join(repository.root, file.path)) !== file.sha256) {
          throw new Error(`${label}: injected verification input changed: ${file.path} (${repository.root})`);
        }
      }
    }
  }

  private assertWorkflowSources(): void {
    for (const workflow of this.options.workflows) {
      const actual = createHash("sha256").update(readFileSync(workflow.entry, "utf8"), "utf8").digest("hex");
      if (actual !== workflow.sourceHash) {
        throw new Error(`verification workflow source changed after resolution: ${workflow.entry}`);
      }
    }
  }
}

/** An unused, uninitialized gitlink is fine; anonymous source bytes are not. */
function assertEmptySubmodule(root: string): void {
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`uninitialized submodule is not empty; initialize it before verification: ${root}`);
  }
}

function materialPath(root: string, path: string): string {
  validateMaterialPath(path);
  let current = realpathSync(root);
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || (index === parts.length - 1 && stat.nlink > 1)) {
      throw new Error(`verification material path follows a symlink or hard link: ${path}`);
    }
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`verification material destination has the wrong file type: ${path}`);
    }
  }
  return current;
}
