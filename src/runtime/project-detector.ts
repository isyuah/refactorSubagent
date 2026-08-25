import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ProjectDetection,
  type BuildAdapterId,
  type BuildSystem,
  type HostPreflight,
} from "../artifacts/index.js";

const SKIP_DIRS = new Set([
  ".git",
  ".refactor",
  "node_modules",
  "build",
  "dist",
  "out",
  "cmake-build-debug",
  "cmake-build-release",
]);

const MARKER_SYSTEM: Record<string, BuildSystem> = {
  "CMakeLists.txt": "cmake",
  "build.ninja": "ninja",
  Makefile: "make",
  makefile: "make",
  GNUmakefile: "make",
};


/** Detect the project build system before an agent proposes a build plan. */
export function detectCProject(
  repoRoot: string,
  host?: HostPreflight,
): ProjectDetection {
  const markers: string[] = [];
  const sourceFiles: string[] = [];
  walk(repoRoot, repoRoot, markers, sourceFiles);

  const systems: BuildSystem[] = [];
  for (const marker of markers) {
    const system = MARKER_SYSTEM[marker] ?? msvcSystem(marker);
    if (system !== null && !systems.includes(system)) systems.push(system);
  }

  if (markers.some((marker) => marker.endsWith(".sln") || marker.endsWith(".vcxproj"))) {
    if (!systems.includes("msvc")) systems.push("msvc");
  }
  if (systems.length === 0 && sourceFiles.length > 0) systems.push("direct-c");

  const primary = choosePrimary(systems);
  const adapter = chooseAdapter(primary, sourceFiles.length > 0);
  const status = sourceFiles.length === 0
    ? "no-c-sources"
    : adapter === "direct-compiler" || adapter === "unsupported" || adapterAvailable(adapter, host)
      ? "ready"
      : "needs-adapter";

  const reason = status === "ready" && adapter === "direct-compiler"
    ? "no supported project build marker; direct C compilation is available"
    : status === "ready"
      ? `${primary} project detected and ${adapter} adapter is available`
      : status === "needs-adapter"
        ? `project declares ${primary} but its adapter or host tool is unavailable`
        : status === "no-c-sources"
          ? "no .c translation units were found"
          : `detected ${primary ?? "unknown"} project markers`;

  return ProjectDetection.parse({
    kind: "project-detection",
    version: 1,
    repo_root: repoRoot,
    language: "c",
    build_systems: systems,
    primary_build_system: primary,
    markers,
    source_files: sourceFiles,
    adapter,
    status,
    reason,
  });
}

function walk(
  root: string,
  dir: string,
  markers: string[],
  sourceFiles: string[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith("cmake-build-")) {
        walk(root, join(dir, entry.name), markers, sourceFiles);
      }
      continue;
    }

    const rel = relative(root, join(dir, entry.name)).split("\\").join("/");
    if (dir === root && (MARKER_SYSTEM[entry.name] !== undefined || msvcSystem(entry.name) !== null)) {
      markers.push(rel);
    }
    if (entry.name.toLowerCase().endsWith(".c")) sourceFiles.push(rel);
  }
}

function msvcSystem(name: string): BuildSystem | null {
  return name.toLowerCase().endsWith(".sln") || name.toLowerCase().endsWith(".vcxproj")
    ? "msvc"
    : null;
}

function choosePrimary(systems: readonly BuildSystem[]): BuildSystem | null {
  const order: BuildSystem[] = ["cmake", "ninja", "make", "msvc", "direct-c"];
  return order.find((candidate) => systems.includes(candidate)) ?? null;
}

function chooseAdapter(
  primary: BuildSystem | null,
  hasSources: boolean,
): BuildAdapterId {
  if (!hasSources) return "unsupported";
  if (primary === null) return "direct-compiler";
  return primary === "direct-c" ? "direct-compiler" : primary;
}

function adapterAvailable(
  adapter: BuildAdapterId,
  host?: HostPreflight,
): boolean {
  if (!host) return false;
  if (adapter === "cmake") return host.tools.cmake?.available === true;
  return false;
}
