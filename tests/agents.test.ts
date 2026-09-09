import { describe, test, expect } from "bun:test";
import { extractJson } from "../src/agents/driver.js";

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
