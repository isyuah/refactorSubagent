import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../../agents/driver.js";
import { REFACTOR_AGENT_TOOLS } from "../../agents/refactor.js";
import { LocalDependencyRegistry } from "../../agents/dep-registry.js";
import { createDependencyMcpServer } from "../../agents/dep-registry-server.js";
import { VerificationAnalysisStore } from "../../agents/verification-analysis.js";
import { FileSessionStore } from "../session-store.js";
import type { RefactorStage } from "../stage-flow.js";
import { halt } from "../stage-flow.js";
import type { RefactorTrigger, RepairEvidence } from "./types.js";

/**
 * feedback/repair — turn a routing decision into a repaired artifact.
 *
 * Phase 2 wires the refactor-dialogue continuation: the SAME SDK conversation
 * that authored the candidate receives the failure evidence and keeps editing
 * on top of its own last commit (the continuation carries the whole project
 * context, so no re-reading budget is spent). Build/test repair entries land
 * in later phases; their decisions stop honestly until then.
 */

/**
 * Compose the feedback message appended to the refactor dialogue. The message
 * carries black-box evidence only — what failed, where, and (for behavior
 * drift) the per-expectation diffs. It never describes the verifier.
 */
export function composeRefactorFeedback(
  trigger: RefactorTrigger,
  evidence: RepairEvidence,
  context: { candidateBranch: string; round: number },
): string {
  const lines: string[] = [];
  lines.push(`[第 ${String(context.round)} 轮反馈 — 系统自动追加]`);
  lines.push(
    `你的候选分支 ${context.candidateBranch} 没有通过验证。你的上一轮修改已经提交，` +
      "请在它的基础上继续修复，不要从原版重新完成整个任务。",
  );
  if (trigger === "candidate-build") {
    lines.push("失败原因：你修改后的代码编译失败（基线侧使用同一构建脚本编译成功）。");
    lines.push(`构建错误：${evidence.summary}`);
    lines.push("请修复编译错误，并保持改动最小。修完后自己先编译确认通过再结束。");
  } else if (trigger === "candidate-crash") {
    lines.push("失败原因：你修改后的程序在测试中崩溃或卡死（基线侧同一测试正常运行）。");
    lines.push(`崩溃证据：${evidence.summary}`);
    lines.push("请定位并修复崩溃，保持其余行为不变。");
  } else {
    lines.push("失败原因：两侧都运行成功，但以下可观察行为与基线不一致：");
    const mismatches = evidence.mismatches ?? [];
    if (mismatches.length > 0) {
      for (const mismatch of mismatches.slice(0, 40)) {
        lines.push(`- ${mismatch.name}：${mismatch.reason}`);
      }
      if (mismatches.length > 40) {
        lines.push(`…以及另外 ${String(mismatches.length - 40)} 条（见判决书文件）`);
      }
    } else {
      lines.push("-（比对器未给出结构化差异；请复查你改动的每一处行为的输入与输出）");
    }
    lines.push("请重新调整修改，使上面列出的每一条行为与基线完全一致；宁可少重构，也不要改变任何可观察行为。");
  }
  if (evidence.evidencePaths !== undefined && evidence.evidencePaths.length > 0) {
    lines.push(`证据文件（可读取）：${evidence.evidencePaths.join("、")}`);
  }
  return lines.join("\n");
}

/**
 * A refactor stage that CONTINUES an existing dialogue. The candidate worktree
 * is fresh from the branch (the pair is rebuilt per round), carrying the AI's
 * own last commit — the conversation's file history is relative to the same
 * content, so the model picks up where it left off. The host re-measures and
 * re-commits after the stage, exactly as for a first-round refactor.
 */
