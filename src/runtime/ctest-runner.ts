import { spawn, execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import type {
  CTestFailure,
  CTestSuiteResult,
  CTestSuiteSpec,
  HostPreflight,
} from "../artifacts/index.js";

export interface CTestRunOptions {
  repoDir: string;
  spec: CTestSuiteSpec;
  host: HostPreflight;
}

export interface ParsedCTestOutput {
  summary: { total: number; passed: number; failed: number; not_run: number };
  failedTests: CTestFailure[];
}

/** Run the CTest suite as one bounded process-tree operation. */
export async function runCTest(
  options: CTestRunOptions,
): Promise<CTestSuiteResult> {
  const ctest = options.host.tools.ctest;
  if (!ctest?.available || ctest.path === null) {
    return resultError("ctest is not available in HostPreflight", "environment");
  }

  const args = [
    "--test-dir",
    options.spec.build_dir,
    "-C",
    options.spec.configuration,
    "--output-on-failure",
    ...options.spec.extra_args,
  ];
  if (options.spec.parallelism !== null) args.push("-j", String(options.spec.parallelism));

  const started = Date.now();
  const child = spawn(ctest.path, args, {
    cwd: options.repoDir,
    env: { ...process.env, ...options.spec.environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child.pid);
  }, options.spec.timeout_ms);

  const exit = await new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code, error: null }));
  });
  clearTimeout(timer);

  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  const parsed = parseCTestOutput(`${out}\n${err}`);
  const duration = Date.now() - started;
  const common = {
    kind: "ctest-suite-result" as const,
    version: 1 as const,
    duration_ms: duration,
    summary: parsed.summary,
    failed_tests: parsed.failedTests,
    stdout_b64: Buffer.from(out).toString("base64"),
    stderr_b64: Buffer.from(err).toString("base64"),
  };

  if (timedOut) {
    return {
      ...common,
      status: "timeout",
      exit_code: null,
      failure: {
        category: "environment",
        explanation: `ctest exceeded timeout ${options.spec.timeout_ms}ms; process tree was terminated`,
      },
    };
  }
  if (exit.error !== null) {
    return {
      ...common,
      status: "error",
      exit_code: null,
      failure: { category: "environment", explanation: exit.error.message },
    };
  }

  const status = exit.code === 0 && parsed.summary.failed === 0 && parsed.summary.not_run === 0
    ? "pass"
    : "fail";
  return {
    ...common,
    status,
    exit_code: exit.code,
    failure: status === "pass"
      ? null
      : {
          category: parsed.summary.failed > 0 ? "test_failure" : "environment",
          explanation: parsed.summary.failed > 0
            ? `${parsed.summary.failed} CTest test(s) failed`
            : parsed.summary.not_run > 0
              ? `${parsed.summary.not_run} CTest test(s) were not run`
              : `ctest exited with code ${String(exit.code)}`,
        },
  };
}

export function parseCTestOutput(output: string): ParsedCTestOutput {
  const topLevel = parseTopLevelTests(output);
  return {
    summary: parseSummary(output, topLevel),
    failedTests: parseFailures(output),
  };
}

function parseTopLevelTests(output: string): Array<{ name: string; status: string }> {
  const tests: Array<{ name: string; status: string }> = [];
  const pattern = /^\s*\d+\/\d+\s+Test\s+#\d+:\s+(.+?)\s+\.*\*\*\*\s*([A-Za-z ]+?)\s+\d+(?:\.\d+)?\s*sec\s*$/gm;
  for (const match of output.matchAll(pattern)) {
    const name = match[1]?.trim();
    const status = match[2]?.trim().toLowerCase().replace(/\s+/g, "_");
    if (name && status) tests.push({ name, status });
  }
  return tests;
}

function parseSummary(
  output: string,
  topLevel: Array<{ name: string; status: string }>,
): ParsedCTestOutput["summary"] {
  const match = output.match(/^\s*(\d+)% tests passed, (\d+) tests failed out of (\d+)/im);
  const failedStatuses = new Set(["failed", "timeout", "exception", "segfault"]);
  const notRun = topLevel.filter((test) => test.status === "not_run").length;
  if (!match) {
    const failed = topLevel.filter((test) => failedStatuses.has(test.status)).length;
    const passed = topLevel.filter((test) => test.status === "passed").length;
    return { total: topLevel.length, passed, failed, not_run: notRun };
  }
  const failed = Number(match[2]);
  const total = Number(match[3]);
  return { total, passed: total - failed, failed, not_run: notRun };
}

function parseFailures(output: string): CTestFailure[] {
  const names: string[] = [];
  const outputByTarget = new Map<string, string>();
  let activeTarget: string | null = null;
  let activeLines: string[] = [];
  const flush = (): void => {
    if (activeTarget !== null) outputByTarget.set(activeTarget, activeLines.join("\n").trim());
    activeLines = [];
  };

  for (const line of output.split(/\r?\n/)) {
    const start = line.match(/^\s*Start\s+\d+:\s*(.+?)\s*$/i);
    if (start?.[1]) {
      flush();
      activeTarget = start[1].trim();
      continue;
    }
    if (activeTarget !== null) activeLines.push(line);
    const tap = line.match(/^not ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/i);
    if (tap?.[1]) {
      const name = tap[1].trim();
      names.push(activeTarget === null ? name : `${activeTarget}:${name}`);
    }
  }
  flush();

  const marker = output.indexOf("The following tests FAILED:");
  if (marker >= 0) {
    for (const line of output.slice(marker).split(/\r?\n/).slice(1)) {
      const name = line.match(/^\s*\d+\s*-\s*(.*?)\s+\(/)?.[1]?.trim();
      if (name) names.push(name);
    }
  }

  return [...new Set(names)].map((name) => {
    const separator = name.indexOf(":");
    const target = separator < 0 ? name : name.slice(0, separator);
    return { name, output: outputByTarget.get(target) ?? "" };
  });
}

function resultError(explanation: string, category: "environment" | "unknown"): CTestSuiteResult {
  return {
    kind: "ctest-suite-result",
    version: 1,
    status: "error",
    exit_code: null,
    duration_ms: 0,
    summary: { total: 0, passed: 0, failed: 0, not_run: 0 },
    failed_tests: [],
    stdout_b64: "",
    stderr_b64: Buffer.from(explanation).toString("base64"),
    failure: { category, explanation },
  };
}

function terminateTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // The process may have exited between timeout and cleanup.
  }
}
