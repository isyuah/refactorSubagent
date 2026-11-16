import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunReport } from "../src/runtime/progress.js";
import type { HarnessSummary } from "../testset/runner/drivers.js";
import { cliFixture, type CliScenario } from "./helpers/cli-fixture.js";
import { defaultPrepareStage, halt, isHalt, runStageFlow, StageFlowFinalizationError } from "../src/runtime/stage-flow.js";
import { runFeedbackStageFlow } from "../src/runtime/feedback/run.js";
import { buildStageFlow, resolvePipeline } from "../src/config/pipeline.js";
import { formatRunReport } from "../src/cli/display.js";

const cli = fileURLToPath(new URL("../scripts/cli.ts", import.meta.url));

describe("offline CLI run output", () => {
  test("missing tasks in noninteractive invocation fail without creating a session or polluting stdout", async () => {
    const f = cliFixture("abort");
    const args = f.args.filter((_, index) => f.args[index] !== "--task" && f.args[index - 1] !== "--task");
    const child = Bun.spawn([process.execPath, cli, ...args, "--format", "json", "--no-interactive"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--task");
    expect(existsSync(join(f.sessionRoot, ".refactor"))).toBeFalse();
    child.stdin.end();
  }, 30_000);

  test("omitted session names produce distinct durable ids without overwriting earlier runs", async () => {
    const f = cliFixture("abort");
    const args = f.args.filter((_, index) => f.args[index] !== "--session" && f.args[index - 1] !== "--session");
    const sessions: string[] = [];
    for (let i = 0; i < 2; i++) {
      const child = Bun.spawn([process.execPath, cli, ...args, "--format", "json", "--progress", "off"],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const result = JSON.parse(stdout) as { session: string; report: RunReport };
      expect(exit, stderr).toBe(1);
      expect(result.session).toMatch(/^run-[a-z0-9]+-[0-9a-f-]{36}$/);
      expect(result.report.session).toBe(result.session);
      expect(existsSync(join(f.sessionRoot, ".refactor", "sessions", result.session, "state.json"))).toBeTrue();
      sessions.push(result.session);
    }
    expect(new Set(sessions).size).toBe(2);
    expect(f.original()).toBe("int value(void) { return 1; }\n");
    const originalReport = join(f.sessionRoot, ".refactor", "e2e", sessions[0]!, "artifacts", "run-summary.json");
    const before = readFileSync(originalReport, "utf8");
    const duplicate = Bun.spawn([process.execPath, cli, ...args, "--session", sessions[0]!, "--format", "json", "--progress", "off"],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const [out, error, code] = await Promise.all([new Response(duplicate.stdout).text(), new Response(duplicate.stderr).text(), duplicate.exited]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(error).toContain("session exists");
    expect(readFileSync(originalReport, "utf8")).toBe(before);
  }, 90_000);

  for (const cancel of [true, false]) {
    test(`terminal input through CLI: ${cancel ? "cancels before session creation" : "launches with entered task and emits one JSON report"}`, async () => {
      const f = cliFixture("abort");
      // Simulate TTY detection in the child, with piped streams under test control.
      const preload = join(f.root, "terminal-preload.ts");
      writeFileSync(preload, 'Object.defineProperty(process.stdin, "isTTY", { value: true });\nObject.defineProperty(process.stderr, "isTTY", { value: true });\n');
      const args = f.args.filter((_, index) => f.args[index] !== "--task" && f.args[index - 1] !== "--task");
      const child = Bun.spawn([process.execPath, "--preload", preload, cli, ...args, "--format", "json", "--no-color"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "" }, timeout: 30_000 });
      let stderr = "", taskSent = false, choiceSent = false;
      const collectErrors = async (): Promise<void> => {
        const reader = child.stderr.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          stderr += decoder.decode(chunk.value, { stream: true });
          if (!taskSent && stderr.includes("重构任务 > ")) {
            taskSent = true;
            child.stdin.write(cancel ? "/cancel\n" : "保持错误顺序，提取校验函数\n");
            child.stdin.flush();
          } else if (!choiceSent && stderr.includes("[1] 开始运行")) {
            choiceSent = true;
            child.stdin.write("1\n");
            child.stdin.flush();
          }
        }
        stderr += decoder.decode();
      };
      const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), collectErrors(), child.exited]);
      expect(taskSent, stderr).toBeTrue();
      if (cancel) {
        expect(exit, stderr).toBe(130);
        expect(stdout).toBe("");
        expect(stderr).toContain("已取消");
        expect(existsSync(join(f.sessionRoot, ".refactor"))).toBeFalse();
      } else {
        const result = JSON.parse(stdout) as { report: RunReport };
        expect(exit, stderr).toBe(1); // The offline fixture deliberately has a missing workflow.
        expect(choiceSent).toBeTrue();
        expect(result.report.task).toBe("保持错误顺序，提取校验函数");
        expect(result.report.state).toBe("ABORTED");
        expect(JSON.parse(readFileSync(result.report.report_path, "utf8"))).toEqual(result.report);
      }
      child.stdin.end();
    }, 60_000);
  }

  test("redirected human output stays plain with default color enabled", async () => {
    const f = cliFixture("abort");
    const child = Bun.spawn([process.execPath, cli, ...f.args, "--verbosity", "summary", "--progress", "plain"],
      { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(1);
    expect(stdout).toContain("state: ABORTED");
    expect(stdout).toContain("中止原因:");
    expect(stderr).toContain("会话:");
    expect(stdout + stderr).not.toContain("\u001b");
    expect(f.original()).toBe("int value(void) { return 1; }\n");
  }, 90_000);

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
      await runFeedbackStageFlow({ repoPath: f.repo, task: "cleanup failure evidence", sessionId: "cleanup-failure", sessionRoot: f.sessionRoot,
        flow: { ...buildStageFlow(resolvePipeline({ repoRoot: f.repo, overrides: { files: [f.pipeline] } }).pipeline),
          prepare: async (ctx, input) => {
            const prepared = await defaultPrepareStage(ctx, input);
            if (isHalt(prepared)) return prepared;
            return { ...prepared, worktrees: { ...prepared.worktrees, cleanup: () => {
              prepared.worktrees.cleanup();
              throw new Error("fixture cleanup failure");
            } } };
          } },
      }, { budget: 3, resumeFrom: null });
      throw new Error("expected finalization failure");
    } catch (error) {
      if (!(error instanceof StageFlowFinalizationError)) throw error;
      expect(error.result.state).toBe("ACCEPTED");
      expect(error.result.report.feedback?.stopped_because).toBe("finalization-error");
      expect(error.result.report.feedback?.rounds).toHaveLength(1);
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
      const child = Bun.spawn([process.execPath, cli, ...f.args, "--format", "json", "--verbosity", "summary", "--progress", progress], { stdout: "pipe", stderr: "pipe" });
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
      expect(stdout).not.toContain("\u001b");
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
