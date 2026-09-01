import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { CTestSuiteSpec } from "../artifacts/ctest-suite.js";
import type {
  HostPreflight,
  ProjectDetection,
} from "../artifacts/index.js";
import {
  CTestWorkflow,
  materializeCTestSuiteSpec,
  TestSpecWorkflow,
  TestWorkflow,
  TestWorkflowManifest,
  type CTestMaterializationPolicy,
  type TestWorkflow as TestWorkflowValue,
} from "../artifacts/test-workflow.js";
import { checkWorkflowSource } from "./source-policy.js";
import { runWorkflow } from "./runner.js";
import type { WorkflowFacts } from "./types.js";

export interface ResolveTestWorkflowOptions {
  readonly entry: string;
  readonly entryRoot: string;
  readonly workspaceRoot?: string;
  readonly workflowId: string;
  readonly revision: number;
  /** Selected BuildWorkflow identity; only id/revision are consumed. */
  readonly buildWorkflow: { readonly workflow_id: string; readonly workflow_revision: number };
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  readonly timeoutMs?: number;
}

export interface TestWorkflowResolution {
  readonly entry: string;
  readonly manifest: TestWorkflowManifest;
  readonly workflow: TestWorkflowValue;
  readonly sourceHash: string;
}

/** Execute and validate a TestWorkflow against a selected BuildWorkflow. */
export async function resolveTestWorkflow(
  options: ResolveTestWorkflowOptions,
): Promise<TestWorkflowResolution> {
  const entry = absoluteWithin(options.entry, options.entryRoot);
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) throw new Error(checked.reason ?? "test workflow source rejected");

  const sourceHash = sha256(checked.source);
  const workspaceRoot = resolve(options.workspaceRoot ?? options.entryRoot);
  const facts: WorkflowFacts = { host: options.host, project: options.project };
  const result = await runWorkflow({
    entry,
    cwd: workspaceRoot,
    input: {
      kind: "test-workflow-input",
      version: 1,
      build_workflow_id: options.buildWorkflow.workflow_id,
      build_workflow_revision: options.buildWorkflow.workflow_revision,
    },
    facts,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  if (result.status !== "pass") {
    throw new Error(`test workflow failed: ${result.failure ?? result.status}`);
  }

  const workflow = TestWorkflow.parse(result.result);
  if (workflow.workflow_id !== options.workflowId) {
    throw new Error(
      `test workflow id mismatch: expected '${options.workflowId}', got '${workflow.workflow_id}'`,
    );
  }
  if (workflow.workflow_revision !== options.revision) {
    throw new Error(
      `test workflow revision mismatch: expected ${String(options.revision)}, got '${workflow.workflow_revision}'`,
    );
  }
  if (
    workflow.build_workflow_id !== options.buildWorkflow.workflow_id ||
    workflow.build_workflow_revision !== options.buildWorkflow.workflow_revision
  ) {
    throw new Error("test workflow references a different BuildWorkflow");
  }
  if (workflow.runner === "ctest") {
    CTestWorkflow.parse(workflow);
    CTestSuiteSpec.parse(materializeCTestSuiteSpec(workflow, {
      timeout_ms: 1,
      parallelism: 1,
    }));
    for (const arg of workflow.extra_args) {
      if (arg.includes("\0")) throw new Error("test workflow extra_args cannot contain NUL");
    }
  } else {
    TestSpecWorkflow.parse(workflow);
  }

  const manifest = TestWorkflowManifest.parse({
    kind: "test-workflow-manifest",
    version: 1,
    id: options.workflowId,
    revision: options.revision,
    entry: relative(options.entryRoot, entry).split(sep).join("/"),
    source_hash: sourceHash,
    workflow_api_version: 1,
    applies_to: {
      build_systems: options.project?.build_systems ?? [],
      markers: options.project?.markers ?? [],
      platforms: options.host ? [options.host.platform] : [],
      architectures: options.host ? [options.host.arch] : [],
      required_tools: workflow.runner === "ctest" ? ["ctest"] : [],
    },
    status: "draft",
  });
  return { entry, manifest, workflow, sourceHash };
}

export function materializeTestWorkflow(
  resolution: TestWorkflowResolution,
  policy: CTestMaterializationPolicy,
): CTestSuiteSpec | null {
  if (resolution.workflow.runner !== "ctest") return null;
  return materializeCTestSuiteSpec(resolution.workflow, policy);
}

function absoluteWithin(entry: string, root: string): string {
  const base = resolve(root);
  const absolute = isAbsolute(entry) ? normalize(entry) : resolve(base, entry);
  const rel = relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`workflow entry escapes entry root: ${entry}`);
  }
  return absolute;
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Read a persisted test workflow manifest and verify its source hash. */
export function loadTestWorkflowManifest(
  manifestPath: string,
  entryRoot: string,
): { manifest: TestWorkflowManifest; entry: string } {
  const manifest = TestWorkflowManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const entry = absoluteWithin(manifest.entry, entryRoot);
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) throw new Error(checked.reason ?? `test workflow source rejected: ${entry}`);
  const actual = sha256(checked.source);
  if (actual !== manifest.source_hash) {
    throw new Error(
      `test workflow source hash mismatch: expected ${manifest.source_hash}, got ${actual}`,
    );
  }
  return { manifest, entry };
}
