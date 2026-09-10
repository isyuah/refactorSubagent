import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  Artifact,
  type AnyArtifact,
  ObservationTrace,
  HostPreflight,
  ProjectDetection,
} from "../artifacts/index.js";
/**
 * SessionStore — durable state for one refactoring attempt.
 *
 * Layout under <root>/.refactor/sessions/<session_id>/:
 *   state.json            current state + full transition history
 *   artifacts/<stem>.json one file per artifact (traces: per build)
 */

export const SessionState = z.enum([
  "INIT",
  "CONTRACT_READY",
  "DEPENDENCY_READY",
  "TESTS_READY",
  "BUILD_WORKFLOW_READY",
  "TEST_WORKFLOW_READY",
  "ENV_READY",
  "BASELINE_READY",
  "PATCH_CREATED",
  "VERIFICATION_RUNNING",
  "ACCEPTED",
  "REJECTED",
  "ABORTED",
]);
export type SessionState = z.infer<typeof SessionState>;

const HistoryEntry = z.object({
  from: SessionState,
  to: SessionState,
  artifact_kind: z.string().nullable(),
  at: z.string(),
  note: z.string().default(""),
});

const SessionFile = z.object({
  session_id: z.string().min(1),
  created_at: z.string(),
  state: SessionState,
  history: z.array(HistoryEntry),
});

type SessionFile = z.infer<typeof SessionFile>;

export class SessionStore {
  readonly sessionDir: string;
  private file: SessionFile;

  private constructor(sessionDir: string, file: SessionFile) {
    this.sessionDir = sessionDir;
    this.file = file;
  }

  /** Create a fresh session directory. */
  static create(root: string, sessionId: string): SessionStore {
    const sessionDir = join(root, ".refactor", "sessions", sessionId);
    if (existsSync(sessionDir)) throw new Error(`session exists: ${sessionId}`);
    const file: SessionFile = {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      state: "INIT",
      history: [],
    };
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    return new SessionStore(sessionDir, file).persist();
  }

  /** Reopen an existing session (workflow recovery). */
  static open(root: string, sessionId: string): SessionStore {
    const sessionDir = join(root, ".refactor", "sessions", sessionId);
    const path = join(sessionDir, "state.json");
    if (!existsSync(path)) {
      throw new Error(`session not found: ${sessionId}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`unreadable state.json in session ${sessionId}: ${detail}`);
    }

    const parsed = SessionFile.safeParse(raw);
    if (!parsed.success) {
      // A state this build does not define means the file was written by an
      // older build (states are removed, never renamed): report that instead
      // of calling the file corrupt. Resume still fails — fail closed.
      const removed = removedStates(parsed.error);
      if (removed.length > 0) {
        throw new Error(
          `session ${sessionId} was written by an older build and cannot be resumed: ` +
            `state.json references removed state(s) ${removed.join(", ")}`,
        );
      }
      const issue = parsed.error.issues[0];
      throw new Error(
        `corrupt state.json in session ${sessionId}: ${issue?.message ?? "schema mismatch"}`,
      );
    }
    return new SessionStore(sessionDir, parsed.data);
  }

  get id(): string {
    return this.file.session_id;
  }

  get state(): SessionState {
    return this.file.state;
  }

  get history(): readonly z.infer<typeof HistoryEntry>[] {
    return this.file.history;
  }

  /** Storage file stem: build/test resolutions and build-scoped artifacts stay distinct. */
  private static storageStem(a: AnyArtifact): string {
    if (a.kind === "observation-trace") {
      return `${a.kind}.${a.build}`;
    }
    if (a.kind === "workflow-resolution") {
      return `${a.kind}.${a.workflow_kind}`;
    }
    return a.kind;
  }

  /** Load one uniquely named artifact; build/test resolutions use workflowResolution(). */
  artifact<K extends AnyArtifact["kind"]>(
    kind: K,
  ): Extract<AnyArtifact, { kind: K }> | null {
    if (kind === "workflow-resolution") return null;
    const stem = kind === "observation-trace" ? `${kind}.baseline` : kind;
    const path = join(this.sessionDir, "artifacts", `${stem}.json`);
    if (!existsSync(path)) return null;
    return Artifact.parse(JSON.parse(readFileSync(path, "utf8"))) as Extract<
      AnyArtifact,
      { kind: K }
    >;
  }

  /** Load a persisted Workflow resolution by its explicit workflow kind. */
  workflowResolution(
    workflowKind: "build" | "test",
  ): Extract<AnyArtifact, { kind: "workflow-resolution" }> | null {
    const path = join(
      this.sessionDir,
      "artifacts",
      `workflow-resolution.${workflowKind}.json`,
    );
    if (!existsSync(path)) return null;
    return Artifact.parse(JSON.parse(readFileSync(path, "utf8"))) as Extract<
      AnyArtifact,
      { kind: "workflow-resolution" }
    >;
  }

  /** Load the stored observation trace for one build; null if absent. */
  trace(build: "baseline" | "candidate"): ObservationTrace | null {
    const path = join(
      this.sessionDir,
      "artifacts",
      `observation-trace.${build}.json`,
    );
    if (!existsSync(path)) return null;
    return ObservationTrace.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  /** Persist measured host facts outside the Artifact state transition union. */
  saveHostPreflight(raw: unknown): HostPreflight {
    const parsed = HostPreflight.parse(raw);
    writeFileSync(
      join(this.sessionDir, "artifacts", "host-preflight.json"),
      JSON.stringify(parsed, null, 2) + "\n",
    );
    return parsed;
  }

  /** Load measured host facts for workflow recovery. */
  hostPreflight(): HostPreflight | null {
    const path = join(this.sessionDir, "artifacts", "host-preflight.json");
    if (!existsSync(path)) return null;
    return HostPreflight.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  /** Persist project build-system detection separately from workflow Artifacts. */
  saveProjectDetection(raw: unknown): ProjectDetection {
    const parsed = ProjectDetection.parse(raw);
    writeFileSync(
      join(this.sessionDir, "artifacts", "project-detection.json"),
      JSON.stringify(parsed, null, 2) + "\n",
    );
    return parsed;
  }

  projectDetection(): ProjectDetection | null {
    const path = join(this.sessionDir, "artifacts", "project-detection.json");
    if (!existsSync(path)) return null;
    return ProjectDetection.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  /** Validate then durably store an artifact (no state transition — orchestrator decides that). */
  saveArtifact(raw: unknown): AnyArtifact {
    const parsed = Artifact.parse(raw);
    writeFileSync(
      join(
        this.sessionDir,
        "artifacts",
        `${SessionStore.storageStem(parsed)}.json`,
      ),
      JSON.stringify(parsed, null, 2) + "\n",
    );
    return parsed;
  }
  /** Record a completed transition and persist. Only the orchestrator calls this. */
  commitTransition(to: SessionState, artifactKind: string | null, note = "") {
    this.file = {
      ...this.file,
      state: to,
      history: [
        ...this.file.history,
        {
          from: this.file.state,
          to,
          artifact_kind: artifactKind,
          at: new Date().toISOString(),
          note,
        },
      ],
    };
    this.persist();
  }

  private persist(): this {
    writeFileSync(
      join(this.sessionDir, "state.json"),
      JSON.stringify(this.file, null, 2) + "\n",
    );
    return this;
  }
}

/**
 * Session states referenced by state.json that this build does not define.
 * Every enum field in the file is a session state, so an invalid enum value
 * always means a state removed by a newer build, not corruption.
 */
function removedStates(error: z.ZodError): string[] {
  const names = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === "invalid_enum_value") names.add(String(issue.received));
  }
  return [...names].sort();
}
