import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/** Task-specific inputs, separate from both the project sources and build outputs. */
export interface VerificationMaterialInput {
  readonly path: string;
  readonly content: string;
}

export interface VerificationMaterial extends VerificationMaterialInput {
  readonly sha256: string;
}

const MaterialRecord = z.object({
  path: z.string(),
  content: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const MaterialFile = z.object({
  version: z.literal(1),
  materials: z.array(MaterialRecord),
}).strict();

/** Use one portable namespace; never let generated inputs overwrite project files. */
export function validateMaterialPath(path: string): void {
  const parts = path.split("/");
  if (parts[0] !== "build" || parts[1] !== "verification" || parts.length < 3 ||
      parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === ".." ||
        part.endsWith(".") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error(`verification material path must be a portable file under build/verification/: ${path}`);
  }
}

export function materialHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Copy and pin content at the host boundary; a writer never supplies the hash. */
export function freezeVerificationMaterials(
  inputs: readonly VerificationMaterialInput[],
): readonly VerificationMaterial[] {
  return mergeVerificationMaterials(inputs.map((input) => {
    validateMaterialPath(input.path);
    return Object.freeze({ path: input.path, content: input.content, sha256: materialHash(input.content) });
  }));
}

/** Declarations may share identical inputs, but conflicting inputs fail closed. */
export function mergeVerificationMaterials(
  materials: readonly VerificationMaterial[],
): readonly VerificationMaterial[] {
  const byPath = new Map<string, VerificationMaterial>();
  for (const material of materials) {
    validateMaterialPath(material.path);
    if (materialHash(material.content) !== material.sha256) {
      throw new Error(`verification material hash mismatch: ${material.path}`);
    }
    const key = material.path.toLowerCase();
    const previous = byPath.get(key);
    if (previous !== undefined &&
        (previous.path !== material.path || previous.content !== material.content)) {
      throw new Error(`conflicting verification materials: ${previous.path} / ${material.path}`);
    }
    // A file cannot also be a parent directory, on any supported platform.
    for (const other of byPath.keys()) {
      if (other.startsWith(`${key}/`) || key.startsWith(`${other}/`)) {
        throw new Error(`conflicting verification material file/directory paths: ${material.path}`);
      }
    }
    byPath.set(key, Object.freeze({ ...material }));
  }
  return Object.freeze([...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)));
}

/** Optional sidecar shared by generated and preset workflows. Invalid data is never ignored. */
export function readVerificationMaterials(entry: string): readonly VerificationMaterial[] {
  if (existsSync(`${entry}.registration-pending`)) {
    throw new Error(`build workflow registration is incomplete; regenerate it: ${entry}`);
  }
  let source: string;
  try {
    source = readFileSync(`${entry}.materials.json`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const parsed = MaterialFile.parse(JSON.parse(source));
  return mergeVerificationMaterials(parsed.materials);
}

export function serializeVerificationMaterials(materials: readonly VerificationMaterial[]): string {
  return JSON.stringify({ version: 1, materials }, null, 2) + "\n";
}
