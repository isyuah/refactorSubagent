import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import {
  HostPreflight,
  type CMakePreflight,
  type ToolProbe,
} from "../artifacts/host-preflight.js";
import {
  SanitizerKind,
  type SanitizerCapability,
} from "../artifacts/sanitizer.js";

const TOOL_NAMES = [
  "gcc",
  "cc",
  "clang",
  "cl",
  "cmake",
  "ctest",
  "make",
  "ninja",
  "msbuild",
  "bash",
  "wsl",
] as const;

const SANITIZER_FLAGS: Record<SanitizerKind, string> = {
  address: "-fsanitize=address",
  undefined: "-fsanitize=undefined",
};

export interface ProbeHostOptions {
  /** Expensive sanitizer probes run only when explicitly requested. */
  probeSanitizers?: boolean;
}

/** Measure host facts once at workflow start. No model/tool call is involved. */
export function probeHost(
  cwd = process.cwd(),
  options: ProbeHostOptions = {},
): HostPreflight {
  const tools: Record<string, ToolProbe> = {};
  for (const name of TOOL_NAMES) tools[name] = probeTool(name);

  const shell = detectShell(tools);
  const cmake = tools.cmake?.available && tools.cmake.path !== null
    ? probeCMake(tools.cmake.path)
    : {
        version: null,
        generators: [],
        default_generator: null,
        c_compiler: null,
        configure_probe: "not-run" as const,
        build_probe: "not-run" as const,
        reason: "cmake executable is not available on PATH",
      };
  if (tools.cmake !== undefined && cmake.version !== null) {
    tools.cmake = { ...tools.cmake, version: cmake.version };
  }

  return HostPreflight.parse({
    kind: "host-preflight",
    version: 1,
    platform: process.platform,
    arch: process.arch,
    shell,
    supports_posix_shell: shell === "bash",
    executable_suffix: process.platform === "win32" ? ".exe" : "",
    working_directory: cwd,
    tools,
    cmake,
    sanitizers: options.probeSanitizers === true ? probeSanitizers(tools) : {},
  });
}

/** Resolve PATH entries directly; spawning `where.exe` is unexpectedly slow on Windows. */
function probeTool(name: string): ToolProbe {
  const path = resolveOnPath(name);
  return { available: path !== null, path, version: null };
}

function resolveOnPath(name: string): string | null {
  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of pathEntries) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function detectShell(tools: Record<string, ToolProbe>): "cmd.exe" | "powershell.exe" | "bash" | "unknown" {
  if (process.platform !== "win32") {
    return tools.bash?.available ? "bash" : "unknown";
  }
  if (process.env.ComSpec?.toLowerCase().endsWith("powershell.exe")) {
    return "powershell.exe";
  }
  return "cmd.exe";
}

function probeCMake(cmakePath: string): CMakePreflight {
  const versionRun = spawnSync(cmakePath, ["--version"], nativeProbeOptions());
  const capabilitiesRun = spawnSync(cmakePath, ["-E", "capabilities"], nativeProbeOptions());
  const version = outputText(versionRun).match(/^cmake version\s+([^\r\n]+)/im)?.[1]?.trim() ?? null;
  const generators = parseCMakeGenerators(outputText(capabilitiesRun));
  const probe = runCMakeToolchainProbe(cmakePath);
  const failures = [
    versionRun.status === 0 ? null : `cmake --version failed: ${probeOutput(versionRun)}`,
    capabilitiesRun.status === 0 ? null : `cmake -E capabilities failed: ${probeOutput(capabilitiesRun)}`,
    probe.reason,
  ].filter((value): value is string => value !== null);

  return {
    version,
    generators,
    default_generator: probe.defaultGenerator,
    c_compiler: probe.compiler,
    configure_probe: probe.configureStatus,
    build_probe: probe.buildStatus,
    reason: failures.length === 0
      ? "CMake version, generators, and minimal C configure/build probes succeeded"
      : failures.join("; ").slice(0, 1000),
  };
}

