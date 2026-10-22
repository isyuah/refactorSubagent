/** CLI boundary keeps SDK/application imports out of the suite scheduler. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { exec } from "./exec.js";
import { ScoutOptionsSchema, ScoutResultSchema, type ScoutResult } from "./scout-contract.js";
import { readJson, writeJson } from "./util.js";
import type { JobContext } from "./drivers.js";
import type { SuiteCase } from "./suite.js";
import type { CaseEvaluation, Check } from "./evaluate.js";
import type { RubricOutcome } from "./rubric.js";

export const ScoutRunSchema = z.object({
  kind: z.literal("scout"),
  status: z.enum(["exited", "timeout", "error"]),
  exitCode: z.number().int().nullable(), elapsedMs: z.number().nonnegative(),
  error: z.string().nullable(), result: ScoutResultSchema.nullable(),
}).strict();
export type ScoutRun = z.infer<typeof ScoutRunSchema>;

export async function runScoutCase(ctx: JobContext, c: SuiteCase, task: string, model: string | null): Promise<ScoutRun> {
  const options = ScoutOptionsSchema.parse({ ...c.scout, ...(model ? { model } : {}) });
  const request = join(ctx.caseDir, "scout-request.json");
  writeJson(request, { repo: join(ctx.caseDir, "env", c.repo), task, output: ctx.caseDir, scout: options });
  ctx.onPhase("scout", `model=${options.model ?? "default"}, ${options.maxTurns} turns`);
  const processResult = await exec({
    program: ctx.bun, args: [join(ctx.harnessDir, "scripts", "eval-scout.ts"), request],
    cwd: ctx.harnessDir,
    // Allow preflight and cooperative SDK shutdown outside the model deadline.
    timeoutMs: c.timeoutMs ?? options.deadlineMs + 30_000, cooperativeShutdown: true,
    onOutput: () => ctx.onPhase("scout", `${Math.round((Date.now() - ctx.startedAt) / 1000)}s`),
  });
  writeFileSync(join(ctx.caseDir, "harness.stdout.txt"), processResult.stdout, "utf8");
  writeFileSync(join(ctx.caseDir, "harness.stderr.txt"), processResult.stderr, "utf8");
  const path = join(ctx.caseDir, "scout-result.json");
  let result: ScoutResult | null = null;
  let error = processResult.error;
  try {
    if (existsSync(path)) result = ScoutResultSchema.parse(readJson(path));
    else error ??= `scout produced no result: ${processResult.stderr.trim().slice(-500)}`;
  } catch (cause) { error = `invalid scout result: ${String(cause)}`; }
  const run: ScoutRun = {
    kind: "scout", status: processResult.status, exitCode: processResult.exitCode,
    elapsedMs: processResult.elapsedMs, error, result,
  };
  writeJson(join(ctx.caseDir, "run-result.json"), run);
  return run;
}

export function evaluateScout(run: ScoutRun, rubric: RubricOutcome | null): CaseEvaluation {
  const checks: Check[] = [
    { name: "scout-completed", ok: run.status === "exited" && run.exitCode === 0 && run.error === null,
      detail: run.error ?? `scout ${run.status}, exit=${String(run.exitCode)}` },
    { name: "scout-report", ok: run.result?.ok === true && run.result.submitted && run.result.report !== null,
      detail: run.result?.error ?? (run.result?.submitted ? "accepted by production MCP store" : "no accepted report") },
    { name: "source-integrity", ok: run.result?.sourceIntegrity === "unchanged",
      detail: run.result?.sourceChanges.join(", ") || run.result?.sourceIntegrity || "source integrity not measured" },
  ];
  if (rubric) checks.push({ name: "scout-quality", ok: rubric.status !== "failed", detail: rubric.detail });
  return {
    status: checks.some(({ ok }) => !ok) ? "failed" : rubric === null || rubric.status === "pending" ? "pending-rubric" : "passed",
    checks,
    observed: { submitted: run.result?.submitted ?? false, timedOut: run.result?.timedOut ?? run.status === "timeout",
      recommendation: run.result?.report?.recommendation ?? null, error: run.result?.error ?? run.error },
    rubric,
  };
}
