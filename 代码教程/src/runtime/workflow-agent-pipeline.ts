/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/workflow-agent-pipeline.ts —— B 方案（声明制依赖）全流程编排
 *
 * 【这个文件是干什么的】
 *   它是"一次完整运行"的主干：把探测、分析、test-writer 会话、隔离、重构、提交、
 *   验证、入库全部串起来，并且每一步都留下可观测的证据（E2ELogger 写 run.jsonl /
 *   artifacts / logs，Dashboard 看的就是这些）。
 *   它是 B 方案改版后的"新主编排"：旧版里的 WORKFLOW_RESOLUTION 阶段（chooser 让
 *   Claude 选 build → 模板生成 → 串行 resolve）已被整体删除，换成了
 *   WORKFLOW_SESSION 阶段 —— 开一个 test-writer 主 agent 会话，让它自己"查库 →
 *   （派 build-writer 子代理生成新 build）→ declareDependency 声明依赖集 → 写出
 *   TestWorkflow 源文件"；宿主拿到的是一份 DeclaredBuildSet（声明集），之后再按
 *   声明集执行 N≥0 个 build。设计依据 docs/b-subagent-workflow.md 第 3 节。
 *
 * 【宿主 vs AI 的分工（本项目最核心的一句设计）】
 *   AI 只"声明"和"写 workflow 源码"；宿主负责"解析、落盘、执行、测量、裁决"。
 *   声明制之后宿主**零产物知识**：宿主不告诉 test workflow 产物路径是什么，test
 *   workflow 自己从 build-writer 的汇报里学到路径并写死在自己的源码里，再用
 *   context.validator.assertFile 自己断言产物存在（见 workflow-session.ts 的会话提示词）。
 *
 * 【本文件在 B 方案时序里的位置】（docs/b-subagent-workflow.md 第 3 节"宿主时序"）
 *
 *     ┌─ PREFLIGHT ──────── probeHost / detectCProject（纯程序测量，不花模型）
 *     ├─ ANALYSIS ───────── analyzeRepo（宿主侧探测，同步、无模型往返）
 *     ├─ WORKFLOW_SESSION ─ runWorkflowSession：开 test-writer 会话（本文件唯一会话拓扑入口）
 *     │      test-writer ── inspectWorkflow（查：库里有什么 build 可复用）
 *     │            ├────── Task → build-writer 子代理 → generateBuildWorkflow（新 build 落盘）
 *     │            └────── declareDependency（声明最终依赖集）+ Write 自己的 test workflow
 *     │      ↓ 会话结束，宿主接管（runDeclaredResolution）：
 *     │      LocalDependencyRegistry.resolveBuildEntry（声明 id → 源文件路径，fail-closed）
 *     │      + resolveDeclaredWorkflows（逐个 build 出 resolution + test 出 resolution）
 *     ├─ WORKTREES ──────── 建分支 + baseline/candidate 两个 git worktree
 *     ├─ REFACTOR ───────── runRefactor（只允许改 candidate 这一份）
 *     ├─ commit ─────────── candidate 里一行没改就 abort
 *     └─ VERIFICATION ───── runWorkflowVerification（详见 workflow-pipeline.ts）
 *              ├─ 按 DeclaredBuildSet 循环执行 N 个 build（baseline / candidate 各一遍）
 *              ├─ 自驱动 test workflow 每边各跑一遍，ctx.expect(...) 收集期望
 *              └─ compareExpectations 差分 → 状态机走到 ACCEPTED / REJECTED
 *     finally ─────────── 删 worktree；ACCEPTED 时 promoteRunLocalBuilds（curator 入库 + alias）
 *
 * 【与旧版（4f870a4 之前）的行为差异，读代码时对照着看】
 *   1. 阶段名 WORKFLOW_RESOLUTION → WORKFLOW_SESSION；决策者从宿主的 chooser 换成 AI 会话。
 *   2. analyzeRepo 从"Claude 分析会话"变成**同步的宿主侧探测**（不花模型、毫秒级返回），
 *      不再产出 contract/deps/tests 三个 artifact —— 它们改由本文件的 defaultContract /
 *      defaultDeps / defaultTests 提供占位（状态机仍要求这三张"表格"才能往后走）。
 *   3. 请求类型里删掉了 `build?` / `test?`（WorkflowRequest 三源选项）；返回值里的
 *      `workflows` 换成了 `declared`（DeclaredAgentResolution）。
 *   4. 新增 FileSessionStore：把每次 AI 会话的完整转录（工具调用、子代理文本、结果）
 *      镜像到 run 目录，方便事后排查慢会话。
 *   5. 大量阶段套上 timed / timedAsync：每个阶段的耗时都写进日志。
 *   6. finally 里新增 promoteRunLocalBuilds：run 被接受后，本次现写的 run-local build
 *      由 curator 提升进持久库并写 alias.json（对应计划步骤 7）。
 *
 * 【先修知识】
 *   · async/await、可选链 ?.、空值合并 ??、try/catch/finally、readonly + 可选字段；
 *   · E2ELogger 的方法（phase/info/warn/error/artifact/logFile/heartbeat/finish/close）；
 *   · 状态机概念：Orchestrator.submit(artifact) 按 artifact 的 kind 推进会话状态，
 *     🔗 见 src/orchestrator/orchestrator.ts 的 PIPELINE 表；
 *   · 🔗 建议先读懂 docs/b-subagent-workflow.md、agents/workflow-session.ts、
 *     agents/dep-registry.ts、workflow/resolve-declared.ts，再回来读本文件。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/workflow-agent-pipeline.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← existsSync / readFileSync：判断 test workflow 文件是否真的被写出来、把源码读成字符串
