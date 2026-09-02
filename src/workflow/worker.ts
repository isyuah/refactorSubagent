import { pathToFileURL } from "node:url";
import type { WorkflowContext, WorkflowFacts, WorkflowFunction } from "./types.js";
import {
  isCapabilityResponse,
  type CapabilityResponse,
  type WorkerPayload,
  type WorkerEnvelope,
} from "./capability-protocol.js";
import { createWorkflowContext, type WorkflowCapabilityClient } from "./client.js";

interface WorkflowModule {
  default?: unknown;
  run?: unknown;
}

const [, , entry, workspaceRoot] = Bun.argv;
if (entry === undefined || workspaceRoot === undefined) {
  process.stderr.write("workflow worker requires entry and workspace root\n");
  process.exit(2);
}

// Keep stdout reserved for the JSONL capability protocol and result envelope.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

const inputLines = readLines(Bun.stdin.stream())[Symbol.asyncIterator]();
const first = await inputLines.next();
if (first.done || first.value === undefined) {
  process.stderr.write("workflow worker requires a JSON payload\n");
  process.exit(2);
}

let client: WorkflowCapabilityClient | null = null;

try {
  const payloadValue: unknown = JSON.parse(first.value);
  const payload = isPayload(payloadValue)
    ? payloadValue
    : { input: payloadValue, facts: {} } satisfies WorkerPayload;
  const created = createWorkflowContext({
    workspaceRoot,
    input: payload.input,
    facts: payload.facts,
    transport: {
      send: (request) => process.stdout.write(`${JSON.stringify(request)}\n`),
    },
  });
  client = created.client;
  const context = created.context;
  void consumeResponses(inputLines, client);

  // Runtime-selected workflow entry: this is the intentional plugin boundary.
  const loaded: unknown = await import(pathToFileURL(entry).href);
  if (!isWorkflowModule(loaded)) throw new Error("workflow module could not be loaded");
  const candidate = loaded.default ?? loaded.run;
  if (!isWorkflowFunction(candidate)) {
    throw new Error("workflow must export a default function or named run function");
  }
  const result = await candidate(context);
  const envelope: WorkerEnvelope = {
    type: "workflow-result",
    ok: true,
    result: result ?? null,
    events: client.getEvents(),
    expectations: client.getExpectations(),
  };
  await writeLine(envelope);
  client.rejectAll(new Error("workflow completed"));
  process.exit(0);
} catch (cause) {
  const envelope: WorkerEnvelope = {
    type: "workflow-result",
    ok: false,
    error: cause instanceof Error ? cause.message : String(cause),
    events: client?.getEvents() ?? [],
    expectations: client?.getExpectations() ?? [],
  };
  await writeLine(envelope);
  process.exit(1);
}

async function consumeResponses(
  lines: AsyncIterator<string>,
  client: WorkflowCapabilityClient,
): Promise<void> {
  try {
    for (;;) {
      const next = await lines.next();
      if (next.done || next.value === undefined) {
        client.rejectAll(new Error("capability broker disconnected"));
        return;
      }
      const value = parseCapabilityResponse(next.value);
      if (value !== null) client.accept(value);
    }
  } catch (cause) {
    client.rejectAll(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

function parseCapabilityResponse(line: string): CapabilityResponse | null {
  try {
    const value: unknown = JSON.parse(line);
    return isCapabilityResponse(value) ? value : null;
  } catch {
    return null;
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) yield buffer.trim();
}

async function writeLine(value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(line, (error?: Error | null) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function isWorkflowModule(value: unknown): value is WorkflowModule {
  return typeof value === "object" && value !== null;
}
function isWorkflowFunction(value: unknown): value is WorkflowFunction {
  return typeof value === "function";
}
function isPayload(value: unknown): value is WorkerPayload {
  return typeof value === "object" && value !== null &&
    "input" in value && "facts" in value;
}
