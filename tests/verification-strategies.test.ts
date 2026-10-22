import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostPreflight } from "../src/artifacts/index.js";
import { LocalDependencyRegistry } from "../src/agents/dep-registry.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { runStageFlow, type RefactorStage } from "../src/runtime/stage-flow.js";
import { patchRefactorStage, presetWorkflowsStage } from "../src/runtime/stage-presets.js";
import type { VerificationMaterialInput } from "../src/workflow/verification-materials.js";

const IMPLEMENTATION = '#include "subject.h"\nint transform(int value) { return value * 2 + 1; }\n';
const PROBE = '#include <stdio.h>\n#include "subject.h"\nint main(void) { printf("%d,%d\\n", transform(0), transform(-4)); return 0; }\n';
const MATERIAL = { path: "build/verification/probe.c", content: PROBE };

const DIRECT_BUILD = `
export const workflowKind = "workflow-driven";
export default async (ctx) => {
  const app = "build/verification/probe" + ctx.facts.host.executable_suffix;
  await ctx.validator.assertFile("build/verification/probe.c", "fixed helper input");
  const compiled = await ctx.process.run({
    program: "gcc", args: ["-I", "include", "src/subject.c", "build/verification/probe.c", "-o", app],
  });
  if (compiled.status !== "exited" || compiled.exitCode !== 0) throw new Error("harness compilation failed");
  await ctx.validator.assertFile(app, "probe");
};
`;

const LIBRARY_BUILD = `
export const workflowKind = "workflow-driven";
export default async (ctx) => {
  const platform = ctx.facts.host.platform;
  const ext = platform === "win32" ? ".dll" : platform === "darwin" ? ".dylib" : ".so";
  const library = "build/verification/libsubject" + ext;
  const flags = platform === "win32"
    ? ["-shared", "-Wl,--out-implib,build/verification/libsubject.dll.a"]
    : platform === "darwin"
      ? ["-dynamiclib", "-Wl,-install_name,@rpath/libsubject.dylib"]
      : ["-shared", "-fPIC"];
  const built = await ctx.process.run({ program: "gcc", args: [...flags, "-I", "include", "src/subject.c", "-o", library] });
  if (built.status !== "exited" || built.exitCode !== 0) throw new Error("library compilation failed");
  await ctx.validator.assertFile(library, "this worktree's shared library");
  const app = "build/verification/probe" + ctx.facts.host.executable_suffix;
  const rpath = platform === "win32" ? [] : platform === "darwin" ? ["-Wl,-rpath,@loader_path"] : ["-Wl,-rpath,$ORIGIN"];
  const linked = await ctx.process.run({ program: "gcc", args: ["-I", "include", "build/verification/probe.c", "-L", "build/verification", "-lsubject", ...rpath, "-o", app] });
  if (linked.status !== "exited" || linked.exitCode !== 0) throw new Error("consumer link failed");
  await ctx.validator.assertFile(app, "probe");
};
`;

const TEST_WORKFLOW = `
export const workflowKind = "test-workflow-driven";
export default async (ctx) => {
  const app = "build/verification/probe" + ctx.facts.host.executable_suffix;
  await ctx.validator.assertFile(app, "probe");
  const run = await ctx.process.run({ program: app, args: [] });
  if (run.status !== "exited" || run.exitCode !== 0) throw new Error("probe execution failed");
  ctx.expect("transform-results", run.stdout.trim());
};
`;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

let measuredHost: HostPreflight | undefined;
function host(root: string): HostPreflight {
  measuredHost ??= probeHost(root);
  return { ...measuredHost, working_directory: root };
}

