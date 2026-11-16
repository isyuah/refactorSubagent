import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CliScenario = "accept" | "mismatch" | "build-failure" | "missing-artifact" | "abort";

/** Tiny file-artifact pipeline: exercises the real host gates, without a compiler or AI. */
export function cliFixture(scenario: CliScenario, parent = tmpdir()) {
  const root = mkdtempSync(join(parent, "cli-"));
  const repo = join(root, "repo");
  const sessionRoot = join(root, "results");
  mkdirSync(join(repo, "workflows"), { recursive: true });
  mkdirSync(sessionRoot);
  const main = "int value(void) { return 1; }\n";
  writeFileSync(join(repo, ".gitattributes"), "* -text\n");
  writeFileSync(join(repo, "main.c"), main);
  writeFileSync(join(repo, "workflows", "build.ts"), `
    export const workflowKind = "workflow-driven";
    export default async (ctx) => {
      await ctx.plan.declare([{ id: "snapshot", title: "生成源码观测材料" }]);
      await ctx.plan.begin("snapshot");
      const source = await ctx.fs.readFile("main.c", "utf8");
      if (source.includes("BUILD_FAIL")) throw new Error("fixture build refused BUILD_FAIL marker");
      await ctx.fs.mkdir("build");
      await ctx.fs.writeFile("build/source.txt", source);
      await ctx.validator.assertFile("build/source.txt", "source snapshot");
      await ctx.plan.complete("snapshot");
    };
  `);
  writeFileSync(join(repo, "workflows", "secondary.ts"), `
    export const workflowKind = "workflow-driven";
    export default async (ctx) => {
      await ctx.fs.mkdir("build");
      ${scenario === "missing-artifact" ? "" : 'await ctx.fs.writeFile("build/secondary.txt", "auxiliary material");'}
      await ctx.validator.assertFile("build/secondary.txt", "required auxiliary artifact");
    };
  `);
  writeFileSync(join(repo, "workflows", "test.ts"), `
    export const workflowKind = "test-workflow-driven";
    export default async (ctx) => {
      const source = await ctx.fs.readFile("build/source.txt", "utf8");
      const auxiliary = await ctx.fs.readFile("build/secondary.txt", "utf8");
      ctx.expect("函数返回值", source.match(/return (\\d+)/)[1]);
      ctx.expect("辅助材料", auxiliary);
    };
  `);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  git(["init", "-q"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "user.email", "cli-fixture@example.com"]);
  git(["config", "user.name", "CLI fixture"]);
  git(["add", "."]); git(["commit", "-qm", "fixture base"]);
  const changed = scenario === "mismatch" ? main.replace("return 1", "return 2")
    : main + (scenario === "build-failure" ? "/* BUILD_FAIL */\n" : "/* 行为不变的注释 */\n");
  writeFileSync(join(repo, "main.c"), changed);
  const patch = join(root, "change.patch");
  writeFileSync(patch, git(["diff", "--", "main.c"]));
  writeFileSync(join(repo, "main.c"), main);
  const pipeline = join(root, "pipeline.json");
  writeFileSync(pipeline, JSON.stringify({ version: 1, stages: {
    workflows: { mode: "preset", builds: [
      { id: "snapshot", entry: scenario === "abort" ? "workflows/absent.ts" : "workflows/build.ts" },
      { id: "secondary", entry: "workflows/secondary.ts" },
    ], testEntry: "workflows/test.ts" },
    refactor: { mode: "patch", patchFile: patch },
  } }));
  return { root, repo, sessionRoot, pipeline,
    args: ["run", repo, "--task", "离线验证 CLI 信息展示", "--session", `fixture-${scenario}`, "--session-root", sessionRoot, "--pipeline-file", pipeline, "--auto-retry", "0"],
    original: () => readFileSync(join(repo, "main.c"), "utf8"),
  };
}