import { existsSync, readFileSync } from "node:fs";
// ← spawnSync：同步起子进程，这里只用来跑 git 命令（建分支、add、commit、diff…）
import { spawnSync } from "node:child_process";
// ← createHash：算 SHA-256（声明集哈希、run-local build 源码哈希），用于审计字段
import { createHash } from "node:crypto";
// ← join 拼路径；relative 把绝对路径转成"相对某个根"的路径（产物里统一存相对路径）
import { join, relative } from "node:path";
// ← 两个纯类型导入：宿主探测结果 / C 项目识别结果（运行时值在 runtime 各文件里）
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
// ← curator：把本次现写的 run-local build 提升进持久库 + 维护 alias.json（B 方案第 5 节）
import { curateBuildWorkflow, loadAliases } from "../workflow/curator.js";
// ← analyzeRepo：注意这是**宿主侧探测**版本的 analyze（同步函数，不再开 Claude 会话）
import { analyzeRepo, type AnalysisResult } from "../agents/analyze.js";
// ← runRefactor：真正改代码的重构 agent 会话
import { runRefactor } from "../agents/refactor.js";
import { E2ELogger } from "./e2e-log.js";
// ← FileSessionStore：把 SDK 会话转录按 {projectKey, sessionId} 落成文件（可观测性）
import { FileSessionStore } from "./session-store.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SessionStore } from "../orchestrator/store.js";
import { detectCProject } from "./project-detector.js";
import { probeHost } from "./host-preflight.js";
// ← 验证半场：真正"跑 build + 跑 test + 差分"的函数在那个文件里
import { runWorkflowVerification, type WorkflowVerificationOutcome } from "./workflow-pipeline.js";
// ← worktree：给 baseline / candidate 各开一份互不干扰的工作目录
import { createWorktrees, resolveHead, type WorktreePair } from "./worktree.js";
// ← B 方案新增：test-writer 会话编排（注入 MCP 工具 + build-writer 子代理 + 收声明集）
import { runWorkflowSession } from "../agents/workflow-session.js";
// ← B 方案新增：声明注册表的宿主实现（inspect / declare / generate 的纯逻辑层）
import { LocalDependencyRegistry } from "../agents/dep-registry.js";
// ← B 方案新增：声明集驱动的 resolve（没有 chooser，只有"查文件 → 校验 → 出 resolution"）
import { resolveDeclaredWorkflows } from "../workflow/resolve-declared.js";
// ← 一堆"表格"的类型：契约、声明集、依赖清单、测试规格、workflow 决议
//   `import type` 只引类型不引运行时代码，编译后这行会整个消失
import type {
  BehaviorContract,
  DeclaredBuildSet as DeclaredBuildSetValue,   // ← 改名：Zod schema 叫 DeclaredBuildSet，这里给它起个别名，避免和本文件的 DeclaredAgentResolution 语义混淆
  DependencyManifest,
  TestSpec,
  WorkflowResolution,
} from "../artifacts/index.js";
import type { TestWorkflowResolution } from "../workflow/test-workflow.js";
import type { BuildWorkflowResolution } from "../workflow/build-workflow.js";

// ── AgentWorkflowPipelineRequest：一次完整运行的输入 ─────────────────
// 【作用】描述"这次 run 要对哪个仓库、做什么重构、允许改哪些文件、各阶段超时多少"。
// 【语法】所有字段 readonly：类型上就禁止流程中途改输入；`?:` 表示可选字段。
// 【关系】scripts/e2e-generated-workflow.ts（`bun run e2e:generated-workflow`）构造它并
//        调用 runAgentWorkflowVerification。
export interface AgentWorkflowPipelineRequest {
  /** Git repository containing the base C project. */
  // ← 被重构的 C 工程所在仓库（必须有 git，因为后面要建分支 + worktree）
  readonly repoPath: string;
  /** Natural-language refactoring task given to Analyze and Refactor agents. */
  // ← 一句自然语言的重构任务，会原样传给 test-writer 会话和重构会话
  readonly task: string;
  /** Root under which the durable session is created. */
  // ← 会话持久化目录的根（.refactor/sessions/<id> 建在它下面）
  readonly sessionRoot: string;
  // ← 本次 run 的唯一 id：目录名、分支名、run-local workflow id 后缀都用它
  readonly sessionId: string;
  /** Optional project policy; declared editable scope must stay within this set. */
  // ← 宿主侧的白名单上限：分析阶段推导出的"允许修改的文件"必须与它完全一致，
  //    超出/缺失都算策略被破坏（声明制下这个约束由 analyzeRepo 直接采纳宿主策略来实现）
  readonly allowedEditableFiles?: readonly string[];
  // ← test-writer（含 build-writer 子代理往返）的整场超时；e2e 里给到 30 分钟
  readonly workflowTimeoutMs?: number;
  /** When false, skip PreToolUse scope enforcement for all agent sessions. */
  // ← ★ 新增开关：false = 所有 agent 会话跳过 PreToolUse 范围拦截（e2e 临时用来
  //   先跑通全流程；Glob/可读白名单模型后续会重新收紧——见 e2e 脚本里的 TEMP 注释）
  readonly enforceScope?: boolean;
  // ← 单个 build workflow 在单个 worktree 里执行的超时（毫秒！）
  readonly buildTimeoutMs?: number;
  // ← test 阶段（CTest 或自驱动 test workflow）的单边超时（毫秒！）
  readonly ctestTimeoutMs?: number;
  // ← 已知"环境敏感"失败的正则：给 baseline 侧失败分类用（怪环境不怪代码）
  readonly knownEnvironmentPatterns?: readonly RegExp[];
  // ← 调用方可以传自己的 logger 共享同一个 run 目录；不传就在会话目录下新建一个
  readonly logger?: E2ELogger;
}

