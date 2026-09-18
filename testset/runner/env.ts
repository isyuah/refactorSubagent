/**
 * Environment: one directory per case, prepared by the case's own script.
 *
 * The runner creates `<case>/env/` and runs `bun prepare.ts <envDir>` with the
 * env dir as the working directory, so the script prepares the environment in
 * place — a clone, a patch, a prebuild, anything — and reports success by
 * leaving the repository where `case.json` says it is. A script that cannot
 * prepare (dependencies missing on this host) exits with BLOCKED_EXIT_CODE or
 * writes `blocked.json`; the case is then skipped, not failed.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exec } from "./exec.js";
import type { SuiteCase } from "./suite.js";

/** Conventional "this host cannot run me": skip, do not fail the batch. */
export const BLOCKED_EXIT_CODE = 78;

export interface PrepareOutcome {
  readonly status: "prepared" | "blocked" | "failed";
  readonly reason: string | null;
  readonly envDir: string;
  readonly repoDir: string;
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface PrepareOptions {
  readonly timeoutMs: number;
  /** Test set root: `TEST_ROOT` for the script, so it can resolve resources. */
  readonly testRoot: string;
  readonly onOutput?: (chunk: string) => void;
}

export async function prepareEnvironment(
  c: SuiteCase,
  caseDir: string,
  options: PrepareOptions,
): Promise<PrepareOutcome> {
  const started = Date.now();
  const envDir = join(caseDir, "env");
  // The runner owns the environment directory: every run starts from a clean
  // one so a case can never inherit state from an earlier attempt.
  rmSync(envDir, { recursive: true, force: true });
  mkdirSync(envDir, { recursive: true });
  const repoDir = resolve(envDir, c.repo);
  const stdoutPath = join(caseDir, "prepare.stdout.txt");
  const stderrPath = join(caseDir, "prepare.stderr.txt");
  const blockedPath = join(envDir, "blocked.json");

  if (c.prepare === null) {
    const reason = "case declares no prepare script";
    writeFileSync(stderrPath, reason + "\n", "utf8");
    return { status: "failed", reason, envDir, repoDir, exitCode: null, elapsedMs: 0, stdoutPath, stderrPath };
  }

  const result = await exec({
    program: process.execPath,
    args: [c.prepare, envDir],
    cwd: envDir,
    timeoutMs: options.timeoutMs,
    env: {
      TEST_ROOT: options.testRoot,
      CASE_ID: c.id,
      CASE_DIR: c.dir,
      ENV_DIR: envDir,
      REPO_DIR: repoDir,
    },
    ...(options.onOutput !== undefined ? { onOutput: options.onOutput } : {}),
  });
  writeFileSync(stdoutPath, result.stdout, "utf8");
  writeFileSync(stderrPath, result.stderr, "utf8");

  const elapsedMs = Date.now() - started;
  const base = { envDir, repoDir, exitCode: result.exitCode, elapsedMs, stdoutPath, stderrPath };
  if (existsSync(blockedPath)) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return { ...base, status: "blocked", reason: detail.slice(0, 300) || "prepare reported blocked" };
  }
  if (result.exitCode === BLOCKED_EXIT_CODE) {
    return { ...base, status: "blocked", reason: (result.stderr.trim() || "prepare reported blocked").slice(0, 300) };
  }
  if (result.status !== "exited" || result.exitCode !== 0) {
    const detail = (result.error ?? result.stderr.trim() ?? result.stdout.trim()).slice(-300);
    return { ...base, status: "failed", reason: `${result.status} exit=${String(result.exitCode)} :: ${detail}` };
  }
  if (!existsSync(repoDir)) {
    return { ...base, status: "failed", reason: `prepare finished but the repository is missing: ${repoDir}` };
  }
  return { ...base, status: "prepared", reason: null };
}