async function fixture(options: {
  build?: string;
  test?: string;
  materials?: readonly VerificationMaterialInput[];
  additionalBuilds?: readonly { name: string; content: string; materials: readonly VerificationMaterialInput[] }[];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "rfr-verification-"));
  const repo = join(root, "repo");
  const sessions = join(root, "sessions");
  const worktreeRoot = join(root, "persistent");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "include"), { recursive: true });
  writeFileSync(join(repo, ".gitattributes"), "* -text\n");
  writeFileSync(join(repo, ".gitignore"), "build/\n.refactor/\n.refactorsa/\n");
  writeFileSync(join(repo, "src", "subject.c"), IMPLEMENTATION);
  writeFileSync(join(repo, "include", "subject.h"), "int transform(int value);\n");
  writeFileSync(join(repo, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.16)\nproject(subject C)\nadd_library(subject src/subject.c)\ntarget_include_directories(subject PUBLIC include)\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  const registry = new LocalDependencyRegistry({ workspaceRoot: repo, sessionRoot: sessions, sessionId: "verification" });
  const generated = await registry.generate({ name: "probe", description: "task-specific behavior probe", content: options.build ?? DIRECT_BUILD, materials: options.materials ?? [MATERIAL] });
  const build = (await registry.resolveBuildEntry(generated.workflowId))!.entry;
  const builds = [{ id: generated.workflowId, entry: build, runLocal: true }];
  for (const additional of options.additionalBuilds ?? []) {
    const extra = await registry.generate({ ...additional, description: "additional task-specific probe" });
    const entry = (await registry.resolveBuildEntry(extra.workflowId))!.entry;
    builds.push({ id: extra.workflowId, entry, runLocal: true });
  }
  const testEntry = join(registry.runLocalBuildDir(), "test-workflow.ts");
  writeFileSync(testEntry, options.test ?? TEST_WORKFLOW);
  const facts = host(repo);
  const project = detectCProject(repo);
  // Discovery does not build the project; these workflows exercise both
  // alternative strategies against each side's real implementation.
  expect(project.status).toBe("detected");

  const patch = (changedBehavior: boolean) => {
    const file = join(repo, "src", "subject.c");
    writeFileSync(file, IMPLEMENTATION.replace("return value * 2 + 1;", changedBehavior
      ? "return value * 2 + 2;" : "int doubled = value * 2; return doubled + 1;"));
    const diff = execFileSync("git", ["diff", "--", "src/subject.c"], { cwd: repo, encoding: "utf8" });
    writeFileSync(file, IMPLEMENTATION);
    const path = join(root, "candidate.patch");
    writeFileSync(path, diff);
    return patchRefactorStage(path);
  };

  const run = (refactor: RefactorStage, injections?: { source: string; dest: string }[]) => runStageFlow({
    repoPath: repo, task: "verify transform behavior", sessionRoot: sessions, sessionId: "verification", worktreeRoot,
    injections,
    flow: {
      preflight: async () => ({ host: facts, project }),
      workflows: presetWorkflowsStage({ builds, testEntry }),
      refactor,
    },
  });
  return { root, repo, baseSha, worktreeRoot, build, builds, run, patch };
}

function abortReason(result: Awaited<ReturnType<typeof runStageFlow>>): string {
  return result.store.history.filter((entry) => entry.to === "ABORTED").at(-1)?.note ?? "";
}

