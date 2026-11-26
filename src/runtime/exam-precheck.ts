import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import type { Limits } from "../config/limits.js";
import type { BuildWorkflowResolution } from "../workflow/build-workflow.js";
import type { TestWorkflowResolution } from "../workflow/test-workflow.js";
import type { ExpectationDeclaration } from "../workflow/types.js";
import type { VerificationMaterial } from "../workflow/verification-materials.js";
import { baselineSelfMatch } from "../workflow/expectation-compare.js";
import { StageFailureError } from "./stage-failure.js";
import type { E2ELogger } from "./e2e-log.js";
import { applyInjections, type InjectionSpec } from "./inject.js";
import { VerificationIntegrity } from "./verification-integrity.js";
import { executeBuildFor, runObservedTest, type SideExecutionRequest } from "./workflow-side.js";

/**
 * exam-precheck — 重构之前的考卷预演。
 *
 * 出卷完成后，先在 **未经改动的原版代码**（一个临时 detached worktree）上
 * 完整执行一遍考卷：写入辅助材料与注入文件、构建全部声明方案、运行测试
 * 工作流，并检查考卷自己的 both-matches 断言是否与基线观测自洽
 * （考卷自违 = 期望值与事实矛盾）。
 *
 * 目的：把考卷缺陷挡在重构之前——构建方案写歪、测试脚本报错、冻结值写错，
 * 这些都与候选代码无关；提前发现即可交给对应的修复通道，而不是让重构
 * 烧完时间才发现"考卷把原版自己都判了不合格"。
 *
 * 预检不提交任何验证工件、不进状态机；失败以 StageFailureError 携带结构化
 * 归因抛出，由反馈路由器决定修复通道。
 */

export interface ExamPrecheckOptions {
  readonly repoPath: string;
  readonly host: HostPreflight;
  readonly project: ProjectDetection;
  readonly limits: Limits;
  readonly logger?: E2ELogger;
  /** 与声明集一一对应的构建方案（id 用声明集里的 id，供归因/简报定位）。 */
  readonly builds: readonly { readonly id: string; readonly resolution: BuildWorkflowResolution }[];
  readonly test: TestWorkflowResolution;
  /** 声明的辅助材料：与真实验证一致地写进预检树（否则读材料的考卷会误报）。 */
  readonly materials?: readonly VerificationMaterial[];
  /** `--inject` 判例材料：与真实验证一致地注入预检树（候选提交前的等价物）。 */
  readonly injections?: readonly InjectionSpec[];
}

/** 在临时 worktree 上执行基线构建与考卷；返回考卷自违的声明名清单。 */
export async function precheckDeclaredExam(options: ExamPrecheckOptions): Promise<{ selfViolations: readonly string[] }> {
  const root = mkdtempSync(join(tmpdir(), "rfr-exam-precheck-"));
  const worktree = join(root, "tree");
  let outcome: { selfViolations: readonly string[] } | null = null;
  let failure: unknown = null;
  try {
    const added = spawnSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
      cwd: options.repoPath,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (added.status !== 0) {
      throw new StageFailureError(
        `exam precheck could not create the pristine worktree: ${(added.stderr ?? "").trim() || `git exited ${String(added.status)}`}`,
        { category: "internal", component: "exam-precheck", retryable: false },
      );
    }
    // 与真实验证同等的输入面：注入文件先落地，再由 VerificationIntegrity
    // 按真实路径守卫写入辅助材料（拒绝覆盖 tracked 文件、拒绝经 symlink/
    // junction 写出树外）。预检树被恶意来源写坏也不影响仓库。
    let injectedFiles: { path: string; sha256: string }[] = [];
    if (options.injections !== undefined && options.injections.length > 0) {
      const reports = applyInjections([worktree], options.injections);
      injectedFiles = reports.flatMap((report) => report.files.map((file) => ({ path: file.path, sha256: file.sha256 })));
    }
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    }).stdout.trim();
    const integrity = new VerificationIntegrity({
      originalRepo: worktree,
      worktrees: [{ root: worktree, commit: head }],
      workflows: [
        ...options.builds.map((build) => ({ entry: build.resolution.entry, sourceHash: build.resolution.sourceHash })),
        { entry: options.test.entry, sourceHash: options.test.sourceHash },
      ],
      materials: options.materials ?? [],
      injectedFiles,
    });
    const request: SideExecutionRequest = {
      host: options.host,
      project: options.project,
      test: options.test,
      limits: options.limits,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      // 复用真实验证的完整性守卫：构建/测试期间 tracked 文件或材料被改动
      // 即失败（与 verify 段同一标准）。
      integrity,
    };
    for (const [index, build] of options.builds.entries()) {
      const execution = await executeBuildFor(
        request,
        build.resolution,
        worktree,
        "baseline",
        `precheck-build-${String(index + 1)}-${build.id.replace(/[^A-Za-z0-9._-]/g, "_")}`,
        build.id,
      );
      if (execution.status !== "pass") {
        throw new StageFailureError(
          `exam precheck: baseline build ${build.id} failed before any refactoring: ${execution.failure ?? execution.status}`,
          {
            category: "build",
            component: "build-workflow:baseline",
            retryable: true,
            detail: { build_id: build.id, precheck: true },
          },
        );
      }
    }
    const run = await runObservedTest(request, worktree, "baseline");
    if (run.status !== "pass") {
      throw new StageFailureError(
        `exam precheck: the test workflow failed on the pristine tree before any refactoring: ${run.failure ?? run.status}`,
        {
          category: "test",
          component: "test-workflow:baseline",
          retryable: true,
          detail: { precheck: true },
        },
      );
    }
    const selfViolations = (run.expectations as readonly ExpectationDeclaration[])
      .filter((declaration) => baselineSelfMatch(declaration) === false)
      .map((declaration) => declaration.name);
    if (selfViolations.length > 0) {
      throw new StageFailureError(
        `exam precheck: the pristine tree violates the exam's own both-matches expectation(s): ${selfViolations.join(", ")} — the exam's expected values contradict the baseline`,
        {
          category: "test",
          component: "test-workflow:baseline",
          retryable: true,
          detail: { precheck: true, self_violations: [...selfViolations] },
        },
      );
    }
    outcome = { selfViolations };
  } catch (error) {
    failure = error;
  }
  // 清理绝不覆盖原始归因：Windows 下后台进程残留导致的 EBUSY/EPERM 只记录，
  // 不影响已经结构化的失败上报（否则修复通道会丢掉 self_violations 证据）。
  try {
    if (existsSync(worktree)) {
      spawnSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: options.repoPath,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
      spawnSync("git", ["worktree", "prune"], {
        cwd: options.repoPath,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
    }
    rmSync(root, { recursive: true, force: true });
  } catch (cleanupError) {
    options.logger?.info("exam precheck cleanup failed (ignored)", {
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
  if (failure !== null) throw failure;
  return outcome!;
}
