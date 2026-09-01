import type { WorkflowCapabilityPolicy, WorkflowEvent, WorkflowFacts } from "./types.js";

export interface WorkerPayload {
  readonly input: unknown;
  readonly facts: WorkflowFacts;
  readonly policy?: WorkflowCapabilityPolicy;
}

export interface CapabilityRequest {
  readonly type: "capability-request";
  readonly id: string;
  readonly capability: "fs" | "process" | "tools" | "plan";
  readonly method: string;
  readonly args: unknown[];
}

export interface CapabilityResponse {
  readonly type: "capability-response";
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly event: WorkflowEvent;
}

export type WorkerEnvelope =
  | {
      readonly type: "workflow-result";
      readonly ok: true;
      readonly result: unknown;
      readonly events: WorkflowEvent[];
    }
  | {
      readonly type: "workflow-result";
      readonly ok: false;
      readonly error: string;
      readonly events: WorkflowEvent[];
    };

export function isCapabilityRequest(value: unknown): value is CapabilityRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "capability-request" &&
    typeof record.id === "string" &&
    (record.capability === "fs" || record.capability === "process" || record.capability === "tools" || record.capability === "plan") &&
    typeof record.method === "string" &&
    Array.isArray(record.args);
}

export function isCapabilityResponse(value: unknown): value is CapabilityResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "capability-response" &&
    typeof record.id === "string" &&
    typeof record.ok === "boolean" &&
    isWorkflowEvent(record.event) &&
    (!Object.hasOwn(record, "error") || record.error === undefined || typeof record.error === "string");
}

export function isWorkerEnvelope(value: unknown): value is WorkerEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "workflow-result" || typeof record.ok !== "boolean") return false;
  if (!isWorkflowEvents(record.events)) return false;
  if (record.ok) return true;
  return typeof record.error === "string";
}

function isWorkflowEvents(value: unknown): value is WorkflowEvent[] {
  return Array.isArray(value) && value.every(isWorkflowEvent);
}

function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" &&
    (record.capability === "fs" || record.capability === "process" || record.capability === "tools" || record.capability === "plan") &&
    typeof record.method === "string" &&
    typeof record.ok === "boolean" &&
    typeof record.durationMs === "number" &&
    (record.error === null || typeof record.error === "string");
}
