import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";

export interface WorkflowFacts {
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
}

export interface WorkflowContext {
  readonly apiVersion: 1;
  readonly workspaceRoot: string;
  readonly input: unknown;
  readonly facts: WorkflowFacts;
}

export type WorkflowFunction = (
  context: WorkflowContext,
) => unknown | Promise<unknown>;

export interface WorkflowRunResult {
  status: "pass" | "failed" | "timeout" | "rejected";
  exitCode: number | null;
  result: unknown;
  stdout: string;
  stderr: string;
  failure: string | null;
}
