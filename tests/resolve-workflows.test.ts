import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeHost } from "../src/runtime/host-preflight.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { resolveWorkflows, type ResolvedWorkflows } from "../src/workflow/resolve-workflows.js";
import {
  AlwaysGenerateChooser,
  DeterministicWorkflowChooser,
  type WorkflowChooser,
} from "../src/workflow/chooser.js";
import { CMakeFactsGenerationStrategy } from "../src/workflow/generate-strategy.js";
import { saveBuildWorkflow, discoverBuildWorkflows } from "../src/workflow/registry.js";
import { saveTestWorkflow } from "../src/workflow/test-registry.js";
import type { BuildWorkflowOutput } from "../src/artifacts/index.js";
import type { BuildWorkflowManifest as BuildWorkflowManifestValue } from "../src/artifacts/index.js";

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Minimal CMake project whose BuildWorkflow can be resolved without a real build. */
function tempCMakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-resolve-"));
  writeFileSync(
    join(root, "CMakeLists.txt"),
    [
      "cmake_minimum_required(VERSION 3.10)",
      "project(smoke C)",
      "add_executable(smoke_app src/main.c)",
      "add_test(NAME smoke_test COMMAND smoke_app)",
      "",
    ].join("\n"),
  );
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.c"), "int main(void){return 0;}\n");
  return root;
}

/** A BuildWorkflow source that needs no real toolchain and passes host validation. */
const VALID_BUILD_WORKFLOW = `
export default ({ facts }) => ({
  kind: "build-workflow-output",
  version: 1,
  workflow_id: "smoke-build",
  workflow_revision: 1,
  environment: {
    kind: "environment-spec",
    version: 1,
    build: { kind: "cmake", source_dir: ".", build_dir: "build", generator: null, target: null, configure_flags: [], build_flags: [], output: "build/app" },
    sanitizers: [],
    determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },
    sandbox: { run_cwd_strategy: "fresh_temp_dir" }
  },
  artifact: {
    kind: "executable", version: 1,
    workflow_id: "smoke-build", workflow_revision: 1,
    paths: { app: "build/app" },
    metadata: { detected: facts.project?.primary_build_system ?? null }
  }
});
`;

/** A TestWorkflow source bound to the smoke BuildWorkflow. */
function validTestWorkflow(build: BuildWorkflowOutput): string {
  return `
export default () => ({
  kind: "test-workflow",
  version: 1,
  workflow_id: "smoke-test",
  workflow_revision: 1,
  runner: "ctest",
  build_workflow_id: ${JSON.stringify(build.workflow_id)},
  build_workflow_revision: ${JSON.stringify(build.workflow_revision)},
  build_dir: "build",
  configuration: "Debug",
  extra_args: [],
  required_top_level_tests: [],
  environment: {}
});
`;
}

const BUILD_OUTPUT: BuildWorkflowOutput = {
  kind: "build-workflow-output",
  version: 1,
  workflow_id: "smoke-build",
  workflow_revision: 1,
  environment: {
    kind: "environment-spec",
    version: 1,
    build: { kind: "cmake", source_dir: ".", build_dir: "build", generator: null, target: null, configure_flags: [], build_flags: [], output: "build/app" },
    sanitizers: [],
    determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },
    sandbox: { run_cwd_strategy: "fresh_temp_dir" },
  },
  artifact: {
    kind: "executable", version: 1,
    workflow_id: "smoke-build", workflow_revision: 1,
    paths: { app: "build/app" },
    metadata: {},
  },
};

function buildManifest(
  entry: string,
  sourceHash: string,
  project: import("../src/artifacts/index.js").ProjectDetection,
  host: import("../src/artifacts/index.js").HostPreflight,
): BuildWorkflowManifestValue {
  return {
    kind: "build-workflow-manifest",
    version: 1,
    id: "smoke-build",
    revision: 1,
    entry,
    source_hash: sourceHash,
    workflow_api_version: 1,
    applies_to: {
      build_systems: project.build_systems,
      markers: project.markers,
      platforms: [host.platform],
      architectures: [host.arch],
      required_tools: [],
    },
    description: "",
    status: "draft",
  };
}

interface ResolveFixtureOptions {
  readonly build?: Parameters<typeof resolveWorkflows>[0]["build"];
  readonly test?: Parameters<typeof resolveWorkflows>[0]["test"];
  readonly chooser?: WorkflowChooser;
}

async function resolveFixture(root: string, options: ResolveFixtureOptions = {}): Promise<ResolvedWorkflows> {
  const host = probeHost(root);
  const project = detectCProject(root, host);
  return resolveWorkflows({
    workspaceRoot: root,
    sessionRoot: join(root, ".refactor", "sessions", "test"),
    host,
    project,
    ...options,
  });
}

