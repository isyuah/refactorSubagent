import { z } from "zod";
import { CTestSummary, CTestSuiteSpec, type CTestSummary as CTestSummaryValue, type CTestSuiteSpec as CTestSuiteSpecValue } from "./ctest-suite.js";
import { RelPath } from "./common.js";

export const RefactorCandidate = z.object({
  file: RelPath,
  symbols: z.array(z.string().min(1)).min(1),
  source_tests: z.array(RelPath),
  verification: z.enum(["official-test-covered", "dedicated-harness-required"]),
  rationale: z.string().min(1),
});
export type RefactorCandidate = z.infer<typeof RefactorCandidate>;

export const RefactorTestCase = z.object({
  id: z.string().min(1),
  category: z.enum(["normal", "boundary", "empty", "invalid", "unicode"]),
  candidate_file: RelPath,
  candidate_symbol: z.string().min(1),
  source_test: RelPath.nullable(),
  scenario: z.string().min(1),
  expected_invariant: z.string().min(1),
});
export type RefactorTestCase = z.infer<typeof RefactorTestCase>;

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
      name: z.string().min(1),
      version: z.string().min(1),
      language: z.literal("c"),
      repository: z.string().url(),
    }),
    workflow: z.object({
      id: z.string().min(1),
      revision: z.number().int().positive(),
    }),
    baseline: z.object({
      status: z.enum(["pass", "fail", "unsupported"]),
      suite: CTestSuiteSpec,
      summary: CTestSummary,
      top_level_tests: z.array(z.string().min(1)).min(1),
      failure_classifications: z.array(BaselineFailureClassification),
      notes: z.array(z.string().min(1)),
    }),
    candidates: z.array(RefactorCandidate).min(1),
    test_plan: z.object({
      cases: z.array(RefactorTestCase).min(1),
      required_before_acceptance: z.array(z.string().min(1)).min(1),
    }),
  })
  .superRefine((task, context) => {
    const candidateFiles = new Set(task.candidates.map((candidate) => candidate.file));
    for (const testCase of task.test_plan.cases) {
      if (!candidateFiles.has(testCase.candidate_file)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["test_plan", "cases"],
          message: `test case references an undeclared candidate: ${testCase.candidate_file}`,
        });
      }
    }
    if (task.baseline.status === "fail" && task.baseline.failure_classifications.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseline", "failure_classifications"],
        message: "failed baseline requires explicit failure classifications",
      });
    }
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

export interface LibuvTaskEvidence {
  readonly sourceRoot: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly baselineSummary: CTestSummaryValue;
  readonly baselineTopLevelTests: readonly string[];
  readonly baselineFailures: readonly BaselineFailureClassification[];
}

/** Build the fixed low-risk libuv task from measured checkout evidence. */
export function createLibuvRefactorTask(evidence: LibuvTaskEvidence): RefactorTestTask {
  const task = RefactorTestTask.parse({
    kind: "refactor-test-task",
    version: 1,
    project: {
      name: "libuv",
      version: "v1.52.1",
      language: "c",
      repository: "https://github.com/libuv/libuv.git",
    },
    workflow: {
      id: evidence.workflowId,
      revision: evidence.workflowRevision,
    },
    baseline: {
      status: evidence.baselineSummary.failed > 0 ? "fail" : "pass",
      suite: {
        kind: "ctest-suite-spec",
        version: 1,
        build_dir: "build",
        configuration: "Debug",
        timeout_ms: 1_200_000,
        parallelism: 1,
        extra_args: [],
        environment: {},
      },
      summary: evidence.baselineSummary,
      top_level_tests: [...evidence.baselineTopLevelTests],
      failure_classifications: [...evidence.baselineFailures],
      notes: [
        "CTest baseline is a gate and must be rerun for every candidate.",
        "Environment-classified failures remain visible and cannot be silently ignored.",
      ],
    },
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
        verification: "dedicated-harness-required",
        rationale: "pure public version functions, but no dedicated test-version.c exists in this checkout",
      },
    ],
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
          source_test: null,
          scenario: "query public numeric and string version values",
          expected_invariant: "values match the v1.52.1 compile-time version macros",
        },
      ],
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

function assertCandidateTestsExist(sourceRoot: string, task: RefactorTestTask): void {
  for (const candidate of task.candidates) {
    for (const sourceTest of candidate.source_tests) {
      const path = `${sourceRoot}/${sourceTest}`.replaceAll("\\", "/");
      if (!Bun.file(path).size) throw new Error(`declared libuv source test is missing or empty: ${sourceTest}`);
    }
  }
}
