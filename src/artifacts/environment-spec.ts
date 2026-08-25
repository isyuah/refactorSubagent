import { z } from "zod";
import { B64, RelPath } from "./common.js";

/**
 * Environment Spec — how both versions are built and made deterministic.
 * C MVP: gcc + compile-time interception of nondeterminism.
 */
export const EnvironmentSpec = z.object({
  kind: z.literal("environment-spec"),
  version: z.literal(1),

  build: z.object({
    cc: z.string().min(1).default("gcc"),
    flags: z.array(z.string()).default([]),
    defines: z.record(z.string()).default({}),
    /** Build entry producing the binary under observation, e.g. `make -f …` or explicit sources. */
    command: z.string().min(1),
    /** Repo-relative path of the produced executable, relative to worktree root. */
    binary: RelPath,
  }),

  determinism: z.object({
    /** Unix epoch ms pinned for time()/gettimeofday-derived shims. */
    frozen_time_epoch_ms: z.number().int().nullable(),
    /** Seed forced into rand()/srand shims. */
    random_seed: z.number().int().nullable(),
    /**
     * Compile-time interception headers force-fed via `-include`, e.g.
     * shim/time.h redefining time() to the frozen clock. Empty means the
     * Dependency Manifest claims no nondeterministic ambient deps.
     */
    intercept_headers: z.array(RelPath).default([]),
  }),

  sandbox: z.object({
    /** Program-visible working directory per run (fresh copy of fixtures). */
    run_cwd_strategy: z.literal("fresh_temp_dir"),
  }),
});

export type EnvironmentSpec = z.infer<typeof EnvironmentSpec>;