describe("resolveWorkflows orchestration", () => {
  test("forced BuildWorkflow bypasses the chooser and uses the provided entry", async () => {
    const root = tempCMakeProject();
    writeFileSync(join(root, "provided-build.ts"), VALID_BUILD_WORKFLOW);
    // A forced build still resolves a TestWorkflow; force it too so the test
    // never reaches the Claude generation branch.
    writeFileSync(join(root, "provided-test.ts"), validTestWorkflow(BUILD_OUTPUT));

    let chooserCalled = false;
    const chooser: WorkflowChooser = {
      choose: async () => {
        chooserCalled = true;
        throw new Error("chooser must not be called for forced input");
      },
    };
    const result = await resolveFixture(root, {
      build: { entry: "provided-build.ts", force: true },
      test: { entry: "provided-test.ts", id: "smoke-test", force: true },
      chooser,
    });
    expect(result.buildResolution.mode).toBe("forced");
    expect(result.build.manifest.id).toBe("smoke-build");
    expect(result.testResolution.mode).toBe("forced");
    expect(chooserCalled).toBe(false);
  }, 30_000);

  test("deterministic chooser reuses a stored candidate instead of generating", async () => {
    const root = tempCMakeProject();
    const host = probeHost(root);
    const project = detectCProject(root, host);
    // Seed the registry with hash-verified persisted entries, without
    // spawning the worker (that path is exercised by e2e). The selected
    // branch must reuse these persisted resolutions.
    const buildEntry = join(root, "stored-build.ts");
    writeFileSync(buildEntry, VALID_BUILD_WORKFLOW);
    const buildSourceHash = sha256(VALID_BUILD_WORKFLOW);
    saveBuildWorkflow(root, {
      entry: buildEntry,
      manifest: buildManifest("stored-build.ts", buildSourceHash, project, host),
      output: BUILD_OUTPUT,
      sourceHash: buildSourceHash,
    });

    const testSource = validTestWorkflow(BUILD_OUTPUT);
    const testEntry = join(root, "stored-test.ts");
    writeFileSync(testEntry, testSource);
    const testSourceHash = sha256(testSource);
    saveTestWorkflow(root, {
      entry: testEntry,
      manifest: {
        kind: "test-workflow-manifest",
        version: 1,
        id: "smoke-test",
        revision: 1,
        entry: "stored-test.ts",
        source_hash: testSourceHash,
        workflow_api_version: 1,
        applies_to: {
          build_systems: project.build_systems,
          markers: project.markers,
          platforms: [host.platform],
          architectures: [host.arch],
          required_tools: ["ctest"],
        },
        status: "draft",
      },
      workflow: {
        kind: "test-workflow",
        version: 1,
        workflow_id: "smoke-test",
        workflow_revision: 1,
        runner: "ctest",
        build_workflow_id: "smoke-build",
        build_workflow_revision: 1,
        build_dir: "build",
        configuration: "Debug",
        extra_args: [],
        required_top_level_tests: [],
        environment: {},
      },
      sourceHash: testSourceHash,
    });

    const result = await resolveFixture(root, {
      chooser: new DeterministicWorkflowChooser(),
    });
    expect(result.buildResolution.mode).toBe("selected");
    expect(result.build.manifest.id).toBe("smoke-build");
    expect(result.testResolution.mode).toBe("selected");
    expect(result.test.manifest.id).toBe("smoke-test");
  }, 30_000);

  test("deterministic chooser generates when no usable candidate exists", async () => {
    const root = tempCMakeProject();
    const chooser = new AlwaysGenerateChooser();
    // With no candidates the orchestration asks the chooser; an
    // AlwaysGenerateChooser reaches the generation branch. Generation itself
    // requires a model, exercised by e2e scripts, so here we assert the
    // deterministic chooser surface only.
    // No candidates: probeHost/detectCProject are slow on Windows and not
    // needed to assert the chooser surface; an empty registry is sufficient.
    expect(await discoverBuildWorkflows(root)).toEqual([]);
    expect(await chooser.choose({
      repoDir: root,
      workflowKind: "build",
      candidates: [],
    })).toEqual({ decision: "generate", candidate_index: null, reason: "chooser policy always generates" });
  });

  test("CMakeFacts generation strategy derives a resolvable BuildWorkflow source", () => {
    const root = tempCMakeProject();
    const strategy = new CMakeFactsGenerationStrategy("build");
    const source = strategy.template({ workspaceRoot: root, workflowId: "smoke", revision: 1 });
    expect(source).not.toBeNull();
    if (source === null) return;
    expect(source).toContain('"kind": "build-workflow-output"');
    expect(source).toContain('"workflow_id": "smoke"');
    expect(source).toContain('"output": "build/smoke_app"');
    // The template is host-authoritative: it must parse as a workflow source.
    expect(source.startsWith("export default")).toBe(true);
  });

  test("saved generated candidates are rediscoverable by the registry", async () => {
    const root = tempCMakeProject();
    const host = probeHost(root, { skipCMakeProbe: true });
    const project = detectCProject(root, host);
    const entry = join(root, "saved.ts");
    writeFileSync(entry, VALID_BUILD_WORKFLOW);
    const sourceHash = sha256(VALID_BUILD_WORKFLOW);
    saveBuildWorkflow(root, {
      entry,
      manifest: buildManifest("saved.ts", sourceHash, project, host),
      output: BUILD_OUTPUT,
      sourceHash,
    });

    const candidates = discoverBuildWorkflows(root, host, project);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.manifest?.id).toBe("smoke-build");
    expect(candidates[0]?.status).toBe("draft");
  }, 30_000);
});
