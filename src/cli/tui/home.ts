import { CliInputCancelled } from "../input.js";
import { guideSection } from "./guide.js";
import type { Item, Workbench } from "./workbench.js";

const TASKS = [
  { id: "run", label: "全流程重构", description: "编写或复用测试，重构代码并比较两侧行为" },
  { id: "prepare", label: "准备测试", description: "编写测试，在原版试跑，审阅后保存或继续重构" },
  { id: "review", label: "打开测试方案", description: "审阅已保存方案、提出修改或再次试跑" },
] as const;

export function chooseLaunchTask(ui: Workbench): Promise<(typeof TASKS)[number]["id"]> {
  const choice = Promise.withResolvers<(typeof TASKS)[number]["id"]>();
  const cancel = (): void => choice.reject(new CliInputCancelled());
  const items: Item[] = TASKS.map(({ id, label, description }) => ({
    id, label, description,
    detail: () => ({ title: label, paragraphs: [{ text: description }] }),
    activate: () => choice.resolve(id),
  }));
  ui.onExit = cancel;
  ui.onCancel = cancel;
  ui.setTitle("Refactor Subagent · 选择任务");
  ui.setSections([{ id: "tasks", title: "选择任务", items: () => items }, guideSection()]);
  ui.setActions([{ id: "open", label: "打开选中项", run: () => ui.openSelected() }, { id: "cancel", label: "退出", run: cancel }]);
  ui.setNotice("Enter 打开 · 按 2 查看使用指引 · Tab 切换焦点 · Q 退出");
  return choice.promise;
}
