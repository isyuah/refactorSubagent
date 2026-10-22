/** Test-only entry into the real scout definition. No writer or build session. */
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runAgent, type DriverOptions, type DriverRun } from "../../src/agents/driver.js";
import { verificationScoutDefinition } from "../../src/agents/verification-scout.js";
import { VerificationAnalysisStore } from "../../src/agents/verification-analysis.js";
import { workflowPreflightContext } from "../../src/agents/workflow-facts.js";
import { LocalDependencyRegistry } from "../../src/agents/dep-registry.js";
import { createDependencyMcpServer } from "../../src/agents/dep-registry-server.js";
import { probeHost } from "../../src/runtime/host-preflight.js";
import { detectCProject } from "../../src/runtime/project-detector.js";
import { FileSessionStore } from "../../src/runtime/session-store.js";
import { ScoutOptionsSchema, sha256, type ScoutInput, type ScoutOptions, type ScoutResult } from "./scout-contract.js";
import { ensureDir, readJson, writeJson } from "./util.js";

/** Small, complete source fixtures only. Never silently truncate judge evidence. */
export function snapshotScoutSources(root: string): ScoutInput["sources"] {
  const files: ScoutInput["sources"] = [];
  let bytes = 0;
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`scout fixtures must not contain symlinks: ${path}`);
      if (stat.isDirectory()) { walk(path); continue; }
      if (!stat.isFile()) throw new Error(`unsupported scout fixture entry: ${path}`);
      if (stat.size > 64 * 1024 || files.length >= 100 || (bytes += stat.size) > 512 * 1024) {
        throw new Error(`scout fixture exceeds complete snapshot budget: ${path}`);
      }
      const buffer = readFileSync(path);
      const content = buffer.toString("utf8");
      if (content.includes("\0") || !buffer.equals(Buffer.from(content, "utf8"))) {
        throw new Error(`scout fixtures must contain UTF-8 text only: ${path}`);
      }
      files.push({ path: relative(root, path).split(sep).join("/"), content, sha256: sha256(content) });
    }
  };
  walk(root);
  if (files.length === 0) throw new Error("scout fixture has no source files");
  return files;
}

export interface ScoutSessionOptions {
  repo: string;
  task: string;
  output: string;
  scout?: Partial<ScoutOptions>;
}

export async function runScoutSession(
  request: ScoutSessionOptions,
  runAgentFn: (options: DriverOptions) => Promise<DriverRun> = runAgent,
): Promise<ScoutResult> {
  const started = Date.now();
  const repo = resolve(request.repo);
  const output = resolve(request.output);
  const inside = relative(repo, output);
  if (inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))) {
    throw new Error("scout evidence directory must be outside the repository");
  }
  ensureDir(output);
  const options = ScoutOptionsSchema.parse(request.scout ?? {});
  const sources = snapshotScoutSources(repo);
  const host = probeHost(repo);
  const project = detectCProject(repo);
  const definition = verificationScoutDefinition("dep-registry", `Task under test:\n${request.task}\n\n${workflowPreflightContext(host, project)}`);
  const skillPath = resolve(import.meta.dir, "../../.claude/plugins/workflow-spec/skills/verification-scout/SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  // AgentDefinition.skills preloads content for subagents. The main-session
  // options.skills only filters discovery, so preload the same bytes explicitly
  // when evaluating the role without a parent/writer session.
  const systemPrompt = `${definition.prompt}\n\n<preloaded-skill name="workflow-spec:verification-scout">\n${skill}\n</preloaded-skill>`;
  const input: ScoutInput = {
    version: 1, task: request.task, preflight: { host, project }, sources,
    agent: {
      prompt: systemPrompt, tools: definition.tools!, skills: definition.skills!, options,
      skill: { path: ".claude/plugins/workflow-spec/skills/verification-scout/SKILL.md", content: skill, sha256: sha256(skill) },
    },
  };
  writeJson(join(output, "scout-input.json"), input);
  const analysisPath = join(output, "scout-analysis.json");
  const store = new VerificationAnalysisStore(analysisPath, request.task);
  const registry = new LocalDependencyRegistry({ workspaceRoot: repo, sessionRoot: output, sessionId: "scout-eval", host, project });
  const server = createDependencyMcpServer({ registry, verificationAnalysis: store });
  let run: DriverRun | null = null;
  let error: string | null = null;
  try {
    run = await runAgentFn({
      cwd: repo, systemPrompt,
      prompt: "Investigate the task under test and submit your verification analysis.",
      allowedTools: [...definition.tools!], skills: [...definition.skills!],
      maxTurns: options.maxTurns, model: options.model,
      timeoutMs: options.deadlineMs, stallTimeoutMs: options.stallMs,
      sessionStore: new FileSessionStore(join(output, "session")),
      mcpServers: { "dep-registry": server },
    });
    if (run.timedOut) error = "scout timed out";
    else if (run.isError) error = "scout model session failed";
    else if (!store.hasSubmission()) error = "scout finished without a report accepted by submitVerificationAnalysis";
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    store.close();
  }
  let sourceChanges: string[] = [];
  let sourceIntegrity: ScoutResult["sourceIntegrity"] = "unverified";
  try {
    const after = new Map(snapshotScoutSources(repo).map(({ path, sha256 }) => [path, sha256]));
    const before = new Map(sources.map(({ path, sha256 }) => [path, sha256]));
    sourceChanges = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
    sourceIntegrity = sourceChanges.length ? "changed" : "unchanged";
  } catch (cause) {
    error = [error, `source integrity check failed: ${String(cause)}`].filter(Boolean).join("; ");
  }
  if (sourceChanges.length > 0) error = [error, `scout changed source: ${sourceChanges.join(", ")}`].filter(Boolean).join("; ");
  const report = store.hasSubmission() ? readJson<{ report: Record<string, unknown> }>(analysisPath).report : null;
  const result: ScoutResult = {
    version: 1, ok: error === null, timedOut: run?.timedOut ?? false, error,
    elapsedMs: Date.now() - started, submitted: store.hasSubmission(), sourceIntegrity, sourceChanges,
    report, summary: run?.result ?? "",
  };
  writeJson(join(output, "scout-result.json"), result);
  writeFileSync(join(output, "scout-summary.txt"), result.summary, "utf8");
  return result;
}
