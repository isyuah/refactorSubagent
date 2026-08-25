import { z } from "zod";
import { RelPath } from "./common.js";

const DirectCompilerBuild = z.object({
  kind: z.literal("direct-compiler"),
  /** Logical compiler name resolved through HostPreflight.tools. */
  compiler: z.string().min(1),
  flags: z.array(z.string()).default([]),
  defines: z.record(z.string()).default({}),
  /** Translation units, repo-relative. */
  sources: z.array(RelPath).min(1),
  /** Repo-relative output path, without or with platform executable suffix. */
  output: RelPath,
});

const ShellCommandBuild = z.object({
  kind: z.literal("shell-command"),
  command: z.string().min(1),
  /** Repo-relative path of the produced executable. */
  binary: RelPath,
});

/** Pre-milestone-5 shape, retained for old sessions and fixtures. */
const LegacyBuild = z.object({
  cc: z.string().min(1).default("gcc"),
  flags: z.array(z.string()).default([]),
  defines: z.record(z.string()).default({}),
  command: z.string().min(1),
  binary: RelPath,
});

export const BuildSpec = z.union([
  DirectCompilerBuild,
  ShellCommandBuild,
  LegacyBuild,
]);

/**
 * Environment Spec — how both versions are built and made deterministic.
 * New artifacts should use `direct-compiler`; shell-command is compatibility
 * fallback only and is intentionally less portable.
 */
export const EnvironmentSpec = z.object({
  kind: z.literal("environment-spec"),
  version: z.literal(1),
  build: BuildSpec,

  determinism: z.object({
    /** Unix epoch ms pinned for time()/gettimeofday-derived shims. */
    frozen_time_epoch_ms: z.number().int().nullable(),
    /** Seed forced into rand()/srand shims. */
    random_seed: z.number().int().nullable(),
    /** Headers force-fed into every TU via compiler `-include`. */
    intercept_headers: z.array(RelPath).default([]),
  }),

  sandbox: z.object({
    /** Program-visible working directory per run (fresh copy of fixtures). */
    run_cwd_strategy: z.literal("fresh_temp_dir"),
  }),
});

export type BuildSpec = z.infer<typeof BuildSpec>;
export type DirectCompilerBuild = z.infer<typeof DirectCompilerBuild>;
export type EnvironmentSpec = z.infer<typeof EnvironmentSpec>;
