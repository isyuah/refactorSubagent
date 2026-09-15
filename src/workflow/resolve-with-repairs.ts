import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import {
  resolveDeclaredWorkflows,
  type DeclaredBuildSource,
  type ResolvedDeclaredWorkflows,
} from "./resolve-declared.js";
import { WorkflowPolicyError, type WorkflowSourceViolation } from "./source-policy.js";

/**
 * resolve-with-repairs — bounded repair of a workflow source the host rejected.
 *
 * A source-policy violation is the one resolution failure the writer can still
 * fix (a hash mismatch, a missing file or an unresolvable build id cannot be
 * repaired by rewriting the module), so it is handed to a repair callback and
 * the whole set is resolved again. Every other failure propagates immediately:
 * the run stays fail-closed, and the caller bounds how often a repair is tried.
 */

export interface WorkflowRepairRequest {
  /** Absolute path of the rejected entry. */
  readonly entry: string;
  readonly kind: "build" | "test";
  readonly violation: WorkflowSourceViolation;
  /** 1-based attempt number. */
  readonly attempt: number;
  /** Total repairs allowed. */
  readonly attempts: number;
}

export interface WorkflowRepairOutcome {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly summary: string;
}

export interface WorkflowRepairAttempt extends WorkflowRepairRequest {
  readonly outcome: WorkflowRepairOutcome;
}

export interface ResolveWithRepairsOptions {
  readonly workspaceRoot: string;
  readonly entryRoot: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  readonly testEntry: string;
  readonly testWorkflowId: string;
  readonly testRevision: number;
  readonly builds: readonly DeclaredBuildSource[];
  /** How many rewrite attempts are allowed per rejected source. */
  readonly policyRepairs: number;
  readonly repair: (request: WorkflowRepairRequest) => Promise<WorkflowRepairOutcome>;
  /** Observability hook, called once per finished repair attempt. */
  readonly onRepairAttempt?: (attempt: WorkflowRepairAttempt) => void;
}

export async function resolveWithRepairs(
  options: ResolveWithRepairsOptions,
): Promise<ResolvedDeclaredWorkflows> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await resolveDeclaredWorkflows({
        workspaceRoot: options.workspaceRoot,
        entryRoot: options.entryRoot,
        host: options.host,
        project: options.project,
        testEntry: options.testEntry,
        testWorkflowId: options.testWorkflowId,
        testRevision: options.testRevision,
        builds: options.builds,
      });
    } catch (error) {
      if (!(error instanceof WorkflowPolicyError) || attempt >= options.policyRepairs) {
        throw error;
      }
      const request: WorkflowRepairRequest = {
        entry: error.entry,
        kind: error.entry === options.testEntry ? "test" : "build",
        violation: error.violation,
        attempt: attempt + 1,
        attempts: options.policyRepairs,
      };
      const outcome = await options.repair(request);
      options.onRepairAttempt?.({ ...request, outcome });
    }
  }
}
