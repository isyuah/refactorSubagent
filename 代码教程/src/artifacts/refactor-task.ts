/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/refactor-task.ts —— libuv 固定重构任务（"考卷"本身）
 *
 * 【这个文件是干什么的】
 *   把"在 libuv v1.52.1 上做行为保持重构"这道题定义成一份可校验的数据：
 *   候选文件有哪些（strscpy/strtok/version.c）、每个有官方测试吗、
 *   基线测试跑出来什么样（含环境失败分类）、验收前必须完成什么。
 *   createLibuvRefactorTask() 是工厂函数：传入真实 checkout 的测量证据，
 *   产出完整任务——"从证据生成任务，不猜测覆盖"。
 *
 * 【在整个项目里的位置】
 *   属于"libuv 基准"阶段产物（PROJECT_STATUS §7.9）；tests/refactor-task.test.ts
 *   锁定其校验规则。它是任务清单 #5（libuv 测试集）的直接素材。
 *
 * 【先修知识】ctest-suite.ts（用到 CTestSuiteSpec/CTestSummary）。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/refactor-task.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { CTestSummary, CTestSuiteSpec, type CTestSummary as CTestSummaryValue, type CTestSuiteSpec as CTestSuiteSpecValue } from "./ctest-suite.js";
// ↑ 注意同名的处理：值（Schema）和类型（z.infer）都叫一个名字，import type 时用
//   as 起别名（CTestSummaryValue），避免"名字既是值又是类型"的冲突。
import { RelPath } from "./common.js";   // 候选文件/测试文件都用"仓库相对路径"类型

export const RefactorCandidate = z.object({
  file: RelPath,                                  // 候选重构的文件
  symbols: z.array(z.string().min(1)).min(1),     // 涉及的符号（至少一个）
  source_tests: z.array(RelPath),                 // 覆盖它的官方测试文件（可为空）
  verification: z.enum(["official-test-covered", "dedicated-harness-required"]),
  // ↑ 两种验证方式：官方测试已覆盖 / 需要专用测试架（version.c 就是没有 test-version.c 的后者）
  rationale: z.string().min(1),                   // 为什么选它当候选（小、纯、风险低…）
});
export type RefactorCandidate = z.infer<typeof RefactorCandidate>;

// 一个差分测试用例的完整定义（注意 category 是受限枚举——考题类型固定）：
export const RefactorTestCase = z.object({
  id: z.string().min(1),
  category: z.enum(["normal", "boundary", "empty", "invalid", "unicode"]),
  candidate_file: RelPath,        // 考哪个文件
  candidate_symbol: z.string().min(1),   // 考哪个符号
  source_test: RelPath.nullable(),       // 对应官方测试（version.c 那题为 null）
  scenario: z.string().min(1),           // 场景描述（"源超过目标容量"…）
  expected_invariant: z.string().min(1), // 期望保持的不变量（"返回 UV_E2BIG 且留下截断字符串"…）
});
export type RefactorTestCase = z.infer<typeof RefactorTestCase>;

// 基线失败分类（与 observation-trace/ctest-suite 里的同构结构——同类概念各有主场）：
export const BaselineFailureClassification = z.object({
  test: z.string().min(1),
  category: z.enum(["environment", "test_failure", "unknown"]),
  related_to_scope: z.boolean(),
  explanation: z.string().min(1),
});
export type BaselineFailureClassification = z.infer<typeof BaselineFailureClassification>;

