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

export type CTestSuiteSpec = z.infer<typeof CTestSuiteSpec>;
export type CTestSummary = z.infer<typeof CTestSummary>;
export type CTestFailure = z.infer<typeof CTestFailure>;
export type CTestSuiteResult = z.infer<typeof CTestSuiteResult>;
