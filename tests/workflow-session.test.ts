import { afterEach, describe, expect, test } from "bun:test";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostPreflight, ProjectDetection } from "../src/artifacts/index.js";
import { DEFAULT_LIMITS, type SessionLimits } from "../src/config/limits.js";
import {
  runWorkflowSession,
  type WorkflowSessionAgentOptions,
  type WorkflowSessionResult,
} from "../src/agents/workflow-session.js";
import { mcpText, withMcpClient } from "./helpers/mcp-client.js";
import { analysisReport } from "./helpers/verification-analysis.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-wfsess-"));
  tempRoots.push(root);
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
    status: "detected",
    reason: null,
  } as unknown as ProjectDetection;
}

interface RunnerBehavior {
  /** Pre-write the test file before the runner returns. */
  writeTestEntry?: boolean;
  /** Register a minimal build and declare it through the real MCP tools. */
  declared?: boolean;
  /** Submit an investigation through the real MCP tool (no model invocation). */
  submitAnalysis?: boolean;
  /** Simulate session error / timeout. */
  isError?: boolean;
  timedOut?: boolean;
  result?: string;
  runnerError?: boolean;
}

function makeSessionHarness(behavior: RunnerBehavior, limits?: SessionLimits) {
  const repoDir = tempRepo();
  const sessionRoot = mkdtempSync(join(tmpdir(), "rfr-wfsess-run-"));
  tempRoots.push(sessionRoot);
  const sessionId = "sess-123";
  const analysisPath = join(repoDir, ".refactor", "runs", sessionId, "workflows", "verification-analysis.json");
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
  }> => {
    capturedOptions = o;
    if (behavior.runnerError) throw new Error("runner disconnected");
    if (behavior.writeTestEntry) {
      mkdirSync(join(testEntry, ".."), { recursive: true });
      writeFileSync(testEntry, "export const workflowKind = \"test-workflow-driven\";\n", "utf8");
    }
    if (behavior.declared || behavior.submitAnalysis) {
      await withMcpClient(o.mcpServers["dep-registry"] as McpSdkServerConfigWithInstance, async (client) => {
        if (behavior.submitAnalysis) {
          const report = await client.callTool({ name: "submitVerificationAnalysis", arguments: analysisReport() });
          if (report.isError) throw new Error(mcpText(report));
        }
        if (behavior.declared) {
          const build = await client.callTool({
            name: "generateBuildWorkflow",
            arguments: {
              name: "session-build",
              content: 'export const workflowKind = "workflow-driven";\nexport default async () => {};\n',
            },
          });
          const id = /workflow_id:\s*(\S+)/.exec(mcpText(build))?.[1];
          if (build.isError || !id) throw new Error(mcpText(build));
          const declared = await client.callTool({ name: "declareDependency", arguments: { buildWorkflowIds: [id] } });
          if (declared.isError) throw new Error(mcpText(declared));
        }
      });
    }
    return {
      result: behavior.result ?? "session done",
      isError: behavior.isError ?? false,
      timedOut: behavior.timedOut ?? false,
    };
  };

  return {
    repoDir,
    sessionRoot,
    testEntry,
    analysisPath,
    run: (): Promise<WorkflowSessionResult> =>
      runWorkflowSession({
        repoDir,
        sessionRoot,
        sessionId,
        task: "verify trim behavior",
        testEntry,
        host: minimalHost(),
        project: minimalProject(repoDir),
        ...(limits !== undefined ? { limits } : {}),
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
    expect(o!.agents["verification-scout"]).toBeDefined();
    expect(o!.mcpServers["dep-registry"]).toBeDefined();
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__inspectWorkflow");
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__declareDependency");
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__generateBuildWorkflow");
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__submitVerificationAnalysis");
    expect(o!.skills).toContain("workflow-spec:workflow-spec");
  });

  test("session model from limits reaches the agent runner", async () => {
    const configured = makeSessionHarness(
      { writeTestEntry: true },
      { ...DEFAULT_LIMITS.sessions.testWriter, model: "codeagent" },
    );
    await configured.run();
    expect(configured.captured()!.model).toBe("codeagent");

    const fallback = makeSessionHarness({ writeTestEntry: true });
    await fallback.run();
    expect(fallback.captured()!.model).toBeNull(); // null = the CLI's own default
  });

  test("fails when the test workflow file is not produced", async () => {
    const h = makeSessionHarness({ writeTestEntry: false });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("did not produce");
    expect(result.testEntryExists).toBe(false);
  });

  test("session prompt delegates investigation before test design and requires the report", async () => {
    const h = makeSessionHarness({ writeTestEntry: true });
    await h.run();
    const o = h.captured();
    expect(o!.prompt).toContain("declareDependency");
    expect(o!.prompt).toContain("MUST NOT rebuild");
    expect(o!.prompt).toContain("inspectWorkflow");
    expect(o!.prompt).toContain("build-writer");
    expect(o!.prompt).toContain("verification-scout");
    expect(o!.prompt).toContain("submitVerificationAnalysis");
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

  test("a fresh submitted report, declared build and test file complete the session", async () => {
    const h = makeSessionHarness({ writeTestEntry: true, declared: true, submitAnalysis: true });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.declaredBuilds).toHaveLength(1);
    expect(result.verificationAnalysisPath).toBe(h.analysisPath);
    expect(JSON.parse(readFileSync(h.analysisPath, "utf8")).report).toEqual(analysisReport());
  });

  test("an old report file cannot replace this session's report submission", async () => {
    const h = makeSessionHarness({ writeTestEntry: true, declared: true });
    mkdirSync(join(h.analysisPath, ".."), { recursive: true });
    writeFileSync(h.analysisPath, JSON.stringify({ version: 1, report: analysisReport() }));
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("verification analysis");
    expect(result.verificationAnalysisPath).toBeNull();
  });

  test.each(["timeout", "runner-error"])("closes report submission after %s", async (failure) => {
    const h = makeSessionHarness({ timedOut: failure === "timeout", runnerError: failure === "runner-error" });
    if (failure === "runner-error") await expect(h.run()).rejects.toThrow("runner disconnected");
    else expect((await h.run()).timedOut).toBe(true);

    const server = h.captured()!.mcpServers["dep-registry"] as McpSdkServerConfigWithInstance;
    await withMcpClient(server, async (client) => {
      const late = await client.callTool({ name: "submitVerificationAnalysis", arguments: analysisReport() });
      expect(late.isError).toBe(true);
      expect(mcpText(late)).toContain("closed");
    });
  });
});
