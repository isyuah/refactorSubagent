import { existsSync, readFileSync } from "node:fs";

/**
 * layers — one multi-source resolution engine for every config domain.
 *
 * Merge order, later wins:
 *   1. domain defaults (code)
 *   2. user file      (~/.refactor/<domain>.json, domain-owned paths)
 *   3. project file   (<repo>/.refactor/<domain>.json)
 *   4. explicit files (--<domain>-file <path> ..., in order)
 *   5. scalar overrides (--<domain> key.path=value ..., in order)
 *
 * A domain supplies its schema checks, its layer paths, its override value
 * parser and the two nouns used in error messages. Reading, deep merging,
 * unknown-key rejection and source accounting live here, so two domains
 * cannot drift into two different precedence rules.
 */

export interface LayerOverrides {
  /** Extra config files, merged in order after the project layer. */
  readonly files?: readonly string[];
  /** `key.path=value` overrides applied last. */
  readonly values?: readonly string[];
}

export type FileCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: string };

export interface LayeredConfigSpec<TContext, T> {
  /** Domain name for file errors: "limits" -> `invalid limits file <path>: ...`. */
  readonly name: string;
  /** Noun for override errors: "limit" -> `unknown limit override 'a.b'`. */
  readonly overrideNoun: string;
  /** Built-in defaults; the merge base. */
  readonly defaults: T;
  /** Validate one complete config, after every layer has been merged. */
  readonly resolve: (merged: unknown) => T;
  /** Validate one layer file: partial shape, unknown keys rejected. */
  readonly checkFile: (json: unknown) => FileCheck;
  /** Layer files in merge order (before the explicit override files). */
  readonly paths: (context: TContext) => readonly string[];
  /** Parse one scalar override value; throws a domain-worded error. */
  readonly parseValue: (text: string, raw: string) => unknown;
}

export interface ResolvedLayeredConfig<T> {
  readonly value: T;
  /** Files that existed and contributed, in merge order. */
  readonly sources: readonly string[];
  /** Paths that were checked but do not exist (diagnostics only). */
  readonly missing: readonly string[];
}

/** Resolve one domain's config. Throws on a malformed file or override. */
export function resolveLayeredConfig<C, T>(
  spec: LayeredConfigSpec<C, T>,
  context: C,
  overrides?: LayerOverrides,
): ResolvedLayeredConfig<T> {
  const sources: string[] = [];
  const missing: string[] = [];
  let merged: unknown = structuredClone(spec.defaults);
  for (const path of [...spec.paths(context), ...(overrides?.files ?? [])]) {
    if (!existsSync(path)) {
      missing.push(path);
      continue;
    }
    const checked = spec.checkFile(readJson(spec.name, path));
    if (!checked.ok) {
      throw new Error(`invalid ${spec.name} file ${path}: ${checked.issue}`);
    }
    merged = mergeLayer(merged, checked.value);
    sources.push(path);
  }
  for (const raw of overrides?.values ?? []) merged = applyOverride(spec, merged, raw);
  return { value: spec.resolve(merged), sources, missing };
}

/**
 * Pull `--<domain>-file <path>` and `--<domain> <key.path>=<value>` out of an
 * argv list. Both are repeatable; everything else is returned untouched so
 * each entry point can parse its own options. Unknown flag forms are left in
 * the remaining args for the caller to reject.
 */
export function extractConfigArgs(
  argv: readonly string[],
  flags: { readonly file: string; readonly value: string },
): { readonly overrides: LayerOverrides; readonly remaining: readonly string[] } {
  const files: string[] = [];
  const values: string[] = [];
  const remaining: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const fileValue = matchOption(arg, flags.file);
    if (fileValue !== null) {
      files.push(fileValue.length > 0 ? fileValue : argv[++index] ?? "");
      continue;
    }
    const overrideValue = matchOption(arg, flags.value);
    if (overrideValue !== null) {
      values.push(overrideValue.length > 0 ? overrideValue : argv[++index] ?? "");
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

function readJson(name: string, path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} file is not valid JSON: ${path}: ${detail}`);
  }
}

/** Deep merge where `null` is an explicit value, not an absence. */
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
function applyOverride<C, T>(
  spec: LayeredConfigSpec<C, T>,
  config: unknown,
  raw: string,
): unknown {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new Error(`${spec.overrideNoun} override must be key=value, got '${raw}'`);
  }
  const path = raw.slice(0, separator).trim().split(".").filter((part) => part.length > 0);
  const value = spec.parseValue(raw.slice(separator + 1).trim(), raw);
  return setPath(spec.overrideNoun, config, path, value, []);
}

function setPath(
  noun: string,
  node: unknown,
  path: readonly string[],
  value: unknown,
  seen: string[],
): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (!isPlainObject(node)) {
    throw new Error(`${noun} override path '${seen.join(".")}' is not an object`);
  }
  if (!(head in node)) {
    throw new Error(
      `unknown ${noun} override '${[...seen, head].join(".")}' ` +
        `(expected one of: ${Object.keys(node).sort().join(", ")})`,
    );
  }
  return { ...node, [head]: setPath(noun, node[head], rest, value, [...seen, head]) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `--flag=value` or `--flag` -> value (empty string when separate). Null when absent. */
function matchOption(arg: string, flag: string): string | null {
  if (arg === flag) return "";
  const prefix = `${flag}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}