export function continuedRefactorStage(spec: {
  readonly dialogueId: string;
  readonly feedback: string;
  /** Round 1's e2e dir — the resume must read the conversation from the
   *  store it was PERSISTED to (this round's own store would not find it). */
  readonly dialogueRoot: string;
}): RefactorStage {
  return async (ctx, input) => {
    const limits = ctx.limits.sessions.refactor;
    const run = await runAgent({
      cwd: input.candidate.worktrees.candidateDir,
      prompt: spec.feedback,
      allowedTools: [...REFACTOR_AGENT_TOOLS],
      // Resume reads the stored conversation from ROUND 1's store root; the
      // continuation appends to the same durable transcript.
      sessionStore: new FileSessionStore(spec.dialogueRoot),
      resumeSessionId: spec.dialogueId,
      maxTurns: limits.maxTurns,
      model: limits.model,
      timeoutMs: limits.deadlineMs ?? undefined,
      stallTimeoutMs: limits.stallMs,
    });
    if (run.resumeMismatch === true) {
      // A fresh chat answered — that is NOT a continuation. Fail loudly: the
      // budget must not pay for a session that lost the authoring context.
      return halt(
        `refactor dialogue resume failed: the SDK answered under a different conversation id (expected ${spec.dialogueId})`,
        {
          category: "model-session",
          component: "refactor-dialogue-resume",
          retryable: false,
          detail: { expected: spec.dialogueId },
        },
      );
    }
    if (run.isError && run.result.length === 0) {
      return halt("refactor dialogue continuation failed without a summary", {
        category: "model-session",
        component: "refactor-dialogue-resume",
        retryable: true,
        detail: { is_error: true, timed_out: run.timedOut, stalled: run.stalled === true },
      });
    }
    return {
      summary: run.result,
      ...(run.sessionId !== undefined ? { dialogueId: run.sessionId } : {}),
    };
  };
}

/**
 * Feedback for the CONTINUED authoring dialogue when the exam itself errored
 * as a script (JS/machinery failure — never a behavior verdict). The exam
 * reshapes ONLY for its own bugs; behavior mismatches never reach this lane.
 */
export function composeTestScriptFeedback(
  evidence: RepairEvidence,
  context: { round: number; testEntry: string },
): string {
  const lines: string[] = [];
  lines.push(`[第 ${String(context.round)} 轮反馈 — 系统自动追加]`);
  lines.push("你编写的 TestWorkflow 在执行时自身出错了（脚本错误，不是被测程序的行为问题）。");
  lines.push(`错误证据：${evidence.summary}`);
  if (evidence.side !== undefined) {
    lines.push(`出错的一侧：${evidence.side === "baseline" ? "基线（原代码）" : "候选（新代码）"}。`);
  }
  if (evidence.evidencePaths !== undefined && evidence.evidencePaths.length > 0) {
    lines.push(`日志与证据路径（可读取）：${evidence.evidencePaths.join("、")}`);
  }
  lines.push("请修复脚本的执行错误（路径、API 用法、语法等），并保持考卷的覆盖面不缩水。");
  return lines.join("\n");
}

/**
 * Repair brief for a dedicated build-writer session (baseline-build lane).
 * Evidence-first: the session reads the provided failure facts instead of
 * re-investigating the whole project; the host executes the fixed workflow.
 */
export function composeBuildRepairBrief(evidence: RepairEvidence, context: {
  round: number;
  failedBuildId: string;
  failedBuildEntry: string;
  failedBuildSource?: string;
  expectedArtifacts?: readonly string[];
  otherSideOutcome?: string;
}): string {
  const lines: string[] = [];
  lines.push(`[第 ${String(context.round)} 轮构建方案修复任务]`);
  lines.push("一个已交付的 BuildWorkflow 执行失败了。请阅读并修复这个方案，保留其中有效的部分，不要重新调查整个项目。");
  lines.push(`失败发生在：${evidence.side === "candidate" ? "候选侧（新代码）" : "基线侧（原代码）"}。`);
  lines.push(`方案编号：${context.failedBuildId}`);
  lines.push(`方案源文件：${context.failedBuildEntry}`);
  if (context.failedBuildSource !== undefined) {
    lines.push("---- 方案当前内容 ----");
    lines.push(context.failedBuildSource);
    lines.push("---- 内容结束 ----");
  }
  lines.push(`失败原因：${evidence.summary}`);
  if (context.expectedArtifacts !== undefined && context.expectedArtifacts.length > 0) {
    lines.push(`预期产物（测试脚本依赖它们，请保持路径与接口不变）：${context.expectedArtifacts.join("、")}`);
  }
  if (context.otherSideOutcome !== undefined) {
    lines.push(`另一侧的执行结果：${context.otherSideOutcome}`);
  }
  if (evidence.evidencePaths !== undefined && evidence.evidencePaths.length > 0) {
    lines.push(`完整日志（可读取）：${evidence.evidencePaths.join("、")}`);
  }
  lines.push("要求：");
  lines.push("1. 依据上面的错误证据定位问题；确需改变产物路径或接口时，说明变化及受影响的测试。");
  lines.push("2. 通过 generateBuildWorkflow 工具提交修复后的完整方案（运行内新修订，不覆盖库里的共享方案）。");
  lines.push("3. 如确认是缺工具、权限等环境问题导致无法修复，直接报告原因与证据，不要硬修。");
  return lines.join("\n");
}

