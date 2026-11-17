import { describe, expect, test } from "bun:test";
import { PreparationScreen, reviewFiles, type PreparationReviewer } from "../src/cli/tui/preparation.js";
import { emptyTrial, type PreparationView } from "../src/testing/types.js";
import { DEFAULT_LIMITS } from "../src/config/limits.js";
import { HostPreflight } from "../src/artifacts/host-preflight.js";
import { CliInputCancelled } from "../src/cli/input.js";
import { terminal } from "./tui-helpers.js";

async function harness(passed = false) {
  const t = await terminal(120, 38);
  const view: PreparationView = { session: "terminal-review", repo: "repo", status: "review", revision: 1, trialOrigin: "current", limits: DEFAULT_LIMITS, history: [], saved: null,
    files: [{ path: "workflows/harness.materials.json", content: JSON.stringify({ materials: [{ path: "verification/辅助.c", content: "int answer(void) { return 42; }\n" }] }), previous: JSON.stringify({ materials: [{ path: "verification/辅助.c", content: "int answer(void) { return 41; }\n" }] }) }],
    content: { metadata: { scope: "检查函数返回值与边界输入", delivery: "complete", base_sha: "1".repeat(40), analysis: null,
      review: { version: 1, scenarios: [{ id: "copy", title: "正常复制", purpose: "检查返回值及终止符", inputs: ["capacity=16"], observations: ["copy.result"], sourceReferences: ["src/copy.c:10"] }] },
      host: HostPreflight.parse({ kind: "host-preflight", version: 1, platform: process.platform, arch: process.arch, shell: "unknown", supports_posix_shell: false, executable_suffix: process.platform === "win32" ? ".exe" : "", working_directory: "repo", tools: {} }),
      trial: { ...emptyTrial(), status: passed ? "pass" : "failed", observations: [{ name: "copy.result", relation: "equal", value: { copied: 5 } }] } }, test: null, builds: [] } };
  const calls: { method: string; text?: string }[] = [];
  const listeners = new Set<(view: PreparationView) => void>();
  const notify = (): void => { for (const listener of listeners) listener(view); };
  const controller: PreparationReviewer = { directory: "evidence", view: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    cancel: () => { calls.push({ method: "cancel" }); },
    author: async text => { calls.push({ method: "author", text }); view.content.metadata.trial.status = "pass"; notify(); },
    repair: async () => { calls.push({ method: "repair" }); },
    trial: async () => { calls.push({ method: "trial" }); view.content.metadata.trial.status = "pass"; notify(); },
    save: () => { calls.push({ method: "save" }); view.saved = "saved/r1"; notify(); return { directory: "saved/r1" }; } };
  const screen = new PreparationScreen(t.ui, controller, { verbosity: "detailed" });
  return { ...t, screen, controller, view, calls, listeners };
}

describe("OpenTUI test preparation review", () => {
  test("failed trial blocks continuation; rerun, multiline feedback, save and separate refactor task work", async () => {
    const h = await harness(); const running = h.screen.run();
    try {
      expect(h.ui.root.findDescendantById("action:continue")!.focusable).toBeFalse();
      await h.activate("action:trial"); await h.frame();
      expect(h.calls.map(c => c.method)).toEqual(["trial"]);
      expect(h.ui.root.findDescendantById("action:continue")!.focusable).toBeTrue();
      await h.activate("action:feedback"); await h.mockInput.pasteBracketedText("补充空输入\n验证终止符"); await h.activate("dialog:submit"); await h.frame();
      expect(h.calls.at(-1)).toEqual({ method: "author", text: "补充空输入\n验证终止符" });
      await h.activate("action:save"); await h.frame(); expect(h.calls.at(-1)?.method).toBe("save"); await h.activate("dialog:close");
      await h.activate("action:continue"); await h.mockInput.pasteBracketedText("提取重复校验函数"); await h.activate("dialog:submit");
      expect(await running).toEqual({ kind: "continue", directory: "saved/r1", task: "提取重复校验函数" });
      expect(h.listeners.size).toBe(0);
    } finally { await h.close(); }
  });
  test("scenario selection shows its observed value and helper sources are unpacked into a real line diff", async () => {
    const h = await harness(true); const running = h.screen.run();
    try {
      h.ui.selectSection(1); const frame = await h.frame(); expect(frame).toContain("capacity=16"); expect(frame).toContain("copied");
      expect(reviewFiles(h.view)[0]?.path).toBe("verification/辅助.c");
      h.ui.selectSection(3); const diff = await h.frame(); expect(diff).toContain("41"); expect(diff).toContain("42");
      await h.activate("action:exit"); expect(await running).toEqual({ kind: "exit", directory: null, task: null }); expect(h.calls).toHaveLength(0);
    } finally { await h.close(); }
  });
  test("save errors remain errors and never announce a successful save", async () => {
    const h = await harness(true); h.controller.save = () => { throw new Error("permission denied"); }; const running = h.screen.run();
    try {
      await h.activate("action:save"); expect(await h.frame()).toContain("permission denied"); await h.activate("dialog:close");
      expect(await h.frame()).not.toContain("方案已保存"); await h.activate("action:exit"); await running;
    } finally { await h.close(); }
  });
  test("immediate cancellation never starts initial authoring", async () => {
    const h = await harness(); const running = h.screen.run(() => h.controller.author()).catch(error => error);
    h.screen.interrupt();
    try { expect(await running).toBeInstanceOf(CliInputCancelled); expect(h.calls).toEqual([{ method: "cancel" }]); }
    finally { await h.close(); }
  });
  test.each(["ctrl-c", "eof"])("%s waits for active cleanup and releases subscriptions", async mode => {
    const h = await harness(); const pending = Promise.withResolvers<void>(); let ended = false;
    const running = h.screen.run(() => pending.promise).catch(error => { ended = true; return error; });
    try {
      await h.frame();
      if (mode === "eof") h.renderer.stdin.emit("end"); else h.mockInput.pressKey("c", { ctrl: true });
      await h.frame(); expect(ended).toBeFalse(); expect(h.calls).toEqual([{ method: "cancel" }]);
      pending.resolve(); expect(await running).toBeInstanceOf(CliInputCancelled); expect(h.listeners.size).toBe(0);
    } finally { pending.resolve(); await h.close(); }
  });
});
