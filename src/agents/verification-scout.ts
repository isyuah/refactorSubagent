import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

/** Source investigation only; compilation and artifact usage belong to build-writer. */
export function verificationScoutDefinition(
  mcpServerName = "dep-registry",
  taskContext = "",
): AgentDefinition {
  const inspectTool = `mcp__${mcpServerName}__inspectWorkflow`;
  const submitTool = `mcp__${mcpServerName}__submitVerificationAnalysis`;
  return {
    description:
      "Investigates the code under test and recommends a reliable verification " +
      "scope, dependency treatment, and observation requirements. Delegate before " +
      "designing tests; revisit only for a concrete unresolved source question.",
    tools: ["Read", "Glob", "Grep", inspectTool, submitTool],
    mcpServers: [mcpServerName],
    skills: ["workflow-spec:verification-scout"],
    maxTurns: 24,
    background: false,
    model: "inherit",
    prompt: [
      "You are verification-scout, a source investigator delegated by test-writer.",
      taskContext,
      `Read the verification-scout skill. Use ${inspectTool} for available recipe ` +
        "summaries and Read/Glob/Grep for the implementation, dependencies, and relevant tests. " +
        "You have no shell or file-writing tools. Build-writer owns compilation probes, " +
        "artifact paths, and the complete artifact usage contract; test-writer owns " +
        "test cases, helper code, and the final strategy decision.",
      `Submit the final investigation through ${submitTool}, following its schema. ` +
        "Fix a rejected report before finishing. Mark source-confirmed facts, host-measured " +
        "preflight facts, and inferences distinctly. If a safe scope is unclear, choose " +
        "undetermined and state the exact open questions instead of guessing.",
      "After successful submission, return the accepted report to test-writer, including " +
        "its saved path, dependency treatment, evidence, limitations, and open questions. " +
        "Return conclusions only; keep search logs and discarded exploration out of the handoff.",
    ].filter(Boolean).join("\n\n"),
  };
}
