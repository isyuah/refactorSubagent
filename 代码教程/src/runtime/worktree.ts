/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/worktree.ts —— Worktree Manager（物理隔离）
 *
 * 【这个文件是干什么的】
 *   用 `git worktree add` 在"会话自己的目录"里另外检出两份代码：
 *     · baseline —— 检出到"改动前的那个 commit"；
 *     · candidate —— 检出到"装着重构提交的分支"。
 *   两个目录各自独立、各自有自己的构建产物，互不污染；主仓库的当前检出（你正在看的
 *   工作区）从头到尾不会被测试碰一下。
 *
 * 【在整个项目里的位置】
 *   · 新路径：src/runtime/workflow-agent-pipeline.ts 第 132 行调用 createWorktrees()
 *     （这是现在 e2e 的主路径）；workflow-pipeline.ts 只 import 了 WorktreePair 这个类型。
 *   · 旧路径：pipeline.ts 和 agent-pipeline.ts 也用它。
 *   · 也就是说：**新旧两条路径共用这一个隔离模块**。
 *
 * ⚠️【和性能的关系：为什么 e2e 永远是冷构建】
 *   每次运行都新建两个全新 worktree，运行结束（finally）就 cleanup() 删掉——
 *   所以 CMake 的 configure/build 缓存永远不存在，每一轮都要从头 configure（~22 秒）、
 *   从头全量编译（~85 秒）。这就是零基础教程"任务 8 为什么 e2e 这么慢"里点名的第 4 条
 *   "worktree 用完即焚"，也是任务 7"失败时保留现场 / 增量重跑"要改的地方：
 *   worktree.ts:59,71 的 existsSync 守卫已经保证了重入安全（目录在就不再 add），
 *   所以"失败后保留 worktree 再跑一次"在代码上是现成可行的。
 *
 * 【先修知识】
 *   · git worktree：让同一个仓库同时检出多个目录（每个目录有自己的 HEAD），不互相影响；
 *   · spawnSync（同步跑子进程）、existsSync（判断路径是否存在）、rmSync（递归删除）。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/worktree.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Worktree Manager — physical isolation of the two builds under observation.
 *
 *   <session-root>/wt-baseline/  checked out at base commit
 *   <session-root>/wt-candidate/ checked out at the refactor branch
 *
 * The orchestrator's own checkout is never touched by test runs.
 */
// ⚠️ 上面这段英文注释里的路径（wt-baseline / wt-candidate）和实际代码不一致：
//    代码里是 <session-root>/worktrees/baseline 和 /worktrees/candidate（见下方 createWorktrees）。
//    真实落盘位置也就是零基础教程 §1.6 画的 `.refactor/sessions/<id>/worktrees/{baseline,candidate}`。

// ── WorktreePair：一对 worktree 的"回执单" ───────────────────────────
// 【字段】baselineDir / candidateDir：两个 worktree 的绝对路径；
//        baseSha：baseline 检出所用的那个 commit（对比结果里要记录它，证明"比的是哪两个版本"）。
// 【方法】cleanup()：把这一对 worktree 拆掉。接口里注明了"重复调用是安全的"。
export interface WorktreePair {
  baselineDir: string;
  candidateDir: string;
  baseSha: string;
  /** Drop both worktrees (safe to call repeatedly). */
  cleanup(): void;
}

// ── git：同步执行一条 git 命令的私有小工具 ───────────────────────────
// 【作用】封装 spawnSync("git", ...)，失败就抛错，成功返回 stdout（去掉了首尾空白）。
// 【参数】repo：在哪个目录里执行（决定作用于哪个仓库）；args：git 子命令与参数；
//        what：给人看的一句话说明，出错时拼进异常信息。
// 【语法】`git ${args[0]} failed` 用的是模板字符串（反引号 + ${} 插值）。
// 【关系】createWorktrees / cleanup 的所有 git 操作都走它。
function git(repo: string, args: string[], what: string): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  // ← status !== 0 表示 git 命令失败了（比如分支不存在）。这里选择"直接抛异常"，
  //   让上层 pipeline 一次性把这次运行判为失败——典型的 fail-closed 姿态。
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} failed (${what}): ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

// ── resolveHead：当前 HEAD 的完整 SHA ───────────────────────────────
// 【作用】`git rev-parse HEAD` —— 拿到"现在停在哪个 commit"。
// 【关系】两个 pipeline 都在创建 worktree 前调它，把结果作为 baseSha 传进去。
export function resolveHead(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"], "rev-parse");
}

