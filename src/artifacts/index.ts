import { z } from "zod";
import { BehaviorContract } from "./behavior-contract.js";
import { ScopeManifest } from "./scope-manifest.js";
import { DependencyManifest } from "./dependency-manifest.js";
import { EnvironmentSpec } from "./environment-spec.js";
import { TestSpec } from "./test-spec.js";
import { ObservationTrace } from "./observation-trace.js";
import { PatchRecord } from "./patch-record.js";
import { ComparisonResult } from "./comparison-result.js";
import { SanitizerResult } from "./sanitizer.js";
import { BuildWorkflowManifest, BuildWorkflowOutput } from "./build-workflow.js";
import { RefactorTestTask } from "./refactor-task.js";
import { WorkflowResolution } from "./workflow-resolution.js";
import { DeclaredBuildSet } from "./declared-build-set.js";
import { CTestBaseline, CTestCandidate, CTestComparisonResult } from "./ctest-suite.js";
import {
  ExpectationBaseline,
  ExpectationCandidate,
  ExpectationComparisonResult,
} from "./expectation-suite.js";
export * from "./common.js";
export * from "./behavior-contract.js";
export * from "./scope-manifest.js";
export * from "./dependency-manifest.js";
export * from "./environment-spec.js";
export * from "./test-spec.js";
export * from "./observation-trace.js";
export * from "./patch-record.js";
export * from "./comparison-result.js";
export * from "./host-preflight.js";
export * from "./project-detection.js";
export * from "./build-workflow.js";
export * from "./ctest-suite.js";
export * from "./sanitizer.js";
export * from "./refactor-task.js";
export * from "./test-workflow.js";
export * from "./workflow-resolution.js";
export * from "./declared-build-set.js";
export * from "./expectation-suite.js";
/** Union of every artifact kind the orchestrator accepts (some carry cross-field
 * refinements, so plain union instead of discriminatedUnion). */
export const Artifact = z.union([
  BehaviorContract,
  ScopeManifest,
  DependencyManifest,
  EnvironmentSpec,
  TestSpec,
  ObservationTrace,
  PatchRecord,
  ComparisonResult,
  SanitizerResult,
  RefactorTestTask,
  WorkflowResolution,
  DeclaredBuildSet,
  CTestBaseline,
  CTestCandidate,
  CTestComparisonResult,
  ExpectationBaseline,
  ExpectationCandidate,
  ExpectationComparisonResult,
]);
export type AnyArtifact = z.infer<typeof Artifact>;