/**
 * Compose the build list for a build-repair round from the round-1
 * checkpoint: the repaired build replaces its declared slot, every other
 * declared build keeps running — shrinking the set would silently verify a
 * different contract than round 1 did.
 *
 * Mapping rules (fail-closed):
 *   - a single declared build is replaced outright (today's common case,
 *     and the shape that predates build-id attribution);
 *   - with several declared builds the failed slot is located by id
 *     (attribution first, repaired id as the fallback);
 *   - null when the repaired build cannot be mapped honestly — the caller
 *     must halt instead of guessing which slot to replace.
 */
export function mergeRepairedBuilds(
  checkpointBuilds: readonly {
    readonly id: string;
    readonly entry: string;
    readonly runLocal: boolean;
  }[],
  fixedBuild: { readonly id: string; readonly entry: string },
  failedBuildId: string | null,
): { id: string; entry: string; runLocal: boolean }[] | null {
  if (checkpointBuilds.length === 0) return null;
  const repaired: { id: string; entry: string; runLocal: boolean } = {
    id: fixedBuild.id,
    entry: fixedBuild.entry,
    runLocal: true,
  };
  if (checkpointBuilds.length === 1) return [repaired];
  const targetId = failedBuildId ?? fixedBuild.id;
  const index = checkpointBuilds.findIndex((build) => build.id === targetId);
  if (index < 0) return null;
  return checkpointBuilds.map((build, position) =>
    position === index ? repaired : { id: build.id, entry: build.entry, runLocal: build.runLocal },
  );
}

/**
 * Run the dedicated build-repair session. The session explores with the same
 * tool arrangement as the authoring build-writer and registers the fixed
 * workflow through the host's MCP registration tool. Returns the registered
 * run-local build ({id, entry}) or null when the session produced nothing.
 */
export async function runBuildWriterRepairSession(options: {
  readonly repoDir: string;
  readonly sessionRoot: string;
  readonly sessionId: string;
  readonly task: string;
  readonly host: unknown;
  readonly project: unknown;
  readonly brief: string;
  readonly logger?: Parameters<typeof runAgent>[0]["logger"];
  readonly limits?: { maxTurns?: number | null; model?: string | null; deadlineMs?: number | null; stallMs?: number | null };
}): Promise<{ id: string; entry: string } | null> {
  const buildDir = join(options.repoDir, ".refactor", "runs", options.sessionId, "workflows", "build");
  const registry = new LocalDependencyRegistry({
    workspaceRoot: options.repoDir,
    sessionRoot: options.sessionRoot,
    sessionId: options.sessionId,
    host: options.host as never,
    project: options.project as never,
  });
  const verificationAnalysis = new VerificationAnalysisStore(
    join(options.repoDir, ".refactor", "runs", options.sessionId, "workflows", "verification-analysis.json"),
    options.task,
  );
  const mcpServer = createDependencyMcpServer({ registry, verificationAnalysis });
  let run: Awaited<ReturnType<typeof runAgent>>;
  try {
    run = await runAgent({
      cwd: options.repoDir,
      prompt: options.brief,
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      extraAllowedTools: [
        "mcp__dep-registry__inspectWorkflow",
        "mcp__dep-registry__generateBuildWorkflow",
      ],
      mcpServers: { "dep-registry": mcpServer as never },
      // A fresh registry session: the repair registers a NEW run-local revision
      // under this repair session id; shared library workflows stay untouched.
      maxTurns: options.limits?.maxTurns ?? undefined,
      model: options.limits?.model ?? null,
      timeoutMs: options.limits?.deadlineMs ?? undefined,
      stallTimeoutMs: options.limits?.stallMs ?? null,
      logger: options.logger,
    });
  } finally {
    verificationAnalysis.close();
  }
  if (run.isError || run.resumeMismatch === true) return null;
  if (!existsSync(buildDir)) return null;
  const entries = readdirSync(buildDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ id: file.slice(0, -3), entry: join(buildDir, file) }))
    .sort((a, b) => a.entry.localeCompare(b.entry));
  if (entries.length === 0) return null;
  // Deterministic pick when several revisions exist: the lexicographically
  // last entry (generateBuildWorkflow appends revisions).
  return entries.at(-1)!;
}
