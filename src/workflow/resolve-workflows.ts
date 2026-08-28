import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  WorkflowResolution,
  type BuildWorkflowOutput as BuildWorkflowOutputValue,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import { generateWorkflowSource } from "../agents/workflow-generator.js";
import { selectWorkflow, type WorkflowSelectionCandidate } from "../agents/workflow-selection.js";
import { resolveBuildWorkflow, type BuildWorkflowResolution } from "./build-workflow.js";
import { discoverBuildWorkflows, loadBuildWorkflow } from "./registry.js";
import { resolveTestWorkflow, type TestWorkflowResolution } from "./test-workflow.js";
import { discoverTestWorkflows, loadTestWorkflow } from "./test-registry.js";

export interface WorkflowResolutionOptions {
  readonly workspaceRoot: string;
  readonly sessionRoot: string;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly taskContext?: string;
  /** Host deadline for each generated Workflow Agent query. */
  readonly workflowTimeoutMs?: number;
  readonly build?: WorkflowRequest;
  readonly test?: WorkflowRequest;
}

export interface WorkflowRequest {
  /** Optional workflow source path supplied by the caller. */
  readonly entry?: string;
  /** Root used for a relative entry, and the trust boundary for an absolute one. */
  readonly entryRoot?: string;
  readonly id?: string;
  readonly revision?: number;
  /** A provided entry is mandatory and cannot be replaced when true. */
  readonly force?: boolean;
}

export interface ResolvedWorkflows {
  readonly build: BuildWorkflowResolution;
  readonly buildResolution: WorkflowResolution;
  readonly test: TestWorkflowResolution;
  readonly testResolution: WorkflowResolution;
}

interface BuildCandidateRecord {
  readonly candidate: WorkflowSelectionCandidate;
  readonly entry: string;
  readonly entryRoot: string;
  readonly manifestPath?: string;
  readonly resolution?: BuildWorkflowResolution;
}

interface TestCandidateRecord {
  readonly candidate: WorkflowSelectionCandidate;
  readonly entry: string;
  readonly entryRoot: string;
  readonly manifestPath?: string;
  readonly resolution?: TestWorkflowResolution;
}

/** Resolve BuildWorkflow and TestWorkflow with the same fail-closed policy. */
export async function resolveWorkflows(
  options: WorkflowResolutionOptions,
): Promise<ResolvedWorkflows> {
  const build = await resolveBuild(options);
  const test = await resolveTest(options, build);
  return { ...build, ...test };
}

