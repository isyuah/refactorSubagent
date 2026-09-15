/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/agent-pipeline.ts —— 旧版"真让 Claude 干活"的全流程编排
 *
 * 【这个文件是干什么的】
 *   它是把"多个 Claude 会话 + 程序验证"串成一条线的总指挥（旧版、无 workflow 那条路）：
 *     ① 程序先测量主机和项目（probeHost / detectCProject）；
 *     ② Claude 分析（analyzeRepo）产出 5 个 artifact（契约/范围/依赖/测试/环境）；
 *     ③ 程序建好 baseline / candidate 两个 worktree；
 *     ④ Claude 在 candidate worktree 里改代码（runRefactor，越界会被 SDK 钩子拦下）；
 *     ⑤ **程序**负责 git add/commit（Claude 全程不许碰 git）；
 *     ⑥ 交给 runVerification()（pipeline.ts）做双版本构建、跑测试、对比、裁决。
 *
 * 【在整个项目里的位置】
 *   · 上游（谁调用 runAgentVerification）：scripts/e2e-agent.ts、scripts/demo-agents.ts
 *     —— 也就是 `bun run e2e:agent` 那条命令。
 *   · 下游：analyze.ts / refactor.ts（两个 Claude 会话）、worktree.ts、pipeline.ts。
 *   · ⚠️ 它是**旧路径**：新版是同目录的 workflow-agent-pipeline.ts（多出 WORKFLOW_RESOLUTION
 *     阶段，构建/测试改由 Build/TestWorkflow 驱动）。旧路径仍被 e2e:agent 使用，所以还在维护。
 *   · 和新版逐段对照着读最有效：两边结构几乎一样，差的正是"workflow 决策与执行"那一段。
 *
 * 【先修知识】
 *   · async/await 与 Promise（analyzeRepo / runRefactor 是异步的，要等 Claude 会话跑完）；
 *   · try/finally（finally 里的清理一定会执行）；对象字面量与展开运算符 ...req.patch；
 *   · Orchestrator / SessionStore（见 src/orchestrator/，状态机与落盘）。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/agent-pipeline.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← spawnSync：同步执行 git 命令用（本文件只跑 git，不需要异步）
import { spawnSync } from "node:child_process";
import { analyzeRepoLegacy } from "../agents/analyze-legacy.js";   // ★ B 方案：旧 AI 分析被隔离为 legacy
import { runRefactor } from "../agents/refactor.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import {
  createWorktrees,
  resolveHead,
  type WorktreePair,
} from "./worktree.js";
import { probeHost } from "./host-preflight.js";
import { detectCProject } from "./project-detector.js";
// ← 旧版差分验证的"下半场"（双版本构建 + 跑测试 + 对比）在 pipeline.ts 里
import { runVerification } from "./pipeline.js";

// ← 请求参数：`readonly` 表示这些字段初始化后不许改（TS 的只读约定，运行时无开销）
export interface AgentPipelineRequest {
  /** Repo containing the C project at its base state. */
  repoPath: string;
  /** What the refactoring should do (natural language). */
  task: string;
  /** Root under which `.refactor/sessions/<id>` is kept. */
  sessionRoot: string;
  sessionId: string;
}

