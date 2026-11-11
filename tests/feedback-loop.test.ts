import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli/args.js";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  runStageFlow,
  verifyStageWithReuse,
  type StageFlowResult,
} from "../src/runtime/stage-flow.js";
import {
  existingBranchPrepareStage,
  presetWorkflowsStage,
} from "../src/runtime/stage-presets.js";
import { loadReusableWorkflowsStage } from "../src/runtime/stage-resume.js";
import { composeRefactorFeedback, mergeRepairedBuilds } from "../src/runtime/feedback/repair.js";
import { runFeedbackLoop, routerInputOf, type FeedbackLoopConfig, type RepairRoundContext } from "../src/runtime/feedback/coordinator.js";

/**
 * Feedback-loop tests: pure orchestration over scripted round results and a
 * captured repair context — no pipeline, no AI. The dialogue-continuation
 * stage itself was live-verified by the Phase 0 spike (scripts/spike-resume.ts).
 */

function fakeResult(options: {
  state: string;
  dialogueId?: string | null;
  workflowsDialogue?: string | null;
  branch?: string;
  commitSha?: string;
  failure?: { category: string; component: string; reason: string } | null;
  failureDetail?: Record<string, unknown>;
  mismatches?: readonly { name: string; reason: string }[];
}): StageFlowResult {
  return {
    state: options.state,
    refactorSummary: "fake",
    refactorDialogueId: options.dialogueId ?? null,
    workflowsDialogueId: options.workflowsDialogue ?? null,
    patch: options.branch !== undefined
      ? {
          branch: options.branch,
          base_sha: "base-000",
          commit_sha: options.commitSha ?? "commit-000",
          changed_files: ["src/x.c"],
          summary: "fake patch",
        }
      : null,
    declared: null,
    verification: {
      state: options.state,
      results: [],
      baselineBuild: null,
      candidateBuild: null,
      baseline: null,
      candidate: null,
      comparison: null,
      expectationComparison:
        options.state === "REJECTED"
          ? ({
              kind: "expectation-comparison-result",
              version: 1,
              overall: "inconsistent",
              declarations: (options.mismatches ?? []).map((mismatch) => ({
                name: mismatch.name,
                relation: "equal",
                matched: false,
                reason: mismatch.reason,
              })),
              errors: [],
              reason: "fake",
            } as never)
          : null,
    },
    provenance: { injected: [], verification_authoritative: true },
    failure: options.failure === undefined || options.failure === null
      ? null
      : {
          kind: "failure-report" as const,
          version: 1 as const,
          stage: "verify",
          category: options.failure.category,
          component: options.failure.component,
          retryable: true,
          reason: options.failure.reason,
          detail: options.failureDetail ?? {},
          at: "2026-01-01T00:00:00.000Z",
        },
    logDir: "D:\\fake\\log",
    store: {} as never,
  } as unknown as StageFlowResult;
}

interface Captured {
  rounds: string[];
  repairContexts: RepairRoundContext[];
  notifications: string[];
  pinnedCalls: number;
}

function makeConfig(
  script: readonly StageFlowResult[],
  captured: Captured,
  budget = 3,
): FeedbackLoopConfig {
  let call = 0;
  const fakeStage = (async () => ({})) as never;
  return {
    baseTask: "重构任务",
    budget,
    notify: (message) => captured.notifications.push(message),
    runInitial: async () => {
      captured.rounds.push("initial");
      const step = script[Math.min(call, script.length - 1)]!;
      call++;
      return step;
    },
    loadPinnedWorkflows: () => fakeStage,
    locateExamEntry: () => "D:\\fake\\exam\\test-workflow.ts",
    composeBuildBrief: () => "构建修复简报",
    runBuildRepair: async () => ({ id: "fixed-build", entry: "D:\\fake\\fixed-build.ts" }),
    loadBaselineObservations: () => null,
    sessionIdFor: (round) => `real-session-${round === 1 ? "base" : `fb${String(round)}`}`,
    runRepairRound: async (round, context) => {
      captured.rounds.push(`repair-${String(round)}`);
      captured.repairContexts.push(context);
      const step = script[Math.min(call, script.length - 1)]!;
      call++;
      return step;
    },
  };
}

const MISMATCHES = [{ name: "csv[0].mean.stdout", reason: "baseline '0.000' vs candidate 'nan'" }];

