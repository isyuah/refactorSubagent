import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Limits — every timeout and resource cap the host applies, resolved from
 * layered config so a project can raise or lift them without code changes.
 *
 * Layers, later wins:
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
  stages: { buildMs: null, ctestMs: null, testWorkflowMs: null },
  commands: { processMs: null, readyMs: 10_000 },
  resources: {
    build: { maxProcesses: 4, maxOutputBytes: 16 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 },
    test: { maxProcesses: 4, maxOutputBytes: 32 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 },
  },
  probes: { hostMs: 30_000 },
};

/** Config-file schema: same shape, every field optional, unknown keys rejected. */
const LimitsFile = Limits.deepPartial();

export interface LimitsLayers {
  /** Extra config files, merged in order after the project layer. */
  readonly files?: readonly string[];
  /** `key.path=value` overrides applied last. `null` lifts a limit. */
  readonly values?: readonly string[];
}

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

/**
 * Resolve the effective limits for one run. Throws on a malformed file or an
 * unknown override key: a typo must not silently keep the old budget.
 */
export function resolveLimits(options: {
  readonly repoRoot: string;
  readonly overrides?: LimitsLayers;
  /** Override for the user-level directory; tests point this at a temp dir. */
  readonly homeDir?: string;
}): ResolvedLimits {
  const candidates = [
    ...limitsPaths(options.repoRoot, options.homeDir),
    ...(options.overrides?.files ?? []),
  ];
  const sources: string[] = [];
  const missing: string[] = [];

  let merged: unknown = structuredClone(DEFAULT_LIMITS);
  for (const path of candidates) {
    if (!existsSync(path)) {
      missing.push(path);
      continue;
    }
    const parsed = LimitsFile.safeParse(readJson(path));
    if (!parsed.success) {
      throw new Error(`invalid limits file ${path}: ${describeIssue(parsed.error)}`);
    }
    merged = mergeLayer(merged, parsed.data);
    sources.push(path);
  }

  const values = options.overrides?.values ?? [];
  for (const raw of values) merged = applyOverride(merged, raw);

  return { limits: Limits.parse(merged), sources, missing };
}

function readJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`limits file is not valid JSON: ${path}: ${detail}`);
  }
}

/** Deep merge where `null` is an explicit value ("no limit"), not an absence. */
function mergeLayer(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (override === null || !isPlainObject(override)) return override;
  if (!isPlainObject(base)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = mergeLayer(base[key], value);
  }
  return out;
}

/** Apply one `a.b.c=value` override, rejecting unknown paths. */
function applyOverride(limits: unknown, raw: string): unknown {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new Error(`limit override must be key=value, got '${raw}'`);
  }
  const path = raw.slice(0, separator).trim().split(".").filter((part) => part.length > 0);
  const value = parseValue(raw.slice(separator + 1).trim(), raw);
  return setPath(limits, path, value, []);
}

function setPath(node: unknown, path: readonly string[], value: unknown, seen: string[]): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (!isPlainObject(node)) {
    throw new Error(`limit override path '${seen.join(".")}' is not an object`);
  }
  if (!(head in node)) {
    throw new Error(
      `unknown limit override '${[...seen, head].join(".")}' ` +
        `(expected one of: ${Object.keys(node).sort().join(", ")})`,
    );
  }
  return { ...node, [head]: setPath(node[head], rest, value, [...seen, head]) };
}

function parseValue(text: string, raw: string): number | null {
  if (text === "null") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`limit override '${raw}' needs a positive number or null`);
  }
  return value;
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "schema mismatch";
  const path = issue.path.join(".");
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One-line summary for logs and run records. */
export function describeLimits(limits: Limits): string {
  const ms = (value: number | null): string => (value === null ? "none" : `${String(value)}ms`);
  return [
    `sessions: testWriter=${ms(limits.sessions.testWriter.deadlineMs)}`,
    `refactor=${ms(limits.sessions.refactor.deadlineMs)}`,
    `stages: build=${ms(limits.stages.buildMs)} ctest=${ms(limits.stages.ctestMs)} testWorkflow=${ms(limits.stages.testWorkflowMs)}`,
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
  readonly overrides: LimitsLayers;
  readonly remaining: readonly string[];
} {
  const files: string[] = [];
  const values: string[] = [];
  const remaining: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const fileValue = matchOption(arg, "--limits-file");
    if (fileValue !== null) {
      files.push(fileValue.length > 0 ? fileValue : argv[++index] ?? "");
      continue;
    }
    const limitValue = matchOption(arg, "--limit");
    if (limitValue !== null) {
      values.push(limitValue.length > 0 ? limitValue : argv[++index] ?? "");
      continue;
    }
    remaining.push(arg);
  }

  return {
    overrides: {
      ...(files.length > 0 ? { files } : {}),
      ...(values.length > 0 ? { values } : {}),
    },
    remaining,
  };
}

/** `--flag=value` or `--flag` -> value (empty string when separate). Null when absent. */
function matchOption(arg: string, flag: string): string | null {
  if (arg === flag) return "";
  const prefix = `${flag}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}
