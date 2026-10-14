import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("legacy reevaluation retains injection replacement evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "rfr-reevaluate-"));
  try {
    const caseDir = join(root, "cases", "legacy");
    const runDir = join(root, "run");
    const resultDir = join(runDir, "legacy");
    const logDir = join(resultDir, "session");
    mkdirSync(caseDir, { recursive: true });
    mkdirSync(join(logDir, "artifacts"), { recursive: true });
    writeFileSync(join(caseDir, "task.txt"), "synthetic task\n");
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({
      id: "legacy", prepare: null, task: "./task.txt",
      expect: { method: "verdict", state: "ACCEPTED", replacedFiles: ["judge/material.txt"] },
    }));
    // Historical run-result files omitted injectionReplaced and harnessPhase.
    writeFileSync(join(resultDir, "run-result.json"), JSON.stringify({
      status: "exited", exitCode: 0, elapsedMs: 1,
      summary: { state: "ACCEPTED", comparison: "consistent" },
      mismatches: [], comparisonErrors: [], envDir: null, logDir,
      comparisonPath: null, pipelinePath: null, error: null,
    }));
    writeFileSync(join(logDir, "artifacts", "injections.json"), JSON.stringify({
      injections: [{ preExisting: ["judge/material.txt"] }],
    }));
    const result = Bun.spawnSync([
      process.execPath, resolve(import.meta.dir, "../testset/run.ts"),
      "--root", root, "--reevaluate", runDir,
    ], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(readFileSync(join(runDir, "summary.reevaluated.json"), "utf8"));
    expect(summary.counts.failed).toBe(0);
    expect(summary.cases[0].checks).toContainEqual(expect.objectContaining({ name: "injection-replaced", ok: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
