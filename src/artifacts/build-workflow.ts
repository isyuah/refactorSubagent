import { z } from "zod";
import { EnvironmentSpec } from "./environment-spec.js";
import { RelPath, Sha256Hex } from "./common.js";

export const BuildArtifactKind = z.enum([
  "executable",
  "library",
  "test-suite",
  "service",
  "custom",
]);
export type BuildArtifactKind = z.infer<typeof BuildArtifactKind>;

export const BuildArtifact = z.object({
  kind: BuildArtifactKind,
  version: z.literal(1),
  workflow_id: z.string().min(1),
  workflow_revision: z.number().int().positive(),
  /** Logical artifact name → repo-relative path. */
  paths: z.record(RelPath).refine((paths) => Object.keys(paths).length > 0, {
    message: "build artifact must expose at least one logical path",
  }),
  metadata: z.record(z.unknown()).default({}),
});
export type BuildArtifact = z.infer<typeof BuildArtifact>;

export const BuildWorkflowOutput = z.object({
  kind: z.literal("build-workflow-output"),
  version: z.literal(1),
  workflow_id: z.string().min(1),
  workflow_revision: z.number().int().positive(),
  /** Compatibility bridge to the current Adapter-backed executor. */
  environment: EnvironmentSpec,
  artifact: BuildArtifact,
});
export type BuildWorkflowOutput = z.infer<typeof BuildWorkflowOutput>;

export const BuildWorkflowAppliesTo = z.object({
  build_systems: z.array(z.string()).default([]),
  markers: z.array(z.string()).default([]),
  platforms: z.array(z.string()).default([]),
  architectures: z.array(z.string()).default([]),
  required_tools: z.array(z.string()).default([]),
});

export const BuildWorkflowManifest = z.object({
  kind: z.literal("build-workflow-manifest"),
  version: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  entry: RelPath,
  source_hash: Sha256Hex,
  workflow_api_version: z.literal(1),
  applies_to: BuildWorkflowAppliesTo.default({}),
  /** Human/agent-facing description of what this workflow builds and produces. */
  description: z.string().max(2048).default(""),
  status: z.enum(["draft", "verified"]).default("draft"),
});
export type BuildWorkflowManifest = z.infer<typeof BuildWorkflowManifest>;
