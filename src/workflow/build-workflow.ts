import { createHash } from "node:crypto";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import {
  BuildWorkflowManifest,
  BuildWorkflowOutput,
  type BuildWorkflowManifest as BuildWorkflowManifestValue,
  type BuildWorkflowOutput as BuildWorkflowOutputValue,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import { checkWorkflowSource } from "./source-policy.js";
import { runWorkflow } from "./runner.js";
import type { WorkflowFacts } from "./types.js";

export interface ResolveBuildWorkflowOptions {
  /** Workflow module path, relative to entryRoot when not absolute. */
  readonly entry: string;
  /** Optional expected identity; generated/provided workflows may establish it themselves. */
  readonly workflowId?: string;
  readonly revision?: number;
  /** Backward-compatible root for the workflow and target project. */
  readonly cwd: string;
  /** Root that contains the workflow source. Defaults to cwd. */
  readonly entryRoot?: string;
  /** Target project exposed through workflow capabilities. Defaults to cwd. */
  readonly workspaceRoot?: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  readonly timeoutMs?: number;
}

export interface BuildWorkflowResolution {
  /** Absolute source entry used to produce this resolution. */
  readonly entry: string;
  readonly manifest: BuildWorkflowManifestValue;
  readonly output: BuildWorkflowOutputValue;
  readonly sourceHash: string;
}

/** Run a BuildWorkflow and validate its compatibility-bridge output. */
export async function resolveBuildWorkflow(
  options: ResolveBuildWorkflowOptions,
): Promise<BuildWorkflowResolution> {
  const entryRoot = resolve(options.entryRoot ?? options.cwd);
  const entry = absoluteWithin(options.entry, entryRoot, "workflow entry");
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) throw new Error(checked.reason ?? "build workflow source rejected");

  const sourceHash = sha256(checked.source);
  const workspaceRoot = resolve(options.workspaceRoot ?? options.cwd);
  const facts: WorkflowFacts = { host: options.host, project: options.project };
  const result = await runWorkflow({
    entry,
    cwd: workspaceRoot,
    input: { kind: "build-workflow-input", version: 1 },
    facts,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  if (result.status !== "pass") {
    throw new Error(`build workflow failed: ${result.failure ?? result.status}`);
  }
  const output = BuildWorkflowOutput.parse(result.result);
  if (options.workflowId !== undefined && output.workflow_id !== options.workflowId) {
    throw new Error(
      `build workflow id mismatch: expected '${options.workflowId}', got '${output.workflow_id}'`,
    );
  }
  if (options.revision !== undefined && output.workflow_revision !== options.revision) {
    throw new Error(
      `build workflow revision mismatch: expected ${String(options.revision)}, got '${output.workflow_revision}'`,
    );
  }
  if (
    output.artifact.workflow_id !== output.workflow_id ||
    output.artifact.workflow_revision !== output.workflow_revision
  ) {
    throw new Error("build artifact identity does not match workflow output identity");
  }
  for (const path of Object.values(output.artifact.paths)) assertWorkspaceRelative(path);

  const manifest = BuildWorkflowManifest.parse({
    kind: "build-workflow-manifest",
    version: 1,
    id: output.workflow_id,
    revision: output.workflow_revision,
    entry: relative(entryRoot, entry).split(sep).join("/"),
    source_hash: sourceHash,
    workflow_api_version: 1,
    applies_to: {
      build_systems: options.project?.build_systems ?? [],
      markers: options.project?.markers ?? [],
      platforms: options.host ? [options.host.platform] : [],
      architectures: options.host ? [options.host.arch] : [],
      required_tools: requiredTools(output),
    },
    status: "draft",
  });
  return { entry, manifest, output, sourceHash };
}

function requiredTools(output: BuildWorkflowOutputValue): string[] {
  const build = output.environment.build;
  if (!("kind" in build)) return [];
  if (build.kind === "direct-compiler") return [build.compiler];
  if (build.kind === "cmake") return ["cmake"];
  if (build.kind === "ninja") return ["ninja"];
  return [];
}

function absoluteWithin(entry: string, root: string, label: string): string {
  const base = resolve(root);
  const absolute = isAbsolute(entry) ? normalize(entry) : resolve(base, entry);
  const rel = relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes root: ${entry}`);
  }
  return absolute;
}

function assertWorkspaceRelative(path: string): void {
  if (isAbsolute(path)) throw new Error(`build artifact path must be relative: ${path}`);
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`build artifact path escapes workspace: ${path}`);
  }
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