async function resolveBuild(options: WorkflowResolutionOptions): Promise<{
  build: BuildWorkflowResolution;
  buildResolution: WorkflowResolution;
}> {
  const request = options.build ?? {};
  if (request.force && request.entry === undefined) {
    throw new Error("forced BuildWorkflow requires entry");
  }

  if (request.force && request.entry !== undefined) {
    const provided = await inspectProvidedBuild(options, request);
    if (provided.resolution === undefined) {
      throw new Error(`forced BuildWorkflow is unusable: ${provided.candidate.reasons.join("; ")}`);
    }
    return {
      build: provided.resolution,
      buildResolution: createResolution({
        kind: "build",
        mode: "forced",
        entry: provided.resolution.entry,
        root: provided.entryRoot,
        workspaceRoot: options.workspaceRoot,
        sessionRoot: options.sessionRoot,
        id: provided.resolution.manifest.id,
        revision: provided.resolution.manifest.revision,
        hash: provided.resolution.sourceHash,
        candidates: [provided.candidate.entry],
        reason: "user-forced BuildWorkflow",
      }),
    };
  }

  const records = await buildCandidates(options, request);
  const selection = records.length > 0
    ? await selectWorkflow({
        repoDir: options.workspaceRoot,
        workflowKind: "build",
        candidates: records.map((record) => record.candidate),
        taskContext: options.taskContext,
      })
    : generatedSelection("no BuildWorkflow candidate was available");

  if (selection.decision === "use" && selection.candidate_index !== null) {
    const selected = records[selection.candidate_index];
    if (selected === undefined) throw new Error("selected BuildWorkflow candidate disappeared");
    const workflow = selected.resolution ?? await resolveStoredBuild(options, selected);
    return {
      build: workflow,
      buildResolution: createResolution({
        kind: "build",
        mode: "selected",
        entry: workflow.entry,
        root: selected.entryRoot,
        workspaceRoot: options.workspaceRoot,
        sessionRoot: options.sessionRoot,
        id: workflow.manifest.id,
        revision: workflow.manifest.revision,
        hash: workflow.sourceHash,
        candidates: records.map((record) => record.candidate.entry),
        reason: selection.reason,
      }),
    };
  }

  const id = request.id ?? generatedId("build", options.project.primary_build_system);
  const revision = request.revision ?? nextRevision(
    records.map((record) => record.candidate),
    id,
  );
  const entry = generatedEntry(options.workspaceRoot, "build", id, revision);
  await generateWorkflowSource({
    cwd: options.workspaceRoot,
    outputPath: entry,
    workflowKind: "build",
    workflowId: id,
    revision,
    sourceTemplate: buildWorkflowSourceTemplate(options.workspaceRoot, id, revision),
    taskContext: options.taskContext,
    measuredHost: JSON.stringify(options.host, null, 2),
    measuredProject: JSON.stringify(options.project, null, 2),
    timeoutMs: options.workflowTimeoutMs,
  });
  const workflow = await resolveBuildWorkflow({
    entry,
    workflowId: id,
    revision,
    cwd: options.workspaceRoot,
    entryRoot: options.workspaceRoot,
    workspaceRoot: options.workspaceRoot,
    host: options.host,
    project: options.project,
  });
  return {
    build: workflow,
    buildResolution: createResolution({
      kind: "build",
      mode: "generated",
      entry: workflow.entry,
      root: options.workspaceRoot,
      workspaceRoot: options.workspaceRoot,
      sessionRoot: options.sessionRoot,
      id: workflow.manifest.id,
      revision: workflow.manifest.revision,
      hash: workflow.sourceHash,
      candidates: records.map((record) => record.candidate.entry),
      reason: selection.reason,
    }),
  };
}

async function buildCandidates(
  options: WorkflowResolutionOptions,
  request: WorkflowRequest,
): Promise<BuildCandidateRecord[]> {
  const records: BuildCandidateRecord[] = [];
  if (request.entry !== undefined) records.push(await inspectProvidedBuild(options, request));

  for (const candidate of discoverBuildWorkflows(
    options.workspaceRoot,
    options.host,
    options.project,
  )) {
    if (candidate.entry === null || candidate.manifest === null) continue;
    records.push({
      candidate: {
        id: candidate.manifest.id,
        revision: candidate.manifest.revision,
        source: "existing",
        entry: relativeEntry(options.workspaceRoot, candidate.entry),
        status: candidate.status,
        reasons: candidate.reasons,
      },
      entry: candidate.entry,
      entryRoot: options.workspaceRoot,
      manifestPath: candidate.manifestPath,
    });
  }
  return records;
}

async function inspectProvidedBuild(
  options: WorkflowResolutionOptions,
  request: WorkflowRequest,
): Promise<BuildCandidateRecord> {
  if (request.entry === undefined) throw new Error("provided BuildWorkflow requires entry");
  const source = requestedSource(request, options.workspaceRoot);
  const fallbackId = request.id ?? "provided-build-workflow";
  const fallbackRevision = request.revision ?? 1;
  try {
    const resolution = await resolveBuildWorkflow({
      entry: source.entry,
      workflowId: request.id,
      revision: request.revision,
      cwd: options.workspaceRoot,
      entryRoot: source.root,
      workspaceRoot: options.workspaceRoot,
      host: options.host,
      project: options.project,
    });
    return {
      candidate: {
        id: resolution.manifest.id,
        revision: resolution.manifest.revision,
        source: "provided",
        entry: displayEntry(source.root, source.entry, options.workspaceRoot),
        status: resolution.manifest.status === "draft" ? "draft" : "valid",
        reasons: [],
      },
      entry: source.entry,
      entryRoot: source.root,
      resolution,
    };
  } catch (error) {
    return {
      candidate: {
        id: fallbackId,
        revision: fallbackRevision,
        source: "provided",
        entry: displayEntry(source.root, source.entry, options.workspaceRoot),
        status: "invalid",
        reasons: [errorMessage(error)],
      },
      entry: source.entry,
      entryRoot: source.root,
    };
  }
}

