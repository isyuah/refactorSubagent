import { z } from "zod";
import { B64, RelPath } from "./common.js";

/**
 * Test Spec — regression tests + differential input set.
 * For C MVP every case is one invocation of the built binary.
 */
export const TestCase = z.object({
  id: z.string().min(1),
  kind: z.enum(["regression", "differential"]),
  /** argv is passed to CreateProcess/exec; NUL cannot cross that boundary. */
  argv: z.array(
    z.string().refine((value) => !value.includes("\0"), {
      message: "argv values cannot contain NUL bytes",
    }),
  ),
  stdin: B64.default(""),
  /** Files materialized into the fresh run cwd before execution. */
  fixtures: z
    .array(z.object({ path: RelPath, content_b64: B64 }))
    .default([]),
  /** Regression-only expectation; differential cases compare against baseline instead. */
  expect_exit_code: z.number().int().optional(),
});

/** ids unique + regression cases carry an expectation. */
export const TestSpec = z
  .object({
    kind: z.literal("test-spec"),
    version: z.literal(1),
    cases: z.array(TestCase).min(1),
  })
  .refine(
    (s) =>
      s.cases.some((c) => c.kind === "differential") &&
      new Set(s.cases.map((c) => c.id)).size === s.cases.length &&
      s.cases.every(
        (c) => c.kind === "differential" || c.expect_exit_code !== undefined,
      ),
    {
      message:
        "need ≥1 differential case, unique case ids, and expectations on all regression cases",
    },
  );

export type TestSpec = z.infer<typeof TestSpec>;