// ── DeclaredAgentResolution：声明制流程的"中间产物包" ────────────────
// 【作用】把 test-writer 会话的产出（声明集 + test 源码）和宿主解析的结果（N 个 build
//        resolution）打包在一起，供 VERIFICATION 阶段一次性消费。
// 【关系】由本文件的 runDeclaredResolution 组装；传给 runWorkflowVerification 的
//        declaredSet / declaredBuilds / test 字段；最终也原样出现在 AgentWorkflowPipelineResult
//        里给入口脚本断言用。
export interface DeclaredAgentResolution {
  /** DeclaredBuildSet artifact carrying the whole declaration. */
  // ← 整个声明的"单凭证"：N 个 build 的 id / 入口 / 源码哈希 / 是否 run-local（B 方案第 2 节）
  readonly declaredSet: DeclaredBuildSetValue;
  // ← test workflow 的决议（入口路径、manifest、sourceHash；自驱动时 workflow 为 null）
  readonly testResolution: TestWorkflowResolution;
  /** Resolved build workflows, in declaration order. */
  // ← 按声明顺序排好的 N 个 build 决议 —— 顺序很重要，宿主就按这个顺序执行
  readonly buildResolutions: readonly BuildWorkflowResolution[];
  // ← test workflow 源码文本（文件不存在时是空串）
  readonly testSource: string;
  // ← 宿主给这次会话产物分配的 test workflow id（test-<sessionId>）
  readonly workflowId: string;
  // ← 宿主分配的版本号，会话产物固定为 1
  readonly workflowRevision: number;
}

// ── AgentWorkflowPipelineResult：整场 run 的最终返回值 ───────────────
// 【语法】中间产物字段都是 `X | null`：流程可能在任何一步 abort，没走到的地方就是 null。
export interface AgentWorkflowPipelineResult {
  readonly store: SessionStore;
  // ← 会话终态：ACCEPTED / REJECTED / ABORTED / 中间态（入口脚本用它判断成败）
  readonly state: string;
  // ← 重构 agent 写的总结（第一行会被用作 commit message）
  readonly refactorSummary: string;
  // ← 重构 agent 越权写被 scope hook 拒绝的记录（超纲行为的证据）
  readonly scopeDenials: string[];
  readonly analysis: AnalysisResult | null;
  // ← B 方案改版：原来是 `workflows: ResolvedWorkflows | null`（chooser 三源决策的结果）
  readonly declared: DeclaredAgentResolution | null;
  // ← 验证半场的结局（构建/测试产物、对比结论）；没进验证阶段就是 null
  readonly verification: WorkflowVerificationOutcome | null;
  // ← 本次 run 的日志目录（run.jsonl、artifacts、会话转录都在里面）
  readonly logDir: string;
}

/**
 * Full Claude-backed Workflow pipeline.
 *
 * Claude proposes artifacts, selects/refines the workflow and edits only the
 * candidate worktree. The host measures, persists, executes and decides.
 */
