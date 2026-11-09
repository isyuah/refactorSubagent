import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunReport } from "../src/runtime/progress.js";
import type { HarnessSummary } from "../testset/runner/drivers.js";
import { cliFixture, type CliScenario } from "./helpers/cli-fixture.js";
import { defaultPrepareStage, halt, isHalt, runStageFlow, StageFlowFinalizationError } from "../src/runtime/stage-flow.js";
import { buildStageFlow, resolvePipeline } from "../src/config/pipeline.js";
import { formatRunReport } from "../src/cli/display.js";

const cli = fileURLToPath(new URL("../scripts/cli.ts", import.meta.url));

describe("offline CLI run output", () => {
  test("CLI resume preserves checkpoint reuse, progress, configuration and the durable report", async () => {
    const f = cliFixture("accept");
    const sourceSession = "cli-resume-source";
    const first = await runStageFlow({ repoPath: f.repo, task: "resume display integration", sessionId: sourceSession, sessionRoot: f.sessionRoot,
      flow: { ...buildStageFlow(resolvePipeline({ repoRoot: f.repo, overrides: { files: [f.pipeline] } }).pipeline),
        verify: async () => halt("fixture verification temporarily unavailable", { category: "environment", component: "cli-resume-fixture", retryable: true }),
      },
    });
    expect(first.state).toBe("ABORTED");
    expect(first.report.failure).toEqual(first.failure);
    expect(first.report.failure?.stage).toBe("verify");
    expect(formatRunReport(first.report, "summary")).toContain("cli-resume-fixture");
    const child = Bun.spawn([process.execPath, cli, ...f.args, "--resume", sourceSession,
      "--format", "json", "--verbosity", "summary", "--progress", "plain", "--no-color"], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = JSON.parse(stdout) as HarnessSummary & { resumed_from: RunReport["resume"]; report: RunReport };
    expect(exit, stderr).toBe(0);
    expect(result.state).toBe("ACCEPTED");
    expect(result.resumed_from).toEqual({ source_session: sourceSession, reused_stages: ["workflows", "refactor"] });
    expect(result.report.resume).toEqual(result.resumed_from);
    expect(result.report.failure).toBeNull();
    expect(result.report.configuration?.sources).toContain(f.pipeline);
    expect(result.report.stage_timings.filter((stage) => stage.status === "reused").map((stage) => stage.name)).toEqual(["workflows", "refactor"]);
    expect(result.report.stage_timings.find((stage) => stage.name === "verify")?.status).toBe("completed");
    expect(result.report.builds).toHaveLength(4);
    expect(result.report.builds.every((build) => build.status === "pass")).toBeTrue();
    expect(result.report.comparison?.overall).toBe("consistent");
    expect(result.verification_authoritative).toBeTrue();
    expect(stderr).toContain(sourceSession);
    expect(stderr).toContain("WORKFLOW_SESSION");
    expect(stderr).toContain("COMPARISON");
    for (const verbosity of ["detailed", "summary"] as const) {
      expect(formatRunReport(result.report, verbosity)).toContain(sourceSession);
      expect(formatRunReport(result.report, verbosity)).toContain(result.report.candidate!.commit_sha);
    }
    expect(JSON.parse(readFileSync(result.report.report_path, "utf8"))).toEqual(result.report);
  }, 120_000);

  test("a cleanup failure retains the gate verdict and durable evidence while still rejecting successful completion", async () => {
    const f = cliFixture("accept");
    try {
      await runStageFlow({ repoPath: f.repo, task: "cleanup failure evidence", sessionId: "cleanup-failure", sessionRoot: f.sessionRoot,
        flow: { ...buildStageFlow(resolvePipeline({ repoRoot: f.repo, overrides: { files: [f.pipeline] } }).pipeline),
          prepare: async (ctx, input) => {
            const prepared = await defaultPrepareStage(ctx, input);
            if (isHalt(prepared)) return prepared;
            return { ...prepared, worktrees: { ...prepared.worktrees, cleanup: () => {
              prepared.worktrees.cleanup();
              throw new Error("fixture cleanup failure");
            } } };
          } },
      });
      throw new Error("expected finalization failure");
    } catch (error) {
      if (!(error instanceof StageFlowFinalizationError)) throw error;
      expect(error.result.state).toBe("ACCEPTED");
      expect(error.result.report.finalization_error).toBe("fixture cleanup failure");
      expect(error.result.report.stage_timings.find((stage) => stage.name === "cleanup")?.status).toBe("failed");
      expect(JSON.parse(readFileSync(error.result.report.report_path, "utf8"))).toEqual(error.result.report);
    }
  }, 120_000);
  for (const [scenario, state, progress] of [
    ["accept", "ACCEPTED", "auto"], ["mismatch", "REJECTED", "plain"],
    ["build-failure", "ABORTED", "off"], ["missing-artifact", "ABORTED", "plain"], ["abort", "ABORTED", "auto"],
  ] as const) {
    test(`${scenario}: JSON stays parseable, preserves compatibility and explains the outcome`, async () => {
      const f = cliFixture(scenario satisfies CliScenario);
      const child = Bun.spawn([process.execPath, cli, ...f.args, "--format", "json", "--verbosity", "summary", "--progress", progress, "--no-color"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const result = JSON.parse(stdout) as HarnessSummary & { report: RunReport };
      expect(result.state).toBe(state);
      expect(exit).toBe(state === "ACCEPTED" ? 0 : 1);
      expect(result.report.state).toBe(state);
      expect(result.report.decision_reason).toBeTruthy();
      expect(result.report.repo).toBe(f.repo);
      expect(result.report.elapsed_ms).toBeGreaterThan(0);
      expect(result.report.stage_timings.find((stage) => stage.name === "cleanup")?.status).toBe("completed");
      expect(result.report.resume).toBeNull();
      if (state === "ABORTED") {
        expect(result.report.failure).toMatchObject({ stage: scenario === "abort" ? "workflows" : "verify", category: scenario === "abort" ? "resolution" : "build" });
      } else expect(result.report.failure).toBeNull();
      expect(JSON.parse(readFileSync(result.report.report_path, "utf8"))).toEqual(result.report);
      expect(result.log_dir).toBe(result.report.log_dir);
      expect(result.report.configuration?.sources).toContain(f.pipeline);
      // Existing testset clients still consume the original top-level fields.
      expect(result.session).toBe(`fixture-${scenario}`);
      expect(result.verification_authoritative).toBeTrue();
      expect(stderr.includes("会话:")).toBe(progress === "plain");
      expect(stderr).not.toContain("\u001b");
      expect(f.original()).toBe("int value(void) { return 1; }\n");
      expect(existsSync(join(f.sessionRoot, ".refactor", "sessions", "fixture-" + scenario, "worktrees", "candidate"))).toBeFalse();
      if (scenario === "abort") {
        expect(result.report.candidate).toBeNull();
        expect(result.report.comparison).toBeNull();
        expect(result.report.abort_reason).toContain("preset workflow source missing");
        return;
      }
      expect(result.report.builds).toHaveLength(4);
      if (scenario === "build-failure") {
        expect(result.report.builds.map((build) => build.status)).toEqual(["pass", "pass", "failed", "not-run"]);
        expect(result.report.abort_reason).toContain("BUILD_FAIL");
      } else if (scenario === "missing-artifact") {
        expect(result.report.builds.map((build) => build.status)).toEqual(["pass", "failed", "not-run", "not-run"]);
        expect(result.report.abort_reason).toContain("build/secondary.txt");
        expect(stderr).toContain("build/secondary.txt");
      } else {
        expect(result.report.builds.every((build) => build.status === "pass")).toBeTrue();
        expect(result.report.comparison).toMatchObject({ total: 2, matched: scenario === "accept" ? 2 : 1, mismatched: scenario === "accept" ? 0 : 1 });
        if (scenario === "mismatch") expect(result.report.comparison?.checks.find((check) => !check.matched)).toMatchObject({ name: "函数返回值", baseline: "1", candidate: "2" });
      }
    }, 120_000);
  }
});
