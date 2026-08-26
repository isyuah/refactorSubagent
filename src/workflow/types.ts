export interface WorkflowContext {
  readonly apiVersion: 1;
  readonly workspaceRoot: string;
  readonly input: unknown;
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
