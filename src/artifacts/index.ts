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
export * from "./ctest-suite.js";
export * from "./sanitizer.js";

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
]);

export type AnyArtifact = z.infer<typeof Artifact>;
