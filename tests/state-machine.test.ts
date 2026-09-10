import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { SessionStore } from "../src/orchestrator/store.js";
import {
  happyPath,
  trace,
  patch,
  comparison,
} from "./fixtures.js";

let orch: Orchestrator;
let store: SessionStore;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "rfr-"));
  const id = "s-" + Math.random().toString(36).slice(2, 8);
  store = SessionStore.create(root, id);
  orch = new Orchestrator(store);
});

/** Submit artifacts[0..n) of the happy path. */
function advance(n: number) {
  for (const a of happyPath().slice(0, n)) {
    const r = orch.submit(a);
    if (!r.ok) throw new Error(`setup failed: ${r.reason}`);
  }
}

describe("fail-closed state machine", () => {
  test("R1+R2: full legal path reaches ACCEPTED", () => {
    advance(8);
    expect(store.state).toBe("ACCEPTED");
    expect(store.history).toHaveLength(8);
  });

  test("R1: skipping a stage is rejected", () => {
    const r = orch.submit(happyPath()[1]!); // deps at INIT, contract missing
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("R1");
    expect(store.state).toBe("INIT");
  });

  test("R2: schema-invalid artifact is rejected without state change", () => {
    const r = orch.submit({ kind: "behavior-contract", version: 1 }); // no channels
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("schema");
    expect(store.state).toBe("INIT");
  });

  test("R3: unclassified baseline failure blocks; preexisting_behavior passes", () => {
    advance(4);
    const bad = trace("baseline", {
      observations: [
        {
          case_id: "d1",
          status: "error",
          exit_code: -1,
          signal: null,
          stdout_b64: "",
          stderr_b64: "",
          filesystem: [],
          duration_ms: 0,
        },
      ],
      failures: [
        {
          case_id: "d1",
          category: "unknown",
          explanation: "segfault, cause unclear",
        },
      ],
    });
    expect(orch.submit(bad).ok).toBeFalse();

    const good = structuredClone(bad)!;
    good.failures[0]!.category = "preexisting_behavior";
    good.failures[0]!.explanation =
      "old code also fails this case identically";
    expect(orch.submit(good).ok).toBeTrue();
  });

  test("R5: candidate trace missing baseline cases is rejected", () => {
    advance(6);
    const partial = trace("candidate");
    partial.observations = partial.observations.slice(0, 2); // drop d2
    const r = orch.submit(partial);
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("R5");
  });

  test("R6: inconsistent comparison lands on REJECTED", () => {
    advance(7);
    const r = orch.submit(comparison(["match", "mismatch", "match"]));
    expect(r).toEqual({ ok: true, from: "VERIFICATION_RUNNING", to: "REJECTED" });
    expect(store.state).toBe("REJECTED");
  });

  test("R7: terminal states are immutable", () => {
    advance(8);
    const r = orch.abort("try again");
    expect(r.ok).toBeFalse();
  });

  test("workflow recovery: reopened session resumes at stored state", () => {
    advance(2);
    const root = store.sessionDir.split(".refactor")[0]!;
    const reopened = SessionStore.open(root, store.id);
    expect(reopened.state).toBe("DEPENDENCY_READY");
    expect(new Orchestrator(reopened).submit(happyPath()[2]!).ok).toBeTrue();
  });

  test("a session written by an older build names the removed state", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-legacy-"));
    const dir = join(root, ".refactor", "sessions", "old-1");
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        session_id: "old-1",
        created_at: "2026-09-03T00:00:00.000Z",
        state: "DEPENDENCY_READY",
        history: [
          { from: "INIT", to: "CONTRACT_READY", artifact_kind: "behavior-contract", at: "t1", note: "" },
          { from: "CONTRACT_READY", to: "SCOPE_READY", artifact_kind: "scope-manifest", at: "t2", note: "" },
          { from: "SCOPE_READY", to: "DEPENDENCY_READY", artifact_kind: "dependency-manifest", at: "t3", note: "" },
        ],
      }),
    );
    expect(() => SessionStore.open(root, "old-1")).toThrow(/older build.*SCOPE_READY/);
  });

  test("corrupt and missing state files stay distinguishable", () => {
    const root = mkdtempSync(join(tmpdir(), "rfr-corrupt-"));
    const dir = join(root, ".refactor", "sessions", "bad-1");
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(join(dir, "state.json"), "{ not json");
    expect(() => SessionStore.open(root, "bad-1")).toThrow(/unreadable state.json/);

    writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "INIT" })); // parses, wrong shape
    expect(() => SessionStore.open(root, "bad-1")).toThrow(/corrupt state.json/);

    expect(() => SessionStore.open(root, "missing")).toThrow(/session not found/);
  });
});
