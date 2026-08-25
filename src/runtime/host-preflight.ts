import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";
import { HostPreflight, type ToolProbe } from "../artifacts/host-preflight.js";

const TOOL_NAMES = ["gcc", "cc", "clang", "cmake", "make", "ninja", "bash", "wsl"] as const;

/** Measure host facts once at workflow start. No model/tool call is involved. */
export function probeHost(cwd = process.cwd()): HostPreflight {
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
