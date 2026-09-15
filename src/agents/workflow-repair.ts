import { relative } from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_LIMITS, type SessionLimits } from "../config/limits.js";
import { runAgent, type DriverRun } from "./driver.js";
import { BUILD_WORKFLOW_SYSTEM, TEST_WORKFLOW_SYSTEM } from "./prompts.js";
import type { Logger } from "../runtime/log.js";
import type { WorkflowSourceViolation } from "../workflow/source-policy.js";

/**
 * workflow-repair — one bounded rewrite session after the host rejected a
 * workflow source.
 *
 * The test-writer session closes before the host validates its output, so a
 * rejected file used to abort the run with no chance to fix it. This session
 * hands the violation back to a writer that already has the workflow contract:
 * it reads the rejected file, fixes the cause, and stops. The host validates
 * again afterwards; the caller bounds how often this may happen.
 */

export interface WorkflowRepairOptions {
  readonly repoDir: string;
  /** Absolute path of the rejected entry. */
  readonly entry: string;
  readonly kind: "build" | "test";
  readonly violation: WorkflowSourceViolation;
  /** 1-based repair attempt. */
  readonly attempt: number;
  /** Total repair attempts the host will allow. */
  readonly attempts: number;
  readonly logger?: Logger;
  readonly sessionStore?: SessionStore;
  readonly limits?: SessionLimits;
  readonly runAgentFn?: (options: WorkflowRepairAgentOptions) => Promise<DriverRun>;
}

/** Options handed to the agent runner (narrowed for testability). */
export interface WorkflowRepairAgentOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly allowedTools: string[];
  readonly extraAllowedTools?: string[];
  readonly skills?: string[];
  readonly maxTurns: number | null;
  readonly timeoutMs?: number;
  readonly stallTimeoutMs?: number | null;
  readonly logger?: Logger;
  readonly sessionStore?: SessionStore;
}

export interface WorkflowRepairResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly timedOut: boolean;
}

/** Enough to read the rejected module and its neighbours, then edit it. */
const REPAIR_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"] as const;

export async function runWorkflowRepairSession(
  options: WorkflowRepairOptions,
): Promise<WorkflowRepairResult> {
  const limits = options.limits ?? DEFAULT_LIMITS.sessions.testWriter;
  const entry = relative(options.repoDir, options.entry).split("\\").join("/");
  const run = await (options.runAgentFn ?? defaultRunAgent)({
    cwd: options.repoDir,
    prompt: repairPrompt(entry, options),
    systemPrompt: options.kind === "test" ? TEST_WORKFLOW_SYSTEM : BUILD_WORKFLOW_SYSTEM,
    allowedTools: [...REPAIR_TOOLS],
    skills: ["workflow-spec:workflow-spec"],
    maxTurns: limits.maxTurns,
    timeoutMs: limits.deadlineMs ?? undefined,
    stallTimeoutMs: limits.stallMs,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.sessionStore !== undefined ? { sessionStore: options.sessionStore } : {}),
  });
  return { ok: !run.isError, summary: run.result, timedOut: run.timedOut };
}

function repairPrompt(entry: string, options: WorkflowRepairOptions): string {
  const { violation } = options;
  return `The host rejected a workflow source before executing it. Fix it in place.

File: ${entry}
Host rule violated: ${violation.rule === "host-import" ? "no host imports" : "no host globals"}
Violation: ${violation.detail} at line ${violation.line}, column ${violation.column}
  ${violation.snippet}

Repair attempt ${options.attempt} of ${options.attempts}. The host re-validates this file
when you finish; if it still violates the policy the run is aborted or repaired again.

Requirements:
  1. Read ${entry} first, then remove the host access with the smallest edit that keeps
     the workflow's behaviour identical. Reaching the host is a hard boundary, not a
     style rule: a value import or a host global would give this module the real
     filesystem or process instead of the injected capabilities.
  2. The policy is enforced on CODE ONLY — comments, string literals, template text and
     regex literals are ignored, so never reword prose to satisfy it.
  3. Use the injected capabilities instead: context.fs / context.process / context.adapters
     / context.validator. Do not import anything, and do not touch process.*, Bun.*,
     node:* or globalThis host objects.
  4. Change nothing else: not the file path, not the exported workflowKind, not the
     declared build set, not the expectations. Do not run builds or tests.
  5. When the file is fixed, stop and state in one sentence what you changed.`;
}

async function defaultRunAgent(o: WorkflowRepairAgentOptions): Promise<DriverRun> {
  return runAgent({
    cwd: o.cwd,
    prompt: o.prompt,
    systemPrompt: o.systemPrompt,
    allowedTools: [...o.allowedTools],
    ...(o.extraAllowedTools !== undefined ? { extraAllowedTools: [...o.extraAllowedTools] } : {}),
    ...(o.skills !== undefined ? { skills: [...o.skills] } : {}),
    maxTurns: o.maxTurns,
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.stallTimeoutMs !== undefined ? { stallTimeoutMs: o.stallTimeoutMs } : {}),
    ...(o.logger !== undefined ? { logger: o.logger } : {}),
    ...(o.sessionStore !== undefined ? { sessionStore: o.sessionStore } : {}),
  });
}
