import { describe, test, expect } from "bun:test";
import { extractJson } from "../src/agents/driver.js";
import { REFACTOR_AGENT_TOOLS } from "../src/agents/refactor.js";
import { TEST_WRITER_AGENT_TOOLS } from "../src/agents/workflow-session.js";

describe("extractJson", () => {
  test("parses fenced json block", () => {
    const out = extractJson('intro\n```json\n{"a": 1}\n```\ntrailer');
    expect(out).toEqual({ a: 1 });
  });

  test("parses bare json object", () => {
    expect(extractJson('{"b": [1,2]}')).toEqual({ b: [1, 2] });
  });

  test("throws when nothing parses", () => {
    expect(() => extractJson("no json here")).toThrow();
  });

  test("prefers fenced block over surrounding text", () => {
    const out = extractJson('{"wrong": true}\n```json\n{"right": false}\n```');
    expect(out).toEqual({ right: false });
  });
});

describe("session tool boundaries", () => {
  test("refactor session grants file tools + a shell, and nothing else", () => {
    // The allowlist IS the boundary (no host-side scope hook any more), so the
    // exact set matters: adding a tool here silently widens what the model can do.
    expect([...REFACTOR_AGENT_TOOLS].sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
  });

  test("test-writer session grants file tools, a shell, and Task for the build-writer", () => {
    expect([...TEST_WRITER_AGENT_TOOLS].sort()).toEqual([
      "Bash", "Edit", "Glob", "Grep", "Read", "Task", "Write",
    ]);
  });
});