// ── gitIn：在指定目录里同步跑一条 git 命令 ──────────────────────────
// 【作用】本文件的 git 全走它；失败就抛异常（fail-closed：git 都不行就别继续了）。
// 【为什么要程序来跑 git】重构 Agent 的工具白名单里没有 git——提交这一步必须由宿主完成，
//   这样"改了什么"才是程序亲眼所见（diff 是程序算出来的，不是模型报的）。
function gitIn(dir: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

/**
 * Agent Pipeline — Claude proposes and refactors; the program validates,
 * commits, builds, runs and decides.
 *
 *   analyzeRepoLegacy()          → artifact proposals (zod-validated, 1 retry)
 *   createWorktrees()      → physical isolation
 *   runRefactor()          → edits candidate worktree, scope-enforced by hook
 *   program git commit     → the agent never touches git
 *   runVerification()      → baseline/candidate differential, R6 verdict
 */
// ── runAgentVerification：旧版全流程入口（本文件唯一导出的函数）──────
// 【作用】把"探测 → 分析 → 隔离 → 重构 → 提交 → 验证"整条线跑完，返回最终状态。
// 【参数】req：仓库路径、任务描述（自然语言）、会话落盘根目录、会话 id。
// 【返回】内联声明的对象类型：store（可继续查 artifact）、state（终态字符串）、
//        refactorSummary（重构 Agent 的总结）、scopeDenials（越界被拦的记录）。
// 【关系】被 scripts/e2e-agent.ts / demo-agents.ts 调用；内部调用 analyzeRepo、
//        runRefactor、createWorktrees、runVerification；**任何**分支最后都会 wt.cleanup()。
// 【语法】async 函数返回 Promise；返回类型写成内联对象字面量（没有单独定义 interface）。
export async function runAgentVerification(
  req: AgentPipelineRequest,
): Promise<{
  store: SessionStore;
  state: string;
  refactorSummary: string;
  scopeDenials: string[];
}> {
  // ← SessionStore.create：新建会话目录（已存在会直接抛错——这也是任务 7"失败恢复"要改的点）
  const store = SessionStore.create(req.sessionRoot, req.sessionId);
  // ← 状态机：只有它有权推进状态（后面的 runVerification 内部还会再建一个，操作同一个 store）
  const orch = new Orchestrator(store);

  // ← 第 1 步：程序测量主机。测完立刻落盘（saveHostPreflight），后面所有阶段共享这一份。
  const host = probeHost(req.repoPath);
  store.saveHostPreflight(host);
  // ← 第 2 步：识别项目构建系统。探测到 Make/MSVC（没实现适配器）会得到 needs-adapter。
  const project = detectCProject(req.repoPath, host);
  store.saveProjectDetection(project);
  if (project.status !== "ready") {
    // ← fail-closed：构建系统这台机器搞不定 → 直接中止，不猜、不降级
    orch.abort(`project build detection blocked: ${project.reason}`);
    return {
      store,
      state: store.state,
      refactorSummary: "",
      scopeDenials: [],
    };
  }

  // Analysis receives measured host and project facts.
  // ← 第 3 步：Claude 分析（只读会话）。测量事实作为上下文注入，模型不许自己猜环境。
  const analysis = await analyzeRepoLegacy(req.repoPath, req.task, host, project);   // ★ B 方案：改调 legacy 版
  // 2. Candidate branch at current HEAD; agent edits land in its worktree.
  // ← 第 4 步：在当前 HEAD 上开一个候选分支，把重构提交装进去。
  //   分支名带 sessionId，多个会话互不冲突。
  const branch = `refactor/agent-${req.sessionId}`;
  const headBefore = resolveHead(req.repoPath);
  gitIn(req.repoPath, ["branch", branch, headBefore]);
  const wt: WorktreePair = createWorktrees(
    req.repoPath,
    store.sessionDir,
    branch,
    headBefore,
  );

  // ← try/finally：不管中途成功还是抛异常，finally 都会把两个 worktree 删掉（冷构建的根源之一）
  try {
    // ⚠️ 这个局部变量在本文件里后面没有被用到（runRefactor 收的是整个 ScopeManifest 对象），
    //    属于遗留代码；新版 workflow-agent-pipeline.ts 里也有一模一样的一行。
    const editable = analysis.scope.editable_files.map((t) => t.file);

    // 3. Refactor inside the candidate worktree (hook-enforced scope).
    // ← 第 5 步：重构 Agent 在 candidate worktree 里干活。
    //   真正的越界拦截不靠提示词自觉，而是 SDK 的 PreToolUse 钩子按 scope 检查每个读写。
    const refactor = await runRefactor(wt.candidateDir, req.task, analysis.scope);

    // 4. Program-owned commit of whatever the agent actually changed.
    // ← `git status --porcelain` 输出为空 = Agent 什么都没改 → 中止（没有可验证的补丁）
    const status = gitIn(wt.candidateDir, ["status", "--porcelain"]);
    if (status.trim().length === 0) {
      orch.abort("refactor agent made no changes");
      return {
        store,
        state: store.state,
        refactorSummary: refactor.summary,
        scopeDenials: refactor.denials,
      };
    }
    gitIn(wt.candidateDir, ["add", "-A"]);
    // ← 提交信息取重构总结的第一行非空文本；取不到就用任务描述兜底。截断到 200 字符。
    const msgLine =
      refactor.summary.split("\n").find((l) => l.trim().length > 0) ??
      req.task;
    gitIn(wt.candidateDir, ["commit", "-m", msgLine.slice(0, 200)]);

    // ← 改动文件清单：用 git diff 自己算（不信模型的自述）。split/map/filter 是把多行文本
    //   清洗成干净的文件名数组。
    const changedFiles = gitIn(wt.candidateDir, [
      "diff",
      "--name-only",
      `${headBefore}..HEAD`,
    ])
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // 5. Verification: every orchestrator gate still applies.
    // ← 第 6 步：把"分析产物 + 补丁记录"一起交给验证器。
    //   注意 runVerification 是同步函数，这里没写 await 也能拿到返回值。
    //   传 worktrees: wt 表示"复用刚才建的那对"，不要重建。
    const outcome = runVerification(store, {
      repoPath: req.repoPath,
      candidateBranch: branch,
      worktrees: wt,
      host,
      contract: analysis.contract,
      scope: analysis.scope,
      deps: analysis.deps,
      tests: analysis.tests,
      env: analysis.env,
      patch: {
        branch,
        commit_sha: gitIn(wt.candidateDir, ["rev-parse", "HEAD"]),
        changed_files: changedFiles,
        summary: msgLine.slice(0, 500),
      },
    });

    return {
      store,
      state: outcome.state,
      refactorSummary: refactor.summary,
      scopeDenials: refactor.denials,
    };
  } finally {
    wt.cleanup();
  }
}
