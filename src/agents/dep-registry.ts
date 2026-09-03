import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
import { discoverBuildWorkflows } from "../workflow/registry.js";

/**
 * dep-registry — host-side dependency registry for the subagent-driven
 * workflow flow. TestWorkflow writers inspect available BuildWorkflows
 * (persisted library + current run), declare their dependency set, and ask
 * the host to materialize new BuildWorkflow sources.
 *
 * The tool layer (MCP server binding) lives in dep-registry-server.ts; the
 * state/logic here is pure and unit-testable without Claude.
 */

export interface WorkflowLibraryItem {
  readonly id: string;
  readonly kind: "build" | "test";
  readonly revision: number;
  readonly status: "library-verified" | "library-draft" | "run-local";
  readonly description: string;
  readonly entry: string;
  readonly producedArtifacts: readonly string[];
  readonly appliesTo: {
    readonly build_systems: readonly string[];
    readonly platforms: readonly string[];
    readonly architectures: readonly string[];
    readonly required_tools: readonly string[];
  };
}

export interface RunLocalWorkflow {
  readonly id: string;
  readonly kind: "build" | "test";
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  /** Absolute path to the materialized source under the run dir. */
  readonly entry: string;
}

export interface InspectQuery {
  readonly kind: "build" | "test";
  /** Exact id, or omit/empty for listing all. */
  readonly id?: string;
}

export interface InspectResult {
  readonly items: WorkflowLibraryItem[];
}

export interface DeclareDependencyInput {
  /** Full dependency set (idempotent overwrite). Empty = explicit none. */
  readonly buildWorkflowIds: readonly string[];
}

export interface GenerateBuildWorkflowInput {
  readonly name: string;
  readonly description: string;
  /** Complete TypeScript source of a workflow-driven BuildWorkflow. */
  readonly content: string;
}

export interface GenerateBuildWorkflowResult {
  readonly workflowId: string;
  readonly revision: number;
  readonly lineCount: number;
  readonly description: string;
}

export interface DependencyRegistry {
  inspect(query: InspectQuery): Promise<InspectResult>;
  /** Declared build ids currently in effect (idempotent overwrite semantics). */
  declare(input: DeclareDependencyInput): Promise<readonly string[]>;
  generate(input: GenerateBuildWorkflowInput): Promise<GenerateBuildWorkflowResult>;
  /** Persisted + run-local ids known to this registry (for validation). */
  knownBuildIds(): Promise<readonly string[]>;
  /** True once declareDependency was called at least once (even with []). */
  declaredExplicitly(): Promise<boolean>;
}

export interface DependencyRegistryOptions {
  /** Absolute repo root containing the persisted library (.refactorsa). */
  readonly workspaceRoot: string;
  /** Absolute session root where run-local workflows are materialized. */
  readonly sessionRoot: string;
  /** Session id used for run-local directory naming. */
  readonly sessionId: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
}

const RUN_DIR = join(".refactor", "runs");
const WORKFLOW_DIR = "workflows";
const BUILD_DIR = "build";

function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "workflow"
  );
}

function safeRunLocalId(slugged: string, sessionId: string): string {
  const session = sessionId.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 12);
  return `${slugged}-${session}`;
}

/**
 * Validate a workflow-driven BuildWorkflow source string before
 * materialization. Mirrors source-policy (syntax, forbidden host imports,
 * workflowKind literal) without requiring the file to exist.
 */
