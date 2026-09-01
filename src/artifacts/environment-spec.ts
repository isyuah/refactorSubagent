import { z } from "zod";
import { RelPath } from "./common.js";
import { SanitizerKind } from "./sanitizer.js";

const DirectCompilerBuild = z.object({
  kind: z.literal("direct-compiler"),
  compiler: z.string().min(1),
  flags: z.array(z.string()).default([]),
  defines: z.record(z.string()).default({}),
  sources: z.array(RelPath).min(1),
  output: RelPath,
});

const CMakeBuild = z.object({
  kind: z.literal("cmake"),
  /** Directory containing CMakeLists.txt, relative to the worktree root. */
  source_dir: RelPath.default("."),
  /** Out-of-source CMake build directory. */
  build_dir: RelPath.default("build"),
  /** Optional generator, e.g. `Ninja`; null lets CMake choose. */
  generator: z.string().min(1).nullable().default(null),
  /** Optional CMake target; null uses the default all target. */
  target: z.string().min(1).nullable().default(null),
  configure_flags: z.array(z.string()).default([]),
  build_flags: z.array(z.string()).default([]),
  /** Expected repo-relative executable path after the build. */
  output: RelPath,
});
const NinjaBuild = z.object({
  kind: z.literal("ninja"),
  /** Directory containing build.ninja, relative to the worktree root. */
  build_dir: RelPath.default("."),
  /** Optional Ninja target; null builds the graph's default target. */
  target: z.string().min(1).nullable().default(null),
  build_flags: z.array(z.string()).default([]),
  /** Expected repo-relative executable path after the build. */
  output: RelPath,
});

/**
 * Commanded by the workflow function itself: the host re-runs the workflow
 * and the function drives the build through injected capabilities. The
 * workflow returns artifact paths in its result; no declarative plan exists.
 */
const WorkflowDrivenBuild = z.object({
  kind: z.literal("workflow-driven"),
});

const ShellCommandBuild = z.object({
  kind: z.literal("shell-command"),
  command: z.string().min(1),
  binary: RelPath,
});

/** Pre-structured-plan shape retained for old sessions and fixtures. */
const LegacyBuild = z.object({
  cc: z.string().min(1).default("gcc"),
  flags: z.array(z.string()).default([]),
  defines: z.record(z.string()).default({}),
  command: z.string().min(1),
  binary: RelPath,
});
 export const BuildSpec = z.union([
   DirectCompilerBuild,
   CMakeBuild,
   NinjaBuild,
  WorkflowDrivenBuild,
   ShellCommandBuild,
   LegacyBuild,
 ]);

export const EnvironmentSpec = z.object({
  kind: z.literal("environment-spec"),
  version: z.literal(1),
  build: BuildSpec,
  /** Requested instrumentation; HostPreflight must prove each one available. */
  sanitizers: z.array(SanitizerKind).default([]),
  determinism: z.object({
    frozen_time_epoch_ms: z.number().int().nullable(),
    random_seed: z.number().int().nullable(),
    intercept_headers: z.array(RelPath).default([]),
  }),
  sandbox: z.object({
    run_cwd_strategy: z.literal("fresh_temp_dir"),
  }),
});

export type BuildSpec = z.infer<typeof BuildSpec>;
export type DirectCompilerBuild = z.infer<typeof DirectCompilerBuild>;
export type NinjaBuild = z.infer<typeof NinjaBuild>;
export type WorkflowDrivenBuildSpec = z.infer<typeof WorkflowDrivenBuild>;
export type EnvironmentSpec = z.infer<typeof EnvironmentSpec>;
