import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkWorkflowSource,
  checkWorkflowSourceText,
  WorkflowPolicyError,
  throwWorkflowSourceError,
} from "../src/workflow/source-policy.js";

/** Wrap a source body in a minimal valid workflow module. */
function workflow(body: string): string {
  return `export const workflowKind = "test-workflow-driven";\n\nexport default async (ctx) => {\n${body}\n};\n`;
}

describe("checkWorkflowSourceText — rejects host access in code", () => {
  test("rejects a node: import and reports where it is", () => {
    const check = checkWorkflowSourceText(workflow(`  const fs = await import("node:fs");`));
    expect(check.ok).toBe(false);
    expect(check.violation?.rule).toBe("host-import");
    expect(check.violation?.line).toBe(4);
    expect(check.violation?.detail).toContain("node:fs");
    expect(check.reason).toContain("use injected capabilities instead");
  });

  test("rejects bare host modules, including subpaths and require", () => {
    const subpath = checkWorkflowSourceText(workflow(`  const p = require("fs/promises");`));
    expect(subpath.ok).toBe(false);
    expect(subpath.violation?.rule).toBe("host-import");

    const process = checkWorkflowSourceText(workflow(`  const x = process.env.FOO;`));
    expect(process.ok).toBe(false);
    expect(process.violation?.detail).toBe("process.");
  });

  test("rejects host globals reached through globalThis", () => {
    const dot = checkWorkflowSourceText(workflow(`  const x = globalThis.process.env.FOO;`));
    expect(dot.ok).toBe(false);

    const index = checkWorkflowSourceText(workflow(`  const x = globalThis["process"].env.FOO;`));
    expect(index.ok).toBe(false);
    expect(index.violation?.rule).toBe("host-global");
  });

  test("rejects code inside a template interpolation", () => {
    const check = checkWorkflowSourceText(workflow("  const s = `pid=${process.pid}`;"));
    expect(check.ok).toBe(false);
    expect(check.violation?.detail).toBe("process.");
  });
});

describe("checkWorkflowSourceText — accepts prose that mentions host APIs", () => {
  test("accepts a comment ending in the word process", () => {
    // Regression: this exact line aborted a real e2e run, because the old
    // pattern matched `process.` across the sentence's full stop.
    const check = checkWorkflowSourceText(
      workflow("  // Layer C — the behaviour oracles, per process.\n  await ctx.process.run({});"),
    );
    expect(check.ok).toBe(true);
  });

  test("accepts host calls quoted inside string literals", () => {
    const check = checkWorkflowSourceText(
      workflow(`  const notice = 'the oracle would call process.exit(1) here';\n  ctx.expect("note", notice);`),
    );
    expect(check.ok).toBe(true);
  });

  test("accepts a string that looks like an import statement", () => {
    const check = checkWorkflowSourceText(
      workflow(`  const example = 'import { x } from "node:fs";';\n  ctx.expect("example", example);`),
    );
    expect(check.ok).toBe(true);
  });

  test("accepts a regex literal matching a host global", () => {
    const check = checkWorkflowSourceText(
      workflow(`  const banned = /process\\.env/;\n  ctx.expect("banned", banned.source);`),
    );
    expect(check.ok).toBe(true);
  });

  test("accepts the injected capabilities", () => {
    const check = checkWorkflowSourceText(
      workflow("  const r = await ctx.process.run({ program: \"echo\", args: [] });\n  ctx.expect(\"r\", r.exitCode);"),
    );
    expect(check.ok).toBe(true);
  });
});

describe("checkWorkflowSourceText — syntax", () => {
  test("rejects a source that does not transpile", () => {
    const check = checkWorkflowSourceText("export default ( => {");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("syntax");
    expect(check.violation).toBeNull();
  });
});

describe("checkWorkflowSource", () => {
  test("reports a missing entry as an unfixable failure", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-policy-"));
    const check = checkWorkflowSource(join(root, "absent.ts"));
    expect(check.ok).toBe(false);
    expect(check.violation).toBeNull();
    expect(check.reason).toContain("does not exist");
  });

  test("carries the entry in the thrown policy error", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-policy-"));
    const entry = join(root, "test-workflow.ts");
    writeFileSync(entry, workflow("  const x = process.exitCode;"), "utf8");
    const check = checkWorkflowSource(entry);
    expect(() => throwWorkflowSourceError(entry, check)).toThrow(WorkflowPolicyError);
    try {
      throwWorkflowSourceError(entry, check);
    } catch (error) {
      expect((error as WorkflowPolicyError).entry).toBe(entry);
      expect((error as WorkflowPolicyError).violation.line).toBe(4);
    }
  });
});