describe("composeRefactorFeedback", () => {
  test("behavior mismatch lists the diffs and forbids drift", () => {
    const message = composeRefactorFeedback(
      "behavior-mismatch",
      { summary: "inconsistent", mismatches: MISMATCHES },
      { candidateBranch: "refactor/agent-x", round: 2 },
    );
    expect(message).toContain("csv[0].mean.stdout");
    expect(message).toContain("baseline '0.000' vs candidate 'nan'");
    expect(message).toContain("refactor/agent-x");
    expect(message).toContain("不要从原版重新完成整个任务");
    expect(message).toContain("与基线完全一致");
  });

  test("candidate-build and candidate-crash carry their evidence", () => {
    const build = composeRefactorFeedback(
      "candidate-build",
      { summary: "main.c:12: syntax error" },
      { candidateBranch: "b", round: 2 },
    );
    expect(build).toContain("编译失败");
    expect(build).toContain("main.c:12: syntax error");
    const crash = composeRefactorFeedback(
      "candidate-crash",
      { summary: "runner exited with assert failure (code 3)" },
      { candidateBranch: "b", round: 3 },
    );
    expect(crash).toContain("崩溃或卡死");
    expect(crash).toContain("assert failure");
  });
});

describe("routerInputOf", () => {
  test("derives the side from the attribution component", () => {
    const input = routerInputOf(
      fakeResult({
        state: "ABORTED",
        failure: { category: "build", component: "build-workflow:candidate", reason: "gcc failed" },
      }),
    );
    expect(input.side).toBe("candidate");
    expect(input.failure?.category).toBe("build");
  });

  test("extracts the failed build id from the attribution detail", () => {
    const input = routerInputOf(
      fakeResult({
        state: "ABORTED",
        failure: {
          category: "build",
          component: "build-workflow:baseline",
          reason: "build b2 failed: gcc exited 1",
        },
        failureDetail: { build_id: "b2" },
      }),
    );
    expect(input.buildId).toBe("b2");
  });

  test("build id stays null without structured attribution", () => {
    const input = routerInputOf(
      fakeResult({
        state: "ABORTED",
        failure: { category: "build", component: "build-workflow:baseline", reason: "gcc failed" },
      }),
    );
    expect(input.buildId).toBeNull();
  });
});

