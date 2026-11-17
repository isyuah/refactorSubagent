import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestPreparation } from "../src/testing/preparation.js";
import { loadLocalDialogue, loadTestPlan } from "../src/testing/bundle.js";
import { runStageFlow } from "../src/runtime/stage-flow.js";
import { testPlanWorkflowsStage } from "../src/testing/stage.js";
import { patchRefactorStage } from "../src/runtime/stage-presets.js";
import { parseCliArgs } from "../src/cli/args.js";
import { spawnOwnedProcess } from "../shared/owned-process.js";
import { cliFixture } from "./helpers/cli-fixture.js";
import { preparationReplay } from "./helpers/test-preparation.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(scenario: "accept" | "mismatch" = "accept") {
  const fixture = cliFixture(scenario); roots.push(fixture.root); return fixture;
}
function prepare(f: ReturnType<typeof fixture>, replay = preparationReplay(), extra: Partial<ConstructorParameters<typeof TestPreparation>[0]> = {}) {
  return new TestPreparation({ repo: f.repo, sessionRoot: f.sessionRoot, session: "prepare", scope: "函数返回值和时钟依赖",
    runAgentFn: replay.author, runBuildAgentFn: replay.build, ...extra });
}
const git = (repo: string, args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8" }).trim();

describe("independent test preparation (offline SDK replay)", () => {
  test("authors, executes every build on the original, resumes the same dialogue and saves portable revisions", async () => {
    const f = fixture(); const replay = preparationReplay(); const prep = prepare(f, replay);
    try {
      const original = f.original(); const branches = git(f.repo, ["branch", "--format=%(refname)"]);
      await prep.author();
      const first = prep.view();
      expect(first.content.metadata.delivery).toBe("complete");
      expect(first.content.metadata.trial.status).toBe("pass");
      expect(first.content.metadata.trial.builds.map(b => b.status)).toEqual(["pass", "pass"]);
      expect(first.content.metadata.trial.observations.map(o => o.name)).toEqual(["函数返回值", "模拟时钟"]);
      expect(first.content.metadata.trial.ctest).toBeNull();
      expect(first.content.builds[0]!.description).toContain("build/source.txt");
      expect(git(f.repo, ["branch", "--format=%(refname)"])).toBe(branches);
      expect(f.original()).toBe(original);
      const firstSaved = prep.save();
      await prep.author("补充与当前函数相关的边界条件，允许调整场景。");
      expect(replay.calls[1]!.resumeSessionId).toBe("preparation-dialogue");
      expect(replay.calls[1]!.prompt).toContain("边界条件");
      expect(replay.calls.every(call => !call.allowedTools.includes("Bash"))).toBe(true);
      const secondSaved = prep.save();
      expect(firstSaved.manifest.revision).toBe(1); expect(secondSaved.manifest.revision).toBe(2);
      expect(firstSaved.content.test?.source).toBe(secondSaved.content.test?.source);
      expect(secondSaved.history.filter(t => t.status === "pass")).toHaveLength(1);
      expect(secondSaved.manifest.metadata.trial.evidence_dir?.startsWith("evidence/")).toBe(true);
      expect(existsSync(join(secondSaved.content.metadata.trial.evidence_dir!, "artifacts", "baseline-test-workflow-run.json"))).toBe(true);
      expect(Object.keys(secondSaved.manifest.files).some(path => path.includes("/sessions/"))).toBe(false);
      const copied = join(f.root, "portable"); cpSync(secondSaved.directory, copied, { recursive: true });
      prep.close();
      const imported = loadTestPlan(copied);
      expect(imported.content.builds[1]!.materials).toContain("fake-clock.c");
      expect(imported.content.metadata.trial.evidence_dir?.startsWith(copied)).toBe(true);
      const reopened = prepare(f, replay, { session: "reopened", from: copied });
      try {
        expect(reopened.view().trialOrigin).toBe("saved");
        const saved = reopened.save(join(f.root, "resaved"));
        expect(saved.history.filter(t => t.status === "pass")).toHaveLength(1);
        expect(existsSync(join(saved.content.metadata.trial.evidence_dir!, "artifacts", "trial-result.json"))).toBe(true);
        await reopened.author("继续使用保存的测试，补充说明。");
        expect(replay.calls.at(-1)!.resumeSessionId).toBe("preparation-dialogue");
        expect(reopened.view().content.metadata.trial.status).toBe("pass");
        expect(reopened.view().trialOrigin).toBe("current");
      } finally { reopened.close(); }
    } finally { prep.close(); }
  }, 60_000);

  test("a failed build records later builds as unexecuted and repairs through a dedicated build role", async () => {
    const f = fixture(); const replay = preparationReplay({ brokenBuild: 0 }); const prep = prepare(f, replay);
    try {
      await prep.author();
      const failed = prep.view().content.metadata.trial;
      expect(failed.status).toBe("failed"); expect(failed.failure?.category).toBe("build");
      expect(failed.builds.map(b => b.status)).toEqual(["failed", "not-run"]);
      const draft = prep.save(); expect(draft.content.metadata.trial.failure?.reason).toContain("broken build 0");
      await prep.repair();
      expect(prep.view().content.metadata.trial.failure).toBeNull();
      expect(prep.view().content.metadata.trial.status).toBe("pass");
      expect(prep.view().content.metadata.trial.builds.map(b => b.status)).toEqual(["pass", "pass"]);
      expect(replay.calls).toHaveLength(1);
    } finally { prep.close(); }
  }, 60_000);

  test("a revised build cannot accidentally reuse a helper removed from its registered materials", async () => {
    const f = fixture(); const prep = prepare(f, preparationReplay({ omitMaterialAfterFirst: true }));
    try {
      await prep.author(); expect(prep.view().content.metadata.trial.status).toBe("pass");
      await prep.author("更新辅助代码交付");
      expect(prep.view().content.metadata.trial.status).toBe("failed");
      expect(prep.view().content.metadata.trial.failure?.category).toBe("build");
      expect(prep.view().content.metadata.trial.builds.map(b => b.status)).toEqual(["pass", "failed"]);
      expect(prep.view().content.metadata.trial.failure?.reason).toContain("fake-clock.c");
    } finally { prep.close(); }
  }, 60_000);

  test("keeps all delivered sources as a draft when scenario documentation is missing", async () => {
    const f = fixture(); const prep = prepare(f, preparationReplay({ missingDocument: true }));
    try {
      await prep.author(); const view = prep.view();
      expect(view.content.metadata.delivery).toBe("draft");
      expect(view.content.metadata.trial.status).toBe("failed");
      expect(view.content.test?.source).toContain("ctx.expect"); expect(view.content.builds).toHaveLength(2);
      const saved = prep.save(); expect(loadTestPlan(saved.directory).content.builds).toHaveLength(2);
      await prep.trial(); expect(prep.view().content.metadata.trial.status).toBe("failed");
      expect(prep.view().content.metadata.trial.builds).toHaveLength(0);
    } finally { prep.close(); }
  }, 60_000);

  test("a script containing only constant observations fails the existing real-artifact gate", async () => {
    const f = fixture(); const prep = prepare(f, preparationReplay({ constantTest: true }));
    try {
      await prep.author();
      expect(prep.view().content.metadata.trial.failure?.category).toBe("test");
      expect(prep.view().content.metadata.trial.failure?.reason).toContain("did not run or read any implementation artifact");
    } finally { prep.close(); }
  }, 60_000);

  test("cancelling authoring reaches its session signal without starting a trial", async () => {
    const f = fixture(); const started = Promise.withResolvers<void>();
    const prep = prepare(f, preparationReplay(), { runAgentFn: async options => {
      const signal = options.signal!;
      started.resolve();
      await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true }));
      return { result: "cancelled", isError: true, timedOut: false };
    } });
    try {
      const running = prep.author(); await started.promise; prep.cancel(); await running;
      expect(prep.cancelled).toBe(true); expect(prep.view().content.metadata.delivery).toBe("draft");
      expect(prep.view().content.metadata.trial.builds).toHaveLength(0);
      expect(prep.view().content.metadata.trial.status).toBe("failed");
      await expect(prep.author()).rejects.toThrow();
    } finally { prep.close(); }
  }, 60_000);

  test("a test with no observations fails instead of claiming an original-only comparison", async () => {
    const f = fixture(); const prep = prepare(f, preparationReplay({ emptyTest: true }));
    try {
      await prep.author();
      expect(prep.view().content.metadata.trial.status).toBe("failed");
      expect(prep.view().content.metadata.trial.failure?.category).toBe("test");
      expect(prep.view().content.metadata.trial.observations).toHaveLength(0);
    } finally { prep.close(); }
  }, 60_000);

  test("cancelling the active original build preserves evidence and releases the owned worktree", async () => {
    const f = fixture(); let prep: TestPreparation;
    prep = prepare(f, preparationReplay({ hangingBuild: true }), { onProgress: event => {
      if (event.type === "step" && event.id === "hold" && event.status === "begin") prep.cancel();
    } });
    try {
      await prep.author();
      expect(prep.cancelled).toBe(true);
      expect(prep.view().content.metadata.trial.status).toBe("failed");
      expect(prep.view().content.metadata.trial.builds.map(b => b.status)).toEqual(["failed", "not-run"]);
      const saved = prep.save(); expect(existsSync(join(saved.content.metadata.trial.evidence_dir!, "artifacts", "trial-result.json"))).toBe(true);
      prep.close();
      expect(git(f.repo, ["worktree", "list", "--porcelain"])).not.toContain("test-preparations");
    } finally { prep.close(); }
  }, 60_000);

  test.each(["accept", "mismatch"] as const)("saved tests use the normal two-sided pipeline: %s", async scenario => {
    const f = fixture(scenario); const prep = prepare(f);
    let directory: string;
    try { await prep.author(); directory = prep.save().directory; } finally { prep.close(); }
    const result = await runStageFlow({ repoPath: f.repo, task: "重构函数，保持返回值", sessionRoot: f.sessionRoot, sessionId: "formal",
      flow: { workflows: testPlanWorkflowsStage(directory!), refactor: patchRefactorStage(join(f.root, "change.patch")) } });
    expect(result.state).toBe(scenario === "accept" ? "ACCEPTED" : "REJECTED");
    expect(result.report.comparison?.total).toBe(2);
    expect(result.report.builds).toHaveLength(4);
    expect(result.report.builds.every(b => b.status === "pass")).toBe(true);
    expect(loadTestPlan(directory!).content.test?.source).toBe(prep.view().content.test?.source);
  }, 120_000);

  test("import verifies file hashes and CLI review emits one JSON document without ANSI", async () => {
    const f = fixture(); const prep = prepare(f);
    let directory: string;
    try { await prep.author(); directory = prep.save().directory; } finally { prep.close(); }
    const cli = fileURLToPath(new URL("../scripts/cli.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, cli, "tests", "review", f.repo, "--from", directory!, "--session", "plain-review", "--ui", "plain", "--format", "json"], { env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(stderr).toBe("");
    expect(JSON.parse(stdout).status).toBe("pass"); expect(stdout).not.toContain("\x1b");
    writeFileSync(join(directory!, "workflows", "test.ts"), "modified after save");
    expect(() => loadTestPlan(directory!)).toThrow("test plan file changed");
  }, 60_000);

  test("noninteractive CLI preparation saves a reusable plan with one JSON stdout and separate progress", async () => {
    const f = fixture(); const helper = fileURLToPath(new URL("./helpers/test-preparation-cli-replay.ts", import.meta.url));
    const child = spawnOwnedProcess({ program: process.execPath, args: [helper, join(f.root, "cli-preparation")], cwd: process.cwd(),
      env: { ...process.env, RFR_LOG_LEVEL: "error" }, cooperativeShutdown: true });
    let stdout = ""; let stderr = "";
    child.child.stdout?.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.child.stderr?.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { void child.stop(); }, 55_000);
    try {
      const exit = await child.exited;
      if (exit.error !== null || exit.code !== 0) throw new Error(`CLI exited ${exit.code}: ${exit.error}\n${stdout}\n${stderr}`);
      const result = JSON.parse(stdout);
      expect(result.status).toBe("pass"); expect(result.report.status).toBe("closed");
      expect(result.report.content.metadata.scope).toBe("Protect function results");
      expect(loadTestPlan(result.saved).content.builds).toHaveLength(2);
      expect(stdout).not.toContain("\x1b"); expect(stderr).not.toContain("\x1b");
      expect(stderr).toContain("已交付两个构建");
    } finally { clearTimeout(timer); await child.stop(); }
  }, 60_000);

  test("a local dialogue is reusable only while its actual transcript exists", async () => {
    const f = fixture(); const prep = prepare(f);
    let directory: string;
    try { await prep.author(); directory = prep.save().directory; } finally { prep.close(); }
    const local = join(f.repo, ".refactor", "test-plan-dialogues");
    const dialogue = loadLocalDialogue(local, "prepare")!; expect(dialogue.id).toBe("preparation-dialogue");
    rmSync(join(dialogue.root, "sessions"), { recursive: true });
    expect(loadLocalDialogue(local, "prepare")).toBeNull();
    const replay = preparationReplay(); const reopened = prepare(f, replay, { session: "portable-edit", from: directory! });
    try { await reopened.author("重新打开修改"); expect(replay.calls[0]!.resumeSessionId).toBeUndefined(); expect(reopened.view().content.metadata.trial.status).toBe("pass"); }
    finally { reopened.close(); }
  }, 60_000);

  test.each(["portable", "local"] as const)("formal feedback repairs an imported plan with %s dialogue context", async mode => {
    const f = fixture(); const output = join(f.root, "feedback-replay");
    const helper = fileURLToPath(new URL("./helpers/test-plan-feedback-replay.ts", import.meta.url));
    const child = spawnOwnedProcess({ program: process.execPath, args: [helper, output, mode], cwd: process.cwd(),
      env: { ...process.env, RFR_LOG_LEVEL: "error" }, cooperativeShutdown: true });
    let stdout = ""; let stderr = "";
    child.child.stdout?.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.child.stderr?.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { void child.stop(); }, 110_000);
    try {
      const exit = await child.exited;
      if (exit.error !== null || exit.code !== 0) throw new Error(`replay exited ${exit.code}: ${exit.error}\n${stdout}\n${stderr}`);
    } finally { clearTimeout(timer); await child.stop(); }
    const result = await Bun.file(join(output, "outcome.json")).json();
    expect(result.state).toBe("ACCEPTED"); expect(result.rounds).toBe(2);
    expect(result.calls[0].resume).toBe(mode === "local" ? "preparation-dialogue" : null);
    if (mode === "portable") expect(result.calls[0].prompt).toContain("Protect the real function result");
    else expect(result.calls[0].prompt).toContain("脚本错误");
  }, 120_000);

  test("parses preparation and reuse options and rejects contradictory inputs", () => {
    expect(parseCliArgs(["tests", "prepare", "repo", "--scope", "function boundaries", "--ui", "plain"])).toMatchObject({ kind: "tests", action: "prepare", scope: "function boundaries", session: null });
    expect(parseCliArgs(["tests", "review", "repo", "--from", "saved/r1"])).toMatchObject({ action: "review", from: "saved/r1" });
    expect(parseCliArgs(["run", "repo", "--task", "refactor", "--tests", "saved/r1"])).toMatchObject({ tests: "saved/r1" });
    expect(() => parseCliArgs(["tests", "review", "repo"])).toThrow("--from");
    expect(() => parseCliArgs(["tests", "prepare", "--from", "r1"])).toThrow("tests review");
  });
});
