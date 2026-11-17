import { expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "../src/cli/tui/workbench.js";
export async function terminal(width = 100, height = 32) {
  const setup = await createTestRenderer({ width, height, exitOnCtrlC: false, exitSignals: [], consoleMode: "disabled" });
  const ui = new Workbench(setup.renderer, true);
  const frame = async (): Promise<string> => { await Promise.resolve(); await setup.renderOnce(); await Promise.resolve(); await setup.renderOnce(); return setup.captureCharFrame(); };
  const activate = async (id: string): Promise<void> => {
    const node = ui.root.findDescendantById(id); expect(node).toBeDefined(); expect(node!.focusable).toBeTrue(); node!.focus(); setup.mockInput.pressEnter(); await frame();
  };
  return { ...setup, ui, frame, activate, close: () => ui.close() };
}
