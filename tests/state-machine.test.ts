import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
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
    advance(9);
    expect(store.state).toBe("ACCEPTED");
    expect(store.history).toHaveLength(9);
  });

  test("R1: skipping a stage is rejected", () => {
    const r = orch.submit(happyPath()[1]!); // scope at INIT, contract missing
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
    advance(5);
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
          related_to_scope: false,
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

  test("R4: patch outside editable scope is rejected", () => {
    advance(6);
    const r = orch.submit(patch(["src/other.c"]));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("R4");
  });

  test("R5: candidate trace missing baseline cases is rejected", () => {
    advance(7);
    const partial = trace("candidate");
    partial.observations = partial.observations.slice(0, 2); // drop d2
    const r = orch.submit(partial);
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("R5");
  });

  test("R6: inconsistent comparison lands on REJECTED", () => {
    advance(8);
    const r = orch.submit(comparison(["match", "mismatch", "match"]));
    expect(r).toEqual({ ok: true, from: "VERIFICATION_RUNNING", to: "REJECTED" });
    expect(store.state).toBe("REJECTED");
  });

  test("R7: terminal states are immutable", () => {
    advance(9);
    const r = orch.abort("try again");
    expect(r.ok).toBeFalse();
  });

  test("workflow recovery: reopened session resumes at stored state", () => {
    advance(3);
    const root = store.sessionDir.split(".refactor")[0]!;
    const reopened = SessionStore.open(root, store.id);
    expect(reopened.state).toBe("DEPENDENCY_READY");
    expect(new Orchestrator(reopened).submit(happyPath()[3]!).ok).toBeTrue();
  });
});
