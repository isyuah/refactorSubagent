import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EnvironmentSpec,
  ObservationTrace,
  TestSpec,
} from "../artifacts/index.js";
import { diffSnapshots, snapshotDir } from "./fs-snapshot.js";
import { resolveBinaryPath } from "./builder.js";

const CASE_TIMEOUT_MS = 10_000;

/**
 * Differential Runner — executes every test case against one build in a
 * fresh throwaway cwd, capturing all observable channels:
 * exit code, stdout/stderr, filesystem effects (before/after snapshot).
 *
 * Convention: `argv[0]` of a case is the program-name placeholder and is not
 * passed to the executable; the real executable comes from EnvironmentSpec.
 */
export function captureTrace(
  worktreeDir: string,
  env: EnvironmentSpec,
  spec: TestSpec,
  build: "baseline" | "candidate",
  envId: string,
): ObservationTrace {
  const binaryAbs = resolveBinaryPath(worktreeDir, env);
  const observations = [];

  for (const c of spec.cases) {
    const runDir = mkdtempSync(join(tmpdir(), "rfrun-"));
    try {
      for (const f of c.fixtures) {
        const dest = join(runDir, f.path);
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, Buffer.from(f.content_b64, "base64"));
      }
      const before = snapshotDir(runDir);
      const args = c.argv.slice(1);
      if (args.some((arg) => arg.includes("\0"))) {
        observations.push({
          case_id: c.id,
          status: "error" as const,
          exit_code: -1,
          signal: null,
          stdout_b64: "",
          stderr_b64: Buffer.from("argv contains NUL bytes").toString("base64"),
          filesystem: [],
          duration_ms: 0,
        });
        continue;
      }

      const r = spawnSync(binaryAbs, args, {
        cwd: runDir,
        timeout: CASE_TIMEOUT_MS,
        input: Buffer.from(c.stdin, "base64"),
        killSignal: "SIGKILL",
      });

      const killed =
        r.error != null &&
        String((r.error as NodeJS.ErrnoException).code ?? "") === "ETIMEDOUT";
      if (killed) {
        observations.push({
          case_id: c.id,
          status: "error" as const,
          exit_code: -1,
          signal: "SIGKILL",
          stdout_b64: "",
          stderr_b64: Buffer.from(`timeout after ${CASE_TIMEOUT_MS}ms`).toString("base64"),
          filesystem: [],
          duration_ms: CASE_TIMEOUT_MS,
        });
        continue;
      }

      observations.push({
        case_id: c.id,
        // Regression cases carry an expectation; violating it is a 'fail'
        // that R3 forces the failure classifier to explain.
        status:
          c.kind === "regression" && r.status !== c.expect_exit_code
            ? ("fail" as const)
            : ("observed" as const),
        exit_code: r.status ?? -1,
        signal: null,
        stdout_b64: Buffer.from(r.stdout ?? "").toString("base64"),
        stderr_b64: Buffer.from(r.stderr ?? "").toString("base64"),
        filesystem: diffSnapshots(before, snapshotDir(runDir)),
        duration_ms: 0,
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  return {
    kind: "observation-trace",
    version: 1,
    build,
    env_id: envId,
    observations,
    failures: [],
  };
}