describe("fixed auxiliary verification through the real pipeline", () => {
  test("multiple declared builds retain separate execution evidence on both sides", async () => {
    const f = await fixture({ additionalBuilds: [{
      name: "secondary",
      content: DIRECT_BUILD.replaceAll("build/verification/probe", "build/verification/secondary"),
      materials: [{ path: "build/verification/secondary.c", content: PROBE }],
    }] });
    const result = await f.run(f.patch(false));
    expect(result.state).toBe("ACCEPTED");
    expect(result.declared?.declaredSet.builds).toHaveLength(2);
    for (const side of ["baseline", "candidate"]) {
      const artifacts = readdirSync(join(result.logDir, "artifacts"));
      expect(artifacts.filter((name) => name.startsWith(`${side}-build-`) && name.endsWith(".json"))).toHaveLength(f.builds.length);
      for (const [index, build] of f.builds.entries()) {
        const evidence = JSON.parse(readFileSync(join(result.logDir, "artifacts", `${side}-build-${index + 1}-${build.id}.json`), "utf8"));
        expect(evidence.status).toBe("pass");
        expect(evidence.events.some((event: { execution?: { status: string; exitCode: number } }) => event.execution?.status === "exited" && event.execution.exitCode === 0)).toBe(true);
      }
      expect(existsSync(join(f.worktreeRoot, "worktrees", side, "build/verification/secondary" + host(f.repo).executable_suffix))).toBe(true);
    }
  }, 120_000);

  for (const [strategy, build] of [["local source harness", DIRECT_BUILD], ["shared-library consumer", LIBRARY_BUILD]] as const) {
    test(`${strategy}: both sides run, inputs stay outside the patch, tracked sources stay intact`, async () => {
      const f = await fixture({ build });
      const result = await f.run(f.patch(false));
      expect(result.state).toBe("ACCEPTED");
      expect(result.verification?.baselineBuild?.status).toBe("pass");
      expect(result.verification?.candidateBuild?.status).toBe("pass");
      expect(result.declared?.materials).toHaveLength(1);
      for (const side of ["baseline", "candidate"]) {
        const tree = join(f.worktreeRoot, "worktrees", side);
        expect(readFileSync(join(tree, MATERIAL.path), "utf8")).toBe(PROBE);
        const evidence = JSON.parse(readFileSync(join(result.logDir, "artifacts", `${side}-test-workflow-run.json`), "utf8"));
        expect(evidence.status).toBe("pass");
        expect(evidence.expectations[0].value).toBe("1,-7");
        expect(evidence.events.some((event: { capability: string; method: string }) => event.capability === "process" && event.method === "run")).toBe(true);
        expect(git(tree, ["diff", "--name-only", "HEAD"])).toBe("");
      }
      expect(git(join(f.worktreeRoot, "worktrees", "baseline"), ["rev-parse", "HEAD"])).toBe(f.baseSha);
      expect(git(join(f.worktreeRoot, "worktrees", "candidate"), ["diff", "--name-only", f.baseSha, "HEAD"])).toBe("src/subject.c");
      expect(git(f.repo, ["status", "--porcelain"])).toBe("");
      expect(readFileSync(join(f.repo, "src", "subject.c"), "utf8")).toBe(IMPLEMENTATION);
      expect(existsSync(join(f.repo, ".refactorsa", "build-workflows"))).toBe(false);
    }, 120_000);

    test(`${strategy}: a real implementation change is rejected`, async () => {
      const f = await fixture({ build });
      const result = await f.run(f.patch(true));
      expect(result.state).toBe("REJECTED");
      expect(result.verification?.baselineBuild?.status).toBe("pass");
      expect(result.verification?.candidateBuild?.status).toBe("pass");
      expect(result.verification?.expectationComparison?.declarations.some((declaration) => !declaration.matched)).toBe(true);
    }, 120_000);
  }

  test("a build that changes tracked source aborts before behavior comparison", async () => {
    const build = DIRECT_BUILD.replace('  await ctx.validator.assertFile(app, "probe");', '  await ctx.fs.writeFile("src/subject.c", "/* altered by build */\\n");');
    const f = await fixture({ build });
    const result = await f.run(f.patch(false));
    expect(result.state).toBe("ABORTED");
    expect(abortReason(result)).toContain("tracked source changed");
    expect(result.verification?.expectationComparison).toBeNull();
  }, 120_000);

  test("a test that changes fixed helper input aborts even when the old executable still passes", async () => {
    const test = TEST_WORKFLOW.replace('  ctx.expect("transform-results", run.stdout.trim());', '  await ctx.fs.writeFile("build/verification/probe.c", "int main(void) { return 0; }\\n");\n  ctx.expect("transform-results", run.stdout.trim());');
    const f = await fixture({ test });
    const result = await f.run(f.patch(false));
    expect(result.state).toBe("ABORTED");
    expect(abortReason(result)).toContain("verification material changed");
  }, 120_000);

  test("an invalid helper actually fails compilation instead of reaching an equal-failure verdict", async () => {
    const f = await fixture({ materials: [{ ...MATERIAL, content: "this is not valid C\n" }] });
    const result = await f.run(f.patch(false));
    expect(result.state).toBe("ABORTED");
    expect(result.verification?.baselineBuild?.status).toBe("failed");
    expect(result.verification?.candidateBuild).toBeNull();
  }, 120_000);

  test("a workflow with no observations cannot accept a candidate", async () => {
    const f = await fixture({ test: 'export const workflowKind = "test-workflow-driven";\nexport default async () => {};\n' });
    const result = await f.run(f.patch(false));
    expect(result.state).toBe("ABORTED");
    expect(abortReason(result)).toContain("without any observations");
  }, 120_000);

  test("constant declarations without running or reading an artifact cannot accept a candidate", async () => {
    const f = await fixture({ test: 'export const workflowKind = "test-workflow-driven";\nexport default async (ctx) => { ctx.expect("constant", "same on both sides"); };\n' });
    const result = await f.run(f.patch(false));
    expect(result.state).toBe("ABORTED");
    expect(abortReason(result)).toContain("did not run or read any implementation artifact");
  }, 120_000);

  test("an explicitly checked negative exit remains a valid test run", async () => {
    const test = TEST_WORKFLOW.replace("run.exitCode !== 0", "run.exitCode !== 7");
    const f = await fixture({ test, materials: [{ ...MATERIAL, content: PROBE.replace("return 0;", "return 7;") }] });
    const result = await f.run(f.patch(false));
    expect(result.state).toBe("ACCEPTED");
    for (const side of ["baseline", "candidate"]) {
      const evidence = JSON.parse(readFileSync(join(result.logDir, "artifacts", `${side}-test-workflow-run.json`), "utf8"));
      expect(evidence.events.some((event: { execution?: { status: string; exitCode: number } }) => event.execution?.status === "exited" && event.execution.exitCode === 7)).toBe(true);
    }
  }, 120_000);

  test("matching process timeouts cannot be accepted even if the writer ignores status", async () => {
    const test = TEST_WORKFLOW
      .replace('program: app, args: []', 'program: app, args: [], timeoutMs: 100')
      .replace('  if (run.status !== "exited" || run.exitCode !== 0) throw new Error("probe execution failed");', "");
    const f = await fixture({ test, materials: [{ ...MATERIAL, content: "int main(void) { for (;;) {} }\n" }] });
    const result = await f.run(f.patch(false));
    expect(result.state).toBe("ABORTED");
    expect(abortReason(result)).toContain("invalid process execution: timeout");
    expect(result.verification?.expectationComparison).toBeNull();
  }, 120_000);

  test("workflow source drift after resolution aborts before either build", async () => {
    const f = await fixture();
    const apply = f.patch(false);
    const result = await f.run(async (ctx, input) => {
      const outcome = await apply(ctx, input);
      writeFileSync(f.build, DIRECT_BUILD + "\n// changed after resolution\n");
      return outcome;
    });
    expect(result.state).toBe("ABORTED");
    expect(abortReason(result)).toContain("workflow source changed after resolution");
    expect(result.verification?.baselineBuild).toBeNull();
  }, 120_000);

  test("material distribution refuses a junction/symlink out of the worktree", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    mkdirSync(join(outside, "verification"), { recursive: true });
    writeFileSync(join(outside, MATERIAL.path.slice("build/".length)), "outside sentinel");
    const apply = f.patch(false);
    const result = await f.run(async (ctx, input) => {
      const outcome = await apply(ctx, input);
      symlinkSync(outside, join(input.candidate.worktrees.baselineDir, "build"), process.platform === "win32" ? "junction" : "dir");
      return outcome;
    });
    expect(result.state).toBe("ABORTED");
    expect(abortReason(result)).toContain("symlink or hard link");
    expect(readFileSync(join(outside, "verification", "probe.c"), "utf8")).toBe("outside sentinel");
  }, 120_000);

  test("host-pinned judge injection still overrides a tracked fake planted by the candidate", async () => {
    const test = TEST_WORKFLOW.replace('  ctx.expect("transform-results", run.stdout.trim());', '  ctx.expect("transform-results", run.stdout.trim());\n  ctx.expect("judge", await ctx.fs.readFile("judge/material.txt", "utf8"));');
    const f = await fixture({ test });
    const source = join(f.root, "judge.txt");
    writeFileSync(source, "fixed judge input\n");
    const apply = f.patch(false);
    const result = await f.run(async (ctx, input) => {
      const outcome = await apply(ctx, input);
      mkdirSync(join(input.candidate.worktrees.candidateDir, "judge"));
      writeFileSync(join(input.candidate.worktrees.candidateDir, "judge", "material.txt"), "fake judge\n");
      return outcome;
    }, [{ source, dest: "judge/material.txt" }]);
    expect(result.state).toBe("ACCEPTED");
    for (const side of ["baseline", "candidate"]) {
      expect(readFileSync(join(f.worktreeRoot, "worktrees", side, "judge", "material.txt"), "utf8")).toBe("fixed judge input\n");
    }
  }, 120_000);
});
