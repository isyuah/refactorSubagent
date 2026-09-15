/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/e2e-differential.ts —— 旧路径验收（safe / broken 双变体）
 *
 * 【这个文件是干什么的】
 *   旧版验证路径（runtime/pipeline.ts）的**验收脚本**：把同一个 C 工程
 *   的两个变体各跑一遍完整差分验证，并与**期望裁决**做比对——
 *     --variant safe    → 期望 ACCEPTED（行为保持的重构应当被放行）
 *     --variant broken  → 期望 REJECTED（故意改行为的版本必须被拦下）
 *   "能接受该接受的、能拒绝该拒绝的"——这两个方向合起来才说明
 *   裁决器没有退化成"永远说好"或"永远说不"。
 *
 *   流程：把 examples/trim-app/base 拷进临时 git 仓库 →
 *   开分支 refactor/<variant> 并盖入 variants/<variant>/util.c →
 *   probeHost → runVerification() → 打印 expected_state vs actual_state。
 *
 * 【跑什么 / 要不要 Claude / 多久 / 期望输出】
 *   命令：bun run e2e:differential:safe        （= --variant safe）
 *         bun run e2e:differential:broken      （= --variant broken）
 *   要不要 Claude：不要（5 个 artifact 全是脚本手写的，和 demo-e2e.ts 同一套）。
 *   要 gcc + git。耗时：中等（几秒到几十秒，视机器）。
 *   期望输出：一段 JSON ——
 *     scenario: "targeted-differential-accept" | "targeted-differential-reject"
 *     expected_state: "ACCEPTED" | "REJECTED"
 *     actual_state:   必须与 expected_state 一致
 *     transitions: 每一步迁移（或第一个被拒的理由）
 *   退出码：actual !== expected → 1（这才是这个脚本的"测试"意义）。
 *
 * 【在整个项目里的位置】
 *   上游：package.json 的 "e2e:differential:safe" / "e2e:differential:broken"。
 *   下游：src/runtime/pipeline.ts 的 runVerification（旧路径：无 workflow 阶段）。
 *   它就是《零基础看懂教程.md》任务 5 建议采用的"expected vs actual"模式样板。
 *
 * 【先修知识】
 *   ① demo-e2e.ts（同一份 request 的逐字段讲解）；
 *   ② examples/trim-app/variants/（safe 与 broken 的 util.c 差在哪）；
 *   ③ Set / as const / process.exit 这几个语法点（下文第一次出现会讲）。
 * 【本文件是教程注释版】
 *   原文件：scripts/e2e-differential.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import { cpSync, copyFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/orchestrator/store.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { runVerification, type VerifyRequest } from "../src/runtime/pipeline.js";

const BASE = join(import.meta.dir, "..", "examples", "trim-app", "base");
const VARIANTS = new Set(["safe", "broken"]);
// ↑【语法】new Set([...])：集合，has() 查找是 O(1)；用来校验参数合法性
const variant = readVariant();
// ↑ 注意：函数定义在文件末尾却在这里调用 —— 这是"函数声明提升"（hoisting），
//   TS/JS 允许先调用后声明 function
const root = mkdtempSync(join(tmpdir(), `refactor-e2e-${variant}-`));
const repo = join(root, "repo");
cpSync(BASE, repo, { recursive: true });

git(repo, ["init", "-b", "main"]);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-m", "base"]);
const candidateBranch = `refactor/${variant}`;
git(repo, ["checkout", "-b", candidateBranch]);
copyFileSync(join(BASE, "..", "variants", variant, "util.c"), join(repo, "src", "util.c"));
// ↑ 把选中变体的 util.c 盖进仓库：safe = 等价重构；broken = 删掉了行尾空白
//   （stdout 因此少了空格 → stdout 通道 exact 比较立刻不一致）
git(repo, ["add", "-A"]);
git(repo, ["commit", "-m", `${variant} refactor`]);
git(repo, ["checkout", "main"]);

const host = probeHost(repo);
// ↑ 这里显式探测一次并传给流水线（demo-e2e.ts 没传，由流水线内部自己探测）
const store = SessionStore.create(root, `session-${variant}`);
const outcome = runVerification(store, request(repo, candidateBranch, host));
const expected = variant === "safe" ? "ACCEPTED" : "REJECTED";

console.log(JSON.stringify({
  scenario: variant === "safe" ? "targeted-differential-accept" : "targeted-differential-reject",
  root,
  candidate_branch: candidateBranch,
  expected_state: expected,      // ← 我们"认为应该"的裁决
  actual_state: outcome.state,   // ← 程序"实际给"的裁决
  transitions: outcome.results.map((result) => result.ok
    ? `${result.from} -> ${result.to}`
    : `rejected: ${result.reason}`),
  // ↑ results 里第一条失败会中断整个流程，所以 broken 变体的列表
  //   通常在 candidate 对比那一项上显示 rejected
}, null, 2));

if (outcome.state !== expected) {
  // ← 验收的核心：期望与实际不一致 = 回归，退出码 1
  console.error(`targeted differential ${variant} expected ${expected}, got ${outcome.state}`);
  process.exitCode = 1;
}

// ── readVariant：解析 --variant 参数（非法就立刻退出 2）────────────
// 【返回】"safe" | "broken"；【副作用】参数缺失/非法时 process.exit(2) 直接结束进程。
// 【语法】process.exit() 与 process.exitCode 的区别：前者立即退出（后面的代码不跑），
//   后者只是"记下退出码，把剩余代码跑完再退"。参数错误用前者合理。
function readVariant(): "safe" | "broken" {
  const args = Bun.argv.slice(2);
  const index = args.indexOf("--variant");
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || !VARIANTS.has(value)) {
    console.error("用法: bun run scripts/e2e-differential.ts --variant <safe|broken>");
    process.exit(2);
  }
  return value as "safe" | "broken";
  // ↑【语法】as 断言：Set.has() 只能证明它是 string，这里我们**人工保证**它
  //   是两个字面量之一，于是用 as 告诉编译器。⚠️ as 不做任何运行时检查。
}

