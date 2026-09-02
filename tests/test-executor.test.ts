import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTestWorkflow } from "../src/workflow/test-executor.js";
import { compareExpectations } from "../src/workflow/expectation-compare.js";

const TEST_POLICY = {
  readableGlobs: ["**"],
  writableGlobs: ["**"],
  allowedTools: ["cmd"],
  maxOutputBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rfr-testexec-"));
}

/** Self-driven test workflow that declares expectations directly (no process). */
const OBSERVE_WORKFLOW = `
import type { WorkflowContext } from "./types";

export const workflowKind = "test-workflow-driven";

export default async (ctx: WorkflowContext) => {
  ctx.expect("exit-code", "equal", 0);
  ctx.expect("marker", "both-matches", "obs-value", "^obs-");
  return { ok: true };
};
`;

describe("executeTestWorkflow (self-driven)", () => {
  test("runs workflow in baseline and candidate, compares expectations consistently", async () => {
    const root = tempDir();
    writeFileSync(join(root, "types.d.ts"), 'export interface WorkflowContext {\n  readonly workspaceRoot: string;\n}\n');
    writeFileSync(join(root, "wf.ts"), OBSERVE_WORKFLOW);
    const baselineDir = join(root, "baseline");
    const candidateDir = join(root, "candidate");
    mkdirSync(baselineDir, { recursive: true });
    mkdirSync(candidateDir, { recursive: true });

    const result = await executeTestWorkflow({
      entry: join(root, "wf.ts"),
      baselineDir,
      candidateDir,
      policy: TEST_POLICY,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("pass");
    expect(result.comparison?.overall).toBe("consistent");
    expect(result.baseline.expectations.length).toBe(2);
    expect(result.candidate.expectations.length).toBe(2);
  }, 90_000);

  test("fails when expectations mismatch (candidate declares different value)", async () => {
    const root = tempDir();
    writeFileSync(join(root, "types.d.ts"), 'export interface WorkflowContext {\n  readonly workspaceRoot: string;\n}\n');
    // Candidate side: same code but host could inject different input — here we
    // simulate by two different workflow files observing different values.
    const baselineWf = `
import type { WorkflowContext } from "./types";
export const workflowKind = "test-workflow-driven";
export default async (ctx: WorkflowContext) => {
  ctx.expect("value", "equal", 42);
};
`;
    const candidateWf = `
import type { WorkflowContext } from "./types";
export const workflowKind = "test-workflow-driven";
export default async (ctx: WorkflowContext) => {
  ctx.expect("value", "equal", 43);
};
`;
    writeFileSync(join(root, "baseline-wf.ts"), baselineWf);
    writeFileSync(join(root, "candidate-wf.ts"), candidateWf);

    // Simulate two different workflow runs with different declared values.
    // executeTestWorkflow uses one entry for both sides, so we test the
    // comparator directly for cross-file differences.
    const comparison = compareExpectations(
      [{ name: "value", relation: "equal", value: 42 }],
      [{ name: "value", relation: "equal", value: 43 }],
    );
    expect(comparison.overall).toBe("inconsistent");
    expect(comparison.mismatched[0]?.reason).toContain("values differ");
  }, 30_000);

  test("baseline-greater relation enforces direction", async () => {
    const comparison = compareExpectations(
      [{ name: "timing", relation: "baseline-greater", value: 100 }],
      [{ name: "timing", relation: "baseline-greater", value: 50 }],
    );
    expect(comparison.overall).toBe("consistent");

    const failed = compareExpectations(
      [{ name: "timing", relation: "baseline-greater", value: 30 }],
      [{ name: "timing", relation: "baseline-greater", value: 80 }],
    );
    expect(failed.overall).toBe("inconsistent");
    expect(failed.mismatched[0]?.reason).toContain("not greater");
  });
});
