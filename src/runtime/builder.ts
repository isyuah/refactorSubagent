import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BuildSpec,
  DirectCompilerBuild,
  EnvironmentSpec,
  HostPreflight,
} from "../artifacts/index.js";
import { probeHost } from "./host-preflight.js";

export interface BuildResult {
  ok: boolean;
  log: string;
  /** Absolute path of the produced executable (set even on failure for diagnostics). */
  binaryAbs: string;
}

/**
 * Builder — executes a structured direct-compiler BuildPlan without a shell.
 * Legacy/shell-command artifacts retain the old shell fallback for recovery
 * of sessions created before the BuildPlan migration.
 */
export function buildWorktree(
  worktreeDir: string,
  env: EnvironmentSpec,
  host = probeHost(worktreeDir),
): BuildResult {
  if ("kind" in env.build && env.build.kind === "direct-compiler") {
    return buildDirectCompiler(worktreeDir, env.build, env, host);
  }
  return buildShellCommand(worktreeDir, env);
}

function buildDirectCompiler(
  worktreeDir: string,
  build: DirectCompilerBuild,
  env: EnvironmentSpec,
  host: HostPreflight,
): BuildResult {
  const output = withExecutableSuffix(build.output, host);
  const outputAbs = join(worktreeDir, output);
  mkdirSync(dirname(outputAbs), { recursive: true });

  const compiler = host.tools[build.compiler];
  if (!compiler?.available || compiler.path === null) {
    return {
      ok: false,
      binaryAbs: outputAbs,
      log: `direct compiler unavailable: ${build.compiler}\n`,
    };
  }

  const args = [
    ...removeInterceptFlags(build.flags, env.determinism.intercept_headers),
    ...Object.entries(build.defines).map(([key, value]) => `-D${key}=${value}`),
  ];
  for (const header of env.determinism.intercept_headers) {
    if (!existsSync(join(worktreeDir, header))) {
      return {
        ok: false,
        binaryAbs: outputAbs,
        log: `determinism header not found: ${header}\n`,
      };
    }
    args.push("-include", header);
  }
  args.push(...build.sources, "-o", output);

  const result = spawnSync(compiler.path, args, {
    cwd: worktreeDir,
    encoding: "utf8",
    shell: false,
  });
  const command = [compiler.path, ...args].map(shellQuote).join(" ");
  const log =
    `$ ${command}\n` +
    (result.stdout ?? "") +
    (result.stderr ?? "") +
    (result.error ? String(result.error) : "");

  return {
    ok: result.status === 0 && existsSync(outputAbs),
    log,
    binaryAbs: outputAbs,
  };
}

function buildShellCommand(
  worktreeDir: string,
  env: EnvironmentSpec,
): BuildResult {
  if (!("command" in env.build)) {
    return {
      ok: false,
      binaryAbs: join(worktreeDir, env.build.output),
      log: "invalid shell build spec: command is missing\n",
    };
  }
  const output = buildOutput(env.build);
  const requestedBinary = join(worktreeDir, output);
  mkdirSync(dirname(requestedBinary), { recursive: true });

  const baseCommand = normalizeBuildCommand(shellCommand(env.build));
  const includes = env.determinism.intercept_headers
    .filter((h) => existsSync(join(worktreeDir, h)))
    .filter((h) => !hasInclude(baseCommand, h))
    .map((h) => `-include "${join(worktreeDir, h)}"`)
    .join(" ");
  const command = `${baseCommand}${includes ? " " + includes : ""}`;
  const result = spawnSync(command, {
    cwd: worktreeDir,
    encoding: "utf8",
    shell: true,
  });
  const log =
    `$ ${command}\n` +
    (result.stdout ?? "") +
    (result.stderr ?? "") +
    (result.error ? String(result.error) : "");
  const binaryAbs = resolveBinaryPath(worktreeDir, env);

  return { ok: result.status === 0 && existsSync(binaryAbs), log, binaryAbs };
}

/** Resolve agent-proposed `app` to MinGW's generated `app.exe` on Windows. */
export function resolveBinaryPath(
  worktreeDir: string,
  env: EnvironmentSpec,
): string {
  const requested = join(worktreeDir, buildOutput(env.build));
  if (existsSync(requested)) return requested;
  if (process.platform === "win32" && !requested.toLowerCase().endsWith(".exe")) {
    const exe = `${requested}.exe`;
    if (existsSync(exe)) return exe;
  }
  return requested;
}

function buildOutput(build: BuildSpec): string {
  if ("output" in build) return build.output;
  return build.binary;
}

function shellCommand(build: BuildSpec & { command: string }): string {
  return build.command;
}

function withExecutableSuffix(output: string, host: HostPreflight): string {
  return host.executable_suffix.length > 0 &&
    !output.toLowerCase().endsWith(host.executable_suffix)
    ? `${output}${host.executable_suffix}`
    : output;
}

function hasInclude(command: string, header: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  const target = header.replaceAll("\\", "/");
  return normalized.includes(`-include ${target}`) ||
    normalized.includes(`-include \"${target}\"`);
}

function normalizeBuildCommand(command: string): string {
  if (process.platform !== "win32") return command;

  const withoutMkdir = command.replace(
    /^\s*mkdir\s+-p\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/i,
    "",
  );
  return withoutMkdir.replace(/\bcc\b/g, "gcc");
}

function removeInterceptFlags(flags: readonly string[], headers: readonly string[]): string[] {
  const normalizedHeaders = headers.map((header) => header.replaceAll("\\", "/"));
  const output: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag === "-include" && i + 1 < flags.length) {
      const candidate = flags[i + 1]!.replaceAll("\\", "/");
      const duplicate = normalizedHeaders.some(
        (header) => candidate === header || header.endsWith(`/${candidate}`),
      );
      if (duplicate) {
        i++;
        continue;
      }
    }
    output.push(flag);
  }
  return output;
}

function shellQuote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