// ── runAgentWorkflowVerification：全流程入口（本文件唯一导出的函数）──────────
// 【作用】按上文时序图跑完 PREFLIGHT → ANALYSIS → WORKFLOW_SESSION → WORKTREES →
//        REFACTOR → commit → VERIFICATION → finally 清扫。
// 【参数】req：见 AgentWorkflowPipelineRequest。
// 【返回】AgentWorkflowPipelineResult。⚠️ 任何失败路径都**返回**而不是抛异常：
//        catch 把异常转成 orch.abort(...)，调用方拿到的永远是完整对象。
// 【关系】scripts/e2e-generated-workflow.ts 调它；验证半场在 workflow-pipeline.ts；
//        状态推进全部经 Orchestrator（fail-closed：artifact 不合规矩就停）。
// ⚠️ 结构提示：整段是一个大 try / catch / finally。所有中间结果先用 let 声明成 null，
//    就是为了在 catch / finally 里还能拿到"跑到哪一步了"的证据 —— 这是把
//    "失败时也要留下现场"做进代码结构里的写法。
export async function runAgentWorkflowVerification(
  req: AgentWorkflowPipelineRequest,
): Promise<AgentWorkflowPipelineResult> {
  // ← 新建会话目录（.refactor/sessions/<id>/），已存在会抛错 → 同一个 id 不能跑两次
  const store = SessionStore.create(req.sessionRoot, req.sessionId);
  // ← 状态机：唯一有权把会话状态往前推的角色
  const orch = new Orchestrator(store);
  // ← 日志器：调用方传了就复用（共享 run 目录），否则在 <sessionRoot>/.refactor/e2e 下开一个
  const logger = req.logger ?? new E2ELogger(
    join(req.sessionRoot, ".refactor", "e2e"),
    req.sessionId,
  );
  // Mirror every AI session transcript (tool calls, subagent text, results)
  // under the run dir so slow runs can be analyzed at full fidelity without
  // raising the run.jsonl log level. One adapter per run; the SDK key is
  // {projectKey, sessionId} so each session lands in its own file.
  // ← B 方案新增：会话转录镜像器。run.jsonl 是"分级摘要"，这里是"全量原声"——
  //    排查一次 30 分钟的 test-writer 会话时，只有全量转录才看得清 AI 到底干了什么
  const sessionStore = new FileSessionStore(logger.runDir);
  let analysis: AnalysisResult | null = null;
  let declared: DeclaredAgentResolution | null = null;      // ← 旧版这里是 `workflows: ResolvedWorkflows | null`
  let verification: WorkflowVerificationOutcome | null = null;
  let refactorSummary = "";
  let scopeDenials: string[] = [];
  let worktrees: WorktreePair | null = null;

  try {
    // ── 路段 1：PREFLIGHT（纯程序测量：机器上有什么编译器/工具，这是什么 C 项目）──
    logger.phase("PREFLIGHT");
    // ← timed(...) 是本文件新增的小工具：包一层计时，阶段耗时写进日志（见下方定义）
    const host = timed(logger, "host probe", () => {
      // ← probeHost：探测平台/编译器/cmake/ctest 等工具可用性，结果是一个 HostPreflight
      const probed = probeHost(req.repoPath);
      // ← 探测结果既是 artifact（持久化+状态机要吃）也是日志证据
      store.saveHostPreflight(probed);
      logger.artifact("host-preflight.json", probed);
      return probed;
    });
    const project = timed(logger, "project detection", () => {
      // ← detectCProject：识别构建体系（cmake/make/…）、源文件清单；status 不是 ready 就别往下走
      const detected = detectCProject(req.repoPath, host);
      store.saveProjectDetection(detected);
      logger.artifact("project-detection.json", detected);
      return detected;
    });
    logger.info("C project preflight completed", {
      status: project.status,
      primary_build_system: project.primary_build_system,
      adapter: project.adapter,
      source_file_count: project.source_files.length,
    });
    // ← fail-closed：项目根本没法构建/识别不出构建体系，直接 abort，后面一步都不跑
    if (project.status !== "ready") {
      abort(orch, logger, `project build detection blocked: ${project.reason}`);
      return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
    }

    // ── 路段 2：ANALYSIS（B 方案改成宿主侧探测，不开模型会话）───────────────
    // 🔗 旧版这里是 `await analyzeRepo(...)`（Claude 分析会话，产出 contract/deps/tests）；
    //    现在 analyzeRepo 是同步纯函数：只算"允许改哪些文件 + 一份探测报告"。
    logger.phase("ANALYSIS");
    analysis = timed(logger, "host-side analysis probe", () =>
      analyzeRepo({
        repoDir: req.repoPath,
        taskContext: req.task,
        host,
        project,
        // ← 宿主策略直接成为修改范围（宿主策略优先，AI 没有讨价还价的空间）
        allowedEditableFiles: req.allowedEditableFiles,
      }),
    );
    logger.artifact("analysis-report.txt", { report: analysis.report });
    logger.info("project probed; modification scope derived from host policy", {
      editable_files: analysis.scope.editable_files.map((target) => target.file),
    });

    // ── 路段 3：WORKFLOW_SESSION（B 方案的核心新阶段，替代旧 WORKFLOW_RESOLUTION）──
    // 🔗 这一段对应设计文档第 3 节的第 1~3 步：开 test-writer 会话 → 它自主
    //    inspect /（派 build-writer → generate）→ declareDependency → Write test workflow；
    //    会话结束后宿主校验"test 文件产出 + 声明集存在"，缺了就判失败。
    logger.phase("WORKFLOW_SESSION");
    logger.info("running test-writer session (declare build deps, author TestWorkflow)");
    // ← 心跳：会话可能跑几十分钟，每 5 秒写一条心跳证明"还活着，不是卡死"
    logger.startHeartbeat(5_000);
    const sessionStarted = performance.now();      // ← performance.now()：毫秒精度的计时起点
    try {
      declared = await runDeclaredResolution({
        repoDir: req.repoPath,
        sessionRoot: store.sessionDir,
        sessionId: req.sessionId,
        task: req.task,
        host,
        project,
        logger,
        sessionStore,
        enforceScope: req.enforceScope,   // ← 透传范围开关给 test-writer 会话
        workflowTimeoutMs: req.workflowTimeoutMs,
      });
    } finally {
      // ← finally 保证哪怕会话抛异常，心跳也会被停掉（否则日志会一直跳）
      logger.stopHeartbeat();
    }
    logger.info("test-writer session wall time", { duration_ms: Math.round(performance.now() - sessionStarted) });
    // ← 三个 artifact 就是本阶段的"交付物清单"：声明集、test 决议、test 源码
    logger.artifact("declared-build-set.json", declared.declaredSet);
    logger.artifact("workflow-resolution-test.json", declared.testResolution);
    // ⚠️ 这行想"把 test workflow 源码当 artifact 记下来"，但 testSource 是 TypeScript 源码
    //    文本（见 runDeclaredResolution 里的 readFileSync），JSON.parse 只认 JSON——
    // testSource is TypeScript source, not JSON — store it as text for audit.
    // ↑ ★ 新版：testSource 是 TypeScript 源码而不是 JSON——按文本对象存档用于审计
    //   （旧版强行 JSON.parse 源码，源文件一非空就必然抛错，这是改版修掉的坑）。
    logger.artifact("test-workflow.json", { kind: "test-workflow-source", source: declared.testSource });
    logger.info("declared build set resolved", {
      build_count: declared.declaredSet.builds.length,   // ← 声明了几个 build（N≥0，e2e 里 ≥1 才能继续）
      test_entry: declared.testResolution.entry,
      test_id: declared.workflowId,
    });

    // ── 路段 4：WORKTREES（给"改之前的基线"和"改之后的候选"各开一份隔离目录）──
    // ← resolveHead：当前 HEAD 的 commit 号，作为对比的起点（base）
    const baseSha = resolveHead(req.repoPath);
    // ← 每场 run 一个自己的分支，方便事后翻看候选改了什么
    const branch = `refactor/agent-${req.sessionId}`;
    worktrees = timed(logger, "branch + worktree creation", () => {
      // ← git branch <name> <baseSha>：先把分支钉在 base 上，再开两个 worktree
      gitIn(req.repoPath, ["branch", branch, baseSha]);
      return createWorktrees(req.repoPath, store.sessionDir, branch, baseSha);
    });
    logger.info("isolated baseline and candidate worktrees created", {
      base_sha: baseSha,
      branch,
      baseline_dir: worktrees.baselineDir,
      candidate_dir: worktrees.candidateDir,
    });

    // ── 路段 5：REFACTOR（唯一的"改代码"环节，只允许碰 candidate）──────────
    logger.phase("REFACTOR");
    // ← 取个新名字只是为了让 TS 知道 analysis 此时非空（上面已经赋过值）
    const analysisNow = analysis;
    // ⚠️ `editable` 算出来后在本文件里没有被再使用（范围校验已前移到 analyzeRepo 内部），
    //    属于改版留下的痕迹，读的时候不必纠结它的去向。
    const editable = analysisNow.scope.editable_files.map((target) => target.file);
    const refactor = await timedAsync(logger, "refactor agent session", () =>
      // ← runRefactor：重构 agent 会话，只允许在 candidateDir 里改 scope 允许的文件
      runRefactor(worktrees!.candidateDir, req.task, analysisNow.scope, {
        logger,
        sessionStore,
      }),
    );
    refactorSummary = refactor.summary;
    scopeDenials = refactor.denials;      // ← agent 想越权写被拒绝的记录，保留作证据
    logger.artifact("refactor-summary.json", {
      summary: refactor.summary,
      scope_denials: refactor.denials,
    });
    logger.info("Claude refactor agent completed", {
      scope_denial_count: refactor.denials.length,
    });

    // ← git status --porcelain：机器可读的"有没有改动"。空 = agent 什么都没改 → abort
    const status = gitIn(worktrees.candidateDir, ["status", "--porcelain"]);
    if (status.trim().length === 0) {
      abort(orch, logger, "refactor agent made no changes");
      return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
    }
    gitIn(worktrees.candidateDir, ["add", "-A"]);      // ← 把所有改动（含新文件）放进暂存区
    // ← commit message 用 agent 总结的第一行，截到 200 字符；没有总结就退回用任务原文
    const summaryLine = firstSummaryLine(refactor.summary) ?? req.task;
    gitIn(worktrees.candidateDir, ["commit", "-m", summaryLine.slice(0, 200)]);
    // ← 相对 base 的改动文件清单（patch-record 要用）
    const changedFiles = gitIn(worktrees.candidateDir, [
      "diff",
      "--name-only",
      `${baseSha}..HEAD`,
    ])
      .split(/\r?\n/)                                  // ← 兼容 Windows 的 \r\n 与 Unix 的 \n
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    logger.artifact("patch-candidate.json", {
      branch,
      commit_sha: gitIn(worktrees.candidateDir, ["rev-parse", "HEAD"]),
      base_commit_sha: baseSha,
      changed_files: changedFiles,
      summary: summaryLine.slice(0, 500),
    });

    // ── 路段 6：VERIFICATION（验证半场，实现在 workflow-pipeline.ts）────────
    logger.phase("VERIFICATION");
    // ← 二道防线：声明集没拿到 / 一个 build 都没声明 → abort（fail-closed）。
    //    注意与 workflow-pipeline.ts 里 executeBuildList 对空集"直接跳过"的宽容不同：
    //    本文件把这视为不可接受的状态，空集根本进不了验证阶段。
    if (declared === null || declared.buildResolutions.length === 0) {
      abort(orch, logger, "declared workflow resolution missing or empty build set");
      return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
    }
    // ← 旧版单 build 字段如今只填"第一个" build：状态机旧字段还要吃一份 resolution，
    //    真正的 N 个 build 走 declaredBuilds 传下去
    const firstBuild = declared.buildResolutions[0]!;   // ← `!`：TS 的非空断言，告诉编译器"这里不是 undefined"
    logger.info("workflow verification started", { phase_detail: "all builds + ctest both sides" });
    const verificationStarted = performance.now();
    verification = await runWorkflowVerification({
      repoPath: req.repoPath,
      worktrees,
      store,
      logger,
      host,
      project,
      // ↓ 契约/依赖/测试三张"表格"全部换成宿主造的占位（见文件底部 defaultContract 等）
      contract: defaultContract(),
      scope: analysis.scope,
      deps: defaultDeps(),
      tests: defaultTests(),
      // Declared mode: DeclaredBuildSet artifact + declared test resolution
      // replace the legacy single build resolution in the state machine.
      // ← 下面这个 buildResolution 是宿主手工捏的"声明制占位决议"：mode 是 declared、
      //    workflow_id 是 declared-set、build_workflow 为 null。状态机在 TESTS_READY
      //    仍要求先收到一份 build 侧决议才让走，但它已不代表某个具体 build 文件
      buildResolution: {
        kind: "workflow-resolution",
        version: 1,
        workflow_kind: "build",
        mode: "declared",
        workflow_id: "declared-set",
        workflow_revision: 1,
        build_workflow: null,
        entry_root: "workspace",
        root_path: req.repoPath,
        entry: "declared-build-set",
        // ← 审计字段：记录的是整份声明集的哈希，不是某个文件的哈希
        source_hash: declared.declaredSet.source_hash,
        candidate_entries: [],
        reason: "declared build set",
      },
      // ← test 侧决议同样是"declared 模式"的占位（见 declaredResolutionArtifact）
      testResolution: declaredResolutionArtifact(declared),
      build: firstBuild,
      // ← 自驱动 test workflow 的决议（workflow === null 时走 expectation 差分路径）
      test: declared.testResolution,
      // ← 关键的两个新字段：声明集本身 + 按声明顺序的 N 个 build 决议
      declaredSet: declared.declaredSet,
      declaredBuilds: declared.buildResolutions,
      patch: {
        branch,
        commit_sha: gitIn(worktrees.candidateDir, ["rev-parse", "HEAD"]),
        changed_files: changedFiles,
        summary: summaryLine.slice(0, 500),
      },
      buildTimeoutMs: req.buildTimeoutMs,
      ctestTimeoutMs: req.ctestTimeoutMs,
      knownEnvironmentPatterns: req.knownEnvironmentPatterns,
    });
    logger.info("workflow verification completed", { duration_ms: Math.round(performance.now() - verificationStarted) });
    return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
  } catch (error) {
    // ← 任何一处抛异常（包括 AI 会话失败、git 失败、上面那个 JSON.parse）都到这：
    //    记日志 + 状态机 abort，然后照样返回完整结果对象
    const reason = errorMessage(error);
    abort(orch, logger, reason);
    return result(store, logger, analysis, declared, verification, refactorSummary, scopeDenials);
  } finally {
    // ← 无论成败都要删掉两个 worktree（磁盘不留给垃圾；要证据看 artifacts/logs）
    timed(logger, "worktree cleanup", () => {
      worktrees?.cleanup();
    });
    // ← 收尾：按终态写不同的收尾记录。ACCEPTED 额外做"入库"——把本次现写的
    //    run-local build 提升进持久库并写 alias（B 方案第 5 节：别名/持久化）
    if (store.state === "ACCEPTED") {
      await promoteRunLocalBuilds(declared, req.repoPath, logger);
      logger.finish("accepted", "workflow verification accepted candidate");
    }
    else if (store.state === "REJECTED") logger.finish("rejected", "workflow verification rejected candidate");
    else if (store.state === "ABORTED") logger.finish("aborted", "workflow verification aborted");
    logger.close();
  }
}
// ── enforceEditablePolicy：旧版遗留的"范围一致性校验" ─────────────────
// 【作用】检查分析阶段声明的 editable 文件集合与宿主策略是否完全一致（多/少都不行）。
// 【关系】⚠️ B 方案改版后**本文件里已经没有任何调用点**：范围现在由 analyzeRepo 直接
//    采纳宿主策略生成（宿主策略优先），这个"事后校验"就被架空了。函数仍保留在源码里。
function enforceEditablePolicy(
  analysis: AnalysisResult,
  allowed: readonly string[] | undefined,
): void {
  // ← `undefined` 表示调用方没设策略，那就没得比，直接放行
  if (allowed === undefined) return;
  const declared = analysis.scope.editable_files.map((target) => target.file);
  // ← outside：AI 声明了但策略不允许的；missing：策略允许但 AI 没声明的
  const outside = declared.filter((file) => !allowed.includes(file));
  const missing = allowed.filter((file) => !declared.includes(file));
  if (outside.length > 0 || missing.length > 0) {
    throw new Error(
      `analysis editable scope does not match host policy: ` +
      `outside=[${outside.join(", ")}] missing=[${missing.join(", ")}]`,
    );
  }
}

