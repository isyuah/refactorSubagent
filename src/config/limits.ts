import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  extractConfigArgs,
  resolveLayeredConfig,
  type FileCheck,
  type LayerOverrides,
  type LayeredConfigSpec,
} from "./layers.js";

/**
 * Limits — every timeout and resource cap the host applies, resolved from
 * layered config so a project can raise or lift them without code changes.
 *
 * Layers, later wins (see `layers.ts` for the shared engine):
 *   1. DEFAULT_LIMITS (this file)
 *   2. ~/.refactor/limits.json            (user)
 *   3. <repo>/.refactor/limits.json       (project)
 *   4. --limits-file <path> ...           (explicit, in order)
 *   5. --limit <key.path>=<value> ...     (single values, in order)
 *
 * Time budgets default to `null` (unbounded): a deadline tuned for a small
 * project kills a healthy large one, and the failure surfaces as an opaque
 * "timeout" instead of a result. `null` at any layer lifts a limit set by a
 * lower layer; an absent key inherits. Projects that want a guard rail opt in
 * by setting a number.
 *
 * Not configurable here, by design: the session dead-stream watchdog defaults
 * stay (they catch a killed SDK subprocess, not a slow project), and ready
 * probes stay short (they wait on a socket/file, not on work).
 */

const NullablePositiveInt = z.union([z.number().int().positive(), z.null()]);
const PositiveInt = z.number().int().positive();

/** Budgets for one agent session. */
export const SessionLimits = z
  .object({
    /** Wall-clock budget for the whole session. null = no deadline. */
    deadlineMs: NullablePositiveInt,
    /** Silence window that declares the SDK stream dead. null = disabled. */
    stallMs: NullablePositiveInt,
    /** Max assistant turns. null = SDK default. */
    maxTurns: NullablePositiveInt,
  })
  .strict();

/** Caps applied to workflow-driven process/file access. */
export const ResourceLimits = z
  .object({
    maxProcesses: PositiveInt,
    maxOutputBytes: PositiveInt,
    maxFileBytes: PositiveInt,
  })
  .strict();

export const Limits = z
  .object({
    version: z.literal(1),
    sessions: z
      .object({
        testWriter: SessionLimits,
        refactor: SessionLimits,
      })
      .strict(),
    /** Budgets for host-driven stages; null = no deadline. */
    stages: z
      .object({
        /** One BuildWorkflow execution on one worktree. */
        buildMs: NullablePositiveInt,
        /** One complete CTest suite run. */
        ctestMs: NullablePositiveInt,
        /** One self-driven TestWorkflow run on one worktree. */
        testWorkflowMs: NullablePositiveInt,
        /**
         * Rewrite sessions allowed when a produced workflow source violates the
         * source policy (0 = reject immediately). Each attempt re-validates.
         */
        policyRepairs: z.number().int().min(0).max(5),
      })
      .strict(),
    commands: z
      .object({
        /** Default for workflow `ctx.process.run` calls that omit timeoutMs. null = no deadline. */
        processMs: NullablePositiveInt,
        /** Cap for file/TCP ready probes. */
        readyMs: PositiveInt,
      })
      .strict(),
    resources: z
      .object({
        build: ResourceLimits,
        test: ResourceLimits,
      })
      .strict(),
    probes: z
      .object({
        /** Per-tool timeout while measuring the host. */
        hostMs: PositiveInt,
      })
      .strict(),
  })
  .strict();

export type Limits = z.infer<typeof Limits>;
export type SessionLimits = z.infer<typeof SessionLimits>;
export type ResourceLimits = z.infer<typeof ResourceLimits>;

/**
 * Every string-keyed field is a limit; null means "no limit" for the time
 * budgets and is rejected for the resource caps.
 */
