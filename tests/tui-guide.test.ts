import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli/args.js";
import { CliInputCancelled } from "../src/cli/input.js";
import { LaunchWizard } from "../src/cli/tui/configure.js";
import { chooseLaunchTask } from "../src/cli/tui/home.js";
import { terminal } from "./tui-helpers.js";

describe("OpenTUI guide before starting", () => {
  test("a user can read the guide before choosing a task and return to the picker", async () => {
    const t = await terminal();
    const picked = chooseLaunchTask(t.ui).catch(error => error);
    try {
      expect(await t.frame()).toContain("使用指引");
      t.mockInput.pressKey("2");
      expect(await t.frame()).toContain("bun scripts/cli.ts run");
      t.mockInput.pressArrow("down");
      expect(await t.frame()).toContain("--scope");

      t.mockInput.pressKey("1");
      t.mockInput.pressArrow("down");
      t.mockInput.pressEnter();
      expect(await picked).toBe("prepare");
    } finally { t.ui.onCancel(); await t.close(); }
  });

  test("the configuration guide is reachable with a narrow terminal and no task entered", async () => {
    const command = parseCliArgs(["run"], true);
    if (command.kind !== "run") throw new Error("run required");
    const t = await terminal(65, 24);
    const pending = new LaunchWizard(t.ui, command, {}, {}).run().catch(error => error);
    try {
      expect(await t.frame()).toContain("按 7 查看使用指引");
      t.mockInput.pressKey("7");
      t.mockInput.pressEnter();
      expect(await t.frame()).toContain("bun scripts/cli.ts run");

      t.mockInput.pressEscape();
      t.mockInput.pressKey("1");
      expect(await t.frame()).toContain("重构需求");
      t.mockInput.pressKey("q");
      expect(await pending).toBeInstanceOf(CliInputCancelled);
    } finally { t.ui.onCancel(); await t.close(); }
  });
});