async function resolveStoredBuild(
  options: WorkflowResolutionOptions,
  selected: BuildCandidateRecord,
): Promise<BuildWorkflowResolution> {
  if (selected.manifestPath === undefined) {
    throw new Error("selected BuildWorkflow has no persisted manifest path");
  }
  const stored = loadBuildWorkflow(selected.manifestPath, options.workspaceRoot);
  if (stored.output === null) {
    throw new Error("selected BuildWorkflow has no persisted output");
  }
  return resolveBuildWorkflow({
    entry: stored.entry,
    workflowId: selected.candidate.id,
    revision: selected.candidate.revision,
    cwd: options.workspaceRoot,
    entryRoot: options.workspaceRoot,
    workspaceRoot: options.workspaceRoot,
    host: options.host,
    project: options.project,
  });
}

async function resolveTest(options: WorkflowResolutionOptions, build: {
  build: BuildWorkflowResolution;
  buildResolution: WorkflowResolution;
}): Promise<{
  test: TestWorkflowResolution;
  testResolution: WorkflowResolution;
}> {
  const request = options.test ?? {};
  if (request.force && request.entry === undefined) {
    throw new Error("forced TestWorkflow requires entry");
  }

  if (request.force && request.entry !== undefined) {
    const provided = await inspectProvidedTest(options, request, build.build.output);
    if (provided.resolution === undefined) {
      throw new Error(`forced TestWorkflow is unusable: ${provided.candidate.reasons.join("; ")}`);
    }
    return {
      test: provided.resolution,
      testResolution: createResolution({
        kind: "test",
        mode: "forced",
        entry: provided.resolution.entry,
        root: provided.entryRoot,
        workspaceRoot: options.workspaceRoot,
        sessionRoot: options.sessionRoot,
        id: provided.resolution.manifest.id,
        revision: provided.resolution.manifest.revision,
        hash: provided.resolution.sourceHash,
        candidates: [provided.candidate.entry],
        buildWorkflow: build.build.output,
        reason: "user-forced TestWorkflow",
      }),
    };
  }

  const records = await testCandidates(options, request, build.build.output);
  const selection = records.length > 0
    ? await selectWorkflow({
        repoDir: options.workspaceRoot,
        workflowKind: "test",
        candidates: records.map((record) => record.candidate),
        taskContext: options.taskContext,
      })
    : generatedSelection("no TestWorkflow candidate was available");

  if (selection.decision === "use" && selection.candidate_index !== null) {
    const selected = records[selection.candidate_index];
    if (selected === undefined) throw new Error("selected TestWorkflow candidate disappeared");
    const workflow = selected.resolution ?? await resolveStoredTest(options, selected, build.build.output);
    return {
      test: workflow,
      testResolution: createResolution({
        kind: "test",
        mode: "selected",
        entry: workflow.entry,
        root: selected.entryRoot,
        workspaceRoot: options.workspaceRoot,
        sessionRoot: options.sessionRoot,
        id: workflow.manifest.id,
        revision: workflow.manifest.revision,
        hash: workflow.sourceHash,
        candidates: records.map((record) => record.candidate.entry),
        buildWorkflow: build.build.output,
        reason: selection.reason,
      }),
    };
  }

  const id = request.id ?? generatedId("test", options.project.primary_build_system);
  const revision = request.revision ?? nextRevision(
    records.map((record) => record.candidate),
    id,
  );
  const entry = generatedEntry(options.workspaceRoot, "test", id, revision);
  await generateWorkflowSource({
    cwd: options.workspaceRoot,
    outputPath: entry,
    workflowKind: "test",
    workflowId: id,
    revision,
    sourceTemplate: testWorkflowSourceTemplate(options.workspaceRoot, id, revision, build.build.output),
    selectedBuildWorkflow: JSON.stringify(build.build.output, null, 2),
    taskContext: options.taskContext,
    measuredHost: JSON.stringify(options.host, null, 2),
    measuredProject: JSON.stringify(options.project, null, 2),
    timeoutMs: options.workflowTimeoutMs,
  });
  const workflow = await resolveTestWorkflow({
    entry,
    entryRoot: options.workspaceRoot,
    workspaceRoot: options.workspaceRoot,
    workflowId: id,
    revision,
    buildWorkflow: build.build.output,
    host: options.host,
    project: options.project,
  });
  return {
    test: workflow,
    testResolution: createResolution({
      kind: "test",
      mode: "generated",
      entry: workflow.entry,
      root: options.workspaceRoot,
      workspaceRoot: options.workspaceRoot,
      sessionRoot: options.sessionRoot,
      id: workflow.manifest.id,
      revision: workflow.manifest.revision,
      hash: workflow.sourceHash,
      candidates: records.map((record) => record.candidate.entry),
      buildWorkflow: build.build.output,
      reason: selection.reason,
    }),
  };
}