describe("runFeedbackLoop", () => {
  test("round 1 accepted: no repair, no budget spent", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(makeConfig([fakeResult({ state: "ACCEPTED" })], captured));
    expect(outcome.stoppedBecause).toBe("accepted");
    expect(captured.rounds).toEqual(["initial"]);
    expect(captured.pinnedCalls).toBe(0);
  });

  test("REJECTED round 1 continues the original dialogue and accepts in round 2", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([
        fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "refactor/agent-x", commitSha: "c1", mismatches: MISMATCHES }),
        fakeResult({ state: "ACCEPTED", dialogueId: "conv-1", branch: "refactor/agent-x", commitSha: "c2" }),
      ], captured),
    );
    expect(outcome.stoppedBecause).toBe("accepted");
    expect(captured.rounds).toEqual(["initial", "repair-2"]);
    // The repair round continued the SAME dialogue with the diff embedded.
    const context = captured.repairContexts[0]!;
    if (context.lane !== "refactor") throw new Error("expected refactor lane");
    expect(context.dialogueId).toBe("conv-1");
    expect(context.candidateBranch).toBe("refactor/agent-x");
    expect(context.feedback).toContain("csv[0].mean.stdout");
  });

  test("budget exhaustion keeps the last real result", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig(
        [
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "c1", mismatches: MISMATCHES }),
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "c2", mismatches: [{ name: "other", reason: "x" }] }),
        ],
        captured,
        1,
      ),
    );
    expect(outcome.stoppedBecause).toBe("budget-exhausted");
    expect(captured.rounds).toEqual(["initial", "repair-2"]);
  });

  test("identical artifact AND identical failure twice stop as no-progress", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig(
        [
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "same", mismatches: MISMATCHES }),
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "same", mismatches: MISMATCHES }),
        ],
        captured,
        3,
      ),
    );
    expect(outcome.stoppedBecause).toBe("no-progress");
    expect(captured.rounds).toEqual(["initial", "repair-2"]);
  });

  test("progress with a new commit keeps the loop going", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig(
        [
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "c1", mismatches: MISMATCHES }),
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "c2", mismatches: MISMATCHES }),
          fakeResult({ state: "ACCEPTED" }),
        ],
        captured,
        3,
      ),
    );
    expect(outcome.stoppedBecause).toBe("accepted");
    expect(captured.rounds).toEqual(["initial", "repair-2", "repair-3"]);
  });

  test("missing dialogue handle stops with a clear reason", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([fakeResult({ state: "REJECTED", dialogueId: null, branch: "b", mismatches: MISMATCHES })], captured),
    );
    expect(outcome.stoppedBecause).toBe("missing-dialogue");
    expect(captured.repairContexts).toHaveLength(0);
  });

  test("baseline reuse receives the PREVIOUS round's real session id", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const observedSessionIds: string[] = [];
    const config = makeConfig([
      fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "c1", mismatches: MISMATCHES }),
      fakeResult({ state: "ACCEPTED", branch: "b" }),
    ], captured);
    const outcome = await runFeedbackLoop({
      ...config,
      loadBaselineObservations: (previousSessionId) => {
        observedSessionIds.push(previousSessionId);
        return [{ name: "e1", relation: "equal", value: 1 }] as never;
      },
    });
    expect(outcome.stoppedBecause).toBe("accepted");
    // The loader must be called with the REAL round-1 session id — the
    // internal "round-1" label names no on-disk directory (regression: reuse
    // silently never activated in production because of exactly that).
    expect(observedSessionIds).toEqual(["real-session-base"]);
    const context = captured.repairContexts[0]!;
    if (context.lane !== "refactor") throw new Error("expected refactor lane");
    expect(context.reusedBaseline).not.toBeNull();
    expect(context.sessionId).toBe("real-session-fb2");
  });

  test("baseline build failure goes through the build-repair lane", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([
        fakeResult({
          state: "ABORTED",
          dialogueId: "conv-1",
          branch: "refactor/agent-x",
          commitSha: "c1",
          failure: { category: "build", component: "build-workflow:baseline", reason: "gcc exited 1" },
        }),
        fakeResult({ state: "ACCEPTED", dialogueId: "conv-1", branch: "refactor/agent-x", commitSha: "c1" }),
      ], captured),
    );
    expect(outcome.stoppedBecause).toBe("accepted");
    expect(captured.rounds).toEqual(["initial", "repair-2"]);
    const context = captured.repairContexts[0]!;
    if (context.lane !== "build") throw new Error("expected build lane");
    expect(context.fixedBuild.id).toBe("fixed-build");
    // Pre-attribution rounds carry no build id: the checkpoint's shape
    // decides (the CLI's merge treats a single declared build as the slot).
    expect(context.failedBuildId).toBeNull();
    // The candidate branch is preserved untouched by the build repair.
    expect(context.candidateBranch).toBe("refactor/agent-x");
    expect(captured.notifications.join("\n")).toContain("构建修理工");
  });

  test("build lane carries the attributed failed build id into the repair context", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([
        fakeResult({
          state: "ABORTED",
          branch: "refactor/agent-x",
          failure: {
            category: "build",
            component: "build-workflow:baseline",
            reason: "build b2 failed: gcc exited 1",
          },
          failureDetail: { build_id: "b2" },
        }),
        fakeResult({ state: "ACCEPTED", branch: "refactor/agent-x" }),
      ], captured),
    );
    expect(outcome.stoppedBecause).toBe("accepted");
    const context = captured.repairContexts[0]!;
    if (context.lane !== "build") throw new Error("expected build lane");
    expect(context.failedBuildId).toBe("b2");
  });

  test("build repair that delivers nothing stops and keeps the evidence", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const config = makeConfig([
      fakeResult({
        state: "ABORTED",
        branch: "refactor/agent-x",
        failure: { category: "build", component: "build-workflow:baseline", reason: "gcc exited 1" },
      }),
    ], captured);
    const outcome = await runFeedbackLoop({ ...config, runBuildRepair: async () => null });
    expect(outcome.stoppedBecause).toBe("repair-failed");
    expect(captured.repairContexts).toHaveLength(0);
    expect(captured.notifications.join("\n")).toContain("没有交付可用的修复方案");
  });

  test("test-script failure continues the authoring dialogue (test lane)", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([
        fakeResult({
          state: "ABORTED",
          workflowsDialogue: "conv-author",
          dialogueId: "conv-refactor",
          branch: "refactor/agent-x",
          commitSha: "c1",
          failure: {
            category: "test",
            component: "test-workflow:baseline",
            reason: "TypeError: ctx.fs.read is not a function",
          },
        }),
        fakeResult({ state: "ACCEPTED", branch: "refactor/agent-x" }),
      ], captured),
    );
    expect(outcome.stoppedBecause).toBe("accepted");
    const context = captured.repairContexts[0]!;
    if (context.lane !== "test") throw new Error("expected test lane");
    expect(context.dialogueId).toBe("conv-author");
    expect(context.testEntry).toContain("test-workflow.ts");
    expect(context.feedback).toContain("脚本错误");
  });

  test("environment failure routes to an immediate stop", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([
        fakeResult({
          state: "ABORTED",
          failure: { category: "build", component: "build-workflow:baseline", reason: "gcc: command not found" },
        }),
      ], captured),
    );
    expect(outcome.stoppedBecause).toBe("routed-stop");
    expect(captured.repairContexts).toHaveLength(0);
  });

  test("pinned exam unavailable stops instead of re-authoring", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const config = makeConfig([fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", mismatches: MISMATCHES })], captured);
    const outcome = await runFeedbackLoop({ ...config, loadPinnedWorkflows: () => null });
    expect(outcome.stoppedBecause).toBe("missing-patch");
    expect(captured.repairContexts).toHaveLength(0);
    expect(captured.notifications.join("\n")).toContain("考卷");
  });
});

