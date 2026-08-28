import { z } from "zod";
import { B64, RelPath } from "./common.js";

export const CTestSuiteSpec = z.object({
  kind: z.literal("ctest-suite-spec"),
  version: z.literal(1),
  build_dir: RelPath,
  configuration: z.string().min(1).default("Debug"),
  timeout_ms: z.number().int().positive().default(600_000),
  parallelism: z.number().int().positive().nullable().default(null),
  extra_args: z.array(z.string()).default([]),
  environment: z.record(z.string()).default({}),
});

export const CTestSummary = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  not_run: z.number().int().nonnegative(),
});

export const CTestFailure = z.object({
  name: z.string().min(1),
  output: z.string().default(""),
});

export const CTestSuiteResult = z.object({
  kind: z.literal("ctest-suite-result"),
  version: z.literal(1),
  status: z.enum(["pass", "fail", "timeout", "error"]),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().nonnegative(),
  summary: CTestSummary,
  /** Top-level CTest targets observed in the process output. */
  top_level_tests: z.array(z.string().min(1)).default([]),
  failed_tests: z.array(CTestFailure),
  stdout_b64: B64,
  stderr_b64: B64,
  failure: z
    .object({
      category: z.enum(["environment", "test_failure", "unknown"]),
      explanation: z.string().min(1),
    })
    .nullable(),
});

export const CTestFailureClassification = z.object({
  test: z.string().min(1),
  category: z.enum(["environment", "preexisting_behavior", "scope_related", "unknown"]),
  related_to_scope: z.boolean(),
  explanation: z.string().min(1),
});

/** Baseline CTest evidence plus the program-owned failure classification. */
export const CTestBaseline = z
  .object({
    kind: z.literal("ctest-baseline"),
    version: z.literal(1),
    result: CTestSuiteResult,
    failure_classifications: z.array(CTestFailureClassification),
    notes: z.array(z.string().min(1)).default([]),
  })
  .superRefine((value, context) => {
    const failed = new Set(value.result.failed_tests.map((test) => test.name));
    if (failed.size === 0 && value.result.status !== "pass") failed.add("__suite__");
    const classified = new Set(value.failure_classifications.map((failure) => failure.test));
    for (const name of failed) {
      if (!classified.has(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failure_classifications"],
          message: `failed CTest target lacks classification: ${name}`,
        });
      }
    }
    for (const failure of value.failure_classifications) {
      if (!failed.has(failure.test)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failure_classifications"],
          message: `classification has no failed CTest target: ${failure.test}`,
        });
      }
    }
  });

/** Candidate CTest evidence kept separate from the baseline classification. */
export const CTestCandidate = z.object({
  kind: z.literal("ctest-candidate"),
  version: z.literal(1),
  result: CTestSuiteResult,
  notes: z.array(z.string().min(1)).default([]),
});

/** Program-owned comparison of the same TestWorkflow on baseline/candidate. */
export const CTestComparisonResult = z.object({
  kind: z.literal("ctest-comparison-result"),
  version: z.literal(1),
  baseline_status: CTestSuiteResult.shape.status,
  candidate_status: CTestSuiteResult.shape.status,
  baseline_top_level_tests: z.array(z.string().min(1)),
  candidate_top_level_tests: z.array(z.string().min(1)),
  baseline_failed_tests: z.array(z.string().min(1)),
  candidate_failed_tests: z.array(z.string().min(1)),
  added_failures: z.array(z.string().min(1)),
  removed_failures: z.array(z.string().min(1)),
  overall: z.enum(["consistent", "inconsistent"]),
  reason: z.string().min(1),
});

export type CTestSuiteSpec = z.infer<typeof CTestSuiteSpec>;
export type CTestSummary = z.infer<typeof CTestSummary>;
export type CTestFailure = z.infer<typeof CTestFailure>;
export type CTestSuiteResult = z.infer<typeof CTestSuiteResult>;
export type CTestFailureClassification = z.infer<typeof CTestFailureClassification>;
export type CTestBaseline = z.infer<typeof CTestBaseline>;
export type CTestCandidate = z.infer<typeof CTestCandidate>;
export type CTestComparisonResult = z.infer<typeof CTestComparisonResult>;