export const RefactorTestTask = z
  .object({
    kind: z.literal("refactor-test-task"),
    version: z.literal(1),
    project: z.object({
      name: z.string().min(1),           // "libuv"
      version: z.string().min(1),        // "v1.52.1" —— 固定版本，保证可复现
      language: z.literal("c"),
      repository: z.string().url(),      // .url()：必须是合法 URL 格式
    }),
    workflow: z.object({                 // 绑定哪个 BuildWorkflow（id + 版本）
      id: z.string().min(1),
      revision: z.number().int().positive(),
    }),
    baseline: z.object({
      status: z.enum(["pass", "fail", "unsupported"]),
      suite: CTestSuiteSpec,             // 基线怎么跑（复用 ctest-suite 的 Schema）
      summary: CTestSummary,             // 基线跑出了什么
      top_level_tests: z.array(z.string().min(1)).min(1),
      failure_classifications: z.array(BaselineFailureClassification),
      notes: z.array(z.string().min(1)),
    }),
    candidates: z.array(RefactorCandidate).min(1),  // 至少一个候选
    test_plan: z.object({
      cases: z.array(RefactorTestCase).min(1),
      required_before_acceptance: z.array(z.string().min(1)).min(1), // 验收前必须做的事清单
    }),
  })
  // —— 三条业务校验（superRefine 可同时记多笔 issue）——
  .superRefine((task, context) => {
    const candidateFiles = new Set(task.candidates.map((candidate) => candidate.file));
    // ① 测试用例考的文件必须是已声明的候选（不许考卷超出范围）。
    for (const testCase of task.test_plan.cases) {
      if (!candidateFiles.has(testCase.candidate_file)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["test_plan", "cases"],
          message: `test case references an undeclared candidate: ${testCase.candidate_file}`,
        });
      }
    }
    // ② 基线是失败的，就必须给出全部失败的分类（不许"挂了但不知道为啥"）。
    if (task.baseline.status === "fail" && task.baseline.failure_classifications.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseline", "failure_classifications"],
        message: "failed baseline requires explicit failure classifications",
      });
    }
    // ③ 说"官方测试已覆盖"的候选，必须真的列出官方测试文件。
    for (const candidate of task.candidates) {
      if (candidate.verification === "official-test-covered" && candidate.source_tests.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates"],
          message: `official-test-covered candidate has no source test: ${candidate.file}`,
        });
      }
    }
  });
export type RefactorTestTask = z.infer<typeof RefactorTestTask>;

// 工厂函数的入参：调用方必须提供"真实测量到的证据"，函数不做任何猜测。
export interface LibuvTaskEvidence {
  readonly sourceRoot: string;             // libuv checkout 的本地路径（用来验证测试文件存在）
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly baselineSummary: CTestSummaryValue;
  readonly baselineTopLevelTests: readonly string[];
  readonly baselineFailures: readonly BaselineFailureClassification[];
}

