import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { SessionStore } from "../src/orchestrator/store.js";
import { runStageFlow, halt } from "../src/runtime/stage-flow.js";
import { planStageResume, runStageFlowResume } from "../src/runtime/stage-resume.js";
import { patchRefactorStage, presetWorkflowsStage } from "../src/runtime/stage-presets.js";
import type { FailureReport } from "../src/artifacts/index.js";

/**
 * Structured failure attribution + checkpoint resume, through the REAL
 * pipeline: preset workflows/refactor stages (no model), real gcc, real git.
 *
 *   run 1  … verify stage halts        → ABORTED + failure-report + checkpoints
 *   run 2  … runStageFlowResume        → reused workflows+refactor, ACCEPTED
 */

const BUILD_WORKFLOW = `
export const workflowKind = "workflow-driven";

export default async ({ process, fs, validator }) => {
  await fs.mkdir("build");
  const compiled = await process.run({
    program: "gcc",
    args: ["main.c", "-o", "build/app.exe"],
    cwd: ".",
    timeoutMs: 60000,
  });
  if (compiled.status !== "exited" || compiled.exitCode !== 0) {
    throw new Error("gcc failed: " + (compiled.error ?? String(compiled.exitCode)));
  }
  await validator.assertFile("build/app.exe", "fixture executable");
};
`;

const TEST_WORKFLOW = `
export const workflowKind = "test-workflow-driven";

export default async (ctx) => {
  await ctx.validator.assertFile("build/app.exe", "fixture executable");
  const run = await ctx.process.run({ program: "build/app.exe", args: [], cwd: ".", timeoutMs: 30000 });
  ctx.expect("exit-code", run.exitCode);
  ctx.expect("stdout", run.stdout.trim());
};
`;

const MAIN_C = [
  "#include <stdio.h>",
  "",
  "int main(void) {",
  '  puts("hello v1");',
  "  return 0;",
  "}",
  "",
].join("\n");

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

interface Fixture {
  readonly repo: string;
  readonly sessionRoot: string;
}

function createRepo(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rfr-stageresume-"));
  const repo = join(root, "repo");
  const sessionRoot = join(root, "session-root");
  mkdirSync(join(repo, "workflows"), { recursive: true });
  mkdirSync(sessionRoot, { recursive: true });
  writeFileSync(join(repo, ".gitattributes"), "* -text\n");
  writeFileSync(join(repo, "main.c"), MAIN_C);
  writeFileSync(join(repo, "workflows", "build.ts"), BUILD_WORKFLOW);
  writeFileSync(join(repo, "workflows", "test.ts"), TEST_WORKFLOW);
  gitIn(repo, ["init", "-q"]);
  gitIn(repo, ["config", "user.email", "t@example.com"]);
  gitIn(repo, ["config", "user.name", "Test"]);
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "-qm", "base"]);
  return { repo, sessionRoot };
}

/** Produce a patch from an edit to main.c, leaving the repo untouched. */
function writePatch(fixture: Fixture, name: string, edit: (source: string) => string): string {
  const target = join(fixture.repo, "main.c");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, edit(original));
  const diff = execFileSync("git", ["diff", "--", "main.c"], { cwd: fixture.repo, encoding: "utf8" });
  writeFileSync(target, original);
  const path = join(fixture.sessionRoot, `${name}.patch`);
  writeFileSync(path, diff);
  return path;
}

function presetFlow(patchFile: string) {
  return {
    workflows: presetWorkflowsStage({
      builds: [{ id: "gcc-app", entry: "workflows/build.ts" }],
      testEntry: "workflows/test.ts",
    }),
    refactor: patchRefactorStage(patchFile),
  };
}

function sessionDir(fixture: Fixture, sessionId: string): string {
  return join(fixture.sessionRoot, ".refactor", "sessions", sessionId);
}

