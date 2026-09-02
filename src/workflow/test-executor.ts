import type {
  HostPreflight,
  ProjectDetection,
} from "../artifacts/index.js";
import { runWorkflow } from "./runner.js";
import {
  compareExpectations,
  type ExpectationComparisonOutcome,
} from "./expectation-compare.js";
import type {
  ExpectationDeclaration,
  WorkflowCapabilityPolicy,
  WorkflowEvent,
} from "./types.js";

export interface ExecuteTestWorkflowOptions {
  /** Workflow source entry (self-driven test workflow). */
  readonly entry: string;
  /** Absolute baseline worktree dir. */
  readonly baselineDir: string;
  /** Absolute candidate worktree dir. */
  readonly candidateDir: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  readonly policy?: WorkflowCapabilityPolicy;
  /** Input injected into each run (build artifacts etc.). */
  readonly input?: unknown;
  readonly timeoutMs?: number;
}

export interface TestRunSide {
  readonly status: "pass" | "failed" | "timeout" | "rejected";
  readonly failure: string | null;
  readonly expectations: ExpectationDeclaration[];
  readonly events: WorkflowEvent[];
}

export interface ExecuteTestWorkflowResult {
  readonly baseline: TestRunSide;
  readonly candidate: TestRunSide;
  readonly comparison: ExpectationComparisonOutcome | null;
  /** Overall pass only when both sides pass and expectations are consistent. */
  readonly status: "pass" | "failed";
  readonly failure: string | null;
}

/**
 * Execute a self-driven test workflow twice — once in the baseline worktree,
 * once in the candidate worktree. The workflow declares expectations via
 * ctx.expect (same code both sides); the host pairs declarations by position
 * and compares them relation-wise.
 */
export async function executeTestWorkflow(
  options: ExecuteTestWorkflowOptions,
): Promise<ExecuteTestWorkflowResult> {
  const baseline = await runOnce(options, options.baselineDir);
  if (baseline.status !== "pass") {
    return {
      baseline,
      candidate: await runOnce(options, options.candidateDir),
      comparison: null,
      status: "failed",
      failure: `baseline test workflow failed: ${baseline.failure ?? baseline.status}`,
    };
  }

  const candidate = await runOnce(options, options.candidateDir);
  if (candidate.status !== "pass") {
    return {
      baseline,
      candidate,
      comparison: null,
      status: "failed",
      failure: `candidate test workflow failed: ${candidate.failure ?? candidate.status}`,
    };
  }

  const comparison = compareExpectations(baseline.expectations, candidate.expectations);
  if (comparison.overall !== "consistent") {
    const reasons = [
      ...comparison.errors,
      ...comparison.mismatched.map((m) => `'${m.declaration.name}': ${m.reason}`),
    ];
    return {
      baseline,
      candidate,
      comparison,
      status: "failed",
      failure: `test expectations inconsistent: ${reasons.join("; ")}`,
    };
  }

  return {
    baseline,
    candidate,
    comparison,
    status: "pass",
    failure: null,
  };
}

/** Run the self-driven test workflow once in a single worktree (one side). */
export async function runTestSide(
  entry: string,
  cwd: string,
  options: {
    readonly host?: HostPreflight;
    readonly project?: ProjectDetection;
    readonly policy?: WorkflowCapabilityPolicy;
    readonly input?: unknown;
    readonly timeoutMs?: number;
  },
): Promise<TestRunSide> {
  const result = await runWorkflow({
    entry,
    cwd,
    input: options.input ?? { kind: "test-workflow-input", version: 1 },
    facts: { host: options.host, project: options.project },
    policy: options.policy,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  return {
    status: result.status,
    failure: result.failure,
    expectations: result.expectations,
    events: result.events,
  };
}

async function runOnce(
  options: ExecuteTestWorkflowOptions,
  cwd: string,
): Promise<TestRunSide> {
  return runTestSide(options.entry, cwd, {
    host: options.host,
    project: options.project,
    policy: options.policy,
    input: options.input,
    timeoutMs: options.timeoutMs,
  });
}