// ── abort：记一条 error 日志 + 把状态机推到 ABORTED ──────────────────
function abort(orch: Orchestrator, logger: E2ELogger, reason: string): void {
  logger.error(reason);
  orch.abort(reason);
}

// ── result：把"跑到哪一步了"打包成返回值 ────────────────────────────
// 【作用】所有出口（正常/abort/异常）都调它，保证返回值结构永远完整。
// 【语法】参数里那些 `X | null` 正是"可能还没跑到"的中间产物。
function result(
  store: SessionStore,
  logger: E2ELogger,
  analysis: AnalysisResult | null,
  declared: DeclaredAgentResolution | null,
  verification: WorkflowVerificationOutcome | null,
  refactorSummary: string,
  scopeDenials: string[],
): AgentWorkflowPipelineResult {
  return {
    store,
    state: store.state,          // ← 终态由状态机说了算，这里只是照抄
    refactorSummary,
    scopeDenials,
    analysis,
    declared,
    verification,
    logDir: logger.runDir,
  };
}

/** First non-empty line of an agent summary, used as the commit subject. */
// ← 找 agent 总结里第一行非空文本，用作 git commit 的标题
function firstSummaryLine(summary: string): string | null {
  // ← split 按行切开 → find 找第一条 trim 后非空的行；找不到就是 null（?? 兜底在调用处）
  return summary.split(/\r?\n/).find((line) => line.trim().length > 0) ?? null;
}

