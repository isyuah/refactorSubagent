import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BuildSpec,
  EnvironmentSpec,
  HostPreflight,
} from "../artifacts/index.js";
import { probeHost } from "./host-preflight.js";
import {
  CMakeAdapter,
  DirectCompilerAdapter,
  resolveBinaryPath,
  type BuildResult,
} from "./build-adapter.js";
export { CMakeAdapter, DirectCompilerAdapter, resolveBinaryPath } from "./build-adapter.js";
export type { BuildResult } from "./build-adapter.js";

const directCompiler = new DirectCompilerAdapter();
const cmake = new CMakeAdapter();

/**
 * Build entry point. New direct-compiler plans use an argv-only Adapter;
 * legacy shell plans remain a compatibility fallback.
 */
export function buildWorktree(
  worktreeDir: string,
  env: EnvironmentSpec,
  host = probeHost(worktreeDir),
): BuildResult {
  if ("kind" in env.build && env.build.kind === "direct-compiler") {
    return directCompiler.build(worktreeDir, env, host);
  }
  if ("kind" in env.build && env.build.kind === "cmake") {
    return cmake.build(worktreeDir, env, host);
  }
  return buildLegacyShell(worktreeDir, env);
}

function buildLegacyShell(worktreeDir: string, env: EnvironmentSpec): BuildResult {
  if (!("command" in env.build)) {
    return {
      ok: false,
      binaryAbs: join(worktreeDir, ""),
      log: "legacy shell adapter received a non-shell build spec\n",
    };
  }

  const output = buildOutput(env.build);
  const requestedBinary = join(worktreeDir, output);
  mkdirSync(dirname(requestedBinary), { recursive: true });
  const baseCommand = normalizeBuildCommand(env.build.command);
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

function buildOutput(build: BuildSpec): string {
  return "output" in build ? build.output : build.binary;
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
