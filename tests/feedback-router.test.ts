import { describe, expect, test } from "bun:test";
import {
  classifyFailureOwner,
  isEnvironmentFailure,
  routeFailure,
  type RouterInput,
} from "../src/runtime/feedback/router.js";
import {
  budgetRemaining,
  consumeBudget,
  detectNoProgress,
  freshFeedbackState,
  loadFeedbackState,
  recordRound,
  rememberDialogue,
  saveFeedbackState,
} from "../src/runtime/feedback/state.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Decision-layer tests: the routing table and the budget sidecar. Pure
 * logic, no pipeline, no AI — the repair handlers get their own suites with
 * controlled agent responses in later phases.
 */

function input(overrides: Partial<RouterInput>): RouterInput {
  return {
    state: "ABORTED",
    failure: null,
    side: null,
    buildId: null,
    mismatches: [],
    failureOwner: null,
    evidencePaths: [],
    ...overrides,
  };
}

const BASELINE_BUILD = {
  stage: "verify",
  category: "build",
  component: "build-workflow:baseline",
  retryable: true,
  reason: "baseline BuildWorkflow failed: gcc exited 1",
  detail: {},
};

const CANDIDATE_BUILD = {
  stage: "verify",
  category: "build",
  component: "build-workflow:candidate",
  retryable: true,
  reason: "candidate BuildWorkflow failed: main.c: syntax error",
  detail: {},
};

const TEST_BASELINE = {
  stage: "verify",
  category: "test",
  component: "test-workflow:baseline",
  retryable: true,
  reason: "baseline test workflow failed",
  detail: {},
};

const TEST_CANDIDATE = {
  stage: "verify",
  category: "test",
  component: "test-workflow:candidate",
  retryable: true,
  reason: "candidate test workflow failed",
  detail: {},
};

describe("classifyFailureOwner / isEnvironmentFailure", () => {
  test("separates script errors from program guards", () => {
    expect(classifyFailureOwner("TypeError: ctx.fs.read is not a function")).toBe("script");
    expect(classifyFailureOwner("runner exited with assert failure (code 3)")).toBe("program");
    expect(classifyFailureOwner("something odd happened")).toBe("ambiguous");
    // Nonzero exits are recorded behavior, not script errors.
    expect(classifyFailureOwner("process exited with code 1")).toBe("ambiguous");
  });

  test("zod declaration-validation failures classify as script errors (live finding)", () => {
    // Observed live: an exam passed observed values into the relation slot;
    // the host's ExpectationBaseline parse rejected the declarations with a
    // zod issue dump. That is definitionally the exam's own bug.
    const zodDump = `[{"code":"invalid_enum_value","path":["expectations",12,"relation"],` +
      `"message":"Invalid enum value. Expected 'equal', received '0.000\\n'"}]`;
    expect(classifyFailureOwner(zodDump)).toBe("script");
    const zodType = `[{"code":"invalid_type","path":["expectations",13,"relation"]}]`;
    expect(classifyFailureOwner(zodType)).toBe("script");
  });

  test("environment markers stop before wasting a repair", () => {
    expect(isEnvironmentFailure("gcc: command not found")).toBe(true);
    expect(isEnvironmentFailure("Access is denied for build/x.exe")).toBe(true);
    expect(isEnvironmentFailure("main.c:12:5: error: expected ';'")).toBe(false);
  });
});

