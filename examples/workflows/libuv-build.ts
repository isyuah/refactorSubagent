import type { WorkflowContext } from "../../src/workflow/types.js";

/** libuv v1.52.1 Windows baseline: CMake Debug tests, benchmark disabled. */
export default function libuvBuildWorkflow(_context: WorkflowContext) {
  return {
    kind: "build-workflow-output",
    version: 1,
    workflow_id: "libuv-v1.52.1-cmake-debug",
    workflow_revision: 1,
    environment: {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "cmake",
        source_dir: ".",
        build_dir: "build",
        generator: null,
        target: null,
        configure_flags: [
          "-DBUILD_TESTING=ON",
          "-DLIBUV_BUILD_TESTS=ON",
          "-DLIBUV_BUILD_BENCH=OFF",
        ],
        build_flags: ["--config", "Debug"],
        output: "build/uv_run_tests",
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
      kind: "test-suite",
      version: 1,
      workflow_id: "libuv-v1.52.1-cmake-debug",
      workflow_revision: 1,
      paths: {
        shared_tests: "build/uv_run_tests",
        static_tests: "build/uv_run_tests_a",
      },
      metadata: {
        project: "libuv",
        version: "v1.52.1",
        configuration: "Debug",
        ctest: true,
      },
    },
  };
}
