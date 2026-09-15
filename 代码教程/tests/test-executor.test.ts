/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/test-executor.test.ts —— 自驱动 TestWorkflow 的"两侧运行 + 期望比较"
 *
 * 【这个文件是干什么的】
 *   这是本项目最新机制（教程 §1.5 最后一段）的锁定测试：
 *   同一份 TestWorkflow 源码，宿主会在 baseline worktree 跑一遍、candidate
 *   worktree 跑一遍；workflow 函数自己不知道在哪一侧，它只管用
 *   ctx.expect("名字", 关系, 值) 把观测到的值声明出去；宿主把两侧声明
 *   【按下标（顺序）配对】，再用关系语义判定：
 *     equal / not-equal / baseline-greater / baseline-less / both-matches
 *   三个用例分别锁定：
 *     ① 两侧各声明 2 条、值完全一致 → overall = "consistent"；
 *     ② 同名期望两侧值不同 → "inconsistent"，mismatch 的 reason 要能看懂
 *        （"values differ"）；
 *     ③ baseline-greater 这种"带方向"的关系：baseline 值确实更大 → 一致；
 *        反过来 → 不一致（reason 含 "not greater"）。
 *
 * 【在整个项目里的位置】
 *   被测对象：src/workflow/test-executor.ts（executeTestWorkflow）+
 *   src/workflow/expectation-compare.ts（compareExpectations）。
 *   它们是流水线第 ⑧⑨ 步的"定向测试"实现——替代全量 CTest 的快路径。
 *
 * 【先修知识】async 箭头函数、ctx.expect 的四参形态
 *   ctx.expect(name, relation, value[, pattern])（both-matches 时第 4 参是正则）。
 *
 * 【需要真实 gcc/cmake 吗】不需要编译 C 代码。但第①个用例会真的
 *   spawn 一个 bun 子进程去跑 workflow 源码（较慢，超时给到 90 秒）；
 *   ②③ 只调比较函数，纯逻辑。
 *
 * 【本文件是教程注释版】原文件 tests/test-executor.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTestWorkflow } from "../src/workflow/test-executor.js";
import { compareExpectations } from "../src/workflow/expectation-compare.js";

// 测试用能力策略：这里放得很宽（可读可写一切、允许 cmd 工具），
// 因为本文件关心的是"期望比较"，不是权限边界（那边在 workflow-capabilities.test.ts）。
// 【语法】const 声明的对象如果不再改，TS 会推断出窄类型，等价于 readonly。
const TEST_POLICY = {
  readableGlobs: ["**"],
  writableGlobs: ["**"],
  allowedTools: ["cmd"],
  maxOutputBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rfr-testexec-"));
}

/** Self-driven test workflow that declares expectations directly (no process). */
// 一份"纯声明"的自驱动 TestWorkflow：不跑任何进程，只是直接调用两次
// ctx.expect。它演示的是协议本身：
//   · 第 1 条：名字 "exit-code"，关系 equal，期望值 0；
//   · 第 2 条：名字 "marker"，关系 both-matches（两侧都要匹配正则），
//     值 "obs-value"，正则 "^obs-"。
// 注意它 return { ok: true } —— 自驱动形态下返回值只是普通数据，
// 真正的"结果"是那些 expect 声明。
const OBSERVE_WORKFLOW = `
import type { WorkflowContext } from "./types";

export const workflowKind = "test-workflow-driven";

export default async (ctx: WorkflowContext) => {
  ctx.expect("exit-code", "equal", 0);
  ctx.expect("marker", "both-matches", "obs-value", "^obs-");
  return { ok: true };
};
`;