describe("structured failure attribution", () => {
  test("a halt with attribution persists failure-report.json and exposes it on the result", async () => {
    const fixture = createRepo();
    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "attribution: halt carries typed fields",
      sessionRoot: fixture.sessionRoot,
      sessionId: "attr-halt",
      flow: {
        workflows: async () =>
          halt("test-writer session timed out", {
            category: "model-session",
            component: "test-writer-session",
            retryable: true,
            detail: { timed_out: true, stalled: false },
          }),
      },
    });

    expect(result.state).toBe("ABORTED");
    expect(result.failure).not.toBeNull();
    expect(result.failure?.kind).toBe("failure-report");
    expect(result.failure?.stage).toBe("workflows");
    expect(result.failure?.category).toBe("model-session");
    expect(result.failure?.component).toBe("test-writer-session");
    expect(result.failure?.retryable).toBe(true);
    expect(result.failure?.reason).toBe("test-writer session timed out");
    expect(result.failure?.detail).toMatchObject({ timed_out: true });

    // The typed record is durable on the session, not just on the result.
    const store = SessionStore.open(fixture.sessionRoot, "attr-halt");
    const persisted = store.failureReport();
    expect(persisted?.category).toBe("model-session");
    // The ABORTED transition note keeps the plain reason for the run journal.
    expect(store.history.at(-1)?.to).toBe("ABORTED");
    expect(store.history.at(-1)?.note).toBe("test-writer session timed out");
  }, 60_000);

  test("a plain Error falls back to internal/non-retryable attribution", async () => {
    const fixture = createRepo();
    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "attribution: unexpected throw",
      sessionRoot: fixture.sessionRoot,
      sessionId: "attr-throw",
      flow: {
        workflows: async () => {
          throw new Error("registry exploded");
        },
      },
    });

    expect(result.state).toBe("ABORTED");
    expect(result.failure?.stage).toBe("workflows");
    expect(result.failure?.category).toBe("internal");
    expect(result.failure?.component).toBe("stage-flow");
    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.reason).toBe("registry exploded");
  }, 60_000);

  test("an abort performed inside the verification stage is attributed from the measured outcome", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* resume fixture */\n"),
    );
    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "attribution: verification-side abort",
      sessionRoot: fixture.sessionRoot,
      sessionId: "attr-verify",
      flow: {
        ...presetFlow(patch),
        verify: async (ctx) => {
          // Simulate what runWorkflowVerification does when a build fails:
          // it aborts the session directly on the store and returns an outcome.
          new Orchestrator(ctx.store).abort("baseline BuildWorkflow failed: gcc exploded");
          return {
            state: ctx.store.state,
            results: [],
            baselineBuild: { status: "failed", failure: "gcc exploded" } as never,
            candidateBuild: null,
            baseline: null,
            candidate: null,
            comparison: null,
            expectationComparison: null,
          };
        },
      },
    });

    expect(result.state).toBe("ABORTED");
    expect(result.failure?.stage).toBe("verify");
    expect(result.failure?.category).toBe("build");
    expect(result.failure?.component).toBe("build-workflow:baseline");
    expect(result.failure?.retryable).toBe(true);
    expect(result.failure?.reason).toBe("baseline BuildWorkflow failed: gcc exploded");
  }, 60_000);

  test("accepted and rejected runs carry no failure attribution", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* resume fixture */\n"),
    );
    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "attribution: accepted run",
      sessionRoot: fixture.sessionRoot,
      sessionId: "attr-accept",
      flow: presetFlow(patch),
    });
    expect(result.state).toBe("ACCEPTED");
    expect(result.failure).toBeNull();
    expect(existsSync(join(sessionDir(fixture, "attr-accept"), "artifacts", "failure-report.json"))).toBe(false);
  }, 180_000);
});