/** Build the fixed low-risk libuv task from measured checkout evidence. */
// ── createLibuvRefactorTask：libuv 固定任务工厂 ────────────────────────
// 【作用】组装整份任务：项目身份、workflow 绑定、基线证据、三个候选、六个测试用例、
//   四条验收要求。全部硬编码自对 v1.52.1 的真实 checkout 观察。
// 【返回】RefactorTestTask（parse 后的强类型对象）。
// 【关系】tests/refactor-task.test.ts 锁定其结构；libuv 基准脚本使用。
export function createLibuvRefactorTask(evidence: LibuvTaskEvidence): RefactorTestTask {
  const task = RefactorTestTask.parse({
    kind: "refactor-test-task",
    version: 1,
    project: {
      name: "libuv",
      version: "v1.52.1",                 // 固定版本 = 可复现的前提
      language: "c",
      repository: "https://github.com/libuv/libuv.git",
    },
    workflow: {
      id: evidence.workflowId,
      revision: evidence.workflowRevision,
    },
    baseline: {
      // 基线状态由证据推导：有任何失败就是 fail（不是 pass）。
      status: evidence.baselineSummary.failed > 0 ? "fail" : "pass",
      suite: {
        kind: "ctest-suite-spec",
        version: 1,
        build_dir: "build",
        configuration: "Debug",
        timeout_ms: 1_200_000,            // 20 分钟——libuv 全量 CTest 的现实需求
        parallelism: 1,                   // 串行：避免网络/文件测试互相干扰
        extra_args: [],
        environment: {},
      },
      summary: evidence.baselineSummary,
      top_level_tests: [...evidence.baselineTopLevelTests],   // 复制一份，不共享引用
      failure_classifications: [...evidence.baselineFailures],
      notes: [
        // 两条备注就是"fail-closed"的口头版：环境失败可见，但不许被悄悄忽略。
        "CTest baseline is a gate and must be rerun for every candidate.",
        "Environment-classified failures remain visible and cannot be silently ignored.",
      ],
    },
    // —— 三个候选：前两个有官方测试，第三个需要专用测试架 ——
    candidates: [
      {
        file: "src/strscpy.c",
        symbols: ["uv__strscpy"],
        source_tests: ["test/test-strscpy.c"],
        verification: "official-test-covered",
        rationale: "small pure helper with explicit zero-length, exact-fit, and truncation assertions",
      },
      {
        file: "src/strtok.c",
        symbols: ["uv__strtok"],
        source_tests: ["test/test-strtok.c"],
        verification: "official-test-covered",
        rationale: "small stateful string helper with empty, multi-separator, and repeated-token coverage",
      },
      {
        file: "src/version.c",
        symbols: ["uv_version", "uv_version_string"],
        source_tests: [],
        verification: "dedicated-harness-required",   // 这个 checkout 里没有 test-version.c
        rationale: "pure public version functions, but no dedicated test-version.c exists in this checkout",
      },
    ],
    // —— 六道考题：strscpy 三道（空/恰好填满/截断）+ strtok 两道 + version 一道 ——
    test_plan: {
      cases: [
        {
          id: "strscpy-zero-length",
          category: "empty",
          candidate_file: "src/strscpy.c",
          candidate_symbol: "uv__strscpy",
          source_test: "test/test-strscpy.c",
          scenario: "destination capacity n=0 with empty and non-empty source",
          expected_invariant: "returns success and does not require a destination write",
        },
        {
          id: "strscpy-exact-fit",
          category: "boundary",
          candidate_file: "src/strscpy.c",
          candidate_symbol: "uv__strscpy",
          source_test: "test/test-strscpy.c",
          scenario: "source length exactly fills destination capacity",
          expected_invariant: "return value and destination bytes remain unchanged",
        },
        {
          id: "strscpy-truncation",
          category: "boundary",
          candidate_file: "src/strscpy.c",
          candidate_symbol: "uv__strscpy",
          source_test: "test/test-strscpy.c",
          scenario: "source exceeds destination capacity",
          expected_invariant: "returns UV_E2BIG and leaves a terminated truncated string",
        },
        {
          id: "strtok-empty-separator",
          category: "empty",
          candidate_file: "src/strtok.c",
          candidate_symbol: "uv__strtok",
          source_test: "test/test-strtok.c",
          scenario: "tokenize a string with an empty separator set",
          expected_invariant: "returns the complete string and clears the iterator at end",
        },
        {
          id: "strtok-multi-separator",
          category: "boundary",
          candidate_file: "src/strtok.c",
          candidate_symbol: "uv__strtok",
          source_test: "test/test-strtok.c",
          scenario: "tokenize repeated delimiters from a multi-character separator set",
          expected_invariant: "token boundaries and iterator progression remain identical",
        },
        {
          id: "version-public-values",
          category: "normal",
          candidate_file: "src/version.c",
          candidate_symbol: "uv_version_string",
          source_test: null,              // 没有官方测试 → null（配合 dedicated-harness-required）
          scenario: "query public numeric and string version values",
          expected_invariant: "values match the v1.52.1 compile-time version macros",
        },
      ],
      // 验收前的四道硬性要求（相当于"交卷前必须完成的检查项"）。
      required_before_acceptance: [
        "rerun the pinned CMake BuildWorkflow and verify every declared artifact",
        "rerun the complete CTest suite and preserve explicit baseline failure classifications",
        "run all candidate-specific cases for both baseline and candidate builds",
        "run sanitizer verification when HostPreflight reports a supported sanitizer",
      ],
    },
  });
  assertCandidateTestsExist(evidence.sourceRoot, task);
  return task;
}

// 最后的"事实核验"：声称存在的官方测试文件必须在 checkout 里真的存在且非空。
// Bun.file(path).size：Bun 的文件 API，size 为 0 或文件不存在都是假值 → 抛错。
// replaceAll("\\", "/")：把 Windows 反斜杠统一成正斜杠再拼路径。
function assertCandidateTestsExist(sourceRoot: string, task: RefactorTestTask): void {
  for (const candidate of task.candidates) {
    for (const sourceTest of candidate.source_tests) {
      const path = `${sourceRoot}/${sourceTest}`.replaceAll("\\", "/");
      if (!Bun.file(path).size) throw new Error(`declared libuv source test is missing or empty: ${sourceTest}`);
    }
  }
}