describe("executeTestWorkflow (self-driven)", () => {
  // 【测什么】两侧运行 + 配对 + 判定的完整闭环：
  //   · status = "pass"（两次 workflow 都跑完了）；
  //   · comparison.overall = "consistent"（两侧声明逐条匹配）；
  //   · baseline / candidate 两侧各自收集到 2 条期望（数量必须一样，
  //     否则根本没法按下标配对）。
  //   👉 这是"同一份代码跑两遍必须给出同样的声明"这个契约的正面证据。
  test("runs workflow in baseline and candidate, compares expectations consistently", async () => {
    const root = tempDir();
    // types.d.ts 是给 workflow 源码看的类型声明（它 import type 自这个文件）。
    writeFileSync(join(root, "types.d.ts"), 'export interface WorkflowContext {\n  readonly workspaceRoot: string;\n}\n');
    writeFileSync(join(root, "wf.ts"), OBSERVE_WORKFLOW);
    const baselineDir = join(root, "baseline");
    const candidateDir = join(root, "candidate");
    mkdirSync(baselineDir, { recursive: true });
    mkdirSync(candidateDir, { recursive: true });

    const result = await executeTestWorkflow({
      entry: join(root, "wf.ts"),   // ← 注意：两侧用的是同一个入口文件
      baselineDir,
      candidateDir,
      policy: TEST_POLICY,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("pass");
    expect(result.comparison?.overall).toBe("consistent");
    expect(result.baseline.expectations.length).toBe(2);
    expect(result.candidate.expectations.length).toBe(2);
  }, 90_000);

  // 【测什么】期望不一致时的判定与可诊断性。
  //   先看注释说明的难点：executeTestWorkflow 只接受一个入口，
  //   两侧跑的是同一份代码，没法在执行器层面让它"两侧观测到不同值"。
  //   所以这里【直接测比较器】compareExpectations：喂给它两侧各一条
  //   equal 期望（42 vs 43），断言 overall = "inconsistent"，
  //   且 mismatch 的 reason 里写明 "values differ"（能看懂为什么挂）。
  //   👉 两个 workflow 文件写出来只是为了让读者看清"差异是什么"。
  test("fails when expectations mismatch (candidate declares different value)", async () => {
    const root = tempDir();
    writeFileSync(join(root, "types.d.ts"), 'export interface WorkflowContext {\n  readonly workspaceRoot: string;\n}\n');
    // Candidate side: same code but host could inject different input — here we
    // simulate by two different workflow files observing different values.
    const baselineWf = `
import type { WorkflowContext } from "./types";
export const workflowKind = "test-workflow-driven";
export default async (ctx: WorkflowContext) => {
  ctx.expect("value", "equal", 42);
};
`;
    const candidateWf = `
import type { WorkflowContext } from "./types";
export const workflowKind = "test-workflow-driven";
export default async (ctx: WorkflowContext) => {
  ctx.expect("value", "equal", 43);
};
`;
    writeFileSync(join(root, "baseline-wf.ts"), baselineWf);
    writeFileSync(join(root, "candidate-wf.ts"), candidateWf);

    // Simulate two different workflow runs with different declared values.
    // executeTestWorkflow uses one entry for both sides, so we test the
    // comparator directly for cross-file differences.
    const comparison = compareExpectations(
      [{ name: "value", relation: "equal", value: 42 }],
      [{ name: "value", relation: "equal", value: 43 }],
    );
    expect(comparison.overall).toBe("inconsistent");
    expect(comparison.mismatched[0]?.reason).toContain("values differ");
  }, 30_000);

  // 【测什么】带方向的关系 baseline-greater（常用于"新代码更快/更省"这类断言）：
  //   · baseline 100 > candidate 50 → consistent（方向符合声明）；
  //   · baseline 30 < candidate 80 → inconsistent，reason 含 "not greater"。
  //   👉 注意方向语义：声明叫 baseline-greater，意思是"基线值应该更大"，
  //      所以 candidate 变小才是"通过"。
  //   两个断言共用一个用例名下的一段代码，前半段先证明"合法方向能过"，
  //   后半段再证明"反向会被抓"——单测里常见的正反成对写法。
  test("baseline-greater relation enforces direction", async () => {
    const comparison = compareExpectations(
      [{ name: "timing", relation: "baseline-greater", value: 100 }],
      [{ name: "timing", relation: "baseline-greater", value: 50 }],
    );
    expect(comparison.overall).toBe("consistent");

    const failed = compareExpectations(
      [{ name: "timing", relation: "baseline-greater", value: 30 }],
      [{ name: "timing", relation: "baseline-greater", value: 80 }],
    );
    expect(failed.overall).toBe("inconsistent");
    expect(failed.mismatched[0]?.reason).toContain("not greater");
  });
});
