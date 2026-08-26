import { z } from "zod";
import { B64 } from "./common.js";

export const SanitizerKind = z.enum(["address", "undefined"]);
export type SanitizerKind = z.infer<typeof SanitizerKind>;

/** Measured compiler capability; availability is never inferred from a flag name. */
export const SanitizerCapability = z.object({
  available: z.boolean(),
  compiler: z.string().nullable(),
  flags: z.array(z.string()),
  reason: z.string().min(1),
});
export type SanitizerCapability = z.infer<typeof SanitizerCapability>;

export const SanitizerFinding = z.object({
  case_id: z.string().min(1),
  sanitizer: SanitizerKind,
  message: z.string().min(1),
});
export type SanitizerFinding = z.infer<typeof SanitizerFinding>;

export const SanitizerCaseResult = z.object({
  case_id: z.string().min(1),
  status: z.enum(["observed", "finding", "runtime_failure", "timeout"]),
  exit_code: z.number().int().nullable(),
  stdout_b64: B64,
  stderr_b64: B64,
  duration_ms: z.number().nonnegative(),
});
export type SanitizerCaseResult = z.infer<typeof SanitizerCaseResult>;

export const SanitizerResult = z
  .object({
    kind: z.literal("sanitizer-result"),
    version: z.literal(1),
    build: z.enum(["baseline", "candidate"]),
    env_id: z.string().min(1),
    requested: z.array(SanitizerKind).min(1),
    status: z.enum([
      "pass",
      "findings",
      "unsupported",
      "build_failure",
      "runtime_failure",
      "timeout",
    ]),
    exit_code: z.number().int().nullable(),
    duration_ms: z.number().nonnegative(),
    case_results: z.array(SanitizerCaseResult).default([]),
    findings: z.array(SanitizerFinding).default([]),
    stdout_b64: B64,
    stderr_b64: B64,
    failure: z
      .object({
        category: z.enum([
          "diagnostic",
          "unsupported",
          "build_failure",
          "runtime_failure",
          "timeout",
          "unknown",
        ]),
        explanation: z.string().min(1),
      })
      .nullable(),
  })
  .refine(
    (result) => result.status !== "findings" || result.findings.length > 0,
    { message: "findings status requires at least one sanitizer finding" },
  )
  .refine(
    (result) => result.status === "pass" ? result.failure === null : result.failure !== null,
    { message: "non-pass sanitizer results require an explicit failure" },
  );

export type SanitizerResult = z.infer<typeof SanitizerResult>;
