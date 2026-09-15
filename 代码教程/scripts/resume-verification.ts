/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/resume-verification.ts —— 从持久化产物"断点续跑"验证阶段
 *
 * 【背景（文件头注释原话的翻译）】
 *   fix-18 那次 e2e 在 BASELINE_TEST_WORKFLOW 阶段中止——而此前的 AI 阶段
 *   （test-writer、build-writer、refactor）全都成功了。它们的产物都在 run
 *   目录里，重构 commit 也留在 refactor/agent-<session> 分支上。本脚本据此
 *   重建 worktree、只重跑"验证阶段"——零 AI 往返。
 *   ★ 这是任务 7（恢复机制）思路的第一次手工落地：AI 阶段贵且已成功 → 不重跑；
 *     验证阶段便宜且失败 → 单独重跑。
 *
 * 【最小复现】bun run scripts/resume-verification.ts --root <e2e-root> --session <id>
 *   （不需要 Claude；需要 gcc/cmake）
 *
 * 【本文件是教程注释版】原文件 scripts/resume-verification.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */
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

// 参数解析：--root 与 --session 缺一不可，缺了打印中文用法后 exit(2)。
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
const e2eRunDir = join(sessionRoot, ".refactor", "e2e", options.sessionId);   // 原次运行的观测目录

// 新开一个"<id>-resume"会话记录续跑（不覆盖原会话，两段证据都能回看）。
const resumeId = `${options.sessionId}-resume`;
const store = SessionStore.create(sessionRoot, resumeId);
const logger = new E2ELogger(join(sessionRoot, ".refactor", "e2e"), `${options.sessionId}-resume`);
logger.phase("RESUME_VERIFICATION");
logger.info("resuming verification from persisted artifacts", { root: options.root });

// 1. Host facts (cheap, no AI).
// 第 1 步：重测主机与项目事实（便宜、无 AI）。
const host = probeHost(repo);
const project = detectCProject(repo, host);
logger.info("host + project probed", { status: project.status });

// 2. Rebuild worktrees from the persisted refactor branch.
// 第 2 步：从持久化的重构分支重建双 worktree（AI 的修改都在这个分支上）。
const baseSha = resolveHead(repo);
const branch = `refactor/agent-${options.sessionId}`;
const worktrees = createWorktrees(repo, store.sessionDir, branch, baseSha);
logger.info("worktrees recreated", { baseline: worktrees.baselineDir, candidate: worktrees.candidateDir });

// 3. Reconstruct the declared resolution from the persisted artifact. The
// registry's declared set is in-memory only; the durable record is the
// declared-build-set.json artifact saved after the session.
// 第 3 步：从持久化 artifact 重建声明集。registry 的声明集只在内存里，
// 落盘的凭证是会话结束后保存的 declared-build-set.json。
const declaredArtifactPath = join(e2eRunDir, "artifacts", "declared-build-set.json");
const declaredArtifact = JSON.parse(await Bun.file(declaredArtifactPath).text()) as {
  builds: { id: string; entry: string; run_local: boolean }[];
};
if (declaredArtifact.builds.length === 0) {
  console.error("no declared builds in artifact");
  process.exit(1);
}
logger.info("declared builds from artifact", { ids: declaredArtifact.builds.map((b) => b.id) });

// 字段名换装：artifact 的 snake_case（run_local）→ 解析函数的 camelCase（runLocal）。
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
// 第 4 步：重建状态机需要的"占位 artifact"（与 pipeline 的取值一致）。
// ★ 关键理解：声明制下这些 artifact 由宿主程序派生——契约全 ignore（期望由
// test workflow 的 ctx.expect 负责）、范围来自宿主策略、依赖显式标 placeholder。
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
// 第 5 步：从 git 读重构 commit 信息拼 patch-record（分支上一切都在）。
// 动态 import：脚本顶层也可以用（Bun 支持顶层 await）。
const { execFileSync } = await import("node:child_process");
const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
const commitSha = git(["rev-parse", branch]);
const changedFiles = git(["diff", "--name-only", `${baseSha}..${branch}`]).split(/\r?\n/).filter((l) => l.length > 0);
const summary = git(["log", "-1", "--format=%s", branch]);

// 6. Run verification (the stage that aborted in fix-18).
// 第 6 步：只重跑验证阶段（fix-18 中止的地方）——双构建/双测试/对比/裁决。
const verification = await runWorkflowVerification({
  repoPath: repo,
  worktrees,
  store,
  logger,
  host,
  project,
  contract: contract as never,      // as never：绕过严格类型（脚本的权宜，正式代码别学）
  scope: scope as never,
  deps: deps as never,
  tests: tests as never,
  buildResolution: {                // build 决策占位：声明制下整组构建就是一份凭证
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
  testResolution: {                 // test 决策：declared 模式豁免 build_workflow 引用
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
  build: resolved.builds[0]!.resolution,   // 非空断言：前面已确认 builds 非空
  test: resolved.test,
  declaredSet: {                    // 声明集凭证（source_hash 缺失时给空串占位）
    kind: "declared-build-set",
    version: 1,
    test_workflow_id: `test-${options.sessionId}`,
    test_workflow_revision: 1,
    builds: declaredArtifact.builds.map((b) => ({ id: b.id, entry: b.entry, source_hash: b.source_hash ?? "", run_local: b.run_local })),
    source_hash: (declaredArtifact as { source_hash?: string }).source_hash ?? "",
  } as never,
  declaredBuilds: resolved.builds.map((b) => b.resolution),
  patch: {                          // patch-record 三要素全部来自 git 查询
    branch,
    commit_sha: commitSha,
    changed_files: changedFiles,
    summary: summary.slice(0, 500),
  },
  buildTimeoutMs: 120_000,
  ctestTimeoutMs: 180_000,
});

// 收尾：状态映射成观测状态 → 清理 worktree → 打印结果摘要。
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
