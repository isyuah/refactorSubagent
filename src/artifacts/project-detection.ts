import { z } from "zod";
import { RelPath } from "./common.js";

export const BuildSystem = z.enum([
  "cmake",
  "ninja",
  "make",
  "msvc",
  "direct-c",
]);

export const BuildAdapterId = z.enum([
  "cmake",
  "ninja",
  "make",
  "msvc",
  "direct-compiler",
  "unsupported",
]);

export const ProjectDetectionStatus = z.enum([
  "detected",
  "no-c-sources",
  // Accepted when reopening historical audit artifacts. New detection only
  // reports discovery; these old values are not evidence of build feasibility.
  "ready",
  "needs-adapter",
]);

/**
 * Project Detection — source inventory and build markers, independent of host
 * tools. The selected workflow must establish actual build feasibility.
 */
export const ProjectDetection = z.object({
  kind: z.literal("project-detection"),
  version: z.literal(1),
  repo_root: z.string().min(1),
  language: z.literal("c"),
  build_systems: z.array(BuildSystem),
  primary_build_system: BuildSystem.nullable(),
  markers: z.array(RelPath),
  source_files: z.array(RelPath),
  adapter: BuildAdapterId,
  status: ProjectDetectionStatus,
  reason: z.string().min(1),
});

export type BuildSystem = z.infer<typeof BuildSystem>;
export type BuildAdapterId = z.infer<typeof BuildAdapterId>;
export type ProjectDetection = z.infer<typeof ProjectDetection>;
