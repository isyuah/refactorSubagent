import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostPreflight, ProjectDetection } from "../src/artifacts/index.js";
import {
  runWorkflowSession,
  type WorkflowSessionAgentOptions,
  type WorkflowSessionResult,
} from "../src/agents/workflow-session.js";

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-wfsess-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.c"), "int main(void){return 0;}\n");
  return root;
}

function minimalHost(): HostPreflight {
  return {
    kind: "host-preflight",
    version: 1,
    platform: process.platform,
    arch: process.arch,
    tools: {},
    paths: {},
  } as unknown as HostPreflight;
}

function minimalProject(root: string): ProjectDetection {
  return {
    kind: "project-detection",
    version: 1,
    repo_root: root,
    language: "c",
    build_systems: [],
    primary_build_system: null,
    markers: [],
    source_files: ["src/main.c"],
    adapter: "none",
    status: "ready",
    reason: null,
  } as unknown as ProjectDetection;
}

interface RunnerBehavior {
  /** Pre-write the test file before the runner returns. */
  writeTestEntry?: boolean;
  /** Whether to simulate the agent having called declareDependency. */
  declared?: boolean;
  /** Whether to register a run-local build so declaration is valid. */
  generateBefore?: boolean;
  /** Simulate session error / timeout. */
  isError?: boolean;
  timedOut?: boolean;
  result?: string;
}

function makeSessionHarness(behavior: RunnerBehavior) {
  const repoDir = tempRepo();
  const sessionRoot = mkdtempSync(join(tmpdir(), "rfr-wfsess-run-"));
  const sessionId = "sess-123";
  const testEntry = join(
    sessionRoot,
    ".refactor",
    "runs",
    sessionId,
    "workflows",
    "test",
    "my-test.ts",
  );
  mkdirSync(join(testEntry, ".."), { recursive: true });



  let capturedOptions: WorkflowSessionAgentOptions | null = null;
  const runner = async (o: WorkflowSessionAgentOptions): Promise<{
    result: string;
    isError: boolean;
    timedOut: boolean;
    denials: string[];
  }> => {
    capturedOptions = o;
    if (behavior.writeTestEntry) {
      mkdirSync(join(testEntry, ".."), { recursive: true });
      writeFileSync(testEntry, "export const workflowKind = \"test-workflow-driven\";\n", "utf8");
    }
    return {
      result: behavior.result ?? "session done",
      isError: behavior.isError ?? false,
      timedOut: behavior.timedOut ?? false,
      denials: [],
    };
  };

  return {
    repoDir,
    sessionRoot,
    testEntry,
    run: (): Promise<WorkflowSessionResult> =>
      runWorkflowSession({
        repoDir,
        sessionRoot,
        sessionId,
        task: "verify trim behavior",
        testEntry,
        host: minimalHost(),
        project: minimalProject(repoDir),
        runAgentFn: runner,
      }),
    captured: () => capturedOptions,
  };
}

describe("runWorkflowSession", () => {
  test("passes agents, mcpServers and MCP allowed tools to the runner", async () => {
    const h = makeSessionHarness({ writeTestEntry: true });
    await h.run();
    const o = h.captured();
    expect(o).not.toBeNull();
    expect(o!.agents["build-writer"]).toBeDefined();
    expect(o!.mcpServers["dep-registry"]).toBeDefined();
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__inspectWorkflow");
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__declareDependency");
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__generateBuildWorkflow");
    expect(o!.skills).toContain("workflow-spec:workflow-spec");
  });

  test("fails when the test workflow file is not produced", async () => {
    const h = makeSessionHarness({ writeTestEntry: false });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("did not produce");
    expect(result.testEntryExists).toBe(false);
  });

  test("session prompt demands both deliverables (declaration + file)", async () => {
    const h = makeSessionHarness({ writeTestEntry: true });
    await h.run();
    const o = h.captured();
    expect(o!.prompt).toContain("declareDependency");
    expect(o!.prompt).toContain("empty array []");
    expect(o!.prompt).toContain("MUST NOT rebuild");
    expect(o!.prompt).toContain("inspectWorkflow");
    expect(o!.prompt).toContain("build-writer");
  });

  test("fails when the session errors without output", async () => {
    const h = makeSessionHarness({ isError: true, result: "" });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("failed without output");
  });

  test("reports timeout", async () => {
    const h = makeSessionHarness({ timedOut: true, writeTestEntry: true });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("timed out");
  });

  test("fails when declaration was never called even if file exists", async () => {
    const h = makeSessionHarness({ writeTestEntry: true });
    const result = await h.run();
    // Fresh registry → declare never called → not explicit → failure.
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("declareDependency");
  });
});
