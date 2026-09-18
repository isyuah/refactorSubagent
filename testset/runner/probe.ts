/**
 * Environment probe: measured host facts, once per batch.
 *
 * A case declares what it needs (`requires`); the runner probes, compares, and
 * skips cases it cannot run instead of failing the batch halfway. Recipes
 * cover the checks a tool list cannot express — "gcc" being on PATH does not
 * mean it accepts the flags the build workflow passes.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Requires } from "./suite.js";

export interface ToolFact {
  readonly available: boolean;
  readonly path: string | null;
  readonly version: string | null;
}

export interface HostFacts {
  readonly os: string;
  readonly arch: string;
  readonly cpu: number;
  readonly tools: Readonly<Record<string, ToolFact>>;
}

export interface RecipeReport {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProbeReport {
  readonly host: HostFacts;
  readonly recipes: Readonly<Record<string, RecipeReport>>;
}

export interface RequirementVerdict {
  readonly ok: boolean;
  /** Human-readable reason, null when the requirement is met. */
  readonly reason: string | null;
}

function runTool(name: string, args: readonly string[], timeoutMs = 20_000): { code: number | null; stdout: string } {
  const result = spawnSync(name, [...args], { encoding: "utf8", timeout: timeoutMs, shell: false, windowsHide: true });
  return { code: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/).map((value) => value.trim()).find((value) => value.length > 0);
  return line ?? null;
}

function probeTool(name: string): ToolFact {
  const path = Bun.which(name);
  if (path === null) return { available: false, path: null, version: null };
  const version = runTool(path, ["--version"]);
  return { available: true, path, version: firstLine(version.stdout) };
}

/** The flags the libuv build workflow passes; a compiler that rejects them cannot build the task. */
function probeWinMinGwRecipe(host: HostFacts): RecipeReport {
  const id = "win-mingw-ninja-debug";
  const gcc = host.tools["gcc"];
  if (gcc === undefined || !gcc.available || gcc.path === null) {
    return { id, ok: false, detail: "gcc is not on PATH" };
  }
  const dir = mkdtempSync(join(tmpdir(), "rfr-recipe-"));
  try {
    const source = join(dir, "probe.c");
    writeFileSync(source, "int main(void) { return 0; }\n");
    const compiled = runTool(gcc.path, [
      "-Wno-error=incompatible-pointer-types",
      "-Wno-error=discarded-qualifiers",
      "-fsyntax-only",
      source,
    ]);
    if (compiled.code !== 0) {
      return { id, ok: false, detail: `gcc rejects the task's -Wno-error flags: ${firstLine(compiled.stdout) ?? "no output"}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const cmake = host.tools["cmake"];
  const ninja = host.tools["ninja"];
  if (cmake === undefined || cmake.path === null) return { id, ok: false, detail: "cmake is not on PATH" };
  if (ninja === undefined || ninja.path === null) return { id, ok: false, detail: "ninja is not on PATH" };
  const generators = runTool(cmake.path, ["--help"]);
  if (!/^\s{2}Ninja\s+=/m.test(generators.stdout)) {
    return { id, ok: false, detail: "cmake does not offer the Ninja generator" };
  }
  return { id, ok: true, detail: `${gcc.version ?? "gcc"} · ${cmake.version ?? "cmake"} · ${ninja.version ?? "ninja"}` };
}

const RECIPES: Record<string, (host: HostFacts) => RecipeReport> = {
  "win-mingw-ninja-debug": probeWinMinGwRecipe,
};

/** Probe once per batch; the tool list is the union of what selected cases ask for. */
export function probeEnvironment(toolNames: readonly string[], recipeIds: readonly string[]): ProbeReport {
  const tools: Record<string, ToolFact> = {};
  for (const name of [...new Set(toolNames)].sort()) tools[name] = probeTool(name);
  const host: HostFacts = {
    os: process.platform,
    arch: process.arch,
    cpu: navigator.hardwareConcurrency || 8,
    tools,
  };
  const recipes: Record<string, RecipeReport> = {};
  for (const id of [...new Set(recipeIds)].sort()) {
    const probe = RECIPES[id];
    recipes[id] = probe === undefined
      ? { id, ok: false, detail: `unknown recipe '${id}'` }
      : probe(host);
  }
  return { host, recipes };
}

export function evaluateRequirement(requires: Requires, report: ProbeReport): RequirementVerdict {
  const missing = requires.tools.filter((name) => report.host.tools[name]?.available !== true);
  if (missing.length > 0) return { ok: false, reason: `missing tool(s): ${missing.join(", ")}` };
  if (requires.recipe !== null) {
    const recipe = report.recipes[requires.recipe];
    if (recipe === undefined) return { ok: false, reason: `unknown recipe '${requires.recipe}'` };
    if (!recipe.ok) return { ok: false, reason: `recipe ${recipe.id}: ${recipe.detail}` };
  }
  return { ok: true, reason: null };
}

export function describeProbe(report: ProbeReport): string {
  const tools = Object.entries(report.host.tools)
    .map(([name, fact]) => `${name}${fact.available ? "" : "(missing)"}`)
    .join(" ");
  const recipes = Object.entries(report.recipes)
    .map(([id, recipe]) => `${id}=${recipe.ok ? "ok" : "FAIL"}`)
    .join(" ");
  return `${report.host.os}/${report.host.arch} cpu=${String(report.host.cpu)} | ${tools}${recipes === "" ? "" : ` | ${recipes}`}`;
}
