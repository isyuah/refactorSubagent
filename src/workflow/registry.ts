import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  BuildWorkflowManifest,
  BuildWorkflowOutput,
  type BuildWorkflowManifest as BuildWorkflowManifestValue,
  type BuildWorkflowOutput as BuildWorkflowOutputValue,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import { checkWorkflowSource } from "./source-policy.js";
import type { BuildWorkflowResolution } from "./build-workflow.js";

const REGISTRY_DIR = ".refactorsa";
const BUILD_WORKFLOWS_DIR = "build-workflows";
const CURRENT_WORKFLOW_API_VERSION = 1;

export type BuildWorkflowCandidateStatus =
  | "valid"
  | "draft"
  | "incompatible"
  | "stale"
  | "invalid";

export interface StoredBuildWorkflow {
  manifestPath: string;
  outputPath: string | null;
  entry: string;
  manifest: BuildWorkflowManifestValue;
  output: BuildWorkflowOutputValue | null;
}

export interface BuildWorkflowCandidate {
  manifestPath: string;
  entry: string | null;
  manifest: BuildWorkflowManifestValue | null;
  status: BuildWorkflowCandidateStatus;
  reasons: string[];
}

export function saveBuildWorkflow(
  repoRoot: string,
  resolution: BuildWorkflowResolution,
  description = "",
): StoredBuildWorkflow {
  const root = resolve(repoRoot);
  const sourceEntry = resolveInside(root, relative(root, resolution.entry), "workflow source");
  const source = readFileSync(sourceEntry, "utf8");
  const extension = workflowExtension(sourceEntry);
  const workflowDir = join(
    root,
    REGISTRY_DIR,
    BUILD_WORKFLOWS_DIR,
    resolution.manifest.id,
    `r${String(resolution.manifest.revision)}`,
  );
  const entry = join(workflowDir, `workflow${extension}`);
  const manifestPath = join(workflowDir, "manifest.json");
  const outputPath = join(workflowDir, "build-workflow-output.json");
  if (existsSync(workflowDir)) {
    if (!existsSync(manifestPath)) {
      throw new Error(`workflow revision directory is incomplete: ${workflowDir}`);
    }
    const existing = loadBuildWorkflow(manifestPath, root);
    if (existing.manifest.source_hash !== sha256(source)) {
      throw new Error(
        `workflow revision already exists with different source: ${resolution.manifest.id}@${String(resolution.manifest.revision)}`,
      );
    }
    return existing;
  }

  mkdirSync(workflowDir, { recursive: true });
  atomicWrite(entry, source);
  const storedManifest = BuildWorkflowManifest.parse({
    ...resolution.manifest,
    entry: relative(root, entry).split(sep).join("/"),
    source_hash: sha256(source),
    description: description.length > 0 ? description : resolution.manifest.description,
  });
  atomicWrite(manifestPath, JSON.stringify(storedManifest, null, 2) + "\n");
  if (resolution.output === null) {
    // workflow-driven workflows have no static plan; nothing to persist.
    return { manifestPath, outputPath: null, entry, manifest: storedManifest, output: null };
  }
  const output = BuildWorkflowOutput.parse(resolution.output);
  atomicWrite(outputPath, JSON.stringify(output, null, 2) + "\n");
  return { manifestPath, outputPath, entry, manifest: storedManifest, output };
}

/** Load and verify one persisted workflow manifest and its source hash. */
export function loadBuildWorkflow(
  manifestPath: string,
  repoRoot: string,
): StoredBuildWorkflow {
  const root = resolve(repoRoot);
  const absoluteManifest = resolve(manifestPath);
  const manifest = BuildWorkflowManifest.parse(
    JSON.parse(readFileSync(absoluteManifest, "utf8")),
  );
  const entry = resolveInside(root, manifest.entry, "workflow entry");
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) throw new Error(checked.reason ?? `workflow source rejected: ${entry}`);
  const actualHash = sha256(checked.source);
  if (actualHash !== manifest.source_hash) {
    throw new Error(
      `workflow source hash mismatch: expected ${manifest.source_hash}, got ${actualHash}`,
    );
  }

  const outputPath = join(dirname(absoluteManifest), "build-workflow-output.json");
  const output = existsSync(outputPath)
    ? BuildWorkflowOutput.parse(JSON.parse(readFileSync(outputPath, "utf8")))
    : null;
  if (output !== null && (
    output.workflow_id !== manifest.id || output.workflow_revision !== manifest.revision
  )) {
    throw new Error("persisted BuildWorkflow output does not match its manifest");
  }
  return {
    manifestPath: absoluteManifest,
    outputPath: output === null ? null : outputPath,
    entry,
    manifest,
    output,
  };
}

