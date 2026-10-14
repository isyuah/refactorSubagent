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
import { z } from "zod";
import type { Requires } from "./suite.js";

const CMakeCapabilities = z.object({
  generators: z.array(z.object({ name: z.string() })),
});

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
  return { code: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}` };
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

/** Check a native GCC toolchain, including the flags/libraries used by the workflows. */
function probeGccNinjaRecipe(host: HostFacts, platform: "win32" | "linux", id: string): RecipeReport {
  if (host.os !== platform) {
    return { id, ok: false, detail: `requires platform ${platform}, current platform is ${host.os}` };
  }
  const gcc = host.tools["gcc"];
  if (gcc === undefined || !gcc.available || gcc.path === null) {
    return { id, ok: false, detail: "gcc is not on PATH" };
  }
  const cmake = host.tools["cmake"];
  const ninja = host.tools["ninja"];
  if (cmake === undefined || !cmake.available || cmake.path === null) return { id, ok: false, detail: "cmake is not on PATH" };
  if (ninja === undefined || !ninja.available || ninja.path === null) return { id, ok: false, detail: "ninja is not on PATH" };
  const target = runTool(gcc.path, ["-dumpmachine"]);
  const targetName = firstLine(target.stdout) ?? "unknown";
  const targetPattern = platform === "win32" ? /mingw/i : /linux/i;
  if (target.code !== 0 || !targetPattern.test(targetName)) {
    return { id, ok: false, detail: `gcc target '${targetName}' is not a native ${platform} toolchain` };
  }
  const dir = mkdtempSync(join(tmpdir(), "rfr-recipe-"));
  try {
    const source = join(dir, "probe.c");
    const executable = join(dir, platform === "win32" ? "probe.exe" : "probe");
    writeFileSync(source, "int main(void) { return 0; }\n");
    const flags = platform === "win32"
      ? ["-Wno-error=incompatible-pointer-types", "-Wno-error=discarded-qualifiers"]
      : [];
    const libraries = platform === "linux" ? ["-pthread", "-ldl", "-lrt", "-lm"] : [];
    const compiled = runTool(gcc.path, [
      ...flags,
      source,
      "-o", executable,
      ...libraries,
    ]);
    if (compiled.code !== 0) {
      return { id, ok: false, detail: `gcc compile/link failed: ${firstLine(compiled.stdout) ?? "no output"}` };
    }
    const executed = runTool(executable, []);
    if (executed.code !== 0) {
      return { id, ok: false, detail: `compiled probe cannot run: ${firstLine(executed.stdout) ?? `exit=${String(executed.code)}`}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const generators = runTool(cmake.path, ["-E", "capabilities"]);
  if (generators.code !== 0) {
    return { id, ok: false, detail: "cmake capabilities probe failed: " + (firstLine(generators.stdout) ?? "no output") };
  }
  try {
    const capabilities = CMakeCapabilities.parse(JSON.parse(generators.stdout));
    if (!capabilities.generators.some((generator) => generator.name === "Ninja")) {
      return { id, ok: false, detail: "cmake does not offer the Ninja generator" };
    }
  } catch {
    return { id, ok: false, detail: "cmake -E capabilities returned invalid generator metadata" };
  }
  return { id, ok: true, detail: `${targetName} · ${gcc.version ?? "gcc"} · ${cmake.version ?? "cmake"} · ${ninja.version ?? "ninja"}` };
}

const RECIPES: Record<string, (host: HostFacts) => RecipeReport> = {
  "win-mingw-ninja-debug": (host) => probeGccNinjaRecipe(host, "win32", "win-mingw-ninja-debug"),
  "linux-gcc-ninja-debug": (host) => probeGccNinjaRecipe(host, "linux", "linux-gcc-ninja-debug"),
  "libuv-ninja-debug": (host) => {
    const id = "libuv-ninja-debug";
    if (host.os !== "win32" && host.os !== "linux") {
      return { id, ok: false, detail: `no libuv build recipe for platform ${host.os}` };
    }
    return probeGccNinjaRecipe(host, host.os, id);
  },
};

/** Also used to validate a single named recipe against already measured facts. */
export function probeRecipe(id: string, host: HostFacts): RecipeReport {
  const probe = Object.hasOwn(RECIPES, id) ? RECIPES[id] : undefined;
  return probe === undefined
    ? { id, ok: false, detail: `unknown recipe '${id}'` }
    : probe(host);
}

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
    recipes[id] = probeRecipe(id, host);
  }
  return { host, recipes };
}

export function evaluateRequirement(requires: Requires, report: ProbeReport): RequirementVerdict {
  if (requires.platforms.length > 0 && !requires.platforms.includes(report.host.os)) {
    return { ok: false, reason: `platform ${report.host.os} is not supported (requires any of: ${requires.platforms.join(", ")})` };
  }
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
