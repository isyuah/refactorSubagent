import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCliArgs, CliUsageError } from "../src/cli/args.js";
import { runWorkflow } from "../src/workflow/runner.js";

function tempWorkflow(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-workflow-"));
  const entry = join(root, "workflow.ts");
  writeFileSync(entry, source);
  return entry;
}

describe("CLI and Workflow foundation", () => {
  test("parses workflow options and mutually exclusive input sources", () => {
    const command = parseCliArgs([
      "workflow",
      "run",
      "workflow.ts",
      "--cwd",
      "repo",
      "--input-json",
      "{\"x\":1}",
      "--timeout-ms",
      "2500",
      "--format",
      "json",
    ]);
    expect(command).toEqual({
      kind: "workflow-run",
      entry: "workflow.ts",
      cwd: "repo",
      inputJson: "{\"x\":1}",
      inputFile: null,
      timeoutMs: 2500,
      format: "json",
    });
    expect(() => parseCliArgs(["workflow", "run", "x.ts", "--input-json", "{}", "--input-file", "x.json"]))
      .toThrow(CliUsageError);
  });

  test("runs a pure workflow and returns structured output", async () => {
    const entry = tempWorkflow("export default ({ input }) => ({ doubled: (input as number) * 2 });\n");
    const result = await runWorkflow({
      entry,
      cwd: process.cwd(),
      input: 21,
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("pass");
    expect(result.result).toEqual({ doubled: 42 });
  });

  test("rejects direct host access before execution", async () => {
    const entry = tempWorkflow("export default () => process.cwd();\n");
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 5_000 });
    expect(result.status).toBe("rejected");
    expect(result.failure).toContain("host API");
  });

  test("reports workflow timeout", async () => {
    const entry = tempWorkflow("export default async () => { await new Promise(() => {}); };\n");
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 100 });
    expect(result.status).toBe("timeout");
  });
});