async function testCandidates(
  options: WorkflowResolutionOptions,
  request: WorkflowRequest,
  build: BuildWorkflowOutputValue,
): Promise<TestCandidateRecord[]> {
  const records: TestCandidateRecord[] = [];
  if (request.entry !== undefined) records.push(await inspectProvidedTest(options, request, build));

  for (const candidate of discoverTestWorkflows(
    options.workspaceRoot,
    options.host,
    options.project,
  )) {
    if (candidate.entry === null || candidate.manifest === null) continue;
    let status = candidate.status;
    const reasons = [...candidate.reasons];
    if (reasons.length === 0 && (status === "valid" || status === "draft")) {
      try {
        const stored = loadTestWorkflow(candidate.manifestPath, options.workspaceRoot);
        if (stored.workflow === null) {
          status = "invalid";
          reasons.push("persisted TestWorkflow has no output");
        } else if (
          stored.workflow.build_workflow_id !== build.workflow_id ||
          stored.workflow.build_workflow_revision !== build.workflow_revision
        ) {
          status = "incompatible";
          reasons.push("TestWorkflow references a different BuildWorkflow");
        }
      } catch (error) {
        status = "stale";
        reasons.push(errorMessage(error));
      }
    }
    records.push({
      candidate: {
        id: candidate.manifest.id,
        revision: candidate.manifest.revision,
        source: "existing",
        entry: relativeEntry(options.workspaceRoot, candidate.entry),
        status,
        reasons,
      },
      entry: candidate.entry,
      entryRoot: options.workspaceRoot,
      manifestPath: candidate.manifestPath,
    });
  }
  return records;
}

async function inspectProvidedTest(
  options: WorkflowResolutionOptions,
  request: WorkflowRequest,
  build: BuildWorkflowOutputValue,
): Promise<TestCandidateRecord> {
  if (request.entry === undefined) throw new Error("provided TestWorkflow requires entry");
  const source = requestedSource(request, options.workspaceRoot);
  const fallbackId = request.id ?? "provided-test-workflow";
  const fallbackRevision = request.revision ?? 1;
  try {
    const resolution = await resolveTestWorkflow({
      entry: source.entry,
      entryRoot: source.root,
      workspaceRoot: options.workspaceRoot,
      workflowId: request.id ?? "provided-test-workflow",
      revision: request.revision ?? 1,
      buildWorkflow: build,
      host: options.host,
      project: options.project,
    });
    return {
      candidate: {
        id: resolution.manifest.id,
        revision: resolution.manifest.revision,
        source: "provided",
        entry: displayEntry(source.root, source.entry, options.workspaceRoot),
        status: resolution.manifest.status === "draft" ? "draft" : "valid",
        reasons: [],
      },
      entry: source.entry,
      entryRoot: source.root,
      resolution,
    };
  } catch (error) {
    return {
      candidate: {
        id: fallbackId,
        revision: fallbackRevision,
        source: "provided",
        entry: displayEntry(source.root, source.entry, options.workspaceRoot),
        status: "invalid",
        reasons: [errorMessage(error)],
      },
      entry: source.entry,
      entryRoot: source.root,
    };
  }
}