describe("routeFailure — the six routing rules", () => {
  test("rule 1: baseline build failure goes to the build-writer", () => {
    const decision = routeFailure(input({ failure: BASELINE_BUILD, side: "baseline" }));
    expect(decision.kind).toBe("repair-build");
  });

  test("rule 1: the attributed build id travels into the repair evidence", () => {
    const decision = routeFailure(
      input({
        failure: { ...BASELINE_BUILD, detail: { build_id: "libuv-static" } },
        side: "baseline",
        buildId: "libuv-static",
      }),
    );
    expect(decision.kind).toBe("repair-build");
    if (decision.kind === "repair-build") expect(decision.evidence.buildId).toBe("libuv-static");
  });

  test("rule 1 + environment: stops instead of repairing", () => {
    const decision = routeFailure(
      input({
        failure: { ...BASELINE_BUILD, reason: "gcc: command not found" },
        side: "baseline",
      }),
    );
    expect(decision.kind).toBe("stop");
    if (decision.kind === "stop") expect(decision.reason).toBe("environment");
  });

  test("rule 2: candidate build failure goes to the refactor dialogue", () => {
    const decision = routeFailure(input({ failure: CANDIDATE_BUILD, side: "candidate" }));
    expect(decision.kind).toBe("repair-refactor");
    if (decision.kind === "repair-refactor") expect(decision.trigger).toBe("candidate-build");
  });

  test("rule 3: script-shaped test failure goes back to the test-writer", () => {
    const decision = routeFailure(
      input({
        failure: TEST_BASELINE,
        side: "baseline",
        failureOwner: "script",
      }),
    );
    expect(decision.kind).toBe("repair-test");
  });

  test("rule 4: program crash on the candidate side goes to the refactor dialogue", () => {
    const decision = routeFailure(
      input({
        failure: TEST_CANDIDATE,
        side: "candidate",
        failureOwner: "program",
      }),
    );
    expect(decision.kind).toBe("repair-refactor");
    if (decision.kind === "repair-refactor") expect(decision.trigger).toBe("candidate-crash");
  });

  test("gray zone: ambiguous test failure surfaces as needs-diagnosis", () => {
    const decision = routeFailure(
      input({ failure: TEST_BASELINE, side: "baseline", failureOwner: "ambiguous" }),
    );
    expect(decision.kind).toBe("needs-diagnosis");
  });

  test("program-shaped guard firing on the BASELINE stops (exam suspects itself)", () => {
    const decision = routeFailure(
      input({ failure: TEST_BASELINE, side: "baseline", failureOwner: "program" }),
    );
    expect(decision.kind).toBe("stop");
  });

  test("rule 5: REJECTED only ever reaches the refactor dialogue", () => {
    const decision = routeFailure(
      input({
        state: "REJECTED",
        mismatches: [{ name: "csv[0].mean.stdout", reason: "baseline '0.000' vs candidate 'nan'" }],
      }),
    );
    expect(decision.kind).toBe("repair-refactor");
    if (decision.kind === "repair-refactor") {
      expect(decision.trigger).toBe("behavior-mismatch");
      expect(decision.evidence.mismatches).toHaveLength(1);
    }
  });

  test("rule 6: host and cancel failures stop immediately", () => {
    const host = routeFailure(
      input({
        failure: { ...BASELINE_BUILD, category: "internal", reason: "host exploded" },
      }),
    );
    expect(host.kind).toBe("stop");
    if (host.kind === "stop") expect(host.reason).toBe("host");
  });
});

describe("feedback state sidecar", () => {
  test("rounds, dialogues and budget survive a save/load cycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "rfr-feedback-"));
    try {
      let state = freshFeedbackState(3);
      state = rememberDialogue(state, "refactor", "conv-42");
      state = recordRound(state, {
        round: 1,
        sessionId: "run-x",
        outcome: "REJECTED",
        decision: "repair-refactor",
        repair: null,
        budgeted: false,
        artifactHash: "commit-1",
        failureSignature: "repair-refactor:csv[0].mean.stdout",
      });
      state = consumeBudget(state)!;
      saveFeedbackState(dir, state);

      const loaded = loadFeedbackState(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.budgetUsed).toBe(1);
      expect(loaded!.dialogues.refactor).toBe("conv-42");
      expect(loaded!.rounds).toHaveLength(1);
      expect(budgetRemaining(loaded!)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("budget refuses to go negative and reports exhaustion", () => {
    let state = freshFeedbackState(2);
    state = consumeBudget(state)!;
    state = consumeBudget(state)!;
    expect(consumeBudget(state)).toBeNull();
    expect(budgetRemaining(state)).toBe(0);
  });

  test("no-progress fires only on identical artifacts AND identical failures", () => {
    expect(detectNoProgress(freshFeedbackState(3), ["abc", "abc"], ["s1", "s1"])).toBe(true);
    expect(detectNoProgress(freshFeedbackState(3), ["abc", "abd"], ["s1", "s1"])).toBe(false);
    expect(detectNoProgress(freshFeedbackState(3), [null, "abc"], ["s1", "s1"])).toBe(false);
  });
});
