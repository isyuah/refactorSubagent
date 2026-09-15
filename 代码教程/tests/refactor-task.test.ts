/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/refactor-task.test.ts —— libuv 固定任务定义（基准测试的"题库"）
 *
 * 【这个文件是干什么的】
 *   锁定 src/artifacts/refactor-task.ts 里那个"写死的 libuv 重构任务"：
 *     ① Schema 硬约束：baseline 失败时必须给出失败分类（failure_classifications
 *        为空就拒绝）；候选目标声称"官方测试已覆盖"时必须给出对应的
 *        source_tests（为空就拒绝）——不许"空口说覆盖了"。
 *     ② createLibuvRefactorTask()：从一次真实 checkout 的证据（baseline 摘要、
 *        顶层测试名单、失败分类）生成一份固定的任务定义，内容是确定性的：
 *        项目是 libuv v1.52.1、3 个候选文件（strscpy / strtok / version.c）、
 *        其中 version.c 被标成 dedicated-harness-required（官方没有针对它的
 *        测试，需要专门写个小 harness）、测试计划 6 个用例。
 *
 * 【在整个项目里的位置】
 *   这份任务是教程任务 #5（libuv 基准测试集）的数据地基；
 *   evidence 里的 baselineFailures（category: environment）也是任务 #4
 *   "基线事实包"和任务 #9 warnings 分类要复用的信息。
 *
 * 【先修知识】Zod 的 parse（失败抛异常）、`as const`（把字符串收窄成字面量类型）。
 *
 * 【需要真实 gcc/cmake 吗】不需要，纯数据构造 + Schema 校验。
 *   ⚠️ 文件顶部那个 sourceRoot 是硬编码的本机临时目录路径，但它只是
 *      一个"证据字段"被塞进任务里，测试并不会去读这个路径。
 *
 * 【本文件是教程注释版】原文件 tests/refactor-task.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
import { createLibuvRefactorTask, RefactorTestTask } from "../src/artifacts/refactor-task.js";

// 一次真实 libuv checkout 的"证据包"：在哪里、用什么 workflow、baseline 长什么样。
// category 后面那个 as const 很重要：Schema 要求的是字面量 "environment"，
// 不加 as const 会被 TS 推断成宽泛的 string 而通不过类型检查。
const sourceRoot = "C:/Users/Yu/AppData/Local/Temp/refactor-libuv-in4Ow9/libuv";
const evidence = {
  sourceRoot,
  workflowId: "libuv-v1.52.1-cmake-debug",
  workflowRevision: 1,
  baselineSummary: { total: 2, passed: 0, failed: 2, not_run: 0 },
  baselineTopLevelTests: ["uv_test", "uv_test_a"],
  baselineFailures: [
    {
      test: "uv_test_a:fs_event_watch_dir_short_path",
      category: "environment" as const,
      related_to_scope: false,
      explanation: "Windows short-path filesystem behavior is host-sensitive.",
    },
  ],
};

describe("libuv refactor test task", () => {
  // 【测什么】两条"证据必须齐全"的硬规则（一次构造一份违法数据同时踩两条线）：
  //   · baseline.status = "fail" 但 failure_classifications = [] —— 失败了却
  //     不解释原因，直接拒绝；
  //   · candidate 标 verification = "official-test-covered" 但 source_tests = []
  //     —— 说官方测试覆盖了却列不出是哪个测试，直接拒绝。
  //   👉 这两个都是防"AI/人偷懒含糊"的闸门：没有证据的声明不算数。
  // 【语法】RefactorTestTask.parse(...) 在校验失败时抛异常，配合 toThrow() 断言。
  test("requires classifications for failed baselines and source tests for official coverage", () => {
    expect(() => RefactorTestTask.parse({
      kind: "refactor-test-task",
      version: 1,
      project: { name: "x", version: "1", language: "c", repository: "https://example.com/x" },
      workflow: { id: "x", revision: 1 },
      baseline: {
        status: "fail",
        suite: { kind: "ctest-suite-spec", version: 1, build_dir: "build", configuration: "Debug", timeout_ms: 1000, parallelism: 1, extra_args: [], environment: {} },
        summary: { total: 1, passed: 0, failed: 1, not_run: 0 },
        top_level_tests: ["x"],
        failure_classifications: [],
        notes: [],
      },
      candidates: [{
        file: "src/a.c",
        symbols: ["a"],
        source_tests: [],
        verification: "official-test-covered",
        rationale: "missing evidence",
      }],
      test_plan: {
        cases: [{
          id: "case",
          category: "normal",
          candidate_file: "src/a.c",
          candidate_symbol: "a",
          source_test: null,
          scenario: "x",
          expected_invariant: "x",
        }],
        required_before_acceptance: ["x"],
      },
    })).toThrow();
  });

  // 【测什么】createLibuvRefactorTask() 的产出是"确定的"，逐项核对：
  //   · 项目身份 libuv v1.52.1；
  //   · baseline 状态是 fail（本机 libuv 全量 CTest 本来就不全绿），且那条
  //     失败被正确分类为 environment（主机环境敏感，不是重构引入的问题）；
  //   · 候选文件顺序固定：strscpy → strtok → version；
  //   · 第 3 个候选（version.c）被标成 dedicated-harness-required——
  //     因为官方测试集里没有 test-version.c，没有现成 harness 可用；
  //   · 测试计划一共 6 个用例。
  // 【语法】expect.objectContaining({...})：只核对关心的字段；
  //   candidates[2]! 的 ! 是非空断言（下标访问的类型是可能 undefined）。
  test("generates the fixed libuv task from checkout evidence", () => {
    const task = createLibuvRefactorTask(evidence);
    expect(task.project).toEqual(expect.objectContaining({ name: "libuv", version: "v1.52.1" }));
    expect(task.baseline.status).toBe("fail");
    expect(task.baseline.failure_classifications[0]!.category).toBe("environment");
    expect(task.candidates.map((candidate) => candidate.file)).toEqual([
      "src/strscpy.c",
      "src/strtok.c",
      "src/version.c",
    ]);
    expect(task.candidates[2]!.verification).toBe("dedicated-harness-required");
    expect(task.test_plan.cases).toHaveLength(6);
  });
});
