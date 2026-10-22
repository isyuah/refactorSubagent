import type { VerificationAnalysis } from "../../src/agents/verification-analysis.js";

/** A submitted report fixture, not a simulated claim about an AI's decision quality. */
export function analysisReport(): VerificationAnalysis {
  return {
    subject: "src/main.c: main",
    recommendation: {
      strategy: "source-harness",
      rationale: "The entry point has no dependencies and its exit behavior is directly observable.",
      alternatives: ["Use the project runner if integration coverage becomes necessary."],
    },
    behaviors: ["Exit status of the real main implementation"],
    dependencies: [],
    evidence: [{ basis: "source", reference: "src/main.c:1 main", finding: "main returns 0 without dependencies." }],
    limitations: ["Does not establish whole-project integration coverage."],
    openQuestions: [],
  };
}
