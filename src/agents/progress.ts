import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "../runtime/log.js";
import type { AgentUsage, ProgressUpdate } from "../runtime/progress.js";

/** Present ordinary assistant text and tool metadata, never thinking or tool payloads. */
export class AgentProgress {
  private readonly id = randomUUID();
  private readonly seen = new Set<string>();
  private readonly tools = new Map<string, { name: string; target: string; role: string; agent_id: string }>();
  private readonly children = new Map<string, string>();
  private readonly hadText = new Set<string>();
  private readonly models = new Map<string, string>();

  constructor(private readonly logger: Logger | undefined, private readonly role: string, model?: string | null) {
    if (model) this.models.set(this.id, model);
    this.emit({ type: "agent-start", agent_id: this.id, role, model: model ?? undefined });
  }

  accept(value: unknown): void {
    const message = record(value);
    const body = record(message.message);
    const parent = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : undefined;
    const agentId = parent ? `${this.id}/${parent}` : this.id;
    const role = parent ? this.children.get(parent) ?? "子会话" : this.role;
    // An SDK assistant turn can deliver several blocks with the same message.id.
    // Deduplicate each delivered block, rather than dropping the rest of the turn.
    const messageId = String(body.id ?? message.uuid ?? "");
    const deliveryId = typeof message.uuid === "string" ? message.uuid : messageId;
    if (typeof body.model === "string") this.models.set(agentId, body.model);
    const content = Array.isArray(body.content) ? body.content : [];
    if (message.type === "assistant") {
      for (const item of content) {
        const block = record(item);
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          if (!this.first(`${agentId}/${deliveryId}/text/${createHash("sha256").update(block.text).digest("hex")}`)) continue;
          this.hadText.add(agentId);
          this.emit({ type: "agent-text", agent_id: agentId, role, text: block.text });
        }
        if (block.type === "tool_use" && typeof block.name === "string" && typeof block.id === "string") {
          if (!this.first(`${agentId}/tool/${block.id}`)) continue;
          const input = record(block.input);
          if (typeof input.subagent_type === "string") this.children.set(block.id, input.subagent_type);
          const tool = { name: block.name, target: toolTarget(block.name, input), role, agent_id: agentId };
          this.tools.set(block.id, tool);
          this.emit({ type: "agent-tool", action: "start", id: block.id, ...tool });
        }
      }
    } else if (message.type === "user") {
      for (const item of content) {
        const block = record(item);
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const tool = this.tools.get(block.tool_use_id);
        if (!tool) continue;
        this.emit({ type: "agent-tool", action: "end", id: block.tool_use_id, ...tool, failed: block.is_error === true });
        this.tools.delete(block.tool_use_id);
      }
    } else if (message.type === "result") {
      if (!this.first(`${agentId}/result/${message.session_id ?? messageId}`)) return;
      if (!this.hadText.has(agentId) && typeof message.result === "string" && message.result) {
        this.hadText.add(agentId);
        this.emit({ type: "agent-text", agent_id: agentId, role, text: message.result });
      }
      const usage = record(message.usage);
      const model = this.models.get(agentId);
      const report: AgentUsage = {
        agent_id: agentId, role,
        ...(parent ? { parent_id: this.id } : {}),
        ...(typeof message.session_id === "string" ? { session_id: message.session_id } : {}),
        ...(model ? { model } : {}),
        ...metric("turns", message.num_turns), ...metric("duration_ms", message.duration_ms),
        ...metric("cost_usd", message.total_cost_usd), ...metric("input_tokens", usage.input_tokens),
        ...metric("output_tokens", usage.output_tokens), ...metric("cache_read_tokens", usage.cache_read_input_tokens),
        ...metric("cache_write_tokens", usage.cache_creation_input_tokens),
      };
      this.emit({ type: "agent-usage", usage: report });
    } else if (message.type === "system" && message.ambient !== true) {
      const toolId = typeof message.tool_use_id === "string" ? message.tool_use_id : undefined;
      if (message.subtype === "task_started" && toolId) {
        if (!this.first(`${agentId}/child/${toolId}`)) return;
        const childRole = typeof message.subagent_type === "string" ? message.subagent_type : "子会话";
        this.children.set(toolId, childRole);
        this.emit({ type: "agent-start", agent_id: `${this.id}/${toolId}`, role: childRole });
      } else if (message.subtype === "task_progress" && typeof message.summary === "string") {
        this.emit({ type: "agent-activity", agent_id: toolId ? `${this.id}/${toolId}` : agentId,
          role: toolId ? this.children.get(toolId) ?? "子会话" : role, text: message.summary });
      }
    } else if (message.type === "tool_progress" && typeof message.tool_name === "string") {
      this.emit({ type: "agent-activity", agent_id: agentId, role,
        text: `${message.tool_name} · ${String(message.elapsed_time_seconds ?? "?")}s`, heartbeat: true });
    }
  }

  private emit(update: ProgressUpdate): void { this.logger?.progress?.(update); }
  private first(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

function metric<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? { [key]: value } as Record<K, number> : {};
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function toolTarget(name: string, input: Record<string, unknown>): string {
  // Deliberately exclude Write/Edit contents, Bash command strings, env and stdin.
  switch (name) {
    case "mcp__dep-registry__generateBuildWorkflow":
      return typeof input.name === "string" ? input.name : "";
    case "mcp__dep-registry__inspectWorkflow":
      return [input.kind, input.id].filter((value) => typeof value === "string").join(" · ");
    case "mcp__dep-registry__declareDependency":
      return Array.isArray(input.buildWorkflowIds) ? input.buildWorkflowIds.filter((value) => typeof value === "string").join(", ") : "";
  }
  const keys = name === "Task" || name === "Agent" ? ["subagent_type", "description"] : ["file_path", "path", "pattern", "glob"];
  return keys.flatMap((key) => typeof input[key] === "string" ? [String(input[key])] : []).join(" · ");
}
