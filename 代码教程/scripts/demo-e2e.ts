/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/demo-e2e.ts —— 第 2 步演示：无 AI 的真实 C 差分验证
 *
 * 【这个文件是干什么的】
 *   项目演进三部曲的第 2 步（第 1 步是 demo.ts 的纯状态机，第 3 步是
 *   demo-agents.ts 的真 Claude）。这一步把"假数据"换成"真东西"：
 *   真的 C 源码（examples/trim-app/base）、真的 gcc 编译、真的运行用例、
 *   真的新旧版本逐通道对比 —— 但**所有 artifact 仍然是脚本里手写的**，
 *   也就是"如果 Claude 分析得完美无缺，它该交上来的那份答卷"。
 *
 *   剧本：
 *     1. 把 examples/trim-app/base 拷进一个临时目录并 git init（base 提交）
 *     2. 开分支 refactor/safe   —— 行为保持的重构（提取辅助函数）
 *     3. 开分支 refactor/broken —— 只是把行尾空白删掉了（行为变了）
 *     4. 对两条分支各跑一次 runVerification()：
 *            safe   → ACCEPTED
 *            broken → REJECTED
 *
 * 【跑什么 / 要不要 Claude / 多久 / 期望输出】
 *   命令：bun run scripts/demo-e2e.ts
 *   要不要 Claude：不要。要不要 gcc：要（direct-compiler 构建走 gcc），
 *   还要 git。
 *   耗时：几秒（项目只有 2 个 .c 文件，10 个用例每侧各跑一遍）。
 *   期望输出：两段 "=== xxx (refactor/yyy) ==="，每段里是状态迁移列表，
 *   safe 那段最后一行是 "⇒ final state: ACCEPTED"，broken 那段是 REJECTED。
 *   退出码恒为 0（脚本不设 process.exitCode，即使 broken 被拒也是"符合预期"）。
 *
 * 【在整个项目里的位置】
 *   上游：手工运行（package.json 没给它起别名）。
 *   下游：src/runtime/pipeline.ts 的 runVerification（旧版验证半场：编译、
 *         跑用例、逐通道 compare、经状态机裁决）。
 *   它是 scripts/e2e-differential.ts 的"双变体版"——后者把 safe/broken 拆成
 *   两个独立入口并用 expected/actual 断言，更适合当回归测试用。
 *
 * 【先修知识】
 *   ① demo.ts（状态机怎么推进）；
 *   ② 代码教程/src/runtime/pipeline.ts（runVerification 的 8 个 gate）；
 *   ③ examples/trim-app/（base 与 variants/safe、variants/broken 的差异）。
 * 【本文件是教程注释版】
 *   原文件：scripts/demo-e2e.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * E2E demo: real C project, real gcc, real differential runs.
 *
 *  1. materialize examples/trim-app/base into a temp repo (base commit)
 *  2. branch refactor/safe   — behavior-preserving extraction
 *  3. branch refactor/broken — trims trailing whitespace only (behavior change)
 *  4. runVerification() on each branch:
 *        safe   → ACCEPTED
 *        broken → REJECTED
 */
// ↑ 原文件自带的英文 doc 注释，一字未动（内容就是上面中文总览的原始版）。
import { cpSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";   // ← execSync：同步执行 shell 命令（简单粗暴）
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/orchestrator/store.js";
import { runVerification, type VerifyRequest } from "../src/runtime/pipeline.js";

const BASE = join(import.meta.dir, "..", "examples", "trim-app", "base");
// ← import.meta.dir：本脚本所在目录（Bun 提供）；这样脚本从任何 cwd 启动都能找到示例
const GIT = 'git -c user.email=demo@local -c user.name=demo';
// ↑ 用 -c 临时注入 git 身份：新机器可能没配 user.email，不注入的话 commit 会失败

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
  // ↑ stdio: "pipe" = 吞掉子进程输出（git 的标准输出不刷屏）；命令失败时 execSync 会抛异常
}

// --- build the sample repo with two candidate branches -------------------
// ↑ 原注释：搭一个带两条候选分支的示例仓库。
const root = mkdtempSync(join(tmpdir(), "refactor-e2e-"));
const repo = join(root, "repo");
cpSync(BASE, repo, { recursive: true });   // ← 递归拷贝整个示例工程

