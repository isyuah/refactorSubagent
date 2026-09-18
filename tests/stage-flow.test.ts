import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStageFlow } from "../src/runtime/stage-flow.js";
import { patchRefactorStage, presetWorkflowsStage } from "../src/runtime/stage-presets.js";

/**
 * End-to-end through the real pipeline, with the two AI stages replaced by
 * presets: preflight → analysis → declared workflows → worktrees → patch →
 * differential build + test → verdict. No model call, real gcc, real git.
 */

/** Build workflow: compile the project's main.c into build/app.exe. */
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

/** Test workflow: run the built executable and declare cross-side expectations. */
const TEST_WORKFLOW = `
export const workflowKind = "test-workflow-driven";

export default async (ctx) => {
  await ctx.validator.assertFile("build/app.exe", "fixture executable");
  const run = await ctx.process.run({ program: "build/app.exe", args: [], cwd: ".", timeoutMs: 30000 });
  ctx.expect("exit-code", run.exitCode);
  ctx.expect("stdout", run.stdout.trim());
};
`;

/** Test workflow that requires judge material injected after the candidate commit. */
const INJECT_TEST_WORKFLOW = `
export const workflowKind = "test-workflow-driven";

export default async (ctx) => {
  await ctx.validator.assertFile("build/app.exe", "fixture executable");
  await ctx.validator.assertFile("judge/material.txt", "injected judge material");
  const run = await ctx.process.run({ program: "build/app.exe", args: [], cwd: ".", timeoutMs: 30000 });
  ctx.expect("exit-code", run.exitCode);
  ctx.expect("stdout", run.stdout.trim());
  const material = await ctx.fs.readFile("judge/material.txt", "utf8");
  ctx.expect("judge.material", material.trim());
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
  const root = mkdtempSync(join(tmpdir(), "rfr-stageflow-"));
  const repo = join(root, "repo");
  const sessionRoot = join(root, "session-root");
  mkdirSync(join(repo, "workflows"), { recursive: true });
  mkdirSync(sessionRoot, { recursive: true });
  // Pin the fixture to exact bytes: with core.autocrlf the worktree would hold
  // CRLF while the patch carries LF, and `git apply` would refuse it.
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
function writePatch(
  fixture: Fixture,
  name: string,
  edit: (source: string) => string,
): string {
  const target = join(fixture.repo, "main.c");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, edit(original));
  const diff = execFileSync("git", ["diff", "--", "main.c"], {
    cwd: fixture.repo,
    encoding: "utf8",
  });
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

describe("stage flow with preset stages", () => {
  test("accepts a behavior-preserving patch through the real differential pipeline", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* preset patch */\n"),
    );

    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "preset: behavior-preserving edit",
      sessionRoot: fixture.sessionRoot,
      sessionId: "preset-accept",
      flow: presetFlow(patch),
    });

    expect(result.state).toBe("ACCEPTED");
    expect(result.verification?.expectationComparison?.overall).toBe("consistent");
    expect(result.verification?.baselineBuild?.status).toBe("pass");
    expect(result.verification?.candidateBuild?.status).toBe("pass");
    expect(result.provenance.injected).toEqual(["workflows", "refactor"]);
    expect(result.provenance.verification_authoritative).toBe(true);
    expect(result.declared?.declaredSet.builds.map((build) => build.id)).toEqual(["gcc-app"]);
  }, 180_000);

  test("rejects a patch that changes observable behavior", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "behavior-change", (source) =>
      source.replace("hello v1", "hello v2"),
    );

    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "preset: behavior-changing edit",
      sessionRoot: fixture.sessionRoot,
      sessionId: "preset-reject",
      flow: presetFlow(patch),
    });

    expect(result.state).toBe("REJECTED");
    expect(result.verification?.expectationComparison?.overall).toBe("inconsistent");
    expect(result.verification?.baselineBuild?.status).toBe("pass");
    expect(result.verification?.candidateBuild?.status).toBe("pass");
  }, 180_000);

  test("a stage that halts aborts the run with its reason", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "unused", (source) => source);

    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "preset: missing workflow source",
      sessionRoot: fixture.sessionRoot,
      sessionId: "preset-halt",
      flow: {
        workflows: presetWorkflowsStage({
          builds: [{ id: "missing", entry: "workflows/absent.ts" }],
          testEntry: "workflows/test.ts",
        }),
        refactor: patchRefactorStage(patch),
      },
    });

    expect(result.state).toBe("ABORTED");
    const runLog = readFileSync(join(result.logDir, "run.jsonl"), "utf8");
    expect(runLog).toContain("preset workflow source missing");
    // The reason must also be readable from the run snapshot, not just the log
    // line: an aborted run whose cause is missing costs a reproduction.
    const events = runLog.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((event) => event.event === "abort")).toBe(true);
    const state = JSON.parse(readFileSync(join(result.logDir, "state.json"), "utf8")) as {
      abort_reason?: string;
    };
    expect(state.abort_reason).toContain("preset workflow source missing");
  }, 180_000);

  test("judge material is injected for verification only, outside the measured change set", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* preset patch */\n"),
    );
    // A worktree-relative path the candidate could not have written: it exists
    // only because the host injects it after the candidate commit.
    writeFileSync(join(fixture.repo, "workflows", "test-inject.ts"), INJECT_TEST_WORKFLOW);
    const judgeDir = join(fixture.sessionRoot, "judge-material");
    mkdirSync(judgeDir, { recursive: true });
    const material = "oracle: strtok empty-token semantics\n";
    writeFileSync(join(judgeDir, "material.txt"), material);
    const expectedSha = createHash("sha256").update(material).digest("hex");

    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "preset: injected judgement material",
      sessionRoot: fixture.sessionRoot,
      sessionId: "preset-inject",
      injections: [{ source: judgeDir, dest: "judge" }],
      flow: {
        workflows: presetWorkflowsStage({
          builds: [{ id: "gcc-app", entry: "workflows/build.ts" }],
          testEntry: "workflows/test-inject.ts",
        }),
        refactor: patchRefactorStage(patch),
      },
    });

    expect(result.state).toBe("ACCEPTED");
    expect(result.provenance.verification_authoritative).toBe(true);

    // The injection must not leak into the host-measured change set.
    const patchRecord = JSON.parse(
      readFileSync(join(result.logDir, "artifacts", "patch-candidate.json"), "utf8"),
    ) as { changed_files: string[] };
    expect(patchRecord.changed_files).toEqual(["main.c"]);

    const injected = JSON.parse(
      readFileSync(join(result.logDir, "artifacts", "injections.json"), "utf8"),
    ) as { injections: { dest: string; files: { path: string; sha256: string }[] }[] };
    expect(injected.injections).toHaveLength(2);
    for (const report of injected.injections) {
      expect(report.dest).toBe("judge");
      expect(report.files).toEqual([{ path: "judge/material.txt", sha256: expectedSha, replaced: false }]);
    }
  }, 180_000);

  test("a missing injection source aborts before any verdict", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* preset patch */\n"),
    );

    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "preset: missing judge material",
      sessionRoot: fixture.sessionRoot,
      sessionId: "preset-inject-missing",
      injections: [{ source: join(fixture.sessionRoot, "absent"), dest: "judge" }],
      flow: presetFlow(patch),
    });

    expect(result.state).toBe("ABORTED");
    expect(readFileSync(join(result.logDir, "run.jsonl"), "utf8")).toContain("injection source is missing");
  }, 180_000);

  test("an injected verification stage is recorded as non-authoritative", async () => {
    const fixture = createRepo();
    const patch = writePatch(fixture, "comment-only", (source) =>
      source.replace("int main(void) {\n", "int main(void) {\n  /* preset patch */\n"),
    );

    const result = await runStageFlow({
      repoPath: fixture.repo,
      task: "preset: staged verification",
      sessionRoot: fixture.sessionRoot,
      sessionId: "preset-verify-override",
      flow: {
        ...presetFlow(patch),
        verify: async (ctx) => ({
          state: ctx.store.state,
          results: [],
          baselineBuild: null,
          candidateBuild: null,
          baseline: null,
          candidate: null,
          comparison: null,
          expectationComparison: null,
        }),
      },
    });

    // Nothing submitted a verdict: no build ran, the session never advanced.
    expect(result.verification?.baselineBuild).toBeNull();
    expect(result.state).toBe("INIT");
    expect(result.provenance.injected).toEqual(["workflows", "refactor", "verify"]);
    expect(result.provenance.verification_authoritative).toBe(false);

    const recorded = JSON.parse(
      readFileSync(join(result.logDir, "artifacts", "stage-provenance.json"), "utf8"),
    ) as { injected: string[]; verification_authoritative: boolean };
    expect(recorded.injected).toEqual(["workflows", "refactor", "verify"]);
    expect(recorded.verification_authoritative).toBe(false);
    expect(existsSync(join(result.logDir, "run.jsonl"))).toBe(true);
  }, 180_000);
});