describe("mergeRepairedBuilds", () => {
  const SINGLE = [{ id: "b1", entry: "wf/build/b1.ts", runLocal: false }];
  const SET = [
    { id: "b1", entry: "wf/build/b1.ts", runLocal: false },
    { id: "b2", entry: "wf/build/b2.ts", runLocal: true },
  ];
  const FIXED = { id: "b2.r2", entry: "D:\\fix\\b2.r2.ts" };

  test("a single declared build is replaced outright", () => {
    expect(mergeRepairedBuilds(SINGLE, FIXED, null)).toEqual([
      { id: "b2.r2", entry: FIXED.entry, runLocal: true },
    ]);
  });

  test("multi-build sets replace the attributed slot and keep the rest verbatim", () => {
    // Shrinking the set would verify a different contract than round 1.
    expect(mergeRepairedBuilds(SET, FIXED, "b2")).toEqual([
      { id: "b1", entry: "wf/build/b1.ts", runLocal: false },
      { id: "b2.r2", entry: FIXED.entry, runLocal: true },
    ]);
    expect(mergeRepairedBuilds(SET, FIXED, "b1")).toEqual([
      { id: "b2.r2", entry: FIXED.entry, runLocal: true },
      { id: "b2", entry: "wf/build/b2.ts", runLocal: true },
    ]);
  });

  test("an unmappable repair returns null instead of guessing", () => {
    expect(mergeRepairedBuilds(SET, FIXED, "ghost")).toBeNull();
    expect(mergeRepairedBuilds([], FIXED, "b1")).toBeNull();
  });
});

describe("--auto-retry parsing (carried over from the auto-retry suite)", () => {
  test("defaults to 3 (feedback on) and accepts an explicit 0", () => {
    const defaults = parseCliArgs(["run", ".", "--task", "t"]);
    expect(defaults.kind === "run" && defaults.autoRetry).toBe(3);
    const explicitZero = parseCliArgs(["run", ".", "--task", "t", "--auto-retry", "0"]);
    expect(explicitZero.kind === "run" && explicitZero.autoRetry).toBe(0);
    const one = parseCliArgs(["run", ".", "--task", "t", "--auto-retry", "1"]);
    expect(one.kind === "run" && one.autoRetry).toBe(1);
    expect(() => parseCliArgs(["run", ".", "--task", "t", "--auto-retry", "-1"])).toThrow(/non-negative/);
  });
});

