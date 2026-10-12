import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRequirement, probeRecipe, type HostFacts, type ProbeReport } from "../testset/runner/probe.js";
import { runPartCase } from "../testset/runner/drivers.js";
import { evaluatePart } from "../testset/runner/evaluate.js";
import { loadPart, loadSuite, type Requires } from "../testset/runner/suite.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function host(os: string): HostFacts {
  return { os, arch: "x64", cpu: 1, tools: {} };
}

function report(os: string): ProbeReport {
  return { host: host(os), recipes: {} };
}

describe("testset platform requirements", () => {
  test("omitted requirements and omitted platforms both allow any host platform", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-platform-"));
    roots.push(root);
    for (const id of ["no-requires", "no-platforms"]) {
      const dir = join(root, "cases", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "case.json"), JSON.stringify({
        id, prepare: null, task: "./task.txt",
        ...(id === "no-platforms" ? { requires: { tools: [] } } : {}),
        expect: { method: "verdict", state: "ACCEPTED" },
      }));
      writeFileSync(join(dir, "task.txt"), "synthetic task\n");
    }
    const { suite } = loadSuite(root);
    for (const c of suite.cases) {
      for (const platform of ["win32", "linux", "darwin", "freebsd"]) {
        expect(evaluateRequirement(c.requires, report(platform)).ok).toBe(true);
      }
    }
  });

  test("platforms are alternatives and an unmatched host is blocked", () => {
    const requires: Requires = { platforms: ["win32", "linux"], tools: [], recipe: null };
    expect(evaluateRequirement(requires, report("win32")).ok).toBe(true);
    expect(evaluateRequirement(requires, report("linux")).ok).toBe(true);
    expect(evaluateRequirement(requires, report("darwin")).ok).toBe(false);
    expect(evaluateRequirement({ ...requires, platforms: [] }, report("darwin")).ok).toBe(true);
  });

  test("a platform match still requires all tools and a successful recipe", () => {
    const requires: Requires = { platforms: ["linux"], tools: ["gcc"], recipe: "linux-gcc-ninja-debug" };
    const probe = report("linux");
    expect(evaluateRequirement(requires, probe).ok).toBe(false);
    const tools = { gcc: { available: true, path: "/usr/bin/gcc", version: "gcc" } };
    const readyHost = { ...probe.host, tools };
    expect(evaluateRequirement(requires, { ...probe, host: readyHost }).ok).toBe(false);
    expect(evaluateRequirement(requires, {
      host: readyHost,
      recipes: { "linux-gcc-ninja-debug": { id: "linux-gcc-ninja-debug", ok: true, detail: "ready" } },
    }).ok).toBe(true);
  });

  test("named recipes reject the wrong OS before checking tools", () => {
    const windows = probeRecipe("win-mingw-ninja-debug", host("linux"));
    const linux = probeRecipe("linux-gcc-ninja-debug", host("win32"));
    expect(windows.ok).toBe(false);
    expect(windows.detail).toContain("win32");
    expect(linux.ok).toBe(false);
    expect(linux.detail).toContain("win32");
    const missingCompiler = probeRecipe("linux-gcc-ninja-debug", host("linux"));
    expect(missingCompiler.ok).toBe(false);
    expect(missingCompiler.detail).toContain("gcc");
    expect(probeRecipe("libuv-ninja-debug", host("darwin")).ok).toBe(false);
  });

  test("platform-only upstream cases are blocked before building their runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-part-platform-"));
    roots.push(root);
    const caseDir = join(root, "cases", "unsupported-part");
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({
      kind: "upstream-part", prepare: null, part: "./part.json", expect: { method: "part" },
    }));
    writeFileSync(join(caseDir, "part.json"), JSON.stringify({
      version: 1, id: "unsupported", title: "platform-only upstream case",
      policy: { kind: "strict", repeats: 1, expectExit: 0, expectTap: "ok 1 - {case}", onFail: "fail" },
      cases: [{
        name: "unsupported-case",
        requires: { platforms: [process.platform === "win32" ? "linux" : "win32"] },
      }],
    }));
    const c = loadSuite(root).suite.cases[0]!;
    const part = loadPart(c.part!);
    // No source checkout exists here: attempting a build would fail.
    const run = await runPartCase({
      caseDir: join(root, "result"), testRoot: root, harnessDir: root, harnessCli: "",
      bun: process.execPath, repeats: 1, rebuild: false, startedAt: Date.now(), onPhase: () => {},
    }, c, part, null);
    expect(run.status).toBe("ok");
    expect(run.skipped.map((entry) => entry.name)).toEqual(["unsupported-case"]);
    expect(evaluatePart(c, part, run).status).toBe("blocked");
  });
});
