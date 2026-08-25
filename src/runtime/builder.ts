import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EnvironmentSpec } from "../artifacts/index.js";

export interface BuildResult {
  ok: boolean;
  log: string;
  /** Absolute path of the produced executable (set even on failure for diagnostics). */
  binaryAbs: string;
}

/**
 * Builder — compiles one worktree per EnvironmentSpec.
 * Intercept headers are force-fed via `-include` so nondeterministic libc
 * entry points (time/rand/…) are replaced BEFORE any TU sees them.
 */
export function buildWorktree(
  worktreeDir: string,
  env: EnvironmentSpec,
): BuildResult {
  const requestedBinary = join(worktreeDir, env.build.binary);
  mkdirSync(dirname(requestedBinary), { recursive: true });
  const baseCommand = normalizeBuildCommand(env.build.command);
  const includes = env.determinism.intercept_headers
    .filter((h) => existsSync(join(worktreeDir, h)))
    .filter((h) => !hasInclude(baseCommand, h))
    .map((h) => `-include "${join(worktreeDir, h)}"`)
    .join(" ");

  const command = `${baseCommand}${includes ? " " + includes : ""}`;
  const r = spawnSync(command, {
    cwd: worktreeDir,
    encoding: "utf8",
    shell: true,
  });

  const log =
    `$ ${command}\n` +
    (r.stdout ?? "") +
    (r.stderr ?? "") +
    (r.error ? String(r.error) : "");
  const binaryAbs = resolveBinaryPath(worktreeDir, env);

  return { ok: r.status === 0 && existsSync(binaryAbs), log, binaryAbs };
}

/** Resolve agent-proposed `app` to MinGW's generated `app.exe` on Windows. */
export function resolveBinaryPath(
  worktreeDir: string,
  env: EnvironmentSpec,
): string {
  const requested = join(worktreeDir, env.build.binary);
  if (existsSync(requested)) return requested;
  if (process.platform === "win32" && !requested.toLowerCase().endsWith(".exe")) {
    const exe = `${requested}.exe`;
    if (existsSync(exe)) return exe;
  }
  return requested;
}

function hasInclude(command: string, header: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  const target = header.replaceAll("\\", "/");
  return normalized.includes(`-include ${target}`) ||
    normalized.includes(`-include \"${target}\"`);
}

function normalizeBuildCommand(command: string): string {
  if (process.platform !== "win32") return command;

  // The host creates output directories before invoking the command. Remove
  // the POSIX-only prefix so Windows cmd.exe never sees `mkdir -p`.
  const withoutMkdir = command.replace(
    /^\s*mkdir\s+-p\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/i,
    "",
  );

  // MinGW provides gcc, not the POSIX `cc` alias emitted by some analyzers.
  return withoutMkdir.replace(/\bcc\b/g, "gcc");
}
