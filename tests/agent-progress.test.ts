import { describe, expect, test } from "bun:test";
import { AgentProgress } from "../src/agents/progress.js";
import type { Logger } from "../src/runtime/log.js";
import type { ProgressUpdate } from "../src/runtime/progress.js";

function replay() {
  const events: ProgressUpdate[] = [];
  const logger: Logger = { level: "info", trace() {}, debug() {}, info() {}, warn() {}, error() {}, progress: (event) => events.push(event) };
  return { events, agent: new AgentProgress(logger, "test-writer") };
}

describe("SDK progress replay", () => {
  test("known registry tools publish only safe identifiers and keep raw protocol names", () => {
    const { agent, events } = replay();
    const calls = [
      { id: "generate", name: "mcp__dep-registry__generateBuildWorkflow", input: { name: "helper-build", content: "PRIVATE_SOURCE", description: "PRIVATE_DESCRIPTION", materials: [{ path: "helper.c", content: "PRIVATE_MATERIAL" }] } },
      { id: "inspect", name: "mcp__dep-registry__inspectWorkflow", input: { kind: "build", id: "build-id" } },
      { id: "declare", name: "mcp__dep-registry__declareDependency", input: { buildWorkflowIds: ["helper-build", "library-build", { token: "PRIVATE_VALUE" }] } },
      { id: "unknown", name: "mcp__other__generateBuildWorkflow", input: { name: "PRIVATE_UNKNOWN_NAME", content: "PRIVATE_UNKNOWN_CONTENT" } },
    ];
    calls.forEach((tool) => agent.accept({ type: "assistant", message: { id: tool.id, content: [{ type: "tool_use", ...tool }] } }));
    const tools = events.filter((event) => event.type === "agent-tool");
    expect(tools.map((tool) => tool.target)).toEqual(["helper-build", "build · build-id", "helper-build, library-build", ""]);
    expect(tools.map((tool) => tool.name)).toEqual(calls.map((tool) => tool.name));
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
  });

  test("retains different blocks in one turn, deduplicates replay and never publishes thinking or tool payloads", () => {
    const { agent, events } = replay();
    const send = (content: unknown[]) => agent.accept({ type: "assistant", message: { id: "same-turn", model: "reported-model", content } });
    send([{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "先检查函数。" }]);
    send([{ type: "text", text: "随后写辅助程序。" }]);
    send([{ type: "text", text: "随后写辅助程序。" }]);
    const tool = { type: "tool_use", id: "edit-1", name: "Write", input: { file_path: "verification/main.c", content: "private file bytes", env: { TOKEN: "secret" } } };
    send([tool]);
    send([tool]);
    agent.accept({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: "private protocol body" }] } });
    agent.accept({ type: "result", session_id: "sdk-1", result: "随后写辅助程序。", num_turns: 2, total_cost_usd: 0.25, usage: { input_tokens: 20, output_tokens: 10 } });
    expect(events.filter((event) => event.type === "agent-text").map((event) => event.text)).toEqual(["先检查函数。", "随后写辅助程序。"]);
    expect(events.filter((event) => event.type === "agent-tool").map((event) => event.action)).toEqual(["start", "end"]);
    const serialized = JSON.stringify(events);
    for (const forbidden of ["private reasoning", "private file bytes", "private protocol body", "secret"]) expect(serialized).not.toContain(forbidden);
    expect(serialized).toContain("verification/main.c");
    expect(events.find((event) => event.type === "agent-usage")).toMatchObject({ usage: { model: "reported-model", turns: 2, cost_usd: 0.25 } });
  });

  test("child text does not suppress root result fallback, and tool liveness is a heartbeat", () => {
    const { agent, events } = replay();
    agent.accept({ type: "system", subtype: "task_started", tool_use_id: "child-1", subagent_type: "build-writer" });
    agent.accept({ type: "assistant", parent_tool_use_id: "child-1", message: { id: "child-turn", content: [{ type: "text", text: "子会话回复" }] } });
    agent.accept({ type: "result", parent_tool_use_id: "child-1", session_id: "sdk-child", result: "子会话回复", total_cost_usd: 0.1 });
    agent.accept({ type: "tool_progress", tool_name: "Agent", elapsed_time_seconds: 30 });
    const result = { type: "result", session_id: "sdk-root", result: "根会话总结", total_cost_usd: 0.5 };
    agent.accept(result);
    agent.accept(result);
    expect(events.filter((event) => event.type === "agent-text").map((event) => event.text)).toEqual(["子会话回复", "根会话总结"]);
    expect(events.filter((event) => event.type === "agent-usage")).toHaveLength(2);
    expect(events.find((event) => event.type === "agent-activity")).toMatchObject({ heartbeat: true });
    expect(events.find((event) => event.type === "agent-usage" && event.usage.role === "build-writer")).toMatchObject({ usage: { parent_id: expect.any(String) } });
  });
});
