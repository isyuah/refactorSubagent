import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildWorkflowOutput as BuildWorkflowOutputValue } from "../artifacts/index.js";

/**
 * Workflow source generation strategy.
 *
 * The orchestrator only needs "produce a source module at outputPath for this
 * identity". Concrete strategies decide HOW: the built-in CMake-facts
 * template generator, a future external generator, or a model-only strategy
 * with no host template. Swapping the strategy never changes orchestration.
 */
export interface WorkflowGenerationStrategy {
  readonly kind: "build" | "test";
  /**
   * Complete host-authoritative source, or null when the strategy cannot
   * derive one from the project (e.g. non-CMake or complex CMake). A null
   * result routes generation to the model-driven path.
   */
  template(options: {
    readonly workspaceRoot: string;
    readonly workflowId: string;
    readonly revision: number;
    readonly build?: BuildWorkflowOutputValue;
  }): string | null;
}

/** Built-in strategy: derive BuildWorkflow/TestWorkflow source from CMakeLists.txt facts. */
export class CMakeFactsGenerationStrategy implements WorkflowGenerationStrategy {
  constructor(readonly kind: "build" | "test") {}

  template(options: {
    readonly workspaceRoot: string;
    readonly workflowId: string;
    readonly revision: number;
    readonly build?: BuildWorkflowOutputValue;
  }): string | null {
    if (this.kind === "build") {
      return buildWorkflowSourceTemplate(options.workspaceRoot, options.workflowId, options.revision);
    }
    if (options.build === undefined) {
      // workflow-driven builds have no static plan; the TestWorkflow cannot
      // be derived from build facts, so fall back to model-driven generation.
      return null;
    }
    return testWorkflowSourceTemplate(
      options.workspaceRoot,
      options.workflowId,
      options.revision,
      options.build,
    );
  }
}

function buildWorkflowSourceTemplate(workspaceRoot: string, workflowId: string, revision: number): string | null {
  const facts = parseCMakeFacts(workspaceRoot);
  if (facts.appTarget === null) {
    return null;
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
): string | null {
  const facts = parseCMakeFacts(workspaceRoot);
  if (facts.testNames.length === 0) {
    return null;
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
    return { appTarget: null, testNames: [] };
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

