import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  /** Per-probe-command timeout. Defaults to 30s (see limits.probes.hostMs). */
  toolTimeoutMs?: number;
}

/** Discover tools and query metadata. Builds belong to the selected workflow;
 *  sanitizer compilation is a separate, explicitly requested capability check. */
export function probeHost(
  cwd = process.cwd(),
  options: ProbeHostOptions = {},
): HostPreflight {
  const toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
  const tools: Record<string, ToolProbe> = {};
  for (const name of TOOL_NAMES) tools[name] = probeTool(name);

  const shell = detectShell(tools);
  const cmake = tools.cmake?.available && tools.cmake.path !== null
    ? probeCMake(tools.cmake.path, toolTimeoutMs)
    : {
        version: null,
        generators: [],
        reason: "cmake executable was not found on PATH",
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
    sanitizers: options.probeSanitizers === true ? probeSanitizers(tools, toolTimeoutMs) : {},
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

function probeCMake(cmakePath: string, timeoutMs: number): CMakePreflight {
  const versionRun = spawnSync(cmakePath, ["--version"], nativeProbeOptions(timeoutMs));
  const capabilitiesRun = spawnSync(cmakePath, ["-E", "capabilities"], nativeProbeOptions(timeoutMs));
  const version = versionRun.status === 0
    ? versionRun.stdout.match(/^cmake version\s+([^\r\n]+)/im)?.[1]?.trim() ?? null
    : null;
  const failures: string[] = [];
  if (versionRun.status !== 0) failures.push(`cmake --version failed: ${probeOutput(versionRun)}`);
  else if (version === null) failures.push("cmake --version returned no recognizable version");

  let generators: string[] = [];
  if (capabilitiesRun.status !== 0) {
    failures.push(`cmake -E capabilities failed: ${probeOutput(capabilitiesRun)}`);
  } else {
    try { generators = parseCMakeGenerators(capabilitiesRun.stdout); }
    catch (error) { failures.push(`cmake -E capabilities returned invalid metadata: ${errorMessage(error)}`); }
  }

  return {
    version,
    generators,
    reason: failures.length === 0
      ? "CMake version and supported generator metadata queried"
      : failures.join("; ").slice(0, 1000),
  };
}

function parseCMakeGenerators(output: string): string[] {
  const value = JSON.parse(output) as { generators?: Array<{ name?: unknown }> } | null;
  if (!Array.isArray(value?.generators)) throw new Error("missing generators array");
  return value.generators.map((generator) => {
    if (typeof generator?.name !== "string" || generator.name.length === 0) {
      throw new Error("generator entry has no name");
    }
    return generator.name;
  });
}

function nativeProbeOptions(timeoutMs: number): {
  encoding: "utf8";
  shell: false;
  windowsHide: boolean;
  timeout: number;
} {
  return { encoding: "utf8", shell: false, windowsHide: true, timeout: timeoutMs };
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

function probeSanitizers(tools: Record<string, ToolProbe>, timeoutMs: number): Record<string, SanitizerCapability> {
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
      : probeSanitizer(kind, compiler.name, compiler.path, timeoutMs);
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
  timeoutMs: number,
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
      timeout: timeoutMs,
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