/** Time one host-side stage; logs completion at info with duration_ms. */
// ── timed / timedAsync：B 方案新增的两个计时包装器 ───────────────────
// 【作用】把任意一段（同步/异步）宿主工作包起来，结束后写一条"XX completed, duration_ms"。
// 【语法】<R> 是泛型：传进去什么类型，返回来还是什么类型，调用处不需要转型。
function timed<R>(logger: E2ELogger, what: string, fn: () => R): R {
  const started = performance.now();
  const value = fn();
  logger.info(`${what} completed`, { duration_ms: Math.round(performance.now() - started) });
  return value;
}

// ← 异步版：fn 返回 Promise，所以要 await；其余完全一样
async function timedAsync<T>(logger: E2ELogger, what: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await fn();
  logger.info(`${what} completed`, { duration_ms: Math.round(performance.now() - started) });
  return value;
}

// ── gitIn：在指定目录里同步跑一条 git 命令 ──────────────────────────
// 【参数】dir：工作目录；args：git 子命令与参数（如 ["add", "-A"]）。
// 【返回】stdout（去首尾空白）。失败（非 0 退出码）直接抛异常 → 外层 catch → abort。
function gitIn(dir: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",      // ← 让 stdout/stderr 是字符串而不是 Buffer
    shell: false,          // ← 不经过 shell，参数不会被解释/注入
    windowsHide: true,     // ← Windows 上不弹黑窗
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

// ← Error 对象取 .message；其他类型（字符串、被 throw 的任意值）转成字符串
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hash the ordered declaration (id:entry) for the artifact audit field. */
// ── declaredSetHash：给"整份声明"算一个稳定哈希 ─────────────────────
// 【作用】把每个 build 的 `id:entry` 按声明顺序喂进 SHA-256，得到声明集的审计哈希。
// 【为什么重要】DeclaredBuildSet.source_hash 就是它 —— 事后审计能发现"声明被换过"。
// 【语法】参数类型是"匿名对象数组"的内联写法：只要对象有 id 和 entry 两个字段就能传进来。
function declaredSetHash(builds: readonly { id: string; entry: string }[]): string {
  const h = createHash("sha256");
  for (const b of builds) h.update(`${b.id}:${b.entry}\n`);   // ← 一行一条，顺序敏感
  return h.digest("hex");       // ← digest：输出最终的十六进制哈希串
}

/**
 * Run the test-writer session, resolve every declared build, and assemble the
 * DeclaredAgentResolution consumed by the verification stage.
 */
// ── runDeclaredResolution：WORKFLOW_SESSION 阶段的宿主侧实现 ─────────
// 【作用】三步走：① 开 test-writer 会话（AI 自主声明依赖 + 写 test workflow）；
//        ② 把声明里的每个 id 解析成真实源文件路径（fail-closed）；
//        ③ 调 resolveDeclaredWorkflows 出 N 个 build 决议 + test 决议，打包返回。
// 【参数】options：一个内联类型（不单独声明 interface）—— 只在本文件用一次的选项包。
// 【返回】DeclaredAgentResolution。
// 【关系】上游是 runAgentWorkflowVerification 的 WORKFLOW_SESSION 阶段；下游依次是
//        runWorkflowSession（agents/workflow-session.ts）→ LocalDependencyRegistry →
//        resolveDeclaredWorkflows（workflow/resolve-declared.ts）。
// 🔗 与设计文档第 3 节一一对应：会话收声明集 → 解析声明集每个 id（缺失 fail-closed）。
async function runDeclaredResolution(options: {
  readonly repoDir: string;
  readonly sessionRoot: string;
  readonly sessionId: string;
  readonly task: string;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly logger: E2ELogger;
  readonly sessionStore: FileSessionStore;
  readonly enforceScope?: boolean;   // ★ 新增：透传范围开关（false = 会话内跳过 PreToolUse 拦截）
  readonly workflowTimeoutMs?: number;
}): Promise<DeclaredAgentResolution> {
  // ← test workflow 必须被写到这个固定位置：.refactor/runs/<sessionId>/workflows/test/
  //   （editableFiles 只放行这一个文件，test-writer 写别处都会被 scope hook 拒绝）
  const testRelDir = join(".refactor", "runs", options.sessionId, "workflows", "test");
  const testEntry = join(options.repoDir, testRelDir, "test-workflow.ts");
  // ① 开会话：注入 dep-registry MCP 三工具 + build-writer 子代理 + workflow-spec skill
  const session = await runWorkflowSession({
    repoDir: options.repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    task: options.task,
    testEntry,
    host: options.host,
    project: options.project,
    logger: options.logger,
    sessionStore: options.sessionStore,
    enforceScope: options.enforceScope,   // ★ 透传给 test-writer 会话
    timeoutMs: options.workflowTimeoutMs,
  });
  // ← 会话失败（超时 / 没产出 test 文件 / 没调 declareDependency）就抛异常 → abort。
  //   🔗 这正是"收会话校验，缺了打回/判负"里"判负"的那条路径
  if (!session.ok) {
    throw new Error(
      `test-writer session failed: ${session.failure ?? "unknown"}${session.summary.length > 0 ? ` — ${session.summary.slice(0, 400)}` : ""}`,
    );
  }
  options.logger.info("test-writer session completed", {
    declared_builds: session.declaredBuilds.join(", "),   // ← 最终生效的声明集（id 列表）
    summary: session.summary.slice(0, 200),
  });

  // Rebuild the registry (run-local files restored from disk) to resolve
  // declared build ids to their workflow entries.
  // ② 重建一个注册表实例：会话里那个实例在会话进程内，这里新 new 一个，构造函数会
  //   从磁盘把 run-local 目录里的 .ts 文件"找回"（restoreRunLocal），所以本次现写的
  //   build 也能按 id 查到
  const registry = new LocalDependencyRegistry({
    workspaceRoot: options.repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    host: options.host,
    project: options.project,
  });
  const buildSources: { id: string; entry: string; runLocal: boolean }[] = [];
  // ← 按声明顺序逐个解析：run-local（本次生成的文件）优先，其次持久库
  for (const id of session.declaredBuilds) {
    const resolved = await registry.resolveBuildEntry(id);
    // ← fail-closed：声明了一个谁也不认识的 id → 整场 run 失败，绝不"跳过继续"
    if (resolved === null) {
      throw new Error(`declared build workflow '${id}' cannot be resolved to a source`);
    }
    buildSources.push({ id, entry: resolved.entry, runLocal: resolved.runLocal });
  }

  // ③ 声明集驱动 resolve：每个 build 出一份 resolution，test 也出一份
  const resolved = await resolveDeclaredWorkflows({
    workspaceRoot: options.repoDir,
    entryRoot: options.repoDir,
    host: options.host,
    project: options.project,
    testEntry,
    // ← 宿主给本次会话产物分配的"身份"：id 带 sessionId、revision 固定 1
    testWorkflowId: `test-${options.sessionId}`,
    testRevision: 1,
    builds: buildSources.map((b) => ({ id: b.id, entry: b.entry, runLocal: b.runLocal })),
  });

  // ← 把 test 源码读成字符串（文件没写出来就是空串；上面 session.ok 已保证它存在）
  const testSource = existsSync(testEntry) ? readFileSync(testEntry, "utf8") : "";
  // ← 组装 DeclaredBuildSet artifact：这是"整份声明"的唯一凭证（B 方案第 2 节）
  const declaredSet: DeclaredBuildSetValue = {
    kind: "declared-build-set",
    version: 1,
    test_workflow_id: `test-${options.sessionId}`,
    test_workflow_revision: 1,
    builds: buildSources.map((b) => ({
      id: b.id,
      // ← 产物里统一存"相对 repo 的正斜杠路径"：跨平台可复现
      entry: relative(options.repoDir, b.entry).split("\\").join("/"),
      // ← run-local 的文件没有 manifest，直接算文件哈希；库里的 build 用 resolution 里
      //   已经算好的那份（sourceHash）
      source_hash: b.runLocal ? sha256File(b.entry) : resolved.builds.find((r) => r.id === b.id)?.resolution.sourceHash ?? "",
      run_local: b.runLocal,
    })),
    source_hash: declaredSetHash(buildSources),   // ← 整份声明（顺序敏感）的哈希
  };

  return {
    declaredSet,
    testResolution: resolved.test,
    buildResolutions: resolved.builds.map((b) => b.resolution),
    testSource,
    workflowId: `test-${options.sessionId}`,
    workflowRevision: 1,
  };
}

// ── sha256File：把一个文件的内容算成 SHA-256 十六进制串 ──────────────
// 【用途】run-local build 源码没有 manifest，声明集里就用"文件内容哈希"当身份指纹
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex");
}

