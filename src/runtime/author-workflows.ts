import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { DeclaredBuildSet as DeclaredBuildSetValue, HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { asWorkflowSessionFailure, runWorkflowSession, type WorkflowSessionOptions, type WorkflowSessionResult } from "../agents/workflow-session.js";
import { LocalDependencyRegistry } from "../agents/dep-registry.js";
import { WorkflowPolicyError } from "../workflow/source-policy.js";
import type { ResolvedDeclaredWorkflows } from "../workflow/resolve-declared.js";
import { resolveWithRepairs as resolveWithRepairSessions, type WorkflowRepairAttempt } from "../workflow/resolve-with-repairs.js";
import { runWorkflowRepairSession } from "../agents/workflow-repair.js";
import { mergeVerificationMaterials, readVerificationMaterials } from "../workflow/verification-materials.js";
import type { SessionLimits } from "../config/limits.js";
import type { DeclaredAgentResolution } from "./stage-flow.js";
import { E2ELogger } from "./e2e-log.js";
import { StageFailureError } from "./stage-failure.js";
import { FileSessionStore } from "./session-store.js";

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function declaredSetHash(builds: DeclaredBuildSetValue["builds"]): string {
  return createHash("sha256").update(JSON.stringify(builds), "utf8").digest("hex");
}

/**
 * Run the test-writer session, resolve every declared build, and assemble the
 * DeclaredAgentResolution consumed by the verification stage.
 */
export async function runDeclaredResolution(options: {
  readonly repoDir: string;
  readonly sessionRoot: string;
  readonly sessionId: string;
  readonly task: string;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly logger: E2ELogger;
  readonly sessionStore: FileSessionStore;
  readonly limits: SessionLimits;
  /** Rewrite sessions allowed per rejected workflow source. */
  readonly policyRepairs: number;
  /** Absolute TestWorkflow entry override (feedback repair rounds keep the
   *  round-1 exam path; default = this session's own run dir). */
  readonly testEntryOverride?: string;
  /** Continue a prior authoring conversation (exam script repair lane). */
  readonly resume?: {
    readonly dialogueId: string;
    readonly feedback: string;
  };
  /** Session-store override for resume: the continuation must read the
   *  conversation from the store root it was persisted to (round 1's e2e
   *  dir), not this round's own store. */
  readonly resumeStoreRoot?: string;
  /** Builds from the effective plan (earlier rounds of this run, absolute
   *  entries) — adopted read-only so exam repairs keep resolving them. */
  readonly adoptBuilds?: readonly { readonly id: string; readonly entry: string }[];
  readonly onSession?: (session: WorkflowSessionResult) => void | Promise<void>;
  readonly review?: WorkflowSessionOptions["review"];
  readonly brief?: string;
  readonly signal?: AbortSignal;
  readonly runAgentFn?: WorkflowSessionOptions["runAgentFn"];
}): Promise<{ resolution: DeclaredAgentResolution; dialogueId?: string }> {
  const testRelDir = join(".refactor", "runs", options.sessionId, "workflows", "test");
  const testEntry = options.testEntryOverride ?? join(options.repoDir, testRelDir, "test-workflow.ts");
  const session = await runWorkflowSession({
    repoDir: options.repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    task: options.task,
    testEntry,
    host: options.host,
    project: options.project,
    logger: options.logger,
    sessionStore: options.resumeStoreRoot !== undefined
      ? new FileSessionStore(options.resumeStoreRoot)
      : options.sessionStore,
    limits: options.limits,
    ...(options.resume !== undefined ? { resume: options.resume } : {}),
    adoptBuilds: options.adoptBuilds,
    review: options.review,
    brief: options.brief,
    signal: options.signal,
    runAgentFn: options.runAgentFn,
  });
  await options.onSession?.(session);
  if (!session.ok) {
    const f = asWorkflowSessionFailure(session.failure);
    throw new StageFailureError(
      `test-writer session failed: ${f?.reason ?? "unknown"}${session.summary.length > 0 ? ` — ${session.summary.slice(0, 400)}` : ""}`,
      {
        category: f?.category ?? "model-session",
        component: "test-writer-session",
        retryable: f?.retryable ?? true,
        detail: { ...(f?.detail ?? {}), summary_excerpt: session.summary.slice(0, 400) },
      },
    );
  }
  options.logger.info("test-writer session completed", {
    declared_builds: session.declaredBuilds.join(", "),
    verification_analysis: session.verificationAnalysisPath,
    summary: session.summary.slice(0, 200),
  });

  // Rebuild the registry (run-local files restored from disk) to resolve
  // declared build ids to their workflow entries. Adopted builds carry the
  // effective plan's earlier-round builds into repair rounds (their files
  // live under ANOTHER session's run dir and never reached the library).
  const registry = new LocalDependencyRegistry({
    workspaceRoot: options.repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    host: options.host,
    project: options.project,
    ...(options.adoptBuilds !== undefined ? { adoptBuilds: options.adoptBuilds } : {}),
  });
  const buildSources: { id: string; entry: string; runLocal: boolean }[] = [];
  for (const id of session.declaredBuilds) {
    const resolved = await registry.resolveBuildEntry(id);
    if (resolved === null) {
      throw new StageFailureError(
        `declared build workflow '${id}' cannot be resolved to a source`,
        {
          category: "resolution",
          component: "dep-registry",
          retryable: false,
          detail: { build_id: id, declared_builds: [...session.declaredBuilds] },
        },
      );
    }
    buildSources.push({ id, entry: resolved.entry, runLocal: resolved.runLocal });
  }

  let resolved: ResolvedDeclaredWorkflows;
  try {
    resolved = await resolveWithRepairs({
      repoDir: options.repoDir,
      testEntry,
      testWorkflowId: `test-${options.sessionId}`,
      buildSources,
      host: options.host,
      project: options.project,
      logger: options.logger,
      sessionStore: options.sessionStore,
      limits: options.limits,
      policyRepairs: options.policyRepairs,
    });
  } catch (error) {
    if (error instanceof StageFailureError) throw error;
    if (error instanceof WorkflowPolicyError) {
      throw new StageFailureError(errorMessage(error), {
        category: "policy",
        component: "source-policy",
        retryable: false,
        detail: {
          entry: relative(options.repoDir, error.entry).split("\\").join("/"),
          rule: error.violation.rule,
          detail: error.violation.detail,
          line: error.violation.line,
          column: error.violation.column,
          snippet: error.violation.snippet,
        },
      });
    }
    throw new StageFailureError(errorMessage(error), {
      category: "resolution",
      component: "workflow-resolution",
      retryable: false,
      detail: {},
    });
  }

  const resolution = buildDeclaredResolution({
    repoDir: options.repoDir,
    testEntry,
    workflowId: `test-${options.sessionId}`,
    revision: 1,
    builds: buildSources,
    resolved,
  });
  return {
    resolution,
    ...(session.dialogueId !== undefined ? { dialogueId: session.dialogueId } : {}),
  };
}

/**
 * Resolve every declared workflow, handing a source-policy violation back to a
 * bounded repair session instead of aborting the run. Any other failure (hash
 * mismatch, missing file, session error) still propagates.
 */
async function resolveWithRepairs(options: {
  readonly repoDir: string;
  readonly testEntry: string;
  readonly testWorkflowId: string;
  readonly buildSources: readonly { id: string; entry: string; runLocal: boolean }[];
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly logger: E2ELogger;
  readonly sessionStore: FileSessionStore;
  readonly limits: SessionLimits;
  readonly policyRepairs: number;
}): Promise<ResolvedDeclaredWorkflows> {
  const attempts: WorkflowRepairAttempt[] = [];
  const record = (attempt: WorkflowRepairAttempt): void => {
    attempts.push(attempt);
  };
  try {
    const resolved = await resolveWithRepairSessions({
      workspaceRoot: options.repoDir,
      entryRoot: options.repoDir,
      host: options.host,
      project: options.project,
      testEntry: options.testEntry,
      testWorkflowId: options.testWorkflowId,
      testRevision: 1,
      builds: options.buildSources.map((b) => ({ id: b.id, entry: b.entry, runLocal: b.runLocal })),
      policyRepairs: options.policyRepairs,
      onRepairAttempt: record,
      repair: async (request) => {
        options.logger.warn("workflow source rejected by the source policy; requesting a repair", {
          attempt: request.attempt,
          max_repairs: request.attempts,
          entry: relative(options.repoDir, request.entry).split("\\").join("/"),
          rule: request.violation.rule,
          line: request.violation.line,
          column: request.violation.column,
          detail: request.violation.detail,
          snippet: request.violation.snippet,
        });
        const repair = await runWorkflowRepairSession({
          repoDir: options.repoDir,
          entry: request.entry,
          kind: request.kind,
          violation: request.violation,
          attempt: request.attempt,
          attempts: request.attempts,
          logger: options.logger,
          sessionStore: options.sessionStore,
          limits: options.limits,
        });
        options.logger.info("workflow source repair session completed", {
          attempt: request.attempt,
          entry: relative(options.repoDir, request.entry).split("\\").join("/"),
          ok: repair.ok,
          timed_out: repair.timedOut,
          summary: repair.summary.slice(0, 200),
        });
        return { ok: repair.ok, timedOut: repair.timedOut, summary: repair.summary };
      },
    });
    if (attempts.length > 0) {
      options.logger.info("workflow source repair accepted", {
        repairs: attempts.length,
        entries: attempts.map((a) => relative(options.repoDir, a.entry).split("\\").join("/")).join(", "),
      });
      options.logger.artifact("workflow-source-repairs.json", {
        outcome: "accepted",
        repairs: repairRecords(options.repoDir, attempts),
      });
    }
    return resolved;
  } catch (error) {
    if (attempts.length > 0) {
      options.logger.artifact("workflow-source-repairs.json", {
        outcome: "rejected",
        repairs: repairRecords(options.repoDir, attempts),
        final_reason: errorMessage(error),
      });
    }
    throw error;
  }
}

/** Journal-friendly view: repo-relative entries, no full session text. */
function repairRecords(
  repoDir: string,
  attempts: readonly WorkflowRepairAttempt[],
): Record<string, unknown>[] {
  return attempts.map((attempt) => ({
    attempt: attempt.attempt,
    entry: relative(repoDir, attempt.entry).split("\\").join("/"),
    kind: attempt.kind,
    rule: attempt.violation.rule,
    detail: attempt.violation.detail,
    line: attempt.violation.line,
    column: attempt.violation.column,
    snippet: attempt.violation.snippet,
    session_ok: attempt.outcome.ok,
    timed_out: attempt.outcome.timedOut,
    summary: attempt.outcome.summary.slice(0, 400),
  }));
}

/**
 * Assemble the declared resolution from resolved workflows. Shared by the AI
 * and preset workflow stages so both produce the exact same artifact shape.
 */
export function buildDeclaredResolution(options: {
  readonly repoDir: string;
  readonly testEntry: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly builds: readonly { id: string; entry: string; runLocal: boolean }[];
  readonly resolved: ResolvedDeclaredWorkflows;
}): DeclaredAgentResolution {
  const testSource = existsSync(options.testEntry) ? readFileSync(options.testEntry, "utf8") : "";
  const inputs = options.builds.map((build) => ({ build, materials: readVerificationMaterials(build.entry) }));
  const materials = mergeVerificationMaterials(inputs.flatMap((input) => [...input.materials]));
  const builds = inputs.map(({ build: b, materials: buildMaterials }) => ({
    id: b.id,
    entry: relative(options.repoDir, b.entry).split("\\").join("/"),
    source_hash: options.resolved.builds.find((r) => r.id === b.id)?.resolution.sourceHash ?? "",
    run_local: b.runLocal,
    materials: buildMaterials.map(({ path, sha256 }) => ({ path, sha256 })),
  }));
  const declaredSet: DeclaredBuildSetValue = {
    kind: "declared-build-set",
    version: 1,
    test_workflow_id: options.workflowId,
    test_workflow_revision: options.revision,
    builds,
    source_hash: declaredSetHash(builds),
  };

  return {
    declaredSet,
    testResolution: options.resolved.test,
    buildResolutions: options.resolved.builds.map((b) => b.resolution),
    materials,
    testSource,
    workflowId: options.workflowId,
    workflowRevision: options.revision,
  };
}