sh(`${GIT} init -b main`, repo);           // ← -b main：初始分支叫 main（老版本 git 默认 master）
sh(`${GIT} add -A`, repo);
sh(`${GIT} commit -m base`, repo);

for (const variant of ["safe", "broken"] as const) {
  // ↑【语法】as const：把数组类型收窄成只读的 "safe" | "broken"，
  //   这样下面 join(BASE, "..", "variants", variant, …) 的类型推导更精确
  sh(`git checkout -b refactor/${variant}`, repo);   // ← 从 main 开出候选分支
  copyFileSync(
    join(BASE, "..", "variants", variant, "util.c"),
    join(repo, "src", "util.c"),
  );
  // ↑ 把"重构后的 util.c"盖进仓库：safe 是提取了辅助函数的等价版本；
  //   broken 是把行尾空白剥掉的版本（stdout 会少几个空格 → 差分立刻发现）
  sh(`${GIT} add -A`, repo);
  sh(`${GIT} commit -m "${variant} refactor"`, repo);
  sh("git checkout main", repo);   // ← 回到 main，下一轮再开新分支（保证两条分支都从同一 base 出发）
}

// --- shared verification inputs ------------------------------------------
// ↑ 原注释：下面是两次验证共用的"答卷"。
// ── request：手工构造一份 VerifyRequest（Claude 本该产出的 5 个 artifact + patch）──
// 【语法】这段返回值类型写得非常啰嗦：
//     Omit<VerifyRequest, "contract" | … | "patch">  先把 6 个字段从类型里"抠掉"，
//     再用 & { contract: …; … } 一个个加回来。
//   效果等价于直接写 VerifyRequest，但好处是：每个字段的类型都被单独点名，
//   在编辑器里悬停能直接看到每个 artifact 的完整类型。
// 【为什么要手写】旧版流水线（pipeline.ts）不做"分析"这一步，它假设 5 个 artifact
//   已经有人给好了——在真 AI 流程里给的人是 analyzeRepo()，在这里是我们。
const request = (
  candidateBranch: string,
  summary: string,
): Omit<VerifyRequest, "contract" | "scope" | "deps" | "tests" | "env" | "patch"> & {
  contract: VerifyRequest["contract"];
  scope: VerifyRequest["scope"];
  deps: VerifyRequest["deps"];
  tests: VerifyRequest["tests"];
  env: VerifyRequest["env"];
  patch: VerifyRequest["patch"];
} => ({
  repoPath: repo,
  candidateBranch,
  // ── contract（行为契约）：哪些"可观察行为"必须保持 ────────────────
  contract: {
    kind: "behavior-contract",
    version: 1,
    channels: {
      exit_code: { mode: "exact" },        // ← 退出码必须逐个相等
      signals: { mode: "exact" },          // ← 信号必须一致
      stdout: { mode: "exact" },           // ← 标准输出逐字节相等（broken 变体就栽在这里）
      stderr: { mode: "ignore" },          // ← 标准错误不比（允许编译器警告之类差异）
      filesystem: { mode: "semantic", comparator: "fs-effects-v1" },
    },                                     // ← 文件系统副作用用语义比较器（不是逐字节比文件）
    allowed_change: { internal_structure: true, execution_time: true },
    // ↑ 明确允许变化的两项：内部结构（我们本来就是要重构）和执行时间
    notes: [],
  },
  // ── scope（范围清单）：能改什么、能读什么、禁止读什么 ─────────────
  scope: {
    kind: "scope-manifest",
    version: 1,
    editable_files: [{ file: "src/util.c", symbols: ["trim"] }],
    // ↑ 只许改 src/util.c 里的 trim（及它内部用到的符号）
    readable_globs: ["src/**"],
    forbidden_globs: [],                   // ← 这里没禁止任何读取（真 AI 流程常禁 test/**、baseline/**）
  },
  // ── deps（依赖清单）：非确定性来源以及怎么隔离 ────────────────────
  deps: {
    kind: "dependency-manifest",
    version: 1,
    dependencies: [
      { name: "time()", kind: "time", strategy: "freeze", evidence: ["src/main.c"], notes: "" },
      // ↑ 用到时间 → 冻结时钟
      { name: "rand()", kind: "randomness", strategy: "seed", evidence: ["src/main.c"], notes: "" },
      // ↑ 用到随机 → 固定种子
    ],
  },
  // ── tests（测试规格）：1 个回归用例 + 4 个差分用例 ────────────────
  //    regression：只跑 candidate，断言退出码；
  //    differential：baseline 和 candidate 都跑，逐通道比对输出。
  tests: {
    kind: "test-spec",
    version: 1,
    cases: [
      { id: "r1", kind: "regression", argv: ["app", "hello"], stdin: "", fixtures: [], expect_exit_code: 0 },
      { id: "d-normal", kind: "differential", argv: ["app", "  padded  "], stdin: "", fixtures: [] },
      { id: "d-empty-args", kind: "differential", argv: ["app"], stdin: "", fixtures: [] },
      { id: "d-blank", kind: "differential", argv: ["app", "", "   ", "\t"], stdin: "", fixtures: [] },
      // ↑ 空串/纯空白是 trim() 的边界，最容易暴露行为变化
      { id: "d-mixed", kind: "differential", argv: ["app", "ünïcødé\t", "a b c "], stdin: "", fixtures: [] },
      // ↑ 带非 ASCII 字符，测试"按字节处理还是按字符处理"这类隐患
    ],
  },
  // ── env（环境规格）：怎么编译、怎么保证确定性 ────────────────────
  env: {
    kind: "environment-spec",
    version: 1,
    build: {
      kind: "direct-compiler",     // ← 不用 CMake，直接调编译器
      compiler: "gcc",
      flags: ["-O2", "-Wall"],
      defines: {},
      sources: ["src/main.c", "src/util.c"],
      output: "app",
    },
    sanitizers: [],                // ← 不跑 ASan/UBSan（独立的安全闸门，这里关着）
    determinism: {
      frozen_time_epoch_ms: 1700000000000,   // ← 冻结到 2023-11-14 附近
      random_seed: 42,                        // ← 固定随机种子
      intercept_headers: ["shim/determinism.h"],
      // ↑ 编译时强制包含的头文件（把 time/rand 替换成可控版本的 shim）
    },
    sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    // ↑ 每个用例都在一个全新临时目录里跑，避免文件系统副作用互相污染
  },
  patch: {
    branch: candidateBranch,
    commit_sha: "0".repeat(40), // pipeline records the true sha itself
    // ↑ 原注释：占位的全 0 sha —— 流水线会自己去查真实提交并覆盖它
    changed_files: ["src/util.c"],
    summary,
  },
});

