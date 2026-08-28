import { z } from "zod";
import { CTestSuiteSpec } from "./ctest-suite.js";
import { RelPath, Sha256Hex } from "./common.js";
import { TestSpec } from "./test-spec.js";

const WorkflowIdentity = z.object({
  workflow_id: z.string().min(1),
  workflow_revision: z.number().int().positive(),
});

const AppliesTo = z.object({
  build_systems: z.array(z.string()).default([]),
  markers: z.array(z.string()).default([]),
  platforms: z.array(z.string()).default([]),
  architectures: z.array(z.string()).default([]),
  required_tools: z.array(z.string()).default([]),
});

const TestWorkflowBase = z.object({
  kind: z.literal("test-workflow"),
  version: z.literal(1),
}).merge(WorkflowIdentity);

/** A reusable test-environment declaration. Runtime limits remain host-owned. */
export const CTestWorkflow = TestWorkflowBase.extend({
  runner: z.literal("ctest"),
  build_workflow_id: z.string().min(1),
  build_workflow_revision: z.number().int().positive(),
  /** Build directory produced by the selected BuildWorkflow. */
  build_dir: RelPath.default("build"),
  configuration: z.string().min(1).default("Debug"),
  /** Additional ctest argv, excluding host-owned timeout policy. */
  extra_args: z.array(z.string()).default([]),
  /** Top-level tests that must be present in the CTest output. */
  required_top_level_tests: z.array(z.string().min(1)).default([]),
  environment: z.record(z.string()).default({}),
});

/** Compatibility runner for projects whose observable tests are TestSpec cases. */
export const TestSpecWorkflow = TestWorkflowBase.extend({
  runner: z.literal("test-spec"),
  build_workflow_id: z.string().min(1),
  build_workflow_revision: z.number().int().positive(),
  test_spec: TestSpec,
});

export const TestWorkflow = z.union([CTestWorkflow, TestSpecWorkflow]);
export type CTestWorkflow = z.infer<typeof CTestWorkflow>;
export type TestSpecWorkflow = z.infer<typeof TestSpecWorkflow>;
export type TestWorkflow = z.infer<typeof TestWorkflow>;

export const TestWorkflowManifest = z.object({
  kind: z.literal("test-workflow-manifest"),
  version: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  entry: RelPath,
  source_hash: Sha256Hex,
  workflow_api_version: z.literal(1),
  applies_to: AppliesTo.default({}),
  status: z.enum(["draft", "verified"]).default("draft"),
});
export type TestWorkflowManifest = z.infer<typeof TestWorkflowManifest>;

/** Final CTest execution settings materialized by the program, not by Claude. */
export const CTestMaterializationPolicy = z.object({
  timeout_ms: z.number().int().positive().default(1_200_000),
  parallelism: z.number().int().positive().default(1),
});
export type CTestMaterializationPolicy = z.infer<typeof CTestMaterializationPolicy>;

export function isCTestWorkflow(workflow: TestWorkflow): workflow is CTestWorkflow {
  return workflow.runner === "ctest";
}

export function materializeCTestSuiteSpec(
  workflow: CTestWorkflow,
  policy: CTestMaterializationPolicy,
): z.infer<typeof CTestSuiteSpec> {
  return CTestSuiteSpec.parse({
    kind: "ctest-suite-spec",
    version: 1,
    build_dir: workflow.build_dir,
    configuration: workflow.configuration,
    timeout_ms: policy.timeout_ms,
    parallelism: policy.parallelism,
    extra_args: [...workflow.extra_args],
    environment: { ...workflow.environment },
  });
}
