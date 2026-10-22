import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** Exercise the real MCP schema/handler path without a model or CLI process. */
export async function withMcpClient<T>(
  server: McpSdkServerConfigWithInstance,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workflow-test", version: "1.0.0" });
  await server.instance.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    await client.close();
    await server.instance.close();
  }
}

export function mcpText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!Array.isArray(result.content)) throw new Error("MCP tool returned no content array");
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