async function resolveStoredTest(
  options: WorkflowResolutionOptions,
  selected: TestCandidateRecord,
  build: BuildWorkflowOutputValue,
): Promise<TestWorkflowResolution> {
  if (selected.manifestPath === undefined) {
    throw new Error("selected TestWorkflow has no persisted manifest path");
  }
  const stored = loadTestWorkflow(selected.manifestPath, options.workspaceRoot);
  if (stored.workflow === null) throw new Error("selected TestWorkflow has no persisted output");
  return resolveTestWorkflow({
    entry: stored.entry,
    entryRoot: options.workspaceRoot,
    workspaceRoot: options.workspaceRoot,
    workflowId: selected.candidate.id,
    revision: selected.candidate.revision,
    buildWorkflow: build,
    host: options.host,
    project: options.project,
  });
}

function createResolution(options: {
  readonly kind: "build" | "test";
  readonly mode: "forced" | "selected" | "generated";
  readonly entry: string;
  readonly root: string;
  readonly workspaceRoot: string;
  readonly sessionRoot: string;
  readonly id: string;
  readonly revision: number;
  readonly hash: string;
  readonly candidates: readonly string[];
  readonly buildWorkflow?: BuildWorkflowOutputValue;
  readonly reason: string;
}): WorkflowResolution {
  return WorkflowResolution.parse({
    kind: "workflow-resolution",
    version: 1,
    workflow_kind: options.kind,
    mode: options.mode,
    workflow_id: options.id,
    workflow_revision: options.revision,
    build_workflow: options.buildWorkflow === undefined
      ? null
      : {
          id: options.buildWorkflow.workflow_id,
          revision: options.buildWorkflow.workflow_revision,
        },
    entry_root: logicalRootKind(options.root, options.workspaceRoot, options.sessionRoot),
    root_path: resolve(options.root),
    entry: relativeEntry(options.root, options.entry),
    source_hash: options.hash,
    candidate_entries: [...options.candidates],
    reason: options.reason,
  });
}

function requestedSource(
  request: WorkflowRequest,
  workspaceRoot: string,
): { entry: string; root: string } {
  if (request.entry === undefined) throw new Error("workflow entry is required");
  const root = resolve(request.entryRoot ?? workspaceRoot);
  const entry = isAbsolute(request.entry)
    ? resolve(request.entry)
    : resolve(root, request.entry);
  return { entry, root };
}

function generatedEntry(
  workspaceRoot: string,
  kind: "build" | "test",
  id: string,
  revision: number,
): string {
  const safeId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  const directory = join(workspaceRoot, ".refactor", "generated-workflows", kind);
  mkdirSync(directory, { recursive: true });
  return join(directory, `${safeId}-r${String(revision)}.ts`);
}

function relativeEntry(root: string, entry: string): string {
  const value = relative(resolve(root), resolve(entry)).replaceAll("\\", "/");
  return value.length === 0 ? "." : value;
}

function displayEntry(root: string, entry: string, workspaceRoot: string): string {
  if (logicalRootKind(root, workspaceRoot, "") === "workspace") {
    return relativeEntry(workspaceRoot, entry);
  }
  return `external:${relativeEntry(root, entry)}`;
}

