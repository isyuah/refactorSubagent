import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDependencyRegistry } from "../src/agents/dep-registry.js";
import { createDependencyMcpServer } from "../src/agents/dep-registry-server.js";
import { VerificationAnalysisStore } from "../src/agents/verification-analysis.js";
import { verificationScoutDefinition } from "../src/agents/verification-scout.js";
import { mcpText, withMcpClient } from "./helpers/mcp-client.js";
import { analysisReport } from "./helpers/verification-analysis.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rfr-scout-"));
  roots.push(root);
  const path = join(root, "workflows", "verification-analysis.json");
  const store = new VerificationAnalysisStore(path, "verify main behavior");
  return { root, path, store };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verification-scout tool boundary", () => {
  test("has only source reads and report/inspection tools, including for a custom server", () => {
    const agent = verificationScoutDefinition("custom-registry");
    expect(agent.tools).toEqual([
      "Read", "Glob", "Grep",
      "mcp__custom-registry__inspectWorkflow",
      "mcp__custom-registry__submitVerificationAnalysis",
    ]);
    expect(agent.mcpServers).toEqual(["custom-registry"]);
    expect(agent.skills).toEqual(["workflow-spec:verification-scout"]);
    expect(agent.background).toBe(false);
    expect(agent.maxTurns).toBeGreaterThan(0);
  });
});

describe("host-saved verification analysis", () => {
  test("accepts an MCP report, persists its context, and preserves it when an update is rejected", async () => {
    const { root, path, store } = fixture();
    const registry = new LocalDependencyRegistry({ workspaceRoot: root, sessionRoot: root, sessionId: "scout" });
    const server = createDependencyMcpServer({ registry, verificationAnalysis: store });
    await withMcpClient(server, async (client) => {
      const result = await client.callTool({ name: "submitVerificationAnalysis", arguments: analysisReport() });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(mcpText(result))).toEqual({ path, report: analysisReport() });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        version: 1, task: "verify main behavior", report: analysisReport(),
      });
      expect(store.hasSubmission()).toBe(true);

      const rejected = await client.callTool({
        name: "submitVerificationAnalysis", arguments: { ...analysisReport(), behaviors: [] },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).report).toEqual(analysisReport());
      expect(await registry.knownBuildIds()).toEqual([]); // reports do not register builds/materials
    });
  });

  test("requires a usable seam and coverage tradeoff before accepting a test-double recommendation", () => {
    const { store } = fixture();
    const dependency = {
      name: "allocation callback", kind: "internal", treatment: "test-double",
      rationale: "Exercise allocation failure through the existing callback.",
    };
    expect(() => store.submit({ ...analysisReport(), dependencies: [dependency] })).toThrow();
    expect(store.hasSubmission()).toBe(false);
    const result = store.submit({
      ...analysisReport(),
      dependencies: [{
        ...dependency,
        seam: "parser_config.allocate callback",
        simulate: ["Return NULL on the selected allocation"],
        retainReal: "Real parser implementation and all internal parsing helpers",
        lostCoverage: ["Actual allocator exhaustion behavior"],
      }],
    });
    expect(result.report.dependencies[0]?.treatment).toBe("test-double");
  });

  test("keeps inference distinct from source evidence and requires actionable uncertainty", () => {
    const { store } = fixture();
    const inferred = { basis: "inference", reference: "task description", finding: "The API may be isolated." };
    expect(() => store.submit({ ...analysisReport(), evidence: [inferred] })).toThrow(/source evidence/);
    const unknown = {
      ...analysisReport(), evidence: [inferred],
      recommendation: { strategy: "undetermined", rationale: "Implementation not located yet.", alternatives: [] },
    };
    expect(() => store.submit(unknown)).toThrow(/unresolved/);
    store.submit({ ...unknown, openQuestions: ["Which source file defines the task's entry point?"] });
    expect(store.hasSubmission()).toBe(true);
  });

  test("allows corrected reports during authoring but neither stale files nor late submissions count", () => {
    const { path, store } = fixture();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ report: analysisReport() }));
    expect(store.hasSubmission()).toBe(false);
    store.submit(analysisReport());
    const updated = { ...analysisReport(), openQuestions: ["Confirm the selected build flags with build-writer."] };
    store.submit(updated);
    store.close();
    expect(() => store.submit(analysisReport())).toThrow(/closed/);
    expect(JSON.parse(readFileSync(path, "utf8")).report).toEqual(updated);
    expect(new VerificationAnalysisStore(path, "new attempt").hasSubmission()).toBe(false);
  });

  test("surfaces persistence failure through MCP without marking the report as submitted", async () => {
    const { root, path, store } = fixture();
    mkdirSync(path, { recursive: true }); // a directory blocks atomic publication of the report
    const registry = new LocalDependencyRegistry({ workspaceRoot: root, sessionRoot: root, sessionId: "failure" });
    const server = createDependencyMcpServer({ registry, verificationAnalysis: store });
    await withMcpClient(server, async (client) => {
      const result = await client.callTool({ name: "submitVerificationAnalysis", arguments: analysisReport() });
      expect(result.isError).toBe(true);
      expect(mcpText(result)).toContain("submitVerificationAnalysis failed");
      expect(store.hasSubmission()).toBe(false);
      expect(readdirSync(join(root, "workflows"))).toEqual(["verification-analysis.json"]);
    });
  });
});