/** Test workflow-resolution artifact (declared mode, no single build ref). */
// ── declaredResolutionArtifact：给状态机造一份"declared 模式"的 test 决议 ──
// 【作用】状态机在 BUILD_WORKFLOW_READY 这一步仍要求收到 kind 为 workflow-resolution 且
//        workflow_kind 为 test 的 artifact；声明制下没有"单个 build 引用"，所以宿主
//        手工捏一份占位：build_workflow 为 null，root_path/entry 都指向 test 源文件。
// 【语法】`relative(a, a).length === 0`：用"自己相对自己是空串"判断路径就是入口本身，
//        这时给个可读的占位名 "test-workflow"，避免 artifact 里出现空字符串路径。
function declaredResolutionArtifact(declared: DeclaredAgentResolution): WorkflowResolution {
  return {
    kind: "workflow-resolution",
    version: 1,
    workflow_kind: "test",
    mode: "declared",
    workflow_id: declared.workflowId,
    workflow_revision: declared.workflowRevision,
    build_workflow: null,           // ← 声明制：test 不再绑死某一个 build（N 个 build 在声明集里）
    entry_root: "workspace",
    root_path: declared.testResolution.entry,
    entry: relative(declared.testResolution.entry, declared.testResolution.entry).length === 0
      ? "test-workflow"
      : declared.testResolution.entry,
    source_hash: declared.testResolution.sourceHash,
    candidate_entries: [],
    reason: "declared test workflow",
  };
}

