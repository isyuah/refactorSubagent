import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { RunProgressEvent, RunReport } from "../src/runtime/progress.js";
import { fileURLToPath } from "node:url";
import { spawnOwnedProcess } from "../shared/owned-process.js";
import type { EffectivePlan } from "../src/runtime/feedback/effective-plan.js";
import type { FeedbackState } from "../src/runtime/feedback/types.js";
import type { WorkflowsCheckpointView } from "../src/runtime/stage-resume.js";
import type { ExpectationBaseline } from "../src/artifacts/index.js";

interface Replay {
  progress: RunProgressEvent[];
  runReport: RunReport;
  stoppedBecause: string;
  calls: { role: string; resume: string | null }[];
  state: FeedbackState;
  plan: EffectivePlan;
  owner: string;
  snapshots: { session: string; state: string; workflows: WorkflowsCheckpointView; contentHash: string; baseline: ExpectationBaseline | null; measuredBaseline: boolean }[];
}

async function replay(scenario: string, displayArgs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "rfr-feedback-replay-"));
  const process = spawnOwnedProcess({
    program: globalThis.process.execPath,
    args: [fileURLToPath(new URL("./helpers/feedback-replay.ts", import.meta.url)), scenario, root, ...displayArgs],
    cwd: fileURLToPath(new URL("..", import.meta.url)), cooperativeShutdown: true,
    env: { ...globalThis.process.env, RFR_LOG_LEVEL: "error" },
  });
  let stdout = "";
  let stderr = "";
  process.child.stdout?.setEncoding("utf8").on("data", (data) => { stdout += data; });
  process.child.stderr?.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => { void process.stop(); }, 120_000);
  try {
    const exit = await process.exited;
    const expected = scenario.startsWith("cli-budget") ? 1 : 0;
    if (exit.error !== null || exit.code !== expected) throw new Error(`replay ${scenario} exited ${String(exit.code)}: ${String(exit.error)}\n${stderr}\n${stdout}`);
    return { report: JSON.parse(readFileSync(join(root, "replay.json"), "utf8")) as Replay, stdout, stderr,
      displays: !scenario.startsWith("cli-") ? Object.fromEntries(["detailed", "summary"].map((mode) => [mode,
        stripVTControlCharacters(readFileSync(join(root, `display-${mode}.ansi`), "utf8"))])) : {} };
  } finally {
    clearTimeout(timer);
    await process.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("feedback through the real pipeline (offline SDK replay)", () => {
  test("repairing build A then build B retains both delivered repairs", async () => {
    const { report, displays } = await replay("build-pair");
    expect(report.stoppedBecause).toBe("accepted");
    expect(report.snapshots.map((round) => round.state)).toEqual(["ABORTED", "ABORTED", "ACCEPTED"]);
    const ids = report.snapshots.map((round) => round.workflows.builds.map((build) => build.id));
    expect(ids[1]![0]).not.toBe(ids[0]![0]);
    expect(ids[2]![0]).toBe(ids[1]![0]);
    expect(ids[2]![1]).not.toBe(ids[1]![1]);
    expect(report.state.budgetUsed).toBe(2);
    expect(report.progress.every((event, index, all) => index === 0 || event.elapsed_ms >= all[index - 1]!.elapsed_ms)).toBe(true);
    expect(report.runReport.feedback?.rounds.map((round) => round.state)).toEqual(["ABORTED", "ABORTED", "ACCEPTED"]);
    expect(report.runReport.feedback?.build_repairs).toHaveLength(2);
    expect(report.runReport.elapsed_ms).toBeGreaterThanOrEqual(report.runReport.feedback!.rounds.reduce((sum, round) => sum + round.elapsed_ms, 0));
    expect(report.runReport.agents.filter((agent) => agent.role === "build-repair")).toHaveLength(2);
    expect(displays.detailed).toContain("离线AI正文");
    expect(displays.summary).not.toContain("离线AI正文");
    expect(displays.summary).toContain("构建方案修复");
    expect(displays.summary).toContain("ACCEPTED");
  }, 120_000);

  test.each(["build-refactor", "test-refactor"])("%s keeps the new plan when continuing the code conversation", async (scenario) => {
    const { report } = await replay(scenario);
    expect(report.stoppedBecause).toBe("accepted");
    expect(report.snapshots.map((round) => round.state)).toEqual(["ABORTED", "REJECTED", "ACCEPTED"]);
    expect(report.snapshots[2]!.contentHash).toBe(report.snapshots[1]!.contentHash);
    expect(report.snapshots[2]!.measuredBaseline).toBe(false);
    expect(report.snapshots[1]!.measuredBaseline).toBe(true);
    expect(report.snapshots[2]!.baseline).toEqual(report.snapshots[1]!.baseline);
    expect(report.calls.at(-1)).toEqual({ role: "refactor", resume: "refactor-dialogue" });
    if (scenario === "test-refactor") {
      expect(report.calls).toContainEqual({ role: "writer", resume: "writer-dialogue" });
      expect(report.snapshots[2]!.baseline?.expectations[0]?.value).toBe("new:original");
    }
  }, 120_000);

  test("registering the same broken recipe with a new session id stops as no progress", async () => {
    const { report } = await replay("no-progress");
    expect(report.stoppedBecause).toBe("no-progress");
    expect(report.state.budgetUsed).toBe(1);
    expect(report.snapshots[0]!.workflows.builds[0]!.id).not.toBe(report.snapshots[1]!.workflows.builds[0]!.id);
    expect(report.state.rounds[0]!.artifactHash).toBe(report.state.rounds[1]!.artifactHash);
    expect(report.state.rounds[0]!.failureSignature).toBe(report.state.rounds[1]!.failureSignature);
  }, 120_000);

  test.each(["cli-budget0", "cli-budget1"])("%s resumes through the CLI without resetting the spent budget", async (scenario) => {
    const { report, stdout } = await replay(scenario);
    const result = JSON.parse(stdout);
    expect(result.state).toBe("ABORTED");
    expect(result.auto_retry.stoppedBecause).toBe("budget-exhausted");
    expect(result.report.feedback.budget_used_before).toBe(1);
    expect(result.report.feedback.budget_used).toBe(1);
    expect(result.report.feedback.stopped_because).toBe("budget-exhausted");
    expect(report.state.budgetUsed).toBe(1);
    expect(report.calls.filter((call) => call.role === "build")).toHaveLength(1);
    expect(report.owner).toBe("first");
    expect(report.state.rounds.at(-1)?.budgeted).toBe(false);
    expect(report.state.rounds.at(-1)?.round).toBe(3);
  }, 120_000);

  test("a writer recreated during resume can subsequently continue from the shared transcript store", async () => {
    const { report, stdout, stderr } = await replay("cli-reauthor");
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).state).toBe("ACCEPTED");
    expect(report.calls.filter((call) => call.role === "writer")).toEqual([
      { role: "writer", resume: null },
      { role: "writer", resume: null },
      { role: "writer", resume: "writer-dialogue2" },
    ]);
    expect(report.state.budgetUsed).toBe(2);
    expect(report.owner).toBe("first");
  }, 120_000);

  test("CLI resume can repair a run that initially had feedback disabled, using its old conversations", async () => {
    const { report, stdout, stderr } = await replay("cli-resume", ["--progress", "plain", "--verbosity", "summary"]);
    const result = JSON.parse(stdout);
    expect(result.state).toBe("ACCEPTED");
    expect(result.auto_retry.rounds).toBe(3);
    expect(result.verification_authoritative).toBe(true);
    expect(stderr).toContain("恢复运行");
    expect(stderr).toContain("继续原重构对话");
    expect(stderr).toContain("原版构建与测试观测复用");
    expect(stderr).not.toContain("离线AI正文");
    expect(stdout).not.toContain("\u001b[");
    expect(result.report.feedback.owner_session).toBe("first");
    expect(result.report.feedback.resumed_from).toBe("first");
    expect(result.report.feedback.budget_used).toBe(2);
    expect(result.report.builds.find((build: { side: string }) => build.side === "baseline").status).toBe("reused");
    expect(result.report.tests.find((test: { side: string }) => test.side === "baseline").status).toBe("reused");
    expect(report.owner).toBe("first");
    expect(report.state.budgetUsed).toBe(2);
    expect(report.calls.filter((call) => call.role === "writer")).toHaveLength(1);
    expect(report.calls.at(-1)).toEqual({ role: "refactor", resume: "refactor-dialogue" });
  }, 120_000);
});
