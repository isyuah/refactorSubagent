/**
 * Resume verification for a previously-generated e2e run.
 *
 * fix-18 aborted at BASELINE_TEST_WORKFLOW after the AI stages (test-writer,
 * build-writer, refactor) all succeeded. Their artifacts persist in the run
 * directory and the refactor commit is on branch refactor/agent-<session>.
 * This script rebuilds the worktrees and runs ONLY the verification stage
 * against those artifacts — no AI round trips.
 *
 * Usage: bun run scripts/resume-verification.ts --root <e2e-root> --session <id>
 */
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { SessionStore } from "../src/orchestrator/store.js";
import { E2ELogger } from "../src/runtime/e2e-log.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { createWorktrees, resolveHead } from "../src/runtime/worktree.js";
import { runWorkflowVerification } from "../src/runtime/workflow-pipeline.js";
import { LocalDependencyRegistry } from "../src/agents/dep-registry.js";
import { resolveDeclaredWorkflows } from "../src/workflow/resolve-declared.js";

interface Options {
  readonly root: string;
  readonly sessionId: string;
}

function parseOptions(args: readonly string[]): Options {
  const root = valueAfter(args, "--root");
  const sessionId = valueAfter(args, "--session");
  if (root === null || sessionId === null) {
    console.error("用法: bun run scripts/resume-verification.ts --root <e2e-root> --session <id>");
    process.exit(2);
  }
  return { root, sessionId };
}

function valueAfter(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) return null;
  return value;
}

const options = parseOptions(Bun.argv.slice(2));
const repo = join(options.root, "repo");
const sessionRoot = join(options.root, "session-root");
const e2eRunDir = join(sessionRoot, ".refactor", "e2e", options.sessionId);

const resumeId = `${options.sessionId}-resume`;
const store = SessionStore.create(sessionRoot, resumeId);
const logger = new E2ELogger(join(sessionRoot, ".refactor", "e2e"), `${options.sessionId}-resume`);
logger.phase("RESUME_VERIFICATION");
logger.info("resuming verification from persisted artifacts", { root: options.root });

// 1. Host facts (cheap, no AI).
const host = probeHost(repo);
const project = detectCProject(repo, host);
logger.info("host + project probed", { status: project.status });

// 2. Rebuild worktrees from the persisted refactor branch.
const baseSha = resolveHead(repo);
const branch = `refactor/agent-${options.sessionId}`;
const worktrees = createWorktrees(repo, store.sessionDir, branch, baseSha);
logger.info("worktrees recreated", { baseline: worktrees.baselineDir, candidate: worktrees.candidateDir });

// 3. Reconstruct the declared resolution from the persisted artifact. The
// registry's declared set is in-memory only; the durable record is the
// declared-build-set.json artifact saved after the session.
const declaredArtifactPath = join(e2eRunDir, "artifacts", "declared-build-set.json");
const declaredArtifact = JSON.parse(await Bun.file(declaredArtifactPath).text()) as {
  builds: { id: string; entry: string; run_local: boolean }[];
};
if (declaredArtifact.builds.length === 0) {
  console.error("no declared builds in artifact");
  process.exit(1);
}
logger.info("declared builds from artifact", { ids: declaredArtifact.builds.map((b) => b.id) });

const buildSources: { id: string; entry: string; runLocal: boolean }[] = declaredArtifact.builds.map((b) => ({
  id: b.id,
  entry: b.entry,
  runLocal: b.run_local,
}));
const testEntry = join(repo, ".refactor", "runs", options.sessionId, "workflows", "test", "test-workflow.ts");
const resolved = await resolveDeclaredWorkflows({
  workspaceRoot: repo,
  entryRoot: repo,
  host,
  project,
  testEntry,
  testWorkflowId: `test-${options.sessionId}`,
  testRevision: 1,
  builds: buildSources.map((b) => ({ id: b.id, entry: b.entry, runLocal: b.runLocal })),
});