export function validateBuildWorkflowSource(source: string): { ok: boolean; reason: string | null } {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "content must not be empty" };
  }
  const forbidden = [
    /from\s+["'](?:node:|bun:)/,
    /import\s*\(\s*["'](?:node:|bun:)/,
    /require\s*\(\s*["'](?:node:|bun:)/,
    /from\s*["'](?:fs|child_process|worker_threads|net|http|https|os|process)["']/,
    /(?<![\w.])process\s*\.(?!run\b|start\b|wait\b|stop\b)/,
    /(?<![\w.])Bun\s*\./,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: "workflow directly imports a host API; use injected capabilities instead" };
    }
  }
  if (!/export\s+const\s+workflowKind\s*=\s*["']workflow-driven["']/.test(trimmed)) {
    return {
      ok: false,
      reason: 'build workflow must declare export const workflowKind = "workflow-driven"',
    };
  }
  try {
    new Bun.Transpiler({ loader: "ts" }).transformSync(trimmed);
  } catch (error) {
    return { ok: false, reason: `workflow syntax transpilation failed: ${errorMessage(error)}` };
  }
  return { ok: true, reason: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registry over a persisted workflow library (discoverBuildWorkflows) plus
 * run-local materializations under sessionRoot/.refactor/runs/<session>/workflows.
 */
export class LocalDependencyRegistry implements DependencyRegistry {
  private readonly workspaceRoot: string;
  private readonly sessionRoot: string;
  private readonly sessionId: string;
  private readonly host?: HostPreflight;
  private readonly project?: ProjectDetection;
  private readonly runLocal = new Map<string, RunLocalWorkflow>();
  private declared: readonly string[] = [];
  private revisionCounter = new Map<string, number>();
  private declareCalled = false;

  constructor(options: DependencyRegistryOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.sessionRoot = resolve(options.sessionRoot);
    this.sessionId = options.sessionId;
    this.host = options.host;
    this.project = options.project;
    this.restoreRunLocal();
  }

  /** Recover run-local builds materialized on disk (host restarts/rebuilds registry). */
  private restoreRunLocal(): void {
    const dir = this.runLocalBuildDir();
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    } catch {
      return; // dir not created yet
    }
    for (const name of names) {
      const id = name.slice(0, -3);
      const entry = join(dir, name);
      try {
        const size = statSync(entry).size;
        if (size === 0) continue;
      } catch {
        continue;
      }
      if (this.runLocal.has(id)) continue;
      this.runLocal.set(id, {
        id,
        kind: "build",
        name: id,
        description: "",
        revision: 1,
        entry,
      });
    }
  }

  runLocalBuildDir(): string {
    return join(this.workspaceRoot, RUN_DIR, this.sessionId, WORKFLOW_DIR, BUILD_DIR);
  }

  private runLocalEntry(id: string): string {
    return join(this.runLocalBuildDir(), `${id}.ts`);
  }

  async inspect(query: InspectQuery): Promise<InspectResult> {
    const items: WorkflowLibraryItem[] = [];
    const kind = query.kind;

    if (kind === "build") {
      for (const candidate of discoverBuildWorkflows(
        this.workspaceRoot,
        this.host,
        this.project,
      )) {
        if (query.id !== undefined && candidate.manifest?.id !== query.id) continue;
        if (candidate.manifest === null) continue;
        items.push({
          id: candidate.manifest.id,
          kind: "build",
          revision: candidate.manifest.revision,
          status: candidate.manifest.status === "verified"
            ? "library-verified"
            : "library-draft",
          description: "",
          entry: candidate.entry ?? "",
          producedArtifacts: [],
          appliesTo: {
            build_systems: candidate.manifest.applies_to.build_systems,
            platforms: candidate.manifest.applies_to.platforms,
            architectures: candidate.manifest.applies_to.architectures,
            required_tools: candidate.manifest.applies_to.required_tools,
          },
        });
      }
      for (const runLocal of [...this.runLocal.values()]) {
        if (runLocal.kind !== "build") continue;
        if (query.id !== undefined && runLocal.id !== query.id) continue;
        items.push({
          id: runLocal.id,
          kind: "build",
          revision: runLocal.revision,
          status: "run-local",
          description: runLocal.description,
          entry: runLocal.entry,
          producedArtifacts: [],
          appliesTo: { build_systems: [], platforms: [], architectures: [], required_tools: [] },
        });
      }
    }

    items.sort((a, b) => a.id.localeCompare(b.id));
    return { items };
  }

  async knownBuildIds(): Promise<readonly string[]> {
    const ids = new Set<string>();
    for (const candidate of discoverBuildWorkflows(
      this.workspaceRoot,
      this.host,
      this.project,
    )) {
      if (candidate.manifest !== null) ids.add(candidate.manifest.id);
    }
    for (const runLocal of [...this.runLocal.values()]) {
      if (runLocal.kind === "build") ids.add(runLocal.id);
    }
    return [...ids].sort();
  }

  async declare(input: DeclareDependencyInput): Promise<readonly string[]> {
    this.declareCalled = true;
    const known = new Set(await this.knownBuildIds());
    const unknown = input.buildWorkflowIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `declareDependency: unknown build workflow id(s): ${unknown.join(", ")}. ` +
          `Known ids: ${known.size > 0 ? [...known].sort().join(", ") : "(none)"}`,
      );
    }
    this.declared = [...input.buildWorkflowIds];
    return [...this.declared];
  }

  async currentDeclared(): Promise<readonly string[]> {
    return [...this.declared];
  }

  async declaredExplicitly(): Promise<boolean> {
    return this.declareCalled;
  }

  /**
   * Materialize a run-local BuildWorkflow source. Validates content before
   * writing (fail-closed); idempotent create-or-replace by slug name.
   */
  async generate(input: GenerateBuildWorkflowInput): Promise<GenerateBuildWorkflowResult> {
    const content = input.content.trim();
    const checked = validateBuildWorkflowSource(content);
    if (!checked.ok) {
      throw new Error(`generateBuildWorkflow: invalid workflow source: ${checked.reason ?? "unknown"}`);
    }

    const slugged = slug(input.name);
    const id = safeRunLocalId(slugged, this.sessionId);
    const revision = (this.revisionCounter.get(id) ?? 0) + 1;
    this.revisionCounter.set(id, revision);

    mkdirSync(this.runLocalBuildDir(), { recursive: true });
    const target = this.runLocalEntry(id);
    writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    this.runLocal.set(id, {
      id,
      kind: "build",
      name: slugged,
      description: input.description,
      revision,
      entry: target,
    });

    const lineCount = content.split("\n").length;
    return { workflowId: id, revision, lineCount, description: input.description };
  }

  /** Resolve a declared build id to an absolute workflow entry, if known. */
  async resolveBuildEntry(id: string): Promise<{ entry: string; runLocal: boolean } | null> {
    const runLocal = this.runLocal.get(id);
    if (runLocal !== undefined) {
      return { entry: runLocal.entry, runLocal: true };
    }
    for (const candidate of discoverBuildWorkflows(
      this.workspaceRoot,
      this.host,
      this.project,
    )) {
      if (candidate.manifest?.id === id && candidate.entry !== null) {
        return { entry: candidate.entry, runLocal: false };
      }
    }
    return null;
  }
}