/** Find persisted workflows and classify deterministic reuse conditions. */
export function discoverBuildWorkflows(
  repoRoot: string,
  host?: HostPreflight,
  project?: ProjectDetection,
): BuildWorkflowCandidate[] {
  const root = resolve(repoRoot);
  const workflowsRoot = join(root, REGISTRY_DIR, BUILD_WORKFLOWS_DIR);
  if (!existsSync(workflowsRoot)) return [];

  const candidates: BuildWorkflowCandidate[] = [];
  for (const workflowId of readdirSync(workflowsRoot, { withFileTypes: true })) {
    if (!workflowId.isDirectory()) continue;
    const idRoot = join(workflowsRoot, workflowId.name);
    for (const revision of readdirSync(idRoot, { withFileTypes: true })) {
      if (!revision.isDirectory()) continue;
      const manifestPath = join(idRoot, revision.name, "manifest.json");
      if (!existsSync(manifestPath)) {
        candidates.push({
          manifestPath,
          entry: null,
          manifest: null,
          status: "invalid",
          reasons: ["workflow revision has no manifest.json"],
        });
        continue;
      }
      candidates.push(classifyCandidate(manifestPath, root, host, project));
    }
  }
  return candidates.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
}

function classifyCandidate(
  manifestPath: string,
  repoRoot: string,
  host?: HostPreflight,
  project?: ProjectDetection,
): BuildWorkflowCandidate {
  try {
    const stored = loadBuildWorkflow(manifestPath, repoRoot);
    const reasons = compatibilityReasons(stored.manifest, host, project);
    if (reasons.length > 0) {
      return {
        manifestPath,
        entry: stored.entry,
        manifest: stored.manifest,
        status: "incompatible",
        reasons,
      };
    }
    return {
      manifestPath,
      entry: stored.entry,
      manifest: stored.manifest,
      status: stored.manifest.status === "draft" ? "draft" : "valid",
      reasons: [],
    };
  } catch (error) {
    return {
      manifestPath,
      entry: null,
      manifest: null,
      status: "stale",
      reasons: [errorMessage(error)],
    };
  }
}

function compatibilityReasons(
  manifest: BuildWorkflowManifestValue,
  host?: HostPreflight,
  project?: ProjectDetection,
): string[] {
  const reasons: string[] = [];
  if (manifest.workflow_api_version !== CURRENT_WORKFLOW_API_VERSION) {
    reasons.push(`workflow API ${String(manifest.workflow_api_version)} is unsupported`);
  }
  if (host !== undefined) {
    if (manifest.applies_to.platforms.length > 0 && !manifest.applies_to.platforms.includes(host.platform)) {
      reasons.push(`platform ${host.platform} is not listed`);
    }
    if (manifest.applies_to.architectures.length > 0 && !manifest.applies_to.architectures.includes(host.arch)) {
      reasons.push(`architecture ${host.arch} is not listed`);
    }
    for (const tool of manifest.applies_to.required_tools) {
      if (host.tools[tool]?.available !== true) reasons.push(`required tool is unavailable: ${tool}`);
    }
  }
  if (project !== undefined) {
    if (manifest.applies_to.build_systems.length > 0 && project.primary_build_system !== null &&
        !manifest.applies_to.build_systems.includes(project.primary_build_system)) {
      reasons.push(`build system ${project.primary_build_system} is not listed`);
    }
    for (const marker of manifest.applies_to.markers) {
      if (!project.markers.includes(marker)) reasons.push(`project marker is missing: ${marker}`);
    }
  }
  return reasons;
}

function resolveInside(root: string, path: string, label: string): string {
  const absolute = isAbsolute(path) ? normalize(path) : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes repository root: ${path}`);
  }
  return absolute;
}

function workflowExtension(entry: string): string {
  const extension = extname(entry).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx"].includes(extension) ? extension : ".ts";
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
