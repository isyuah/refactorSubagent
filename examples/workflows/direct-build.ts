import type { WorkflowContext } from "../../src/workflow/types.js";

export default function directBuildWorkflow(_context: WorkflowContext) {
  const compiler = "gcc";
  return {
    kind: "build-workflow-output",
    version: 1,
    workflow_id: "direct-smoke",
    workflow_revision: 3,
    environment: {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "direct-compiler",
        compiler,
        flags: ["-Wall"],
        defines: {},
        sources: ["main.c"],
        output: "build/app",
      },
      sanitizers: [],
      determinism: {
        frozen_time_epoch_ms: null,
        random_seed: null,
        intercept_headers: [],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    },
    artifact: {
      kind: "executable",
      version: 1,
      workflow_id: "direct-smoke",
      workflow_revision: 3,
      paths: { app: "build/app" },
      metadata: { source: "example" },
    },
  };
}
