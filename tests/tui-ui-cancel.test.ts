import { describe, expect, test } from "bun:test";
import { CliInputCancelled } from "../src/cli/input.js";
import { cancelReturnsToMenu } from "../src/cli/ui.js";

/**
 * 裸启动的主菜单 ⇄ 配置向导往返语义。两种"取消"共用同一个异常类型，
 * 必须靠中断标记区分：用户点取消 = 回菜单；Ctrl+C = 退出。
 */
describe("cancelReturnsToMenu", () => {
  test("用户点配置向导的取消 → 回到主菜单", () => {
    expect(cancelReturnsToMenu(new CliInputCancelled(), false)).toBe(true);
  });

  test("Ctrl+C / 中断 → 退出而不是回菜单", () => {
    expect(cancelReturnsToMenu(new CliInputCancelled(), true)).toBe(false);
  });

  test("其他错误永远不当作取消处理", () => {
    expect(cancelReturnsToMenu(new Error("boom"), false)).toBe(false);
    expect(cancelReturnsToMenu(new Error("boom"), true)).toBe(false);
  });
});