function runCMakeToolchainProbe(cmakePath: string): {
  configureStatus: "pass" | "fail";
  buildStatus: "pass" | "fail" | "not-run";
  defaultGenerator: string | null;
  compiler: string | null;
  reason: string | null;
} {
  const root = mkdtempSync(join(tmpdir(), "rfr-cmake-preflight-"));
  const source = join(root, "main.c");
  const project = join(root, "CMakeLists.txt");
  const build = join(root, "build");
  try {
    writeFileSync(source, "int main(void) { return 0; }\n", "utf8");
    writeFileSync(
      project,
      "cmake_minimum_required(VERSION 3.15)\nproject(rfr_cmake_probe C)\nadd_executable(rfr_cmake_probe main.c)\n",
      "utf8",
    );
    const configure = spawnSync(
      cmakePath,
      ["-S", ".", "-B", "build"],
      { ...nativeProbeOptions(), cwd: root },
    );
    const configureOutput = outputText(configure);
    const cache = join(build, "CMakeCache.txt");
    const defaultGenerator = configureOutput.match(/^-- Building for:\s*(.+)$/m)?.[1]?.trim()
      ?? readCacheValue(cache, "CMAKE_GENERATOR:INTERNAL");
    const compiler = configure.status === 0
      ? readCacheValue(cache, "CMAKE_C_COMPILER:FILEPATH") ?? parseWorkingCCompiler(configureOutput)
      : null;
    if (configure.status !== 0) {
      return {
        configureStatus: "fail",
        buildStatus: "not-run",
        defaultGenerator,
        compiler,
        reason: `minimal CMake configure failed: ${probeOutput(configure)}`,
      };
    }

    const built = spawnSync(
      cmakePath,
      ["--build", "build", "--config", "Debug"],
      { ...nativeProbeOptions(), cwd: root },
    );
    if (built.status !== 0) {
      return {
        configureStatus: "pass",
        buildStatus: "fail",
        defaultGenerator,
        compiler,
        reason: `minimal CMake build failed: ${probeOutput(built)}`,
      };
    }
    return {
      configureStatus: "pass",
      buildStatus: "pass",
      defaultGenerator,
      compiler,
      reason: null,
    };
  } catch (error) {
    return {
      configureStatus: "fail",
      buildStatus: "not-run",
      defaultGenerator: null,
      compiler: null,
      reason: `CMake toolchain probe errored: ${errorMessage(error)}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readCacheValue(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return readFileSync(path, "utf8").match(new RegExp(`^${escaped}=(.*)$`, "m"))?.[1]?.trim() ?? null;
}

function parseCMakeGenerators(output: string): string[] {
  try {
    const value = JSON.parse(output) as { generators?: Array<{ name?: unknown }> };
    return (value.generators ?? [])
      .map((generator) => generator.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  } catch {
    return [];
  }
}

function parseWorkingCCompiler(output: string): string | null {
  const match = output.match(/^-- Check for working C compiler:\s*(.+)$/im);
  if (match === null) return null;
  const compiler = match[1]!.replace(/\s+-\s+(?:skipped|works?)\s*$/i, "").trim();
  return compiler.length === 0 ? null : compiler;
}

function nativeProbeOptions(): {
  encoding: "utf8";
  shell: false;
  windowsHide: boolean;
  timeout: number;
} {
  return { encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 };
}

function outputText(result: { stdout?: string | Buffer; stderr?: string | Buffer }): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function probeOutput(result: {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error | null;
  status?: number | null;
}): string {
  const output = outputText(result).trim();
  return (output || result.error?.message || `exit code ${String(result.status)}`).slice(0, 400);
}

function probeSanitizers(tools: Record<string, ToolProbe>): Record<string, SanitizerCapability> {
  const compiler = selectSanitizerCompiler(tools);
  const result: Record<string, SanitizerCapability> = {};
  for (const kind of SanitizerKind.options) {
    result[kind] = compiler === null
      ? {
          available: false,
          compiler: null,
          flags: [SANITIZER_FLAGS[kind]],
          reason: "no gcc or clang compiler is available on PATH",
        }
      : probeSanitizer(kind, compiler.name, compiler.path);
  }
  return result;
}

function selectSanitizerCompiler(
  tools: Record<string, ToolProbe>,
): { name: string; path: string } | null {
  for (const name of ["gcc", "clang"] as const) {
    const tool = tools[name];
    if (tool?.available && tool.path !== null) return { name, path: tool.path };
  }
  return null;
}

function probeSanitizer(
  kind: SanitizerKind,
  compilerName: string,
  compilerPath: string,
): SanitizerCapability {
  const root = mkdtempSync(join(tmpdir(), "rfr-sanitizer-probe-"));
  const source = join(root, "probe.c");
  const output = join(root, process.platform === "win32" ? "probe.exe" : "probe");
  try {
    writeFileSync(source, "int main(void) { return 0; }\n");
    const result = Bun.spawnSync([
      compilerPath,
      SANITIZER_FLAGS[kind],
      "-g",
      "-O1",
      source,
      "-o",
      output,
    ], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const stdout = Buffer.from(result.stdout).toString("utf8").trim();
    const stderr = Buffer.from(result.stderr).toString("utf8").trim();
    if (result.exitCode === 0 && existsSync(output)) {
      return {
        available: true,
        compiler: compilerName,
        flags: [SANITIZER_FLAGS[kind]],
        reason: `${compilerName} compiled and linked a ${kind} sanitizer probe`,
      };
    }
    const detail = (stderr || stdout || `exit code ${String(result.exitCode)}`).slice(0, 400);
    return {
      available: false,
      compiler: compilerName,
      flags: [SANITIZER_FLAGS[kind]],
      reason: `${compilerName} cannot build ${kind} sanitizer probe: ${detail}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
