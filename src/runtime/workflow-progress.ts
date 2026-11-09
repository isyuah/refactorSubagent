import { basename, join } from "node:path";
import type { E2ELogger } from "./log.js";
import type { CheckResult, ComparisonSummary, ExecutionContext, WorkflowProgressObserver } from "./progress.js";
import type { CTestComparisonResult } from "../artifacts/index.js";

/** Describe the comparator's actual observations without inventing passing tests. */
export function ctestProgressSummary(comparison: CTestComparisonResult): ComparisonSummary {
  const membership = (left: readonly string[], right: readonly string[], category: string): CheckResult[] =>
    [...new Set([...left, ...right])].map((name) => ({ name: `${category}/${name}`,
      matched: left.includes(name) === right.includes(name), reason: `${category}在两侧的成员关系`,
      baseline: left.includes(name), candidate: right.includes(name) }));
  const checks = [
    { name: "CTest 状态", matched: comparison.baseline_status === comparison.candidate_status,
      reason: "两侧 CTest 整体状态", baseline: comparison.baseline_status, candidate: comparison.candidate_status },
    ...membership(comparison.baseline_top_level_tests, comparison.candidate_top_level_tests, "顶层目标"),
    ...membership(comparison.baseline_failed_tests, comparison.candidate_failed_tests, "失败集合"),
  ];
  return { overall: comparison.overall, total: checks.length, matched: checks.filter((item) => item.matched).length,
    mismatched: checks.filter((item) => !item.matched).length, reason: comparison.reason, checks, errors: [],
    warnings: comparison.warnings,
    evidence_paths: ["ctest-comparison-result.json", "ctest-baseline.json", "ctest-candidate.json"] };
}

/** Store native output once and forward it with the side/build that owns it. */
export function workflowProgress(logger: E2ELogger | undefined, context: ExecutionContext): WorkflowProgressObserver {
  return (update) => {
    if (!logger) return;
    if (update.type === "command-output") {
      logger.appendLogFile(basename(context.log_path), update.text);
    }
    logger.progress({ ...update, context });
  };
}

export function nativeLogPath(logger: E2ELogger | undefined, name: string): string {
  logger?.logFile(name, "");
  return logger ? join(logger.logsDir, name) : name;
}
