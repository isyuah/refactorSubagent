import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  DependencyRegistry,
  InspectQuery,
} from "./dep-registry.js";

/**
 * dep-registry MCP server binding. Exposes the host-side dependency registry
 * (inspect/declare/generate) as tools the test-writer session can call.
 *
 * The heavy logic lives in dep-registry.ts (unit-tested without Claude); this
 * file only adapts tool arguments/results to the MCP surface.
 */

const InspectInput = z.object({
  kind: z.enum(["build", "test"]),
  id: z.string().min(1).optional(),
});

const DeclareInput = z.object({
  buildWorkflowIds: z.array(z.string().min(1)),
});

const GenerateInput = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional().default(""),
  content: z.string().min(1),
});

export interface DependencyMcpServerOptions {
  readonly registry: DependencyRegistry;
  readonly serverName?: string;
}

/**
 * Build an MCP server exposing the dependency registry to a Claude Code
 * session. Returns the SDK in-process server instance; the caller passes it
 * into query options under `mcpServers`.
 *
 * Tool names in the session are `mcp__<serverName>__<tool>` and must be listed
 * in `allowedTools` to be auto-allowed (verified by spike).
 */
export function createDependencyMcpServer(
  options: DependencyMcpServerOptions,
): McpSdkServerConfigWithInstance {
  const registry = options.registry;
  const name = options.serverName ?? "dep-registry";

  return createSdkMcpServer({
    name,
    version: "1.0.0",
    instructions:
      "Dependency registry for workflow-driven verification. " +
      "inspectWorkflow lists available build workflows (persisted library or " +
      "created this run); declareDependency declares which build workflows the " +
      "test workflow depends on (call with the full set, empty for none); " +
      "generateBuildWorkflow materializes a new workflow-driven BuildWorkflow.",
    tools: [
      {
        name: "inspectWorkflow",
        description:
          "List build workflows available for dependency declaration: persisted " +
          "library entries (status library-verified or library-draft) and entries " +
          "generated this run (status run-local). Omit id to list all of a kind.",
        inputSchema: InspectInput.shape,
        handler: async (args: Record<string, unknown>) => {
          try {
            const parsed = InspectInput.parse(args);
            const query: InspectQuery = {
              kind: parsed.kind,
              ...(parsed.id !== undefined ? { id: parsed.id } : {}),
            };
            const result = await registry.inspect(query);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            };
          } catch (error) {
            return {
              content: [{
                type: "text" as const,
                text: `inspectWorkflow failed: ${errorMessage(error)}`,
              }],
              isError: true,
            };
          }
        },
      },
      {
        name: "declareDependency",
        description:
          "Declare the full set of build workflow ids this test workflow depends " +
          "on (idempotent overwrite). Pass an empty array to explicitly declare no " +
          "dependency. The host executes every declared build before running the " +
          "test workflow.",
        inputSchema: DeclareInput.shape,
        handler: async (args: Record<string, unknown>) => {
          try {
            const parsed = DeclareInput.parse(args);
            const declared = await registry.declare({ buildWorkflowIds: parsed.buildWorkflowIds });
            return {
              content: [{
                type: "text" as const,
                text: `declared build dependencies: ${JSON.stringify(declared)}`,
              }],
            };
          } catch (error) {
            return {
              content: [{
                type: "text" as const,
                text: `declareDependency failed: ${errorMessage(error)}`,
              }],
              isError: true,
            };
          }
        },
      },
      {
        name: "generateBuildWorkflow",
        description:
          "Materialize a workflow-driven BuildWorkflow source. Provide a short " +
          "name, a description of what it builds and produces, and the complete " +
          "TypeScript source. The host validates the source before writing; on " +
          "failure no file is created and the error is returned. Returns the " +
          "assigned workflow id for use in declareDependency.",
        inputSchema: GenerateInput.shape,
        handler: async (args: Record<string, unknown>) => {
          try {
            const parsed = GenerateInput.parse(args);
            const result = await registry.generate({
              name: parsed.name,
              description: parsed.description,
              content: parsed.content,
            });
            return {
              content: [{
                type: "text" as const,
                text: [
                  `generated build workflow:`,
                  `  workflow_id: ${result.workflowId}`,
                  `  revision: ${String(result.revision)}`,
                  `  lines: ${String(result.lineCount)}`,
                  result.description.length > 0 ? `  description: ${result.description}` : "",
                ].filter((line) => line.length > 0).join("\n"),
              }],
            };
          } catch (error) {
            return {
              content: [{
                type: "text" as const,
                text: `generateBuildWorkflow failed: ${errorMessage(error)}`,
              }],
              isError: true,
            };
          }
        },
      },
    ],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
