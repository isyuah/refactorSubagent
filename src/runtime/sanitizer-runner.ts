import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type {
  EnvironmentSpec,
  HostPreflight,
  SanitizerFinding,
  SanitizerKind,
  SanitizerResult,
  TestSpec,
} from "../artifacts/index.js";
import type { BuildResult } from "./build-adapter.js";
import { resolveBinaryPath } from "./build-adapter.js";

const DEFAULT_CASE_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_MARKERS: Record<SanitizerKind, RegExp[]> = {
  address: [/AddressSanitizer/i],
  undefined: [/UndefinedBehaviorSanitizer/i, /runtime error:/i],
};

interface CaseExecution {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface SanitizerRunOptions {
  worktreeDir: string;
  env: EnvironmentSpec;
  spec: TestSpec;
  build: "baseline" | "candidate";
  envId: string;
  host: HostPreflight;
  buildResult?: BuildResult;
  caseTimeoutMs?: number;
}

/**
 * Execute an already-built sanitizer-instrumented binary against every case.
 * Sanitizer diagnostics are evidence, not ordinary stderr differences.
 */
export function runSanitizers(options: SanitizerRunOptions): SanitizerResult {
  const requested = options.env.sanitizers;
  if (requested.length === 0) {
    throw new Error("runSanitizers requires at least one requested sanitizer");
  }

  const base = {
    kind: "sanitizer-result" as const,
    version: 1 as const,
    build: options.build,
    env_id: options.envId,
    requested,
    duration_ms: 0,
    case_results: [],
    findings: [],
    stdout_b64: "",
    stderr_b64: "",
  };

  const unsupported = requested
    .map((kind) => ({ kind, capability: options.host.sanitizers[kind] }))
    .filter(({ capability }) => capability?.available !== true);
  if (unsupported.length > 0) {
    const explanation = unsupported
      .map(({ kind, capability }) => `${kind}: ${capability?.reason ?? "not measured"}`)
      .join("; ");
    return {
      ...base,
      status: "unsupported",
      exit_code: null,
      failure: { category: "unsupported", explanation },
    };
  }

  if (options.buildResult !== undefined && !options.buildResult.ok) {
    return {
      ...base,
      status: "build_failure",
      exit_code: null,
      stderr_b64: Buffer.from(options.buildResult.log).toString("base64"),
      failure: {
        category: "build_failure",
        explanation: "sanitizer-instrumented build failed",
      },
    };
  }

  const binaryAbs = options.buildResult?.binaryAbs ?? resolveBinaryPath(options.worktreeDir, options.env);
  if (!existsSync(binaryAbs)) {
    return {
      ...base,
      status: "build_failure",
      exit_code: null,
      failure: {
        category: "build_failure",
        explanation: `sanitizer binary does not exist: ${binaryAbs}`,
      },
    };
  }

  const started = Date.now();
  const timeout = options.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const caseResults: SanitizerResult["case_results"] = [];
  const findings: SanitizerFinding[] = [];
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];

  for (const testCase of options.spec.cases) {
    const runDir = mkdtempSync(join(tmpdir(), "rfsanitize-"));
    try {
      for (const fixture of testCase.fixtures) {
        const destination = join(runDir, fixture.path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, Buffer.from(fixture.content_b64, "base64"));
      }

      const args = testCase.argv.slice(1);
      const execution = args.some((arg) => arg.includes("\0"))
        ? invalidArgumentExecution()
        : executeCase(binaryAbs, args, runDir, testCase.stdin, timeout);
      const output = `${execution.stdout}\n${execution.stderr}`;
      const diagnosticFindings = parseSanitizerDiagnostics(testCase.id, requested, output);
      findings.push(...diagnosticFindings);
      stdoutParts.push(`[${testCase.id}]\n${execution.stdout}`);
      stderrParts.push(`[${testCase.id}]\n${execution.stderr}`);

      const expectedExit = testCase.kind === "regression"
        ? testCase.expect_exit_code
        : undefined;
      const exitMatches = expectedExit === undefined || execution.status === expectedExit;
      const status = diagnosticFindings.length > 0
        ? "finding"
        : execution.timedOut
          ? "timeout"
          : execution.status === null || !exitMatches
            ? "runtime_failure"
            : "observed";

      caseResults.push({
        case_id: testCase.id,
        status,
        exit_code: execution.timedOut ? null : execution.status,
        stdout_b64: Buffer.from(execution.stdout).toString("base64"),
        stderr_b64: Buffer.from(execution.stderr).toString("base64"),
        duration_ms: execution.timedOut ? timeout : execution.durationMs,
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  const duration = Date.now() - started;
  const timedOut = caseResults.some((result) => result.status === "timeout");
  const runtimeFailure = caseResults.some((result) => result.status === "runtime_failure");
  const status = findings.length > 0
    ? "findings"
    : timedOut
      ? "timeout"
      : runtimeFailure
        ? "runtime_failure"
        : "pass";
  const failure = status === "pass"
    ? null
    : status === "findings"
      ? {
          category: "diagnostic" as const,
          explanation: `${findings.length} sanitizer diagnostic(s) found`,
        }
      : status === "timeout"
        ? {
            category: "timeout" as const,
            explanation: `one or more sanitizer cases exceeded ${timeout}ms`,
          }
        : {
            category: "runtime_failure" as const,
            explanation: "one or more sanitizer cases failed without a sanitizer diagnostic",
          };

  return {
    ...base,
    status,
    exit_code: caseResults.length === 1 ? caseResults[0]!.exit_code : null,
    duration_ms: duration,
    case_results: caseResults,
    findings,
    stdout_b64: Buffer.from(stdoutParts.join("\n")).toString("base64"),
    stderr_b64: Buffer.from(stderrParts.join("\n")).toString("base64"),
    failure,
  };
}

function invalidArgumentExecution(): CaseExecution {
  return {
    status: null,
    stdout: "",
    stderr: "argv contains NUL bytes",
    timedOut: false,
    durationMs: 0,
  };
}

function executeCase(
  binaryAbs: string,
  args: string[],
  cwd: string,
  stdin: string,
  timeout: number,
): CaseExecution {
  const started = Date.now();
  const result = spawnSync(binaryAbs, args, {
    cwd,
    encoding: "utf8",
    timeout,
    input: Buffer.from(stdin, "base64"),
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const timedOut = String((result.error as NodeJS.ErrnoException | undefined)?.code ?? "") === "ETIMEDOUT";
  return {
    status: timedOut ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.error && !timedOut
      ? `${result.stderr ?? ""}${String(result.error)}`
      : result.stderr ?? (timedOut ? `timeout after ${timeout}ms` : ""),
    timedOut,
    durationMs: Date.now() - started,
  };
}

export function parseSanitizerDiagnostics(
  caseId: string,
  requested: readonly SanitizerKind[],
  output: string,
): SanitizerFinding[] {
  const findings: SanitizerFinding[] = [];
  for (const sanitizer of requested) {
    const marker = DIAGNOSTIC_MARKERS[sanitizer].find((pattern) => pattern.test(output));
    if (!marker) continue;
    const message = output
      .split(/\r?\n/)
      .find((line) => marker.test(line))
      ?.trim()
      .slice(0, 500) ?? `${sanitizer} diagnostic detected`;
    findings.push({ case_id: caseId, sanitizer, message });
  }
  return findings;
}
