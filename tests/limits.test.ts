import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS, resolveLimits } from "../src/config/limits.js";

let repo: string;
let home: string;

function writeLimits(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rfr-limits-repo-"));
  home = mkdtempSync(join(tmpdir(), "rfr-limits-home-"));
});

describe("limits resolution", () => {
  test("time budgets default to unbounded, structural caps keep defaults", () => {
    const { limits, sources } = resolveLimits({ repoRoot: repo, homeDir: home });
    expect(sources).toEqual([]);
    expect(limits.sessions.refactor.deadlineMs).toBeNull();
    expect(limits.sessions.testWriter.deadlineMs).toBeNull();
    expect(limits.stages.buildMs).toBeNull();
    expect(limits.stages.ctestMs).toBeNull();
    expect(limits.commands.processMs).toBeNull();
    expect(limits.resources.build.maxOutputBytes).toBe(
      DEFAULT_LIMITS.resources.build.maxOutputBytes,
    );
    // The dead-stream watchdog is a liveness guard, not a project budget.
    expect(limits.sessions.refactor.stallMs).toBe(180_000);
  });

  test("project layer overrides user layer, field by field", () => {
    writeLimits(join(home, ".refactor", "limits.json"), {
      stages: { buildMs: 300_000 },
      sessions: { refactor: { deadlineMs: 1_800_000 } },
    });
    writeLimits(join(repo, ".refactor", "limits.json"), {
      stages: { buildMs: 900_000, ctestMs: 60_000 },
    });

    const { limits, sources } = resolveLimits({ repoRoot: repo, homeDir: home });
    expect(sources).toHaveLength(2);
    expect(limits.stages.buildMs).toBe(900_000); // project wins
    expect(limits.stages.ctestMs).toBe(60_000); // project adds
    expect(limits.sessions.refactor.deadlineMs).toBe(1_800_000); // user value survives
  });

  test("an explicit null lifts a limit set by a lower layer", () => {
    writeLimits(join(repo, ".refactor", "limits.json"), { stages: { buildMs: 60_000 } });
    const { limits } = resolveLimits({
      repoRoot: repo,
      homeDir: home,
      overrides: { values: ["stages.buildMs=null"] },
    });
    expect(limits.stages.buildMs).toBeNull();
  });

  test("explicit files merge after the project layer, overrides last", () => {
    writeLimits(join(repo, ".refactor", "limits.json"), { stages: { buildMs: 10_000 } });
    const extra = join(repo, "extra-limits.json");
    writeLimits(extra, { stages: { buildMs: 20_000, ctestMs: 30_000 } });

    const { limits, sources } = resolveLimits({
      repoRoot: repo,
      homeDir: home,
      overrides: { files: [extra], values: ["stages.ctestMs=40_000".replace("_", "")] },
    });
    expect(limits.stages.buildMs).toBe(20_000); // file beats project
    expect(limits.stages.ctestMs).toBe(40_000); // flag beats file
    expect(sources).toHaveLength(2);
  });

  test("resource caps are overridable but reject null", () => {
    const { limits } = resolveLimits({
      repoRoot: repo,
      homeDir: home,
      overrides: { values: ["resources.build.maxProcesses=16"] },
    });
    expect(limits.resources.build.maxProcesses).toBe(16);

    expect(() =>
      resolveLimits({
        repoRoot: repo,
        homeDir: home,
        overrides: { values: ["resources.build.maxFileBytes=null"] },
      }),
    ).toThrow(/maxFileBytes/);
  });
});

describe("limits validation", () => {
  test("a mistyped key in a config file fails instead of silently keeping the old budget", () => {
    writeLimits(join(repo, ".refactor", "limits.json"), { stages: { build: 60_000 } });
    expect(() => resolveLimits({ repoRoot: repo, homeDir: home })).toThrow(/invalid limits file/);
  });

  test("a mistyped override key names the available keys", () => {
    expect(() =>
      resolveLimits({ repoRoot: repo, homeDir: home, overrides: { values: ["stages.builMs=1"] } }),
    ).toThrow(/unknown limit override 'stages.builMs'.*buildMs, ctestMs, testWorkflowMs/);
  });

  test("non-JSON and non-positive values are rejected with the file named", () => {
    const path = join(repo, ".refactor", "limits.json");
    mkdirSync(join(repo, ".refactor"), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(() => resolveLimits({ repoRoot: repo, homeDir: home })).toThrow(/not valid JSON/);

    writeLimits(path, { stages: { buildMs: -1 } });
    expect(() => resolveLimits({ repoRoot: repo, homeDir: home })).toThrow(/buildMs/);
  });

  test("override syntax errors are explicit", () => {
    expect(() =>
      resolveLimits({ repoRoot: repo, homeDir: home, overrides: { values: ["stages.buildMs"] } }),
    ).toThrow(/key=value/);
    expect(() =>
      resolveLimits({ repoRoot: repo, homeDir: home, overrides: { values: ["stages.buildMs=soon"] } }),
    ).toThrow(/positive number or null/);
  });
});
