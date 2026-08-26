import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const FORBIDDEN_IMPORTS = [
  /from\s+["'](?:node:|bun:)/,
  /import\s*\(\s*["'](?:node:|bun:)/,
  /require\s*\(\s*["'](?:node:|bun:)/,
  /from\s*["'](?:fs|child_process|worker_threads|net|http|https|os|process)["']/,
  /\bprocess\s*\./,
  /\bBun\s*\./,
];

export interface WorkflowSourceCheck {
  ok: boolean;
  source: string;
  reason: string | null;
}

export function checkWorkflowSource(entry: string): WorkflowSourceCheck {
  const source = readWorkflowSource(entry);
  if (source === null) {
    return { ok: false, source: "", reason: `workflow entry does not exist: ${entry}` };
  }
  if (!/\.(?:ts|tsx|js|jsx)$/.test(entry)) {
    return { ok: false, source, reason: "workflow entry must be a TypeScript or JavaScript module" };
  }
  const forbidden = FORBIDDEN_IMPORTS.find((pattern) => pattern.test(source));
  if (forbidden !== undefined) {
    return {
      ok: false,
      source,
      reason: "workflow directly imports a host API; use injected capabilities instead",
    };
  }
  try {
    new Bun.Transpiler({ loader: loaderFor(entry) }).transformSync(source);
  } catch (error) {
    return {
      ok: false,
      source,
      reason: `workflow syntax/type-preserving transpilation failed: ${errorMessage(error)}`,
    };
  }
  return { ok: true, source, reason: null };
}

function readWorkflowSource(entry: string): string | null {
  const absolute = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function loaderFor(entry: string): "ts" | "tsx" | "js" | "jsx" {
  if (entry.endsWith(".tsx")) return "tsx";
  if (entry.endsWith(".jsx")) return "jsx";
  if (entry.endsWith(".js")) return "js";
  return "ts";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