// 4. Reconstruct host-derived placeholder artifacts (same values the pipeline uses).
const contract = {
  kind: "behavior-contract",
  version: 1,
  channels: { exit_code: { mode: "ignore" }, signals: { mode: "ignore" }, stdout: { mode: "ignore" }, stderr: { mode: "ignore" }, filesystem: { mode: "ignore" } },
  allowed_change: { internal_structure: true, execution_time: true },
  notes: ["host-derived placeholder: expectations are declared by the test workflow"],
};
const scope = {
  kind: "scope-manifest",
  version: 1,
  editable_files: [{ file: "src/trim.c", symbols: ["*"] }],
  readable_globs: ["CMakeLists.txt", "cmake/**", "config/**", "include/**", "src/**", "test/**", "tests/**"],
  forbidden_globs: ["baseline/**", ".refactor/**", "node_modules/**"],
  notes: [],
};
const deps = {
  kind: "dependency-manifest",
  version: 1,
  dependencies: [{ name: "none-declared", kind: "time", strategy: "reject", evidence: [], notes: "host-derived placeholder" }],
};
const tests = {
  kind: "test-spec",
  version: 1,
  cases: [{ id: "self-driven", kind: "differential", argv: [], stdin: "", fixtures: [] }],
  notes: [],
};

// 5. Read the refactor commit info from git for the patch record.
const { execFileSync } = await import("node:child_process");
const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
const commitSha = git(["rev-parse", branch]);
const changedFiles = git(["diff", "--name-only", `${baseSha}..${branch}`]).split(/\r?\n/).filter((l) => l.length > 0);
const summary = git(["log", "-1", "--format=%s", branch]);

// 6. Run verification (the stage that aborted in fix-18).
const verification = await runWorkflowVerification({
  repoPath: repo,
  worktrees,
  store,
  logger,
  host,
  project,
  contract: contract as never,
  scope: scope as never,
  deps: deps as never,
  tests: tests as never,
  buildResolution: {
    kind: "workflow-resolution",
    version: 1,
    workflow_kind: "build",
    mode: "declared",
    workflow_id: "declared-set",
    workflow_revision: 1,
    build_workflow: null,
    entry_root: "workspace",
    root_path: repo,
    entry: "declared-build-set",
    source_hash: "",
    candidate_entries: [],
    reason: "declared build set",
  },
  testResolution: {
    kind: "workflow-resolution",
    version: 1,
    workflow_kind: "test",
    mode: "declared",
    workflow_id: `test-${options.sessionId}`,
    workflow_revision: 1,
    build_workflow: null,
    entry_root: "workspace",
    root_path: relative(repo, resolved.test.entry).split("\\").join("/"),
    entry: relative(repo, resolved.test.entry).split("\\").join("/"),
    source_hash: resolved.test.sourceHash,
    candidate_entries: [],
    reason: "declared test workflow",
  },
  build: resolved.builds[0]!.resolution,
  test: resolved.test,
  declaredSet: {
    kind: "declared-build-set",
    version: 1,
    test_workflow_id: `test-${options.sessionId}`,
    test_workflow_revision: 1,
    builds: declaredArtifact.builds.map((b) => ({ id: b.id, entry: b.entry, source_hash: b.source_hash ?? "", run_local: b.run_local })),
    source_hash: (declaredArtifact as { source_hash?: string }).source_hash ?? "",
  } as never,
  declaredBuilds: resolved.builds.map((b) => b.resolution),
  patch: {
    branch,
    commit_sha: commitSha,
    changed_files: changedFiles,
    summary: summary.slice(0, 500),
  },
  buildTimeoutMs: 120_000,
  ctestTimeoutMs: 180_000,
});

logger.finish(verification.state === "ACCEPTED" ? "accepted" : verification.state === "REJECTED" ? "rejected" : "aborted",
  `resume verification ended: ${verification.state}`);
worktrees.cleanup();
console.log(JSON.stringify({
  state: verification.state,
  baseline_build: verification.baselineBuild?.status ?? null,
  candidate_build: verification.candidateBuild?.status ?? null,
  baseline: verification.baseline !== null ? "ok" : null,
  candidate: verification.candidate !== null ? "ok" : null,
  comparison: verification.comparison !== null ? "ok" : null,
  log_dir: logger.runDir,
}, null, 2));
if (verification.state !== "ACCEPTED") process.exitCode = 1;
