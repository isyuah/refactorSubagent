import { describe, expect, test } from "bun:test";
import { BUILD_WORKFLOW_SYSTEM, buildWorkflowPrompt } from "../src/agents/prompts.js";

 describe("BuildWorkflow Agent guidance", () => {
  test("keeps host facts, structured argv, and fail-closed rules explicit", () => {
    expect(BUILD_WORKFLOW_SYSTEM).toContain("HostPreflight");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("ProjectDetection");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("Never emit shell commands");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("Be fail-closed");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("node:/bun:");
  });

  test("binds workflow identity and measured context into the request", () => {
    const prompt = buildWorkflowPrompt(
      "libuv-v1.52.1-cmake-debug",
      1,
      '{"tools":{"cmake":{"available":true}}}',
      '{"primary_build_system":"cmake"}',
      "keep benchmarks disabled",
    );
    expect(prompt).toContain("libuv-v1.52.1-cmake-debug@1");
    expect(prompt).toContain('"primary_build_system":"cmake"');
    expect(prompt).toContain("keep benchmarks disabled");
  });
});
