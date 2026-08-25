import { z } from "zod";

export const DepKind = z.enum([
  "pure",
  "time",
  "randomness",
  "filesystem",
  "env",
  "network",
  "stateful_external", // DB, IPC, shared memory…
  "concurrency",
]);

export const IsolationStrategy = z.enum([
  "real_isolated", // real dependency inside an isolated instance (preferred)
  "freeze", // pin nondeterministic source (fixed clock)
  "seed", // deterministic seeding (rand, PRNGs)
  "temp_sandbox", // throwaway temp dir / container
  "record_replay",
  "fake",
  "mock",
  "reject", // cannot verify safely → block refactoring touching this dep
]);

/** Default strategy per dependency kind — overridable per item. */
export const DEFAULT_STRATEGY: Record<
  z.infer<typeof DepKind>,
  z.infer<typeof IsolationStrategy>
> = {
  pure: "real_isolated",
  time: "freeze",
  randomness: "seed",
  filesystem: "temp_sandbox",
  env: "fake",
  network: "record_replay",
  stateful_external: "real_isolated",
  concurrency: "reject",
};

/**
 * Dependency Manifest — direct/transitive/ambient dependencies of the
 * modification scope and how each will be controlled during observation runs.
 */
export const DependencyManifest = z.object({
  kind: z.literal("dependency-manifest"),
  version: z.literal(1),

  dependencies: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: DepKind,
        strategy: IsolationStrategy,
        /** Where this dependency was observed: files/functions/callsites. */
        evidence: z.array(z.string().min(1)).default([]),
        notes: z.string().default(""),
      }),
    )
    .min(1),
});

export type DependencyManifest = z.infer<typeof DependencyManifest>;
