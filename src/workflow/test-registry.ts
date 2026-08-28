import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  TestWorkflow,
  TestWorkflowManifest,
  type TestWorkflow as TestWorkflowValue,
  type TestWorkflowManifest as TestWorkflowManifestValue,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import { checkWorkflowSource } from "./source-policy.js";
import type { TestWorkflowResolution } from "./test-workflow.js";

const REGISTRY_DIR = ".refactorsa";
const TEST_WORKFLOWS_DIR = "test-workflows";
const CURRENT_WORKFLOW_API_VERSION = 1;

export type TestWorkflowCandidateStatus =
  | "valid"
  | "draft"
  | "incompatible"
  | "stale"
  | "invalid";

export interface StoredTestWorkflow {
  readonly manifestPath: string;
  readonly workflowPath: string;
  readonly entry: string;
  readonly manifest: TestWorkflowManifestValue;
  readonly workflow: TestWorkflowValue | null;
}

export interface TestWorkflowCandidate {
  readonly manifestPath: string;
  readonly entry: string | null;
  readonly manifest: TestWorkflowManifestValue | null;
  readonly status: TestWorkflowCandidateStatus;
  readonly reasons: string[];
}

export function saveTestWorkflow(
  repoRoot: string,
  resolution: TestWorkflowResolution,
): StoredTestWorkflow {
  const root = resolve(repoRoot);
  const sourceEntry = resolveInside(
    root,
    relative(root, resolution.entry),
    "test workflow source",
  );
  const source = readFileSync(sourceEntry, "utf8");
  const extension = workflowExtension(sourceEntry);
  const workflowDir = join(
    root,
    REGISTRY_DIR,
    TEST_WORKFLOWS_DIR,
    resolution.manifest.id,
    `r${String(resolution.manifest.revision)}`,
  );
  const entry = join(workflowDir, `workflow${extension}`);
  const manifestPath = join(workflowDir, "manifest.json");
  const workflowPath = join(workflowDir, "test-workflow.json");

  if (existsSync(workflowDir)) {
    if (!existsSync(manifestPath)) {
      throw new Error(`test workflow revision directory is incomplete: ${workflowDir}`);
    }
    const existing = loadTestWorkflow(manifestPath, root);
    if (existing.manifest.source_hash !== sha256(source)) {
      throw new Error(
        `test workflow revision already exists with different source: ` +
          `${resolution.manifest.id}@${String(resolution.manifest.revision)}`,
      );
    }
    return existing;
  }

  mkdirSync(workflowDir, { recursive: true });
  atomicWrite(entry, source);
  const storedManifest = TestWorkflowManifest.parse({
    ...resolution.manifest,
    entry: relative(root, entry).split(sep).join("/"),
    source_hash: sha256(source),
  });
  const workflow = TestWorkflow.parse(resolution.workflow);
  atomicWrite(manifestPath, `${JSON.stringify(storedManifest, null, 2)}\n`);
  atomicWrite(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  return {
    manifestPath,
    workflowPath,
    entry,
    manifest: storedManifest,
    workflow,
  };
}

export function loadTestWorkflow(
  manifestPath: string,
  repoRoot: string,
): StoredTestWorkflow {
  const root = resolve(repoRoot);
  const absoluteManifest = resolve(manifestPath);
  const manifest = TestWorkflowManifest.parse(
    JSON.parse(readFileSync(absoluteManifest, "utf8")),
  );
  const entry = resolveInside(root, manifest.entry, "test workflow entry");
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) {
    throw new Error(checked.reason ?? `test workflow source rejected: ${entry}`);
  }
  const actualHash = sha256(checked.source);
  if (actualHash !== manifest.source_hash) {
    throw new Error(
      `test workflow source hash mismatch: expected ${manifest.source_hash}, got ${actualHash}`,
    );
  }
  const workflowPath = join(dirname(absoluteManifest), "test-workflow.json");
  const workflow = existsSync(workflowPath)
    ? TestWorkflow.parse(JSON.parse(readFileSync(workflowPath, "utf8")))
    : null;
  if (
    workflow !== null &&
    (workflow.workflow_id !== manifest.id || workflow.workflow_revision !== manifest.revision)
  ) {
    throw new Error("persisted TestWorkflow identity does not match its manifest");
  }
  return {
    manifestPath: absoluteManifest,
    workflowPath,
    entry,
    manifest,
    workflow,
  };
}

export function discoverTestWorkflows(
  repoRoot: string,
  host?: HostPreflight,
  project?: ProjectDetection,
): TestWorkflowCandidate[] {
  const root = resolve(repoRoot);
  const workflowsRoot = join(root, REGISTRY_DIR, TEST_WORKFLOWS_DIR);
  if (!existsSync(workflowsRoot)) return [];

  const candidates: TestWorkflowCandidate[] = [];
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
          reasons: ["test workflow revision has no manifest.json"],
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
): TestWorkflowCandidate {
  try {
    const stored = loadTestWorkflow(manifestPath, repoRoot);
    const reasons = compatibilityReasons(stored.manifest, host, project);
    return {
      manifestPath,
      entry: stored.entry,
      manifest: stored.manifest,
      status:
        reasons.length > 0
          ? "incompatible"
          : stored.manifest.status === "draft"
            ? "draft"
            : "valid",
      reasons,
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
  manifest: TestWorkflowManifestValue,
  host?: HostPreflight,
  project?: ProjectDetection,
): string[] {
  const reasons: string[] = [];
  if (manifest.workflow_api_version !== CURRENT_WORKFLOW_API_VERSION) {
    reasons.push(`workflow API ${String(manifest.workflow_api_version)} is unsupported`);
  }
  if (host !== undefined) {
    if (
      manifest.applies_to.platforms.length > 0 &&
      !manifest.applies_to.platforms.includes(host.platform)
    ) {
      reasons.push(`platform ${host.platform} is not listed`);
    }
    if (
      manifest.applies_to.architectures.length > 0 &&
      !manifest.applies_to.architectures.includes(host.arch)
    ) {
      reasons.push(`architecture ${host.arch} is not listed`);
    }
    for (const tool of manifest.applies_to.required_tools) {
      if (host.tools[tool]?.available !== true) {
        reasons.push(`required tool is unavailable: ${tool}`);
      }
    }
  }
  if (project !== undefined && manifest.applies_to.build_systems.length > 0) {
    if (
      project.primary_build_system !== null &&
      !manifest.applies_to.build_systems.includes(project.primary_build_system)
    ) {
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
