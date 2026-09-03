import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkToolScope,
  DEFAULT_AGENT_FORBIDDEN_GLOBS,
  extractJson,
  normalizeToolInput,
} from "../src/agents/driver.js";
import { ScopeManifest } from "../src/artifacts/scope-manifest.js";

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

describe("Agent scope enforcement", () => {
  test("checks read, search, and write scopes fail-closed", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "rfr-agent-scope-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "src", "main.c"), "int main(void){return 0;}\n");
    writeFileSync(join(root, "tests", "secret.c"), "int secret(void){return 1;}\n");

    const readable = ["src/**"];
    const forbidden = ["tests/**", ...DEFAULT_AGENT_FORBIDDEN_GLOBS];
    const editable = ["src/main.c"];
    expect(checkToolScope("Read", { file_path: "src/main.c" }, root, readable, forbidden, editable).allowed).toBeTrue();
    expect(checkToolScope("Read", { file_path: "tests/secret.c" }, root, ["**"], forbidden, editable).reason).toContain("forbidden");
    expect(checkToolScope("Read", { file_path: "README.md" }, root, readable, forbidden, editable).reason).toContain("Observation Scope");
    expect(checkToolScope("Glob", { path: "src", pattern: "*.c" }, root, readable, forbidden, editable).allowed).toBeTrue();
    expect(checkToolScope("Grep", { path: ".", glob: "**/*.c" }, root, ["**"], forbidden, editable).reason).toContain("may include forbidden");
    expect(checkToolScope("Write", { file_path: "src/main.c" }, root, readable, forbidden, editable).allowed).toBeTrue();
    expect(checkToolScope("Write", { file_path: "src/other.c" }, root, readable, forbidden, editable).reason).toContain("Modification Scope");
    expect(checkToolScope("Write", { file_path: "tests/generated.c" }, root, ["**"], forbidden, ["tests/generated.c"]).reason).toContain("forbidden");
    expect(checkToolScope("Read", { file_path: "../outside.c" }, root, ["**"], [], editable).reason).toContain("escapes");
    // Claude Code sends Glob with an absolute repo-root path plus a pattern;
    // a pattern targeting a readable subtree must not be denied just because
    // the bare root is not itself listed as readable.
    expect(checkToolScope("Glob", { path: root, pattern: "src/**" }, root, readable, forbidden, editable).allowed).toBeTrue();
    expect(checkToolScope("Glob", { path: root, pattern: "tests/**" }, root, readable, forbidden, editable).reason).toContain("forbidden");
    expect(checkToolScope("Glob", { path: root, pattern: "**/*" }, root, readable, forbidden, editable).reason).not.toBeNull();
  });
});
describe("Agent tool input normalization", () => {
  test("resolves relative file and search roots under the agent cwd", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "rfr-agent-normalize-"));
    expect(normalizeToolInput("Read", { file_path: "src/main.c" }, root)).toEqual({
      file_path: join(root, "src", "main.c"),
    });
    expect(normalizeToolInput("Glob", { path: "src", pattern: "*.c" }, root)).toEqual({
      path: join(root, "src"),
      pattern: "*.c",
    });
    expect(normalizeToolInput("Grep", { path: ".", glob: "src/**/*.c" }, root)).toEqual({
      path: join(root, "src"),
      glob: "src/**/*.c",
    });
    expect(normalizeToolInput("Read", { file_path: "../outside.c" }, root)).toBeNull();
  });
});

describe("ScopeManifest validation", () => {
  test("rejects readable and forbidden globs that overlap", () => {
    expect(() => ScopeManifest.parse({
      kind: "scope-manifest",
      version: 1,
      editable_files: [{ file: "src/trim.c", symbols: ["trim_in_place"] }],
      readable_globs: ["src/**"],
      forbidden_globs: ["src/trim.h"],
    })).toThrow("must not overlap");

    expect(() => ScopeManifest.parse({
      kind: "scope-manifest",
      version: 1,
      editable_files: [{ file: "src/trim.c", symbols: ["trim_in_place"] }],
      readable_globs: ["**"],
      forbidden_globs: ["tests/**"],
    })).toThrow("must not overlap");
  });
});
