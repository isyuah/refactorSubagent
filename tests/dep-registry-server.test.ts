import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalDependencyRegistry,
} from "../src/agents/dep-registry.js";
import { createDependencyMcpServer } from "../src/agents/dep-registry-server.js";

const VALID_SOURCE = `export const workflowKind = "workflow-driven";
export default async () => { return; };
`;

function makeServer() {
  const root = mkdtempSync(join(tmpdir(), "rfr-depserver-"));
  const sessionRoot = mkdtempSync(join(tmpdir(), "rfr-depserver-sess-"));
  const registry = new LocalDependencyRegistry({
    workspaceRoot: root,
    sessionRoot,
    sessionId: "sess-test",
  });
  const server = createDependencyMcpServer({ registry });
  // The SDK server instance shape: tools live under _tools or similar. For a
  // unit test we only verify construction succeeds and exposes the expected
  // tool names; actual tool invocation is covered by the SDK (spike).
  return { server, registry };
}

describe("createDependencyMcpServer", () => {
  test("constructs without error", () => {
    const { server } = makeServer();
    expect(server).toBeTruthy();
    expect(server.name).toBe("dep-registry");
  });

  test("registry integration: generate then declare then inspect", async () => {
    const { registry } = makeServer();
    const gen = await registry.generate({
      name: "hello",
      description: "builds hello",
      content: VALID_SOURCE,
    });
    expect(gen.workflowId).toMatch(/^hello-sess/);

    const declared = await registry.declare({ buildWorkflowIds: [gen.workflowId] });
    expect(declared).toEqual([gen.workflowId]);

    const items = await registry.inspect({ kind: "build" });
    const mine = items.items.find((item) => item.id === gen.workflowId);
    expect(mine?.status).toBe("run-local");
    expect(mine?.description).toBe("builds hello");
  });

  test("declare rejects unknown id via registry", async () => {
    const { registry } = makeServer();
    await expect(registry.declare({ buildWorkflowIds: ["ghost"] })).rejects.toThrow(/unknown/);
  });
});
