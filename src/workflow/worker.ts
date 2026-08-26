import { pathToFileURL } from "node:url";
import type { WorkflowContext, WorkflowFacts, WorkflowFunction } from "./types.js";
interface WorkflowModule {
  default?: unknown;
  run?: unknown;
}

const [, , entry, workspaceRoot] = Bun.argv;
if (entry === undefined || workspaceRoot === undefined) {
  process.stderr.write("workflow worker requires entry and workspace root\n");
  process.exit(2);
}

// Keep stdout reserved for the machine-readable worker envelope.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

try {
  const payload: unknown = JSON.parse(await Bun.stdin.text());
  const input = isPayload(payload) ? payload.input : payload;
  const facts = isPayload(payload) ? payload.facts : {};
  // Runtime-selected workflow entry: this is the intentional plugin boundary.
  const loaded: unknown = await import(pathToFileURL(entry).href);
  if (!isWorkflowModule(loaded)) throw new Error("workflow module could not be loaded");
  const candidate = loaded.default ?? loaded.run;
  if (!isWorkflowFunction(candidate)) {
    throw new Error("workflow must export a default function or named run function");
  }
  const context: WorkflowContext = {
    apiVersion: 1,
    workspaceRoot,
    input,
    facts,
  };
  const result = await candidate(context);
  process.stdout.write(JSON.stringify({ ok: true, result: result ?? null }));
} catch (cause) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: cause instanceof Error ? cause.message : String(cause),
  }));
  process.exitCode = 1;
}

function isWorkflowModule(value: unknown): value is WorkflowModule {
  return typeof value === "object" && value !== null;
}
function isWorkflowFunction(value: unknown): value is WorkflowFunction {
  return typeof value === "function";
}

interface WorkerPayload {
  input: unknown;
  facts: WorkflowFacts;
}

function isPayload(value: unknown): value is WorkerPayload {
  return typeof value === "object" && value !== null && "input" in value && "facts" in value;
}
