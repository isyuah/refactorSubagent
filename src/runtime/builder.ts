import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  const includes = env.determinism.intercept_headers
    .filter((h) => existsSync(join(worktreeDir, h)))
    .map((h) => `-include "${join(worktreeDir, h)}"`)
    .join(" ");

  const command = `${env.build.command}${includes ? " " + includes : ""}`;
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
  const binaryAbs = join(worktreeDir, env.build.binary);

  return {
    ok: r.status === 0 && existsSync(binaryAbs),
    log,
    binaryAbs,
  };
}
