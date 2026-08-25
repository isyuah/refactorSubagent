/**
 * Prompts for the Claude capability modules. The prompts describe intent and
 * output format; ALL validation happens programmatically in the orchestrator.
 */

export const ANALYZE_SYSTEM = `You are the analysis module of a behavior-preserving C refactoring system.
You inspect a C project and propose verification artifacts. You never modify files.

Return one JSON object with exactly these top-level keys: contract, scope, deps, tests, env.
The host validates the object strictly. Use these exact shapes:

contract: { kind: "behavior-contract", version: 1,
  channels: { exit_code: {mode, comparator?}, signals: {mode, comparator?}, stdout: {mode, comparator?}, stderr: {mode, comparator?}, filesystem: {mode, comparator?} },
  allowed_change: { internal_structure: boolean, execution_time: true }, notes: [] }
Modes are exact, semantic, normalize, or ignore. Semantic requires comparator "fs-effects-v1".

scope: { kind: "scope-manifest", version: 1,
  editable_files: [{file: "repo-relative/path.c", symbols: ["function"]}],
  readable_globs: ["src/**"], forbidden_globs: [] }

deps: { kind: "dependency-manifest", version: 1, dependencies: [
  {name, kind: pure|time|randomness|filesystem|env|network|stateful_external|concurrency,
   strategy: real_isolated|freeze|seed|temp_sandbox|record_replay|fake|mock|reject,
   evidence: [], notes: ""} ] }

tests: { kind: "test-spec", version: 1, cases: [
  {id, kind: regression|differential, argv: ["program", "arg"], stdin: "", fixtures: [], expect_exit_code?} ] }
Include at least one differential case, unique ids, and expect_exit_code on every regression case.

env: { kind: "environment-spec", version: 1,
  build: {kind: "direct-compiler", compiler: "gcc", flags: [], defines: {}, sources: ["src/main.c"], output: "build/app"},
  determinism: {frozen_time_epoch_ms: number|null, random_seed: number|null, intercept_headers: []},
  sandbox: {run_cwd_strategy: "fresh_temp_dir"} }

Use direct-compiler whenever the project can be built from explicit C sources. Do not emit shell commands, mkdir, cc aliases, platform-specific executable suffixes, or compiler include flags for determinism headers; the host injects declared intercept_headers and creates output directories. The compiler name must be one of the measured available tools.

Be conservative. Cover normal, boundary, empty, invalid, and Unicode input where the program accepts text. Tests and baseline/** belong in forbidden_globs.`;

export function analyzePrompt(extra?: string, hostContext?: string): string {
  return [
    "Analyze this C project and produce the JSON artifact proposal.",
    hostContext ? `\nMeasured host environment:\n${hostContext}` : "",
    extra ? `\nTask context:\n${extra}` : "",
  ].join("\n");
}


export const REFACTOR_SYSTEM = `You are the refactoring module of a behavior-preserving refactoring system.
You restructure C code while keeping externally observable behavior identical.

Allowed: extract functions, simplify control flow, remove duplication, safe renames of statics, provably safe optimizations.
Forbidden: changing APIs/data formats/exit codes/output bytes, adding caching or concurrency, algorithm replacement.
If you cannot prove a change is safe under the contract, STOP and say so instead of guessing.

Do NOT run git commands. Do NOT touch any file outside the Modification Scope — writes outside it are blocked by the system.
When done, reply with a one-paragraph summary of what changed.`;

export function refactorPrompt(task: string, editableFiles: readonly string[]): string {
  return [
    `Modification Scope (the ONLY files you may edit): ${editableFiles.join(", ")}`,
    `Task: ${task}`,
    `Work from the current directory; it already IS the candidate worktree.`,
  ].join("\n");
}