// ── verify：对一条分支跑完整验证并打印结果 ─────────────────────────
// 【参数】branch：候选分支名；label：打印用的人类标签。
// 【关系】内部 new 一个 SessionStore（每个分支一个独立会话，互不影响），
//   然后调 runVerification —— 它会依次：建 baseline/candidate 两个 worktree →
//   双方各编译一次 → 各跑一遍用例 → compare → 状态机裁决。
function verify(branch: string, label: string): void {
  const store = SessionStore.create(root, `session-${branch.split("/")[1]}`);
  // ↑ branch.split("/")[1] 取 "safe"/"broken"，作为会话目录名
  const outcome = runVerification(store, request(branch, `${branch} refactor`));
  console.log(`\n=== ${label} (${branch}) ===`);
  for (const r of outcome.results) {
    console.log(
      r.ok ? `  ✓ ${r.from} → ${r.to}` : `  ✗ ${r.reason.slice(0, 120)}`,
    );
    // ↑ 被拒时只打印 reason 的前 120 个字符，防止刷屏
  }
  console.log(`  ⇒ final state: ${outcome.state}`);
}

verify("refactor/safe", "behavior-preserving refactor");   // ← 期望 ACCEPTED
verify("refactor/broken", "behavior-changing refactor");   // ← 期望 REJECTED（stdout 缺了行尾空白）

console.log(`\n(temp artifacts left in ${root}; delete manually if needed)`);
// ↑ 原注释：临时产物留在系统临时目录里，需要时手动删。
//   ⚠️ import 了 rmSync 却没用它 —— 想自动清理的话可以用 rmSync(root, { recursive: true, force: true })。
