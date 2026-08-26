import type { WorkflowContext } from "../../src/workflow/types.js";

export default function echoWorkflow(context: WorkflowContext) {
  return {
    apiVersion: context.apiVersion,
    workspaceRoot: context.workspaceRoot,
    input: context.input,
  };
}
