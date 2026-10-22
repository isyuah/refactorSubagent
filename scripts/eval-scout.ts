/** Standalone scout adapter; invoked by testset/run.ts, never by the pipeline. */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ScoutOptionsSchema } from "../testset/runner/scout-contract.js";
import { runScoutSession } from "../testset/runner/scout-session.js";
import { installOwnedProcessSignalHandlers } from "../shared/owned-process.js";

installOwnedProcessSignalHandlers();
const Request = z.object({
  repo: z.string().min(1), task: z.string().min(1), output: z.string().min(1),
  scout: ScoutOptionsSchema,
}).strict();
try {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) throw new Error("Usage: bun scripts/eval-scout.ts <request.json>");
  const result = await runScoutSession(Request.parse(JSON.parse(readFileSync(file, "utf8"))));
  process.stdout.write(JSON.stringify({ ok: result.ok, error: result.error }) + "\n");
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
