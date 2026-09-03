import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { resolveBuildWorkflow, type BuildWorkflowResolution } from "./build-workflow.js";
import { resolveTestWorkflow, type TestWorkflowResolution } from "./test-workflow.js";

/**
 * resolve-declared — declaration-set workflow resolution for the
 * subagent-driven flow.
 *
 * The test-writer session produced a TestWorkflow source plus a declaration
 * set of build workflow ids. This module resolves every declared build
 * (fail-closed on unknown/missing), then resolves the test workflow source.
 *
 * There is no Claude selection here: ids are host-validated against the
 * registry's known set, and entries come from the run-local directory or the
 * persisted library.
 */

export interface DeclaredBuildSource {
  /** Declared build workflow id. */
  readonly id: string;
  /** Absolute path to the workflow source (run-local or library entry). */
  readonly entry: string;
  /** True when this build was generated during the current run. */
  readonly runLocal: boolean;
  /** Optional host-assigned identity; workflow-driven sources may not carry one. */
  readonly workflowId?: string;
  readonly revision?: number;
}

export interface ResolveDeclaredWorkflowsOptions {
  /** Target project root exposed through workflow capabilities. */
  readonly workspaceRoot: string;
  /** Root used as the trust boundary for workflow source entries. */
  readonly entryRoot: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  /** Absolute entry of the produced TestWorkflow source. */
  readonly testEntry: string;
  /** Host-assigned identity for the test workflow. */
  readonly testWorkflowId: string;
  readonly testRevision: number;
  /** Declared build sources (id → entry), already validated known. */
  readonly builds: readonly DeclaredBuildSource[];
}

export interface ResolvedDeclaredBuild {
  readonly id: string;
  readonly runLocal: boolean;
  readonly resolution: BuildWorkflowResolution;
}

export interface ResolvedDeclaredWorkflows {
  readonly builds: readonly ResolvedDeclaredBuild[];
  readonly test: TestWorkflowResolution;
}

/**
 * Resolve every declared build, then the test workflow source.
 *
 * Self-driven test workflows (test-workflow-driven) carry no static build
 * reference; the executed set is exactly the declared builds, and the test
 * references artifact paths it learned from the build-writer report (asserting
 * them itself via context.validator). Legacy declarative tests still receive a
 * single build identity for their static compatibility check.
 */
export async function resolveDeclaredWorkflows(
  options: ResolveDeclaredWorkflowsOptions,
): Promise<ResolvedDeclaredWorkflows> {
  const builds: ResolvedDeclaredBuild[] = [];
  for (const source of options.builds) {
    const resolution = await resolveBuildWorkflow({
      entry: source.entry,
      workflowId: source.workflowId,
      revision: source.revision,
      cwd: options.workspaceRoot,
      entryRoot: options.entryRoot,
      workspaceRoot: options.workspaceRoot,
      host: options.host,
      project: options.project,
    });
    builds.push({ id: source.id, runLocal: source.runLocal, resolution });
  }

  const test = await resolveTestWorkflow({
    entry: options.testEntry,
    entryRoot: options.entryRoot,
    workspaceRoot: options.workspaceRoot,
    workflowId: options.testWorkflowId,
    revision: options.testRevision,
    buildWorkflow: singleBuildReference(builds),
    host: options.host,
    project: options.project,
  });

  return { builds, test };
}

/** Legacy single-build identity for declarative tests; empty for none/many. */
function singleBuildReference(builds: readonly ResolvedDeclaredBuild[]): {
  readonly workflow_id: string;
  readonly workflow_revision: number;
} {
  if (builds.length === 1) {
    const manifest = builds[0]!.resolution.manifest;
    return { workflow_id: manifest.id, workflow_revision: manifest.revision };
  }
  return { workflow_id: "", workflow_revision: 0 };
}
