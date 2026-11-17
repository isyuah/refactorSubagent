import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { TestReviewTerminal, type PreparationReviewer } from "../src/cli/test-review.js";
import { emptyTrial, type PreparationView } from "../src/testing/types.js";
import { DEFAULT_LIMITS } from "../src/config/limits.js";
import { HostPreflight } from "../src/artifacts/host-preflight.js";
import { CliInputCancelled } from "../src/cli/input.js";

const settle = () => new Promise<void>(done => setImmediate(done));
function harness(passed = false, columns = 80, rows = 24) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; return this; } });
  const chunks: string[] = [];
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } }), { isTTY: true, columns, rows });
  const view: PreparationView = { session: "terminal-review", repo: "repo", status: "review", revision: 1, trialOrigin: "current", limits: DEFAULT_LIMITS, history: [], saved: null, files: [{ path: "workflows/中文路径/test.ts", content: "长文本".repeat(70) + "\x1b[31mEXTERNAL", previous: null }],
    content: { metadata: { scope: "检查函数返回值与所有边界输入", delivery: "complete", base_sha: "1".repeat(40),
      analysis: null, review: null, host: HostPreflight.parse({ kind: "host-preflight", version: 1, platform: process.platform, arch: process.arch, shell: "unknown", supports_posix_shell: false,
        executable_suffix: process.platform === "win32" ? ".exe" : "", working_directory: "repo", tools: {} }),
      trial: { ...emptyTrial(), status: passed ? "pass" : "failed" } }, test: null, builds: [] } };
  const calls: { method: string; text?: string }[] = [];
  const controller: PreparationReviewer = { directory: "evidence", view: () => view,
    cancel: () => { calls.push({ method: "cancel" }); },
    author: async text => { calls.push({ method: "author", text }); view.content.metadata.trial.status = "pass"; },
    repair: async () => { calls.push({ method: "repair" }); },
    trial: async () => { calls.push({ method: "trial" }); view.content.metadata.trial.status = "pass"; },
    save: () => { calls.push({ method: "save" }); view.saved = "saved/r1"; return { directory: "saved/r1" }; } };
  const terminal = new TestReviewTerminal(controller, { color: true, env: {}, input, output });
  const key = async (text: string, name = text) => { input.emit("keypress", text, { name }); await settle(); };
  return { input, output, controller, terminal, view, calls, chunks, key };
}

describe("test review terminal interactions", () => {
  test("refuses continuation after failure, reruns, accepts human feedback and returns the saved plan plus a separate refactor task", async () => {
    const h = harness(); const running = h.terminal.run();
    await h.key("c"); expect(h.calls).toHaveLength(0);
    await h.key("r"); expect(h.calls.map(c => c.method)).toEqual(["trial"]);
    await h.key("m"); await h.key("补充空输入"); await h.key("", "return");
    expect(h.calls.at(-1)).toEqual({ method: "author", text: "补充空输入" });
    await h.key("s"); await h.key("c"); await h.key("提取重复校验函数"); await h.key("", "return");
    expect(await running).toEqual({ kind: "continue", directory: "saved/r1", task: "提取重复校验函数" });
    expect(h.input.isRaw).toBe(false); expect(h.input.listenerCount("keypress")).toBe(0);
    expect(h.chunks.at(-1)).toContain("\x1b[?1049l");
  });

  test("plain exit does not start refactoring or silently save", async () => {
    const h = harness(true); const running = h.terminal.run(); await h.key("q");
    expect(await running).toEqual({ kind: "exit", directory: null, task: null }); expect(h.calls).toHaveLength(0);
    expect(h.input.isRaw).toBe(false);
  });

  test("immediate cancellation does not start the queued initial authoring action", async () => {
    const h = harness();
    const running = h.terminal.run(() => h.controller.author()).catch(error => error);
    h.input.emit("keypress", "c", { ctrl: true, name: "c" });
    expect(await running).toBeInstanceOf(CliInputCancelled);
    expect(h.calls).toEqual([{ method: "cancel" }]); expect(h.input.isRaw).toBe(false);
  });

  test.each(["ctrl-c", "eof"])("%s cancels the active operation and restores the terminal before waiting for cleanup", async mode => {
    const h = harness(); const pending = Promise.withResolvers<void>(); let completed = false;
    const before = { exit: process.listenerCount("exit"), term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
    const running = h.terminal.run(() => pending.promise).catch(error => { completed = true; return error; });
    await settle();
    if (mode === "ctrl-c") h.input.emit("keypress", "c", { ctrl: true, name: "c" }); else h.input.emit("end");
    await settle(); expect(h.calls).toEqual([{ method: "cancel" }]); expect(h.input.isRaw).toBe(false); expect(completed).toBe(false);
    pending.resolve(); expect(await running).toBeInstanceOf(CliInputCancelled);
    expect(process.listenerCount("exit")).toBe(before.exit); expect(process.listenerCount("SIGTERM")).toBe(before.term); expect(process.listenerCount("SIGINT")).toBe(before.int);
  });

  test("Chinese, long source and external ANSI fit a narrow terminal while pages remain navigable", async () => {
    const h = harness(true, 31, 12); const running = h.terminal.run();
    await h.key("4"); await h.key("", "pagedown"); await h.key("", "pageup");
    expect(h.chunks.join("")).not.toContain("\x1b[31mEXTERNAL");
    for (const chunk of h.chunks.filter(text => text.includes("\x1b[2J"))) {
      const lines = stripVTControlCharacters(chunk).split("\n");
      expect(lines.length).toBeLessThan(12);
      expect(lines.every(line => Bun.stringWidth(line) < 31)).toBe(true);
    }
    await h.key("q"); await running;
  });
});