describe("checkpoint resume", () => {
  test("resumes an aborted run from checkpoints without re-running completed stages", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* resume fixture */\n"),
    );

    // Run 1: everything succeeds until the verify stage halts.
    const first = await runStageFlow({
      repoPath: fixture.repo,
      task: "resume: aborted at verification",
      sessionRoot: fixture.sessionRoot,
      sessionId: "resume-src",
      flow: {
        ...presetFlow(patch),
        verify: async () => halt("verification interrupted by the test harness", {
          category: "internal",
          component: "test-harness",
          retryable: true,
        }),
      },
    });
    expect(first.state).toBe("ABORTED");
    expect(first.failure?.stage).toBe("verify");
    expect(existsSync(join(sessionDir(fixture, "resume-src"), "stage-checkpoints.json"))).toBe(true);

    // The plan sees both expensive stages as reusable.
    const plan = planStageResume({
      repoPath: fixture.repo,
      task: "resume: aborted at verification",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "resume-src",
      sessionId: "resume-dst",
    });
    expect(plan.sourceState).toBe("ABORTED");
    expect(plan.failure?.stage).toBe("verify");
    expect(plan.reuseWorkflows).toBe(true);
    expect(plan.reuseRefactor).toBe(true);
    expect(plan.workflows?.testEntry.replace(/\\/g, "/")).toContain("workflows/test.ts");
    expect(plan.refactor?.branch).toBe("refactor/agent-resume-src");

    // Run 2: the real verification runs to a verdict; no model session anywhere.
    const second = await runStageFlowResume({
      repoPath: fixture.repo,
      task: "resume: aborted at verification",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "resume-src",
      sessionId: "resume-dst",
    });
    expect(second.state).toBe("ACCEPTED");
    expect(second.failure).toBeNull();
    expect(second.provenance.resume?.source_session).toBe("resume-src");
    expect(second.provenance.resume?.reused_stages).toEqual(["workflows", "refactor"]);
    expect(second.provenance.verification_authoritative).toBe(true);
    expect(second.verification?.expectationComparison?.overall).toBe("consistent");
    // The candidate commit is the one the first run measured, not a new one.
    expect(second.refactorSummary).toContain("resume: candidate branch refactor/agent-resume-src");
    const patchRecord = JSON.parse(
      readFileSync(join(second.logDir, "artifacts", "patch-candidate.json"), "utf8"),
    ) as { commit_sha: string };
    expect(patchRecord.commit_sha).toBe(plan.refactor!.commitSha);
    // Provenance is durable on the run dir too.
    const provenance = JSON.parse(
      readFileSync(join(second.logDir, "artifacts", "stage-provenance.json"), "utf8"),
    ) as { resume?: { source_session: string } };
    expect(provenance.resume?.source_session).toBe("resume-src");
  }, 240_000);

  test("refuses to resume a session that already has a verdict", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* resume fixture */\n"),
    );
    const accepted = await runStageFlow({
      repoPath: fixture.repo,
      task: "resume: accepted source",
      sessionRoot: fixture.sessionRoot,
      sessionId: "resume-accepted",
      flow: presetFlow(patch),
    });
    expect(accepted.state).toBe("ACCEPTED");

    expect(() =>
      planStageResume({
        repoPath: fixture.repo,
        task: "resume: accepted source",
        sessionRoot: fixture.sessionRoot,
        sourceSessionId: "resume-accepted",
        sessionId: "resume-accepted-2",
      }),
    ).toThrow(/only ABORTED sessions can be resumed/);
  }, 180_000);

  test("demotes stages whose checkpoint facts no longer verify", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* resume fixture */\n"),
    );
    const first = await runStageFlow({
      repoPath: fixture.repo,
      task: "resume: stale checkpoint",
      sessionRoot: fixture.sessionRoot,
      sessionId: "resume-stale",
      flow: {
        ...presetFlow(patch),
        verify: async () => halt("interrupted", { category: "internal", component: "test-harness" }),
      },
    });
    expect(first.state).toBe("ABORTED");

    // The repo moved on after the failed run: the candidate branch is stale.
    writeFileSync(join(fixture.repo, "NOTES.txt"), "moved on\n");
    gitIn(fixture.repo, ["add", "-A"]);
    gitIn(fixture.repo, ["commit", "-qm", "unrelated work after the failure"]);

    const plan = planStageResume({
      repoPath: fixture.repo,
      task: "resume: stale checkpoint",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "resume-stale",
      sessionId: "resume-stale-2",
    });
    expect(plan.reuseWorkflows).toBe(true); // workflow sources still exist
    expect(plan.reuseRefactor).toBe(false); // HEAD moved → branch is stale
    expect(plan.notes.join("\n")).toContain("repo HEAD moved");

    // A missing workflow source demotes the workflows stage too.
    const fixture2 = createRepo();
    const patch2 = writePatch(fixture2, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* resume fixture 2 */\n"),
    );
    const first2 = await runStageFlow({
      repoPath: fixture2.repo,
      task: "resume: deleted workflow source",
      sessionRoot: fixture2.sessionRoot,
      sessionId: "resume-del",
      flow: {
        ...presetFlow(patch2),
        verify: async () => halt("interrupted", { category: "internal", component: "test-harness" }),
      },
    });
    expect(first2.state).toBe("ABORTED");
    const { rmSync } = await import("node:fs");
    rmSync(join(fixture2.repo, "workflows", "test.ts"));
    const plan2 = planStageResume({
      repoPath: fixture2.repo,
      task: "resume: deleted workflow source",
      sessionRoot: fixture2.sessionRoot,
      sourceSessionId: "resume-del",
      sessionId: "resume-del-2",
    });
    expect(plan2.reuseWorkflows).toBe(false);
    expect(plan2.reuseRefactor).toBe(true);
    expect(plan2.notes.join("\n")).toContain("source missing on disk");
  }, 240_000);

  test("a malformed checkpoint file is treated as absent, never as reusable", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* resume fixture */\n"),
    );
    const first = await runStageFlow({
      repoPath: fixture.repo,
      task: "resume: malformed checkpoint",
      sessionRoot: fixture.sessionRoot,
      sessionId: "resume-bad",
      flow: {
        ...presetFlow(patch),
        verify: async () => halt("interrupted", { category: "internal", component: "test-harness" }),
      },
    });
    expect(first.state).toBe("ABORTED");
    writeFileSync(join(sessionDir(fixture, "resume-bad"), "stage-checkpoints.json"), "{not json");

    const plan = planStageResume({
      repoPath: fixture.repo,
      task: "resume: malformed checkpoint",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "resume-bad",
      sessionId: "resume-bad-2",
    });
    expect(plan.reuseWorkflows).toBe(false);
    expect(plan.reuseRefactor).toBe(false);
    expect(plan.notes.join("\n")).toContain("unreadable stage-checkpoints.json");
  }, 240_000);
});