describe("feedback integration (real gcc, real git)", () => {
  const BUILD_WORKFLOW = `
export const workflowKind = "workflow-driven";

export default async ({ process, fs, validator }) => {
  await fs.mkdir("build");
  const compiled = await process.run({
    program: "gcc",
    args: ["main.c", "-o", "build/app.exe"],
    cwd: ".",
    timeoutMs: 60000,
  });
  if (compiled.status !== "exited" || compiled.exitCode !== 0) {
    throw new Error("gcc failed");
  }
  await validator.assertFile("build/app.exe", "fixture executable");
};
`;

  const TEST_WORKFLOW = `
export const workflowKind = "test-workflow-driven";

export default async (ctx) => {
  await ctx.validator.assertFile("build/app.exe", "fixture executable");
  const run = await ctx.process.run({ program: "build/app.exe", args: [], cwd: ".", timeoutMs: 30000 });
  ctx.expect("exit-code", run.exitCode);
  ctx.expect("stdout", run.stdout.trim());
};
`;

  const MAIN_V1 = [
    "#include <stdio.h>",
    "",
    "int main(void) {",
    '  puts("hello v1");',
    "  return 0;",
    "}",
    "",
  ].join("\n");

  const MAIN_V2 = MAIN_V1.replace("hello v1", "hello v2");
  const MAIN_FIXED = MAIN_V1.replace("int main(void) {", "int main(void) { /* fixed */");

  function gitIn(dir: string, args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  }

  function createRepo(): { repo: string; sessionRoot: string } {
    const root = mkdtempSync(join(tmpdir(), "rfr-feedback-int-"));
    const repo = join(root, "repo");
    const sessionRoot = join(root, "session-root");
    mkdirSync(join(repo, "workflows"), { recursive: true });
    mkdirSync(sessionRoot, { recursive: true });
    writeFileSync(join(repo, ".gitattributes"), "* -text\n");
    writeFileSync(join(repo, "main.c"), MAIN_V1);
    writeFileSync(join(repo, "workflows", "build.ts"), BUILD_WORKFLOW);
    writeFileSync(join(repo, "workflows", "test.ts"), TEST_WORKFLOW);
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@example.com"]);
    gitIn(repo, ["config", "user.name", "Test"]);
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    return { repo, sessionRoot };
  }

  test("a REJECTED round's baseline observations are reused by the repair round", async () => {
    const fixture = createRepo();
    try {
      // Round 1: the candidate branch carries a behavior-breaking change.
      const baseSha = gitIn(fixture.repo, ["rev-parse", "HEAD"]);
      writeFileSync(join(fixture.repo, "main.c"), MAIN_V2);
      gitIn(fixture.repo, ["add", "-A"]);
      gitIn(fixture.repo, ["commit", "-qm", "behavior-breaking change"]);
      gitIn(fixture.repo, ["branch", "fb-int-1-branch"]);
      gitIn(fixture.repo, ["checkout", "-q", "HEAD~1"]);

      const round1 = await runStageFlow({
        repoPath: fixture.repo,
        task: "integration: rejected round",
        sessionRoot: fixture.sessionRoot,
        sessionId: "fb-int-1",
        flow: {
          workflows: presetWorkflowsStage({
            builds: [{ id: "gcc-app", entry: "workflows/build.ts" }],
            testEntry: "workflows/test.ts",
          }),
          prepare: existingBranchPrepareStage({ branch: "fb-int-1-branch", baseSha }),
          refactor: async () => ({ summary: "behavior-breaking change already on the branch" }),
        },
      });
      expect(round1.state).toBe("REJECTED");
      expect(round1.patch).not.toBeNull();
      expect(round1.patch!.branch).toBe("fb-int-1-branch");

      // Repair round: the continued dialogue's fix (simulated — a
      // behavior-restoring edit) re-verifies with the baseline REUSED.
      const pinned = loadReusableWorkflowsStage(fixture.repo, fixture.sessionRoot, "fb-int-1");
      expect(pinned).not.toBeNull();
      const reusedExpectations = (JSON.parse(
        readFileSync(join(round1.logDir, "artifacts", "expectation-baseline.json"), "utf8"),
      ) as { expectations: unknown }).expectations;
      expect(Array.isArray(reusedExpectations)).toBe(true);

      const round2 = await runStageFlow({
        repoPath: fixture.repo,
        task: "integration: repair round",
        sessionRoot: fixture.sessionRoot,
        sessionId: "fb-int-2",
        flow: {
          workflows: pinned!,
          prepare: existingBranchPrepareStage({
            branch: round1.patch!.branch,
            baseSha: round1.patch!.base_sha,
          }),
          refactor: async (_ctx, input) => {
            // The continued dialogue's output: restore the original behavior,
            // keep only a comment-level difference from the base.
            writeFileSync(join(input.candidate.worktrees.candidateDir, "main.c"), MAIN_FIXED);
            return { summary: "fixed: behavior restored, comment-only difference" };
          },
          verify: verifyStageWithReuse({ reusedBaseline: { expectations: reusedExpectations as never } }),
        },
      });
      expect(round2.state).toBe("ACCEPTED");

      // The reuse actually happened (not a silent full re-run).
      const runLog = readFileSync(join(round2.logDir, "run.jsonl"), "utf8");
      expect(runLog).toContain("baseline observations reused");
      // And the reused baseline is identical to round 1's measurement.
      const reusedArtifact = JSON.parse(
        readFileSync(join(round2.logDir, "artifacts", "expectation-baseline.json"), "utf8"),
      ) as { expectations: unknown };
      expect(JSON.stringify(reusedArtifact.expectations)).toBe(JSON.stringify(reusedExpectations));
    } finally {
      rmSync(join(fixture.repo, ".."), { recursive: true, force: true });
    }
  }, 180_000);
});

