import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verificationScoutDefinition } from "../src/agents/verification-scout.js";
import { runScoutSession, snapshotScoutSources } from "../testset/runner/scout-session.js";
import { ScoutReferenceSchema, sha256, validateScoutEvidence, type ScoutInput } from "../testset/runner/scout-contract.js";
import { parseScoutScoring, gradeScoutScoring } from "../testset/runner/scout-rubric.js";
import { loadSuite, verifyMaterial } from "../testset/runner/suite.js";
import { analysisReport } from "./helpers/verification-analysis.js";
import { withMcpClient } from "./helpers/mcp-client.js";

const ROOT = resolve(import.meta.dir, "..");
const SUITE = join(ROOT, "testset");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-scout evaluation-"));
  roots.push(root);
  return root;
}
function fixture(root: string) {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/main.c"), "int main(void) { return 0; }\n");
  return { repo, task: "Preserve main behavior", output: join(root, "evidence") };
}

describe("isolated scout evaluation boundaries", () => {
  test("uses the production role and real MCP submission without starting writers", async () => {
    const request = fixture(temp());
    const result = await runScoutSession(request, async (options) => {
      const production = verificationScoutDefinition();
      expect(options.allowedTools).toEqual(production.tools!);
      expect(options.skills).toEqual(production.skills!);
      expect(options.systemPrompt).toContain(readFileSync(join(ROOT, ".claude/plugins/workflow-spec/skills/verification-scout/SKILL.md"), "utf8"));
      expect(options.agents).toBeUndefined();
      expect(options.allowedTools).not.toContain("Bash");
      expect(options.allowedTools).not.toContain("Write");
      const server = options.mcpServers!["dep-registry"] as unknown as Parameters<typeof withMcpClient>[0];
      await withMcpClient(server, async (client) => {
        const rejected = await client.callTool({ name: "submitVerificationAnalysis", arguments: { subject: "incomplete" } });
        expect(rejected.isError).toBe(true);
        const accepted = await client.callTool({ name: "submitVerificationAnalysis", arguments: analysisReport() });
        expect(accepted.isError).not.toBe(true);
      });
      return { result: "handoff", isError: false, timedOut: false };
    });
    expect(result.ok).toBe(true);
    expect(result.report).toEqual(analysisReport());
    expect(result.sourceChanges).toEqual([]);
    const input = JSON.parse(readFileSync(join(request.output, "scout-input.json"), "utf8"));
    expect(input.sources.map((source: { path: string }) => source.path)).toEqual(["src/main.c"]);
    expect(input.preflight.project.status).toBe("detected");
    expect(input.agent.prompt).toContain(request.task);
    expect(existsSync(join(request.repo, ".refactor"))).toBe(false);
  });

  test("stale reports, failed sessions and source changes cannot pass as an investigation", async () => {
    for (const failure of ["stale", "timeout", "exception", "source-change"] as const) {
      const request = fixture(temp());
      mkdirSync(request.output, { recursive: true });
      writeFileSync(join(request.output, "scout-analysis.json"), JSON.stringify({ report: analysisReport() }));
      const result = await runScoutSession(request, async (options) => {
        if (failure !== "stale") {
          await withMcpClient(options.mcpServers!["dep-registry"] as Parameters<typeof withMcpClient>[0], async (client) => {
            await client.callTool({ name: "submitVerificationAnalysis", arguments: analysisReport() });
          });
        }
        if (failure === "exception") throw new Error("transport lost");
        if (failure === "source-change") writeFileSync(join(request.repo, "src/main.c"), "int main(void) { return 1; }\n");
        return { result: "", isError: false, timedOut: failure === "timeout" };
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      if (failure === "stale") expect(result.report).toBeNull();
      if (failure === "timeout") expect(result.timedOut).toBe(true);
      if (failure === "source-change") expect(result.sourceChanges).toEqual(["src/main.c"]);
    }
  });

  test("every scenario's reference is anchored to complete fixture source across the difficulty tiers", () => {
    const { suite } = loadSuite(SUITE);
    expect(verifyMaterial(suite, SUITE)).toEqual([]);
    const cases = suite.cases.filter((c) => c.kind === "scout");
    const tiers: Record<string, number> = {};
    for (const c of cases) {
      const reference = ScoutReferenceSchema.parse(JSON.parse(readFileSync(c.expect.rubric!.reference!, "utf8")));
      const sources = snapshotScoutSources(join(SUITE, "resources/scout/fixtures", c.id.slice(6)));
      const input = { sources, agent: { skill: { path: "test", content: "skill", sha256: sha256("skill") } } } as ScoutInput;
      validateScoutEvidence(input, reference);
      expect(sources.some(({ path }) => /reference|rubric|case\.json|task\.txt/.test(path))).toBe(false);
      tiers[reference.difficulty] = (tiers[reference.difficulty] ?? 0) + 1;
      const corrupted = structuredClone(input);
      corrupted.sources[0]!.content += "changed";
      expect(() => validateScoutEvidence(corrupted, reference)).toThrow(/hash mismatch/);
    }
    expect(Object.keys(tiers).sort()).toEqual(["advanced", "basic", "intermediate"]);
  });

  test("strict fact scores use host weights and critical failures cannot hide in a high total", () => {
    const reference = ScoutReferenceSchema.parse(JSON.parse(readFileSync(join(SUITE, "cases/scout-missing-provider/reference.json"), "utf8")));
    const score = {
      score: 1, criteria: reference.facts.map((fact) => ({ name: fact.id, score: fact.id === "actionable-uncertainty" ? 0 : 1, reason: "evidence citation" })),
    };
    const parsed = parseScoutScoring(JSON.stringify(score), reference);
    const grade = gradeScoutScoring(parsed, reference, "prompt", 0.8);
    expect(grade.score).toBeCloseTo(10 / 12);
    expect(grade.status).toBe("failed");
    expect(grade.detail).toContain("critical failures: actionable-uncertainty");
    const variants = [
      { criteria: score.criteria.slice(1) },
      { criteria: [score.criteria[0], ...score.criteria.slice(0, -1)] },
      { criteria: [{ ...score.criteria[0], score: 2 }, ...score.criteria.slice(1)] },
      { criteria: [{ ...score.criteria[0], name: "invented" }, ...score.criteria.slice(1)] },
    ];
    for (const invalid of variants) expect(() => parseScoutScoring(JSON.stringify(invalid), reference)).toThrow();
  });

  test("runner keeps unscored reports pending, re-scores without the env, and binds saved scores to evidence", () => {
    const root = temp();
    const testRoot = join(root, "testset");
    const id = "scout-existing-tests";
    const cdir = join(testRoot, "cases", id);
    mkdirSync(cdir, { recursive: true });
    cpSync(join(SUITE, "cases", id, "reference.json"), join(cdir, "reference.json"));
    writeFileSync(join(cdir, "task.txt"), "Preserve normalize_key behavior");
    const config = {
      id, subject: "scout", kind: "scout", repo: "repo", task: "./task.txt",
      prepare: join(SUITE, "resources/scout/prepare.ts"),
      expect: { method: "scout+rubric", rubric: { rubric: join(SUITE, "resources/scout/rubric.md"), reference: "./reference.json" } },
    };
    writeFileSync(join(cdir, "case.json"), JSON.stringify(config));
    mkdirSync(join(root, "scripts"));
    // A private synthetic adapter exercises the real session/MCP/runner path;
    // production has no fake-model option.
    writeFileSync(join(root, "scripts/eval-scout.ts"), `
import { readFileSync } from "node:fs";
import { runScoutSession } from ${JSON.stringify(pathToFileURL(join(SUITE, "runner/scout-session.ts")).href)};
import { withMcpClient } from ${JSON.stringify(pathToFileURL(join(ROOT, "tests/helpers/mcp-client.ts")).href)};
const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
const result = await runScoutSession(request, async (options) => {
  await withMcpClient(options.mcpServers["dep-registry"], async client => {
    await client.callTool({ name: "submitVerificationAnalysis", arguments: ${JSON.stringify(analysisReport())} });
  });
  return { result: "synthetic", isError: false, timedOut: false };
});
process.exitCode = result.ok ? 0 : 1;
`);
    const out = join(root, "out");
    const run = (...args: string[]) => {
      const child = Bun.spawnSync([process.execPath, join(SUITE, "run.ts"), "--root", testRoot, "--no-color", ...args],
        { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
      return { exit: child.exitCode, text: child.stdout.toString() + child.stderr.toString() };
    };
    expect(run("--out", out, "--drop-env").exit).toBe(0);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary.counts).toMatchObject({ passed: 0, pendingRubric: 1, errored: 0 });
    expect(existsSync(join(out, id, "env"))).toBe(false);
    expect(existsSync(join(out, id, "pipeline.json"))).toBe(false);
    // A saved case scorer must not cause a supposedly offline re-evaluation
    // to invoke a model implicitly.
    writeFileSync(join(cdir, "case.json"), JSON.stringify({ ...config, evaluate: { command: "this-scorer-must-not-run" } }));
    expect(run("--reevaluate", out).exit).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "summary.reevaluated.json"), "utf8")).counts.pendingRubric).toBe(1);
    const reference = ScoutReferenceSchema.parse(JSON.parse(readFileSync(join(cdir, "reference.json"), "utf8")));
    const scorer = join(root, "local scorer.ts");
    writeFileSync(scorer, `console.log(${JSON.stringify(JSON.stringify({ criteria: reference.facts.map(({ id }) => ({ name: id, score: 1, reason: "synthetic transport check only" })) }))});`);
    const scored = run("--reevaluate", out, "--rubric-cmd", `"${process.execPath}" "${scorer}"`);
    expect(scored.text).not.toContain("error:");
    expect(scored.exit).toBe(0);
    const judged = JSON.parse(readFileSync(join(out, "summary.reevaluated.json"), "utf8"));
    expect(judged.counts.passed).toBe(1);
    expect(judged.cases[0].rubric.score).toBe(1);
    expect(run("--reevaluate", out).exit).toBe(0); // cached; never starts an SDK session
    const storedPath = join(out, id, "run-result.json");
    const stored = JSON.parse(readFileSync(storedPath, "utf8"));
    stored.result.report.subject = "different report";
    writeFileSync(storedPath, JSON.stringify(stored));
    expect(run("--reevaluate", out).exit).toBe(1);
    const stale = JSON.parse(readFileSync(join(out, "summary.reevaluated.json"), "utf8"));
    expect(stale.counts.errored).toBe(1);
    expect(stale.cases[0].error).toContain("does not match");
  }, 60_000);
});
