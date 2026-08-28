import type { WorkflowContext } from "../../src/workflow/types.js";

/** libuv v1.52.1 Debug CTest suite; the host owns timeout and execution policy. */
export default function libuvTestWorkflow(_context: WorkflowContext) {
  return {
    kind: "test-workflow",
    version: 1,
    workflow_id: "libuv-v1.52.1-ctest-debug",
    workflow_revision: 1,
    runner: "ctest",
    build_workflow_id: "libuv-v1.52.1-cmake-debug",
    build_workflow_revision: 1,
    build_dir: "build",
    configuration: "Debug",
    extra_args: [],
    required_top_level_tests: ["uv_test", "uv_test_a"],
    environment: {},
  };
}
