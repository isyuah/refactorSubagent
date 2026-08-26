import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import {
  HostPreflight,
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
  /** Expensive compile/link probes run only for sanitizer verification. */
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
