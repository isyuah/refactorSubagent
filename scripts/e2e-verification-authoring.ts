/** Live writer integration: author once, then verify fixed positive/negative controls. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { extractLimitArgs } from "../src/config/limits.js";
import { runStageFlow, type DeclaredAgentResolution, type StageFlowResult } from "../src/runtime/stage-flow.js";
import { patchRefactorStage, presetWorkflowsStage, type PresetWorkflowsSpec } from "../src/runtime/stage-presets.js";
import type { TestRunSide } from "../src/workflow/test-executor.js";
import { installOwnedProcessSignalHandlers } from "../shared/owned-process.js";

installOwnedProcessSignalHandlers();

const projectRoot = resolve(import.meta.dir, "..");
const fixture = join(projectRoot, "testset/resources/scout/fixtures/local-function");
const task = "对 src/text_copy.c 的长度计算和复制循环做保守的行为保持型重构，保持 text_copy 的公开接口和既有行为。";
const sourcePath = "src/text_copy.c";
const original = readFileSync(join(fixture, sourcePath), "utf8").replaceAll("\r\n", "\n");
const controls = [
  {
    id: "equivalent", expected: "accept",
    source: original.replace("size_t text_copy", "static size_t source_length(const char *src) {\n    size_t length = 0;\n    while (src[length] != '\\0') ++length;\n    return length;\n}\n\nsize_t text_copy")
      .replace("    size_t length = 0;\n    while (src[length] != '\\0') ++length;\n    if", "    size_t length = source_length(src);\n    if"),
  },
  {
    id: "truncated-return", expected: "block",
    source: original.replace("return length;", "return capacity == 0 ? length : (length < capacity - 1 ? length : capacity - 1);"),
  },
  {
    id: "capacity-one", expected: "block",
    source: original.replace("dst[copied] = '\\0';", "if (capacity > 1) dst[copied] = '\\0';"),
  },
] as const;

const Pins = z.array(z.object({ path: z.string(), sha256: z.string() }).strict());
const Snapshot = z.object({
  version: z.literal(1), repo: z.string(), baseSha: z.string(), task: z.string(),
  builds: z.array(z.object({ id: z.string(), entry: z.string(), workflowId: z.string(), revision: z.number() }).strict()),
  testEntry: z.string(), workflowId: z.string(), revision: z.number(), pins: Pins, sources: Pins.default([]),
}).strict();
type Snapshot = z.infer<typeof Snapshot>;

const parsed = extractLimitArgs(process.argv.slice(2));
let outArg: string | undefined;
let replayArg: string | undefined;
let controlsOnly = false;
for (let index = 0; index < parsed.remaining.length; index += 1) {
  const arg = parsed.remaining[index];
  if (arg === "--controls-only") controlsOnly = true;
  else if (arg === "--out" || arg === "--replay") {
    const value = parsed.remaining[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    if (arg === "--out") outArg = value;
    else replayArg = value;
  } else throw new Error("Usage: bun scripts/e2e-verification-authoring.ts [--out <new directory>] [--replay <previous directory>] [--controls-only] [--limit <key=value>]... [--limits-file <path>]...");
}
const output = outArg ? resolve(outArg) : mkdtempSync(join(tmpdir(), "refactor-writer-e2e-"));
if (outArg) mkdirSync(output, { recursive: false });
const limitOverrides = {
  files: parsed.overrides.files,
  values: [
    "sessions.testWriter.deadlineMs=900000", "stages.buildMs=120000",
    "stages.testWorkflowMs=120000", "commands.processMs=30000",
    ...parsed.overrides.values ?? [],
  ],
};
let snapshot: Snapshot | null = replayArg
  ? Snapshot.parse(JSON.parse(readFileSync(join(resolve(replayArg), "authoring.json"), "utf8")))
  : null;
const repo = snapshot?.repo ?? join(output, "repo");
const rows: Record<string, unknown>[] = [];
console.log(JSON.stringify({ scenario: "live-verification-authoring", output, repo, replay: replayArg ?? null }));

try {
  checkControls();
  if (controlsOnly) {
    save("summary.json", { ok: true, controlsOnly: true });
  } else {
    if (snapshot === null) {
      cpSync(fixture, repo, { recursive: true });
      writeFileSync(join(repo, sourcePath), original);
      writeFileSync(join(repo, ".gitignore"), ".refactor/\nbuild/\n");
      git(["init", "-q"]);
      git(["config", "user.email", "e2e@local.invalid"]);
      git(["config", "user.name", "Verification E2E"]);
      git(["config", "core.autocrlf", "false"]);
      git(["add", "."]);
      git(["commit", "-qm", "local-function authoring fixture"]);
    } else {
      if (snapshot.task !== task || git(["rev-parse", "HEAD"]).trim() !== snapshot.baseSha ||
          readFileSync(join(repo, sourcePath), "utf8") !== original || git(["diff", "--name-only", "HEAD", "--"]).trim()) {
        throw new Error("Replay source/task differs from the recorded authoring input");
      }
      assertPins(snapshot);
    }
    save("input.json", { task, repo, hostPlatform: process.platform, controls: controls.map(({ id, expected }) => ({ id, expected })), limitOverrides });

    for (const control of controls) {
      const patch = join(output, `${control.id}.patch`);
      try {
        writeFileSync(join(repo, sourcePath), control.source);
        const diff = git(["diff", "--", sourcePath]);
        if (!diff.trim()) throw new Error(`Empty control patch: ${control.id}`);
        writeFileSync(patch, diff);
      } finally {
        writeFileSync(join(repo, sourcePath), original);
      }
      if (snapshot !== null) assertPins(snapshot);
      console.log(`Running ${control.id}; workflows=${snapshot === null ? "live verification authoring" : "fixed authoring snapshot"}`);
      const result = await runStageFlow({
        repoPath: repo, task, sessionRoot: join(output, "sessions"),
        sessionId: control.id, limitOverrides,
        flow: {
          ...(snapshot === null ? {} : { workflows: presetWorkflowsStage(spec(snapshot)) }),
          refactor: patchRefactorStage(patch),
        },
      });
      if (snapshot === null && result.declared !== null) {
        snapshot = pinAuthoring(result.declared);
      }
      if (snapshot !== null) {
        assertPins(snapshot);
        save("authoring.json", snapshot);
      }
      const row = inspect(control, result);
      rows.push(row);
      save("summary.json", { ok: rows.length === controls.length && rows.every((row) => row.ok), complete: rows.length === controls.length, results: rows });
      console.log(JSON.stringify({
        id: row.id, state: row.state, ok: row.ok, detection: row.detection,
        baselineBuild: row.baselineBuild, candidateBuild: row.candidateBuild,
        baselineTest: row.baselineTest, candidateTest: row.candidateTest, logDir: row.logDir,
      }));
      // A valid positive baseline is required before interpreting negative controls.
      if (control.expected === "accept" && row.ok !== true) break;
    }
    if (rows.length !== controls.length || rows.some((row) => row.ok !== true)) process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  save("summary.json", { ok: false, error: message, results: rows });
  console.error(message);
  process.exitCode = 1;
}

function save(name: string, value: unknown): void {
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pinAuthoring(declared: DeclaredAgentResolution): Snapshot {
  const builds = declared.buildResolutions.map((build, index) => ({
    id: declared.declaredSet.builds[index]!.id, entry: build.entry,
    workflowId: build.manifest.id, revision: build.manifest.revision,
  }));
  const paths = [declared.testResolution.entry, ...builds.flatMap(({ entry }) =>
    existsSync(`${entry}.materials.json`) ? [entry, `${entry}.materials.json`] : [entry])];
  return {
    version: 1, repo, baseSha: git(["rev-parse", "HEAD"]).trim(), task, builds,
    testEntry: declared.testResolution.entry, workflowId: declared.workflowId, revision: declared.workflowRevision,
    pins: paths.map((path) => ({ path, sha256: digest(path) })),
    sources: git(["ls-files", "-z"]).split("\0").filter(Boolean)
      .map((entry) => { const path = join(repo, entry); return { path, sha256: digest(path) }; }),
  };
}

function assertPins(value: Snapshot): void {
  for (const pin of [...value.pins, ...value.sources]) {
    if (digest(pin.path) !== pin.sha256) throw new Error(`Frozen authoring input changed: ${pin.path}`);
  }
}

function spec(value: Snapshot): PresetWorkflowsSpec {
  return { builds: value.builds, testEntry: value.testEntry, entryRoot: value.repo, workflowId: value.workflowId, revision: value.revision };
}

function inspect(control: typeof controls[number], result: StageFlowResult): Record<string, unknown> {
  const side = (name: string): TestRunSide | null => {
    const path = join(result.logDir, "artifacts", `${name}-test-workflow-run.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as TestRunSide : null;
  };
  const baseline = side("baseline");
  const candidate = side("candidate");
  const buildsPassed = result.verification?.baselineBuild?.status === "pass" && result.verification?.candidateBuild?.status === "pass";
  const compared = result.state === "REJECTED" && result.verification?.expectationComparison?.overall === "inconsistent";
  // A native assertion failure can abort the test before comparison. Keep that
  // classification visible; infrastructure aborts never count as mutation detection.
  const executions = candidate?.events.flatMap((event) => event.execution ? [event.execution] : []) ?? [];
  const assertionBlocked = result.state === "ABORTED" && candidate?.status === "failed" &&
    executions.length > 0 && executions.every((execution) => execution.status === "exited" && execution.signal === null) &&
    executions.some((execution) => execution.exitCode !== null && execution.exitCode !== 0);
  const valid = result.provenance.verification_authoritative && buildsPassed && baseline?.status === "pass";
  const accepted = result.state === "ACCEPTED" && candidate?.status === "pass" && result.verification?.expectationComparison?.overall === "consistent";
  return {
    id: control.id, expected: control.expected, state: result.state,
    ok: valid && (control.expected === "accept" ? accepted : compared || assertionBlocked),
    detection: compared ? "observation-mismatch" : assertionBlocked ? "candidate-test-failure-review-required" : null,
    baselineBuild: result.verification?.baselineBuild?.status ?? null,
    candidateBuild: result.verification?.candidateBuild?.status ?? null,
    baselineTest: baseline?.status ?? null, candidateTest: candidate?.status ?? null,
    candidateFailure: candidate?.failure ?? null,
    comparison: result.verification?.expectationComparison ?? null,
    abortReason: result.store.history.filter((entry) => entry.to === "ABORTED").at(-1)?.note ?? null,
    provenance: result.provenance, logDir: result.logDir,
    materialCount: result.declared?.materials.length ?? 0,
  };
}

/** Hidden fixture oracle validates the control patches, never supplied to the writers. */
function checkControls(): void {
  const dir = join(output, "controls");
  mkdirSync(dir);
  const compiler = Bun.which("cc") ?? Bun.which("gcc") ?? Bun.which("clang");
  if (!compiler) throw new Error("A C compiler is required to validate the control patches");
  const results = controls.map((control) => {
    if (control.source === original) throw new Error(`Control did not change the source: ${control.id}`);
    const source = join(dir, `${control.id}.c`);
    const executable = join(dir, control.id + (process.platform === "win32" ? ".exe" : ""));
    writeFileSync(source, control.source);
    execFileSync(compiler, ["-std=c11", "-I", join(fixture, "include"), source,
      join(projectRoot, "testset/resources/scout/checks/local-function.c"), "-o", executable], { windowsHide: true, timeout: 30000 });
    const run = Bun.spawnSync([executable], { timeout: 30000 });
    if (run.signalCode != null || (run.exitCode === 0) !== (control.expected === "accept")) {
      throw new Error(`Fixture oracle did not confirm ${control.id}: exit=${run.exitCode}, signal=${run.signalCode}`);
    }
    return { id: control.id, exitCode: run.exitCode, compiler };
  });
  save("controls.json", results);
}