/** Promote run-local build workflows to the library after an accepted run. */
// ── promoteRunLocalBuilds：验收通过后把"本次现写的 build"收进持久库 ────
// 【作用】遍历声明集里的 build：只处理 run_local === true 的；逐个调 curator 入库，
//        并在 alias.json 里写下 run-local id → 稳定库 id 的映射。
// 【关系】只在 finally 里 state === ACCEPTED 时被调用（失败的 build 不配进库）。
// 🔗 对应 docs/b-subagent-workflow.md 第 5 节（别名/持久化）与实现计划步骤 7。
// ⚠️ 单个 build 入库失败只 warn 不抛异常：入库是"锦上添花"，不能让一场已被接受的 run 翻车。
async function promoteRunLocalBuilds(
  declared: DeclaredAgentResolution | null,
  repoRoot: string,
  logger: E2ELogger,
): Promise<void> {
  if (declared === null) return;
  // ← 先读一次现有别名表：库里已有的就不再重复提升（幂等）
  const existingAliases = loadAliases(repoRoot).aliases;
  for (const build of declared.declaredSet.builds) {
    if (!build.run_local) continue;              // ← 库里本来就有的 build，跳过
    if (existingAliases[build.id] !== undefined) continue; // already promoted
    const entry = join(repoRoot, build.entry);
    if (!existsSync(entry)) {
      logger.warn(`run-local build source missing, skip promotion: ${build.entry}`);
      continue;
    }
    try {
      // ← 描述信息存在源文件旁边的 .description.json 边车里（generate 时写下的）
      const description = readDescriptionSidecar(entry);
      const result = await curateBuildWorkflow({
        repoRoot,
        entry,
        runLocalId: build.id,
        description,
      });
      logger.info(`promoted run-local build '${build.id}' -> '${result.libraryId}'`, {
        library_id: result.libraryId,
        revision: result.revision,
      });
    } catch (error) {
      logger.warn(`promotion failed for '${build.id}': ${errorMessage(error)}`);
    }
  }
}

// ── readDescriptionSidecar：读 build 源码旁边的描述边车文件 ──────────
// 【边车文件】<entry>.description.json，内容形如 {"name": "...", "description": "..."}
// 【语法】try { ... } catch { ... }：catch 不带参数表示"不在乎错在哪，一律当没有"。
function readDescriptionSidecar(entry: string): string {
  try {
    const parsed = JSON.parse(readFileSync(`${entry}.description.json`, "utf8")) as {
      description?: string;
    };
    return parsed.description ?? "";
  } catch {
    return "";       // ← 文件不存在/不是 JSON 都返回空描述，不影响入库
  }
}

/**
 * Host-constructed default proposal artifacts. In the declared-mode flow the
 * behavior contract, dependency list and test spec are decided inside the
 * AI sessions (test workflow declares expectations; the build/test workflows
 * self-drive). The state machine still requires these artifacts to advance
 * INIT → CONTRACT_READY → SCOPE_READY → DEPENDENCY_READY → TESTS_READY, so the
 * host submits minimal, semantically-neutral placeholders that carry no
 * verification meaning — the real gate is the DeclaredBuildSet + expectation
 * diff that follows.
 */
// ── defaultContract / defaultDeps / defaultTests：三张"占位表格" ─────
// 【作用】状态机要求按顺序吃进 behavior-contract → scope-manifest → dependency-manifest →
//        test-spec 才能走到 TESTS_READY；声明制下这三样东西的"真决策"都在 AI 会话里
//        （期望由 test workflow 声明，build/test workflow 自驱动），所以宿主只交
//        **语义中性**的占位：所有通道都是 ignore、唯一依赖是"没声明"、唯一测试用例是
//        "self-driven 差分"。它们不承担任何验证含义 —— 真正的关卡是后面的
//        DeclaredBuildSet + 期望差分。
// 🔗 "宿主零产物知识"：宿主不解释行为，只负责执行与对比。
function defaultContract(): BehaviorContract {
  // ← mode: "ignore" 表示"这个通道不设约束"（exit code / 信号 / stdout / stderr / 文件全忽略）
  const ignore = { mode: "ignore" as const };
  return {
    kind: "behavior-contract",
    version: 1,
    channels: {
      exit_code: ignore,
      signals: ignore,
      stdout: ignore,
      stderr: ignore,
      filesystem: ignore,
    },
    // ← 允许改动内部结构、允许执行时间变化 —— 这正是"行为保持型重构"的容忍面
    allowed_change: { internal_structure: true, execution_time: true },
    notes: ["host-derived placeholder: expectations are declared by the test workflow"],
  };
}

function defaultDeps(): DependencyManifest {
  return {
    kind: "dependency-manifest",
    version: 1,
    dependencies: [
      {
        name: "none-declared",
        kind: "time",        // ← 依赖类型选一个"中性"的（时间），策略是 reject：不引入时间依赖
        strategy: "reject",
        evidence: [],
        notes: "host-derived placeholder: no static dependency analysis in declared mode",
      },
    ],
  };
}

function defaultTests(): TestSpec {
  return {
    kind: "test-spec",
    version: 1,
    cases: [
      {
        id: "self-driven",   // ← 占位用例名：真正的测试逻辑在自驱动 test workflow 里
        kind: "differential",// ← 差分式：baseline 与 candidate 各跑一遍再对比
        argv: [],            // ← 不实际执行任何命令（自驱动路径不用这份 spec 的 argv）
        stdin: "",
        fixtures: [],
      },
    ],
  };
}