export const DEFAULT_LIMITS: Limits = {
  version: 1,
  sessions: {
    testWriter: { deadlineMs: null, stallMs: 180_000, maxTurns: 48 },
    refactor: { deadlineMs: null, stallMs: 180_000, maxTurns: 80 },
  },
  stages: { buildMs: null, ctestMs: null, testWorkflowMs: null, policyRepairs: 1 },
  commands: { processMs: null, readyMs: 10_000 },
  resources: {
    build: { maxProcesses: 4, maxOutputBytes: 16 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 },
    test: { maxProcesses: 4, maxOutputBytes: 32 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 },
  },
  probes: { hostMs: 30_000 },
};

/** Config-file schema: same shape, every field optional, unknown keys rejected. */
const LimitsFile = Limits.deepPartial();

export interface ResolvedLimits {
  readonly limits: Limits;
  /** Files that existed and contributed, in merge order. */
  readonly sources: readonly string[];
  /** Paths that were checked but do not exist (diagnostics only). */
  readonly missing: readonly string[];
}

/** Layer paths for a repo, in merge order. */
export function limitsPaths(repoRoot: string, homeDir = homedir()): string[] {
  return [
    join(homeDir, ".refactor", "limits.json"),
    join(repoRoot, ".refactor", "limits.json"),
  ];
}

const LIMITS_LAYERS: LayeredConfigSpec<{ repoRoot: string; homeDir: string }, Limits> = {
  name: "limits",
  overrideNoun: "limit",
  defaults: DEFAULT_LIMITS,
  resolve: (merged) => Limits.parse(merged),
  checkFile: checkLimitsFile,
  paths: ({ repoRoot, homeDir }) => limitsPaths(repoRoot, homeDir),
  parseValue: (text, raw) => {
    if (text === "null") return null;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`limit override '${raw}' needs a positive number or null`);
    }
    return value;
  },
};

function checkLimitsFile(json: unknown): FileCheck {
  const parsed = LimitsFile.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  if (issue === undefined) return { ok: false, issue: "schema mismatch" };
  const path = issue.path.join(".");
  return { ok: false, issue: path.length > 0 ? `${path}: ${issue.message}` : issue.message };
}

/**
 * Resolve the effective limits for one run. Throws on a malformed file or an
 * unknown override key: a typo must not silently keep the old budget.
 */
export function resolveLimits(options: {
  readonly repoRoot: string;
  readonly overrides?: LayerOverrides;
  /** Override for the user-level directory; tests point this at a temp dir. */
  readonly homeDir?: string;
}): ResolvedLimits {
  const resolved = resolveLayeredConfig(
    LIMITS_LAYERS,
    { repoRoot: options.repoRoot, homeDir: options.homeDir ?? homedir() },
    options.overrides,
  );
  return { limits: resolved.value, sources: resolved.sources, missing: resolved.missing };
}

/** One-line summary for logs and run records. */
export function describeLimits(limits: Limits): string {
  const ms = (value: number | null): string => (value === null ? "none" : `${String(value)}ms`);
  return [
    `sessions: testWriter=${ms(limits.sessions.testWriter.deadlineMs)}`,
    `refactor=${ms(limits.sessions.refactor.deadlineMs)}`,
    `stages: build=${ms(limits.stages.buildMs)} ctest=${ms(limits.stages.ctestMs)} testWorkflow=${ms(limits.stages.testWorkflowMs)} policyRepairs=${String(limits.stages.policyRepairs)}`,
    `commands: process=${ms(limits.commands.processMs)}`,
  ].join("; ");
}

/**
 * Pull `--limits-file <path>` and `--limit <key.path>=<value>` out of an argv
 * list. Both are repeatable; everything else is returned untouched so each
 * entry point can parse its own options. Unknown `--limit*` forms are left in
 * the remaining args for the caller to reject.
 */
export function extractLimitArgs(argv: readonly string[]): {
  readonly overrides: LayerOverrides;
  readonly remaining: readonly string[];
} {
  return extractConfigArgs(argv, { file: "--limits-file", value: "--limit" });
}
