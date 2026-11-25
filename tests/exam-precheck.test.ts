import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { halt, runStageFlow } from "../src/runtime/stage-flow.js";
import { presetWorkflowsStage } from "../src/runtime/stage-presets.js";

/**
 * 考卷预检：出卷后、重构前，先在未经改动的原版代码上完整彩排考卷。
 * 考卷缺陷（构建方案写歪 / 脚本报错 / both-matches 冻结值写错）在这里
 * 以结构化归因中止，由反馈路由决定修复通道——而不是让重构烧完时间才发现。
 */

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.email=t@local", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  }).trim();
}

function createRepo(testWorkflow: string): { repo: string; sessionRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "rfr-precheck-"));
  tempRoots.push(root);
  const repo = join(root, "repo");
  const sessionRoot = join(root, "session-root");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "workflows"), { recursive: true });
  writeFileSync(join(repo, "src", "main.c"), "#include <stdio.h>\nint main(void){puts(\"hello v1\");return 0;}\n");
  writeFileSync(join(repo, "workflows", "build.ts"), `
export const workflowKind = "workflow-driven";
export default async ({ fs, process, validator }) => {
  await fs.mkdir("build");
  await process.run({ program: "gcc", args: ["src/main.c", "-o", "build/app.exe"], cwd: ".", timeoutMs: 60000 });
  await validator.assertFile("build/app.exe", "fixture executable");
};
`);
  writeFileSync(join(repo, "workflows", "test.ts"), testWorkflow);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "fixture"]);
  return { repo, sessionRoot };
}

const presetFlow = () => presetWorkflowsStage({
  builds: [{ id: "gcc-app", entry: "workflows/build.ts" }],
  testEntry: "workflows/test.ts",
});

describe("exam precheck (pristine-tree dry run)", () => {
  test("a frozen both-matches value the baseline violates aborts BEFORE refactoring, with attribution", async () => {
    const { repo, sessionRoot } = createRepo(`
export const workflowKind = "test-workflow-driven";
export default async (ctx) => {
  await ctx.validator.assertFile("build/app.exe", "fixture executable");
  const run = await ctx.process.run({ program: "build/app.exe", args: [], cwd: ".", timeoutMs: 30000 });
  ctx.expect("exit", "both-matches", String(run.exitCode), "^0$");
  // 考卷把冻结值写死错了（1120-f 现场同款）：原版代码不可能匹配。
  ctx.expect("frozen", "both-matches", "actual-value", "^frozen-wrong$");
};
`);
    const result = await runStageFlow({
      repoPath: repo,
      task: "precheck self-violation",
      sessionRoot,
      sessionId: "precheck-self",
      examPrecheck: true,
      flow: {
        workflows: presetFlow(),
        refactor: async () => halt("must not reach refactoring", { category: "internal", component: "test-harness" }),
      },
    });
    expect(result.state).toBe("ABORTED");
    expect(result.failure?.stage).toBe("workflows");
    expect(result.failure?.category).toBe("test");
    expect(result.failure?.component).toBe("test-workflow:baseline");
    expect(result.failure?.detail).toMatchObject({ precheck: true });
    expect(result.failure?.detail["self_violations"]).toEqual(["frozen"]);
    expect(result.failure?.reason).toContain("exam precheck");
  }, 240_000);

  test("a clean exam passes the precheck and the run continues past it", async () => {
    const { repo, sessionRoot } = createRepo(`
export const workflowKind = "test-workflow-driven";
export default async (ctx) => {
  await ctx.validator.assertFile("build/app.exe", "fixture executable");
  const run = await ctx.process.run({ program: "build/app.exe", args: [], cwd: ".", timeoutMs: 30000 });
  ctx.expect("exit", "both-matches", String(run.exitCode), "^0$");
  ctx.expect("stdout", "both-matches", run.stdout.trim(), "^hello v1$");
};
`);
    const result = await runStageFlow({
      repoPath: repo,
      task: "precheck clean",
      sessionRoot,
      sessionId: "precheck-clean",
      examPrecheck: true,
      flow: {
        workflows: presetFlow(),
        // 预检通过后才走到这里；用一个显式中止证明流程越过了预检。
        refactor: async () => halt("reached refactoring after a clean precheck", { category: "internal", component: "test-harness" }),
      },
    });
    expect(result.state).toBe("ABORTED");
    expect(result.failure?.component).toBe("test-harness");
    expect(result.failure?.detail["precheck"]).toBeUndefined();
  }, 240_000);

  test("a build workflow that fails on the pristine tree is attributed as a baseline build failure", async () => {
    const { repo, sessionRoot } = createRepo(`
export const workflowKind = "test-workflow-driven";
export default async (ctx) => {
  await ctx.validator.assertFile("build/app.exe", "fixture executable");
};
`);
    writeFileSync(join(repo, "workflows", "build.ts"), `
export const workflowKind = "workflow-driven";
export default async () => {
  throw new Error("broken build recipe");
};
`);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "broken build"]);
    const result = await runStageFlow({
      repoPath: repo,
      task: "precheck build failure",
      sessionRoot,
      sessionId: "precheck-build",
      examPrecheck: true,
      flow: {
        workflows: presetFlow(),
        refactor: async () => halt("must not reach refactoring", { category: "internal", component: "test-harness" }),
      },
    });
    expect(result.state).toBe("ABORTED");
    expect(result.failure?.stage).toBe("workflows");
    expect(result.failure?.category).toBe("build");
    expect(result.failure?.component).toBe("build-workflow:baseline");
    expect(result.failure?.detail).toMatchObject({ precheck: true, build_id: "gcc-app" });
  }, 240_000);
});