// ── git：同步执行 git 命令的小工具 ───────────────────────────────
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  }).trim();
}

// ── request：手写一份 VerifyRequest（AI 本该产出的 5 个 artifact + patch）──
// 【参数】repoPath：仓库根；candidateBranch：要验证的分支；host：已探测好的主机事实。
// 【关系】字段逐个讲在 demo-e2e.ts 里已经做过，这里只标注与裁决相关的关键点：
//   · stdout 用 exact 模式 —— broken 变体删行尾空白就会在这里被抓到；
//   · editable_files 限定 src/util.c 的 trim —— patch 声明的 changed_files 必须落在其中；
//   · determinism 冻结时间/种子 —— 否则两次运行本身就可能不同，对比失去意义。
function request(
  repoPath: string,
  candidateBranch: string,
  host: VerifyRequest["host"],
): VerifyRequest {
  // ↑【语法】VerifyRequest["host"]：索引访问类型 —— "取 VerifyRequest 里 host 字段的类型"，
  //   免得再 import 一次 HostPreflight
  return {
    repoPath,
    candidateBranch,
    host,
    contract: {
      kind: "behavior-contract",
      version: 1,
      channels: {
        exit_code: { mode: "exact" },
        signals: { mode: "exact" },
        stdout: { mode: "exact" },
        stderr: { mode: "ignore" },
        filesystem: { mode: "semantic", comparator: "fs-effects-v1" },
      },
      allowed_change: { internal_structure: true, execution_time: true },
      notes: [],
    },
    scope: {
      kind: "scope-manifest",
      version: 1,
      editable_files: [{ file: "src/util.c", symbols: ["trim"] }],
      readable_globs: ["src/**"],
      forbidden_globs: [],
    },
    deps: {
      kind: "dependency-manifest",
      version: 1,
      dependencies: [
        { name: "time()", kind: "time", strategy: "freeze", evidence: ["src/main.c"], notes: "" },
        { name: "rand()", kind: "randomness", strategy: "seed", evidence: ["src/main.c"], notes: "" },
      ],
    },
    tests: {
      kind: "test-spec",
      version: 1,
      cases: [
        { id: "r1", kind: "regression", argv: ["app", "hello"], stdin: "", fixtures: [], expect_exit_code: 0 },
        { id: "d-normal", kind: "differential", argv: ["app", "  padded  "], stdin: "", fixtures: [] },
        { id: "d-blank", kind: "differential", argv: ["app", "", "   ", "\t"], stdin: "", fixtures: [] },
        { id: "d-mixed", kind: "differential", argv: ["app", "ünïcødé\t", "a b c "], stdin: "", fixtures: [] },
      ],
      // ↑ 注意：比 demo-e2e.ts 少一个 d-empty-args 用例 —— 两个脚本并不要求用例集相同
    },
    env: {
      kind: "environment-spec",
      version: 1,
      build: {
        kind: "direct-compiler",
        compiler: "gcc",
        flags: ["-O2", "-Wall"],
        defines: {},
        sources: ["src/main.c", "src/util.c"],
        output: "app",
      },
      sanitizers: [],
      determinism: {
        frozen_time_epoch_ms: 1_700_000_000_000,
        // ↑【语法】数字分隔符 _：1_700_000_000_000 比 1700000000000 好读，值完全一样
        random_seed: 42,
        intercept_headers: ["shim/determinism.h"],
      },
      sandbox: { run_cwd_strategy: "fresh_temp_dir" },
    },
    patch: {
      branch: candidateBranch,
      commit_sha: "0".repeat(40),   // ← 占位全 0；流水线会自己取真实 sha 覆盖
      changed_files: ["src/util.c"],
      summary: `${variant} targeted differential refactor`,
    },
  };
}