function logicalRootKind(
  root: string,
  workspaceRoot: string,
  sessionRoot: string,
): "workspace" | "external" | "session" {
  if (isWithin(root, workspaceRoot)) return "workspace";
  if (sessionRoot.length > 0 && isWithin(root, sessionRoot)) return "session";
  return "external";
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function generatedSelection(reason: string): {
  decision: "generate";
  candidate_index: null;
  reason: string;
} {
  return { decision: "generate", candidate_index: null, reason };
}

function generatedId(kind: "build" | "test", system: string | null): string {
  return `generated-${kind}-${system ?? "c"}`;
}

function nextRevision(candidates: readonly WorkflowSelectionCandidate[], id: string): number {
  const revisions = candidates
    .filter((candidate) => candidate.id === id)
    .map((candidate) => candidate.revision);
  return revisions.length === 0 ? 1 : Math.max(...revisions) + 1;
}

function buildWorkflowSourceTemplate(workspaceRoot: string, workflowId: string, revision: number): string {
  const facts = parseCMakeFacts(workspaceRoot);
  if (facts.appTarget === null) {
    throw new Error("cannot generate BuildWorkflow: CMakeLists.txt has no executable target containing main.c");
  }
  const output = `build/${facts.appTarget}`;
  const value = {
    kind: "build-workflow-output",
    version: 1,
    workflow_id: workflowId,
    workflow_revision: revision,
    environment: {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "cmake",
        source_dir: ".",
        build_dir: "build",
        generator: null,
        target: null,
        configure_flags: [],
        build_flags: [],
        output,
      },
      sanitizers: [],
      determinism: {
        frozen_time_epoch_ms: null,
        random_seed: null,
        intercept_headers: [],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    },
    artifact: {
      kind: "executable",
      version: 1,
      workflow_id: workflowId,
      workflow_revision: revision,
      paths: { app: output },
      metadata: { source: "host-cmake-facts" },
    },
  };
  return `export default () => (${JSON.stringify(value, null, 2)});\n`;
}

function testWorkflowSourceTemplate(
  workspaceRoot: string,
  workflowId: string,
  revision: number,
  build: BuildWorkflowOutputValue,
): string {
  const facts = parseCMakeFacts(workspaceRoot);
  if (facts.testNames.length === 0) {
    throw new Error("cannot generate TestWorkflow: CMakeLists.txt has no add_test(NAME ...) entry");
  }
  const buildSpec = build.environment.build;
  const buildDir = "kind" in buildSpec && (buildSpec.kind === "cmake" || buildSpec.kind === "ninja")
    ? buildSpec.build_dir
    : "build";
  const value = {
    kind: "test-workflow",
    version: 1,
    workflow_id: workflowId,
    workflow_revision: revision,
    runner: "ctest",
    build_workflow_id: build.workflow_id,
    build_workflow_revision: build.workflow_revision,
    build_dir: buildDir,
    configuration: "Debug",
    extra_args: [],
    required_top_level_tests: facts.testNames,
    environment: {},
  };
  return `export default () => (${JSON.stringify(value, null, 2)});\n`;
}

interface CMakeFacts {
  readonly appTarget: string | null;
  readonly testNames: string[];
}

function parseCMakeFacts(workspaceRoot: string): CMakeFacts {
  const path = join(workspaceRoot, "CMakeLists.txt");
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot generate Workflow: unable to read CMakeLists.txt: ${errorMessage(error)}`);
  }

  const appTargets: string[] = [];
  const executablePattern = /\badd_executable\s*\(\s*([A-Za-z_][A-Za-z0-9_.-]*)\s+([^)]*)\)/gim;
  for (const match of source.matchAll(executablePattern)) {
    const target = match[1];
    const argumentsText = match[2] ?? "";
    if (target !== undefined && /(?:^|[\s"'\\/])main\.c(?:$|[\s"'])/i.test(argumentsText)) {
      appTargets.push(target);
    }
  }

  const testNames: string[] = [];
  const testPattern = /\badd_test\s*\(\s*NAME\s+([A-Za-z_][A-Za-z0-9_.-]*)/gim;
  for (const match of source.matchAll(testPattern)) {
    const name = match[1];
    if (name !== undefined && !testNames.includes(name)) testNames.push(name);
  }
  return { appTarget: appTargets[0] ?? null, testNames };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