// Type-level guard: FailureReport re-export used by the plan is the artifact schema.

describe("resume review fixes", () => {
  /** Run 1 helper: preset workflows + patch refactor, then the verify stage halts. */
  async function abortedAtVerify(
    fixture: Fixture,
    sessionId: string,
    extra: { worktreeRoot?: string } = {},
  ) {
    const patch = writePatch(fixture, `${sessionId}-patch`, (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* resume fixture */\n"),
    );
    const first = await runStageFlow({
      repoPath: fixture.repo,
      task: `resume-fix: aborted at verification (${sessionId})`,
      sessionRoot: fixture.sessionRoot,
      sessionId,
      ...(extra.worktreeRoot !== undefined ? { worktreeRoot: extra.worktreeRoot } : {}),
      flow: {
        ...presetFlow(patch),
        verify: async () => halt("interrupted", { category: "internal", component: "test-harness" }),
      },
    });
    expect(first.state).toBe("ABORTED");
    return patch;
  }

  test("#1 resume honors the caller's stage sources for stages without checkpoints", async () => {
    const fixture = createRepo();
    // Run 1 halts INSIDE the refactor stage → workflows checkpoint exists, no
    // refactor checkpoint. A resume must run the CALLER's refactor stage (the
    // patch preset), not the AI default.
    const first = await runStageFlow({
      repoPath: fixture.repo,
      task: "resume-fix: aborted inside refactor",
      sessionRoot: fixture.sessionRoot,
      sessionId: "rf-base",
      flow: {
        workflows: presetWorkflowsStage({
          builds: [{ id: "gcc-app", entry: "workflows/build.ts" }],
          testEntry: "workflows/test.ts",
        }),
        refactor: async () =>
          halt("refactor agent exploded", {
            category: "model-session",
            component: "refactor-session",
            retryable: true,
          }),
      },
    });
    expect(first.state).toBe("ABORTED");

    const patch = writePatch(fixture, "late-patch", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* applied on resume */\n"),
    );
    const second = await runStageFlowResume({
      repoPath: fixture.repo,
      task: "resume-fix: aborted inside refactor",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "rf-base",
      sessionId: "rf-base-dst",
      baseFlow: { refactor: patchRefactorStage(patch) },
    });
    expect(second.state).toBe("ACCEPTED");
    // Only workflows was reused; the caller's patch refactor actually ran.
    expect(second.provenance.resume?.reused_stages).toEqual(["workflows"]);
    expect(second.refactorSummary).toContain("preset patch");
  }, 240_000);

  test("#2 resume forwards --inject into the resumed run", async () => {
    const fixture = createRepo();
    await abortedAtVerify(fixture, "rf-inject-src");

    const sourceFile = join(fixture.sessionRoot, "judge-material.txt");
    writeFileSync(sourceFile, "oracle-v1\n");
    const second = await runStageFlowResume({
      repoPath: fixture.repo,
      task: "resume-fix: with injections",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "rf-inject-src",
      sessionId: "rf-inject-dst",
      injections: [{ source: sourceFile, dest: "materials/judge-material.txt" }],
    });
    expect(second.state).toBe("ACCEPTED");
    // The injection actually happened in the resumed run.
    const injected = join(second.logDir, "artifacts", "injections.json");
    expect(existsSync(injected)).toBe(true);
    const report = JSON.parse(readFileSync(injected, "utf8")) as {
      injections: readonly { files: readonly { path: string }[] }[];
    };
    expect(report.injections[0]?.files[0]?.path.replace(/\\/g, "/")).toContain("materials/judge-material.txt");
  }, 240_000);

  test("#3 resume with a caller-owned worktree root reuses that pair", async () => {
    const fixture = createRepo();
    const worktreeRoot = join(fixture.sessionRoot, "..", "wt-persistent");
    await abortedAtVerify(fixture, "rf-wt-src", { worktreeRoot });

    // The candidate branch is checked out under the old root; the resume must
    // reuse THAT pair instead of creating a second checkout elsewhere.
    const second = await runStageFlowResume({
      repoPath: fixture.repo,
      task: "resume-fix: persistent worktree root",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "rf-wt-src",
      sessionId: "rf-wt-dst",
      worktreeRoot,
    });
    expect(second.state).toBe("ACCEPTED");
    expect(second.provenance.resume?.reused_stages).toEqual(["workflows", "refactor"]);
  }, 240_000);

  test("#4 checkpoints record the entry root and resume re-resolves against it", async () => {
    const fixture = createRepo();
    const external = join(fixture.sessionRoot, "..", "external-workflows");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "build.ts"), BUILD_WORKFLOW);
    writeFileSync(join(external, "test.ts"), TEST_WORKFLOW);
    const patch = writePatch(fixture, "external-patch", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* resume fixture */\n"),
    );
    const first = await runStageFlow({
      repoPath: fixture.repo,
      task: "resume-fix: external workflow sources",
      sessionRoot: fixture.sessionRoot,
      sessionId: "rf-ext-src",
      flow: {
        workflows: presetWorkflowsStage({
          builds: [{ id: "gcc-app", entry: "build.ts" }],
          testEntry: "test.ts",
          entryRoot: external,
        }),
        refactor: patchRefactorStage(patch),
        verify: async () => halt("interrupted", { category: "internal", component: "test-harness" }),
      },
    });
    expect(first.state).toBe("ABORTED");

    const plan = planStageResume({
      repoPath: fixture.repo,
      task: "resume-fix: external workflow sources",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "rf-ext-src",
      sessionId: "rf-ext-dst",
    });
    expect(plan.reuseWorkflows).toBe(true);
    // The checkpoint recorded the original entry root, not the repository.
    expect(plan.workflows?.entryRoot?.replace(/\\/g, "/")).toContain("external-workflows");

    const second = await runStageFlowResume({
      repoPath: fixture.repo,
      task: "resume-fix: external workflow sources",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "rf-ext-src",
      sessionId: "rf-ext-dst",
    });
    // Without the entry-root restore this halted with "workflow entry escapes root".
    expect(second.state).toBe("ACCEPTED");
    expect(second.provenance.resume?.reused_stages).toContain("workflows");
  }, 240_000);

  test("#5 a candidate-side test workflow abort is attributed to candidate", async () => {
    const fixture = createRepo();
    // Custom test workflow that fails ONLY when the candidate's change is live.
    writeFileSync(
      join(fixture.repo, "workflows", "test.ts"),
      TEST_WORKFLOW.replace(
        'ctx.expect("stdout", run.stdout.trim());',
        'ctx.expect("stdout", run.stdout.trim());\n  if (run.stdout.includes("v2")) throw new Error("candidate-side boom");',
      ),
    );
    gitIn(fixture.repo, ["add", "-A"]);
    gitIn(fixture.repo, ["commit", "-qm", "candidate-only failing test"]);

    const patch = writePatch(fixture, "v2-patch", (source) =>
      source.replace("hello v1", "hello v2"),
    );
    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "resume-fix: candidate-side test abort",
      sessionRoot: fixture.sessionRoot,
      sessionId: "rf-attr",
      flow: presetFlow(patch),
    });
    expect(result.state).toBe("ABORTED");
    // The abort reason says candidate; the structured fields must say it too.
    expect(result.failure?.reason).toContain("candidate test workflow failed");
    expect(result.failure?.stage).toBe("verify");
    expect(result.failure?.category).toBe("test");
    expect(result.failure?.component).toBe("test-workflow:candidate");
    expect(result.failure?.retryable).toBe(true);
  }, 240_000);

  test("#6 a replaced candidate branch tip demotes the refactor checkpoint", async () => {
    const fixture = createRepo();
    await abortedAtVerify(fixture, "rf-tip-src");

    // The branch name the source run measured (recorded in its checkpoint).
    const branch = planStageResume({
      repoPath: fixture.repo,
      task: "resume-fix: replaced branch tip",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "rf-tip-src",
      sessionId: "rf-tip-plan",
    }).refactor!.branch;

    // Someone lands another commit on the candidate branch after the failure.
    const originalHead = gitIn(fixture.repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    gitIn(fixture.repo, ["checkout", "-q", branch]);
    writeFileSync(join(fixture.repo, "EXTRA.txt"), "sneaky follow-up\n");
    gitIn(fixture.repo, ["add", "-A"]);
    gitIn(fixture.repo, ["commit", "-qm", "post-failure commit on the candidate branch"]);
    gitIn(fixture.repo, ["checkout", "-q", originalHead]);

    const plan = planStageResume({
      repoPath: fixture.repo,
      task: "resume-fix: replaced branch tip",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "rf-tip-src",
      sessionId: "rf-tip-dst",
    });
    // Everything else still verifies; ONLY the replaced tip demotes reuse.
    expect(plan.reuseWorkflows).toBe(true);
    expect(plan.reuseRefactor).toBe(false);
    expect(plan.notes.join("\n")).toContain("tip no longer matches the measured commit");

    // The resume then runs the caller's refactor stage instead of verifying
    // an unmeasured candidate.
    const patch = writePatch(fixture, "tip-patch", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* fresh candidate */\n"),
    );
    const second = await runStageFlowResume({
      repoPath: fixture.repo,
      task: "resume-fix: replaced branch tip",
      sessionRoot: fixture.sessionRoot,
      sourceSessionId: "rf-tip-src",
      sessionId: "rf-tip-dst",
      baseFlow: { refactor: patchRefactorStage(patch) },
    });
    expect(second.state).toBe("ACCEPTED");
    expect(second.provenance.resume?.reused_stages).toEqual(["workflows"]);
    expect(second.refactorSummary).toContain("preset patch");
  }, 240_000);
});

// Type-level guard: FailureReport re-export used by the plan is the artifact schema.
type _FailureReportCheck = FailureReport["kind"];