// ── hasBranch：某个本地分支存不存在 ─────────────────────────────────
// 【作用】用 `git show-ref --verify refs/heads/<branch>` 探测分支是否存在。
// 【返回】boolean：退出码 0 → 存在；其他 → 不存在（这里不抛错，只返回布尔）。
export function hasBranch(repo: string, branch: string): boolean {
  return (
    spawnSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
      cwd: repo,
    }).status === 0
  );
}

/**
 * Create the worktree pair. `candidateBranch` must already hold the
 * refactoring commits; it is NOT created here (the refactor agent owns that
 * step). Baseline always checks out the recorded base commit.
 */
// ── createWorktrees：把 baseline / candidate 两个 worktree 检出来 ────
// 【作用】本文件核心函数。保证"存在一对可用的 worktree"，并返回它们的路径和 baseSha。
// 【参数】
//   repo：主仓库路径；sessionRoot：本次会话的落盘目录（worktree 建在它下面）；
//   candidateBranch：已经装着重构提交的分支名（⚠️ 这里只负责检出，不负责创建分支——
//                    建分支是重构流程的事）；
//   baseSha：baseline 要检出的 commit，默认值取当前 HEAD（参数默认值写法 baseSha = resolveHead(repo)）。
// 【返回】WorktreePair（含一个 cleanup 闭包）。
// 【语法】闭包：cleanup 是一个函数值，它"记住"了外面的 baselineDir/candidateDir/repo 变量，
//        所以调用方拿到对象之后随时可以调用 worktrees.cleanup()。
// 【关系】workflow-agent-pipeline.ts（新）/ pipeline.ts、agent-pipeline.ts（旧）都调它；
//        新路径在 finally 里调 cleanup()（这就是"永远冷构建"的直接原因，见文件头）。
export function createWorktrees(
  repo: string,
  sessionRoot: string,
  candidateBranch: string,
  baseSha = resolveHead(repo),
): WorktreePair {
  // ← 会话目录下再开一层 worktrees/ 目录（recursive: true 表示父目录不存在就一路建出来）
  const wtRoot = join(sessionRoot, "worktrees");
  mkdirSync(wtRoot, { recursive: true });

  const baselineDir = join(wtRoot, "baseline");
  const candidateDir = join(wtRoot, "candidate");

  // ← existsSync 守卫：目录已经在了就不再 `worktree add`。
  //   这就是"重复调用安全（可重入）"的实现方式，也是任务 7 想利用的"失败后重入"入口。
  if (!existsSync(baselineDir)) {
    // Worktrees cannot be re-attached to a detached commit twice; use a temp
    // local branch per session for the baseline.
    // ← git 不允许把两个 worktree 检到同一个"游离 commit"上，所以先给这个 commit
    //   造一个临时本地分支。分支名里带 SHA 前 12 位，避免不同会话互相打架。
    const baseBranch = `refactor-session/base-${baseSha.slice(0, 12)}`;
    if (!hasBranch(repo, baseBranch)) {
      git(repo, ["branch", baseBranch, baseSha], "branch base");
    }
    // ← --detach：worktree 本身处于游离 HEAD 状态，指到刚才那个临时分支的 commit 上
    git(repo, ["worktree", "add", "--detach", baselineDir, baseBranch], "add baseline");
  }
  if (!hasBranch(repo, candidateBranch)) {
    // ← 分支不存在就抛错（fail-closed）：没有可比较的候选版本，继续跑没有意义
    throw new Error(`candidate branch not found: ${candidateBranch}`);
  }
  if (!existsSync(candidateDir)) {
    git(repo, ["worktree", "add", candidateDir, candidateBranch], "add candidate");
  }

  return {
    baselineDir,
    candidateDir,
    baseSha,
    cleanup() {
      // ← 先删两个目录（force + recursive：不存在也不报错、子目录一并删）
      for (const dir of [baselineDir, candidateDir]) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
      // ← git 内部还记着"这个路径是个 worktree"，目录没了会留下脏记录，
      //   `git worktree prune` 负责把这些失效记录清掉。
      // ⚠️ 注意 cleanup 只删目录 + prune：`refactor-session/base-xxx` 这个临时分支和
      //    candidate 分支**都还在仓库里**，这正是任务 7 L3 说的"孤儿分支清理"要补的窟窿。
      git(repo, ["worktree", "prune"], "prune");
    },
  };
}
