import { describe, expect, test } from "bun:test";
import { terminal } from "./tui-helpers.js";
import { parseCliArgs } from "../src/cli/args.js";
import { resolveUi } from "../src/cli/ui.js";
import { BoundedText } from "../src/cli/tui/run.js";

describe("OpenTUI workbench", () => {
  test("selection changes the detail independently and keyboard focus reaches a visible action", async () => {
    const t = await terminal(); let saved = false;
    try {
      t.ui.setSections([{ id: "scenarios", title: "测试场景", items: () => [
        { id: "copy", label: "正常复制", detail: () => ({ title: "正常复制", paragraphs: [{ text: "capacity=16" }] }) },
        { id: "truncate", label: "截断复制", detail: () => ({ title: "截断复制", paragraphs: [{ text: "capacity=4" }] }) },
      ] }]);
      t.ui.setActions([{ id: "save", label: "保存方案", run: () => { saved = true; } }]);
      expect(await t.frame()).toContain("capacity=16");
      t.mockInput.pressArrow("down"); expect(await t.frame()).toContain("capacity=4");
      expect(t.ui.currentItem()?.id).toBe("truncate");
      t.mockInput.pressTab(); await t.frame(); expect(t.renderer.currentFocusedRenderable?.id).toBe("details");
      t.mockInput.pressTab(); t.mockInput.pressEnter(); await t.frame(); expect(saved).toBeTrue();
    } finally { await t.close(); }
  });
  test("multiline Chinese input is editable and submit/cancel are separate actions", async () => {
    const t = await terminal();
    try {
      const pending = t.ui.input({ title: "修改意见", multiline: true });
      await t.mockInput.pasteBracketedText("补充空输入\n保留边界检查");
      await t.activate("dialog:submit"); expect(await pending).toBe("补充空输入\n保留边界检查");
      const cancelled = t.ui.input({ title: "重构需求", value: "保留此文本" });
      t.mockInput.pressEscape(); expect(await cancelled).toBeNull();
    } finally { await t.close(); }
  });
  test("resizing preserves selection, external ANSI is stripped and disabled actions cannot execute", async () => {
    const t = await terminal(); let calls = 0;
    try {
      t.ui.setSections([{ id: "files", title: "文件", items: () => [
        { id: "one", label: "中文路径/辅助.c", detail: () => ({ title: "源码", paragraphs: [{ text: "\x1b[31m外部正文\x1b[0m" }], code: "int main(void) { return 0; }\n" }) },
        { id: "two", label: "第二个文件", detail: () => ({ title: "第二个", paragraphs: [{ text: "保持选中项" }] }) },
      ] }]);
      t.ui.setActions([{ id: "continue", label: "继续重构", disabled: "试跑失败", run: () => { calls++; } }]);
      const wide = await t.frame(); expect(wide).toContain("外部正文"); expect(wide).not.toContain("\x1b");
      expect(t.ui.root.findDescendantById("action:continue")!.focusable).toBeFalse();
      t.mockInput.pressArrow("down"); await t.frame(); t.resize(65, 24); await t.frame();
      expect(t.ui.currentItem()?.id).toBe("two"); t.mockInput.pressEnter(); expect(await t.frame()).toContain("保持选中项");
      t.resize(100, 32); expect(await t.frame()).toContain("保持选中项"); expect(calls).toBe(0);
    } finally { await t.close(); }
  });
  test("live logs follow the bottom, while scrolling up preserves the reading position", async () => {
    const t = await terminal(100, 26); let log = Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n");
    try {
      t.ui.setSections([{ id: "log", title: "运行输出", items: () => [{ id: "command", label: "命令", detail: () => ({ title: "输出", paragraphs: [{ text: log }], follow: true }) }] }]);
      expect(await t.frame()).toContain("line 79");
      t.ui.detail.focus(); t.mockInput.pressKey("\x1b[5~"); const before = await t.frame(); expect(before).not.toContain("line 79");
      log += "\nnewest line"; t.ui.refresh(); expect(await t.frame()).not.toContain("newest line");
      t.ui.follow(); expect(await t.frame()).toContain("newest line");
    } finally { await t.close(); }
  });
  test("logs retain contiguous chunks and bound memory without cutting Chinese characters", () => {
    const text = new BoundedText(); text.append("hello"); text.append(" world\n"); expect(text.text()).toBe("hello world\n");
    text.append("中文\n".repeat(3000)); expect(text.clipped).toBeTrue(); expect(text.text()).not.toContain("hello"); expect(text.text()).not.toContain("�");
    const large = new BoundedText(); large.append("汉".repeat(900000)); expect(large.text()).not.toContain("�"); expect(Buffer.byteLength(large.text())).toBeLessThan(2 * 1024 * 1024 + 200);
  });
});

describe("UI selection preserves scripting contracts", () => {
  const tty = { input: { isTTY: true }, output: { isTTY: true }, env: { TERM: "xterm-256color" } };
  const run = (args: string[]) => { const command = parseCliArgs(["run", "--task", "task", ...args]); if (command.kind !== "run") throw new Error("run expected"); return command; };
  test("interactive defaults to TUI, while JSON, CI, explicit line progress and redirection stay plain", () => {
    expect(resolveUi(run([]), tty)).toBe("tui");
    for (const args of [["--format", "json"], ["--no-interactive"], ["--ui", "plain"], ["--progress", "plain"], ["--progress", "off"]]) expect(resolveUi(run(args), tty)).toBe("plain");
    expect(resolveUi(run([]), { ...tty, env: { CI: "true" } })).toBe("plain");
    expect(resolveUi(run([]), { ...tty, output: { isTTY: false } })).toBe("plain");
    expect(() => resolveUi(run(["--ui", "tui", "--format", "json"]), tty)).toThrow();
    expect(() => resolveUi(run(["--ui", "tui", "--progress", "off"]), tty)).toThrow();
    expect(() => resolveUi(run(["--configure", "--ui", "plain"]), tty)).toThrow();
    expect(() => resolveUi(run(["--configure", "--progress", "plain"]), tty)).toThrow();
  });
});
