import { CliUsageError, parseCliArgs, type CliCommand, type RunCommand, type TestsCommand } from "./args.js";
import { CliInputCancelled, resolveCliInput } from "./input.js";
import type { LayerOverrides } from "../config/layers.js";
import type { Workbench } from "./tui/workbench.js";

/**
 * 配置向导的取消是否应回到主菜单。用户点「取消」属于操作选择；
 * Ctrl+C / 窗口中断属于退出意图——两者都表现为 CliInputCancelled，
 * 必须靠中断标记区分，否则 Ctrl+C 会被误救回菜单。
 */
export function cancelReturnsToMenu(error: unknown, interrupted: boolean): boolean {
  return error instanceof CliInputCancelled && !interrupted;
}

export interface UiEnvironment { input: { isTTY?: boolean }; output: { isTTY?: boolean }; env: Record<string, string | undefined> }
const environment = (): UiEnvironment => ({ input: process.stdin, output: process.stderr, env: process.env });
export function interactiveTerminal(io: UiEnvironment = environment()): boolean {
  return Boolean(io.input.isTTY && io.output.isTTY) && !(Boolean(io.env.CI) && !/^(false|0)$/i.test(io.env.CI!)) && io.env.TERM !== "dumb";
}
export function resolveUi(command: RunCommand | TestsCommand, io: UiEnvironment = environment()): "tui" | "plain" {
  const available = interactiveTerminal(io) && !command.noInteractive && command.format === "human";
  if (command.ui === "tui" && !available) throw new CliUsageError("--ui tui requires interactive stdin/stderr, human output and a capable terminal");
  if (command.kind === "run" && command.ui === "tui" && command.progress !== "auto") throw new CliUsageError("--ui tui conflicts with --progress plain/off; use --ui plain for line output");
  if (command.configure && command.kind === "run" && command.progress !== "auto") throw new CliUsageError("--configure requires --progress auto; use --ui plain without --configure for line output");
  if (command.configure && (!available || command.ui === "plain")) throw new CliUsageError("--configure requires the interactive TUI; remove --ui plain, --no-interactive or --format json");
  if (command.ui === "plain" || !available || (command.kind === "run" && command.progress !== "auto")) return "plain";
  return "tui";
}
export interface CliLaunch { command: CliCommand; limitOverrides: LayerOverrides; pipelineOverrides: LayerOverrides; workbench: Workbench | null }
export async function prepareCliLaunch(argv: readonly string[], limits: LayerOverrides, pipeline: LayerOverrides): Promise<CliLaunch> {
  const home = argv.length === 0 && interactiveTerminal();
  let command = home ? parseCliArgs(["run"], true) : parseCliArgs(argv, true);
  let interrupted = false;
  if (!home && command.kind !== "run" && command.kind !== "tests") return { command, limitOverrides: limits, pipelineOverrides: pipeline, workbench: null };
  if ((command.kind === "run" || command.kind === "tests") && resolveUi(command) === "plain") {
    return { command: await resolveCliInput(argv), limitOverrides: limits, pipelineOverrides: pipeline, workbench: null };
  }
  let workbench: Workbench;
  try { const { Workbench } = await import("./tui/workbench.js"); workbench = await Workbench.create(command.kind === "run" || command.kind === "tests" ? command.color : true); }
  catch (error) {
    if ((command.kind === "run" || command.kind === "tests") && (command.ui === "tui" || command.configure)) throw error;
    console.error(`TUI 初始化失败，改用文字模式：${error instanceof Error ? error.message : String(error)}`);
    return { command: await resolveCliInput(argv), limitOverrides: limits, pipelineOverrides: pipeline, workbench: null };
  }
  const interrupt = (): void => { interrupted = true; workbench.dismissDialog(); workbench.onCancel(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    workbench.onCancel = () => { void workbench.close(); };
    if (home) {
      // 裸启动：主菜单 ⇄ 配置向导可往返；只有主菜单取消才离开程序。
      for (;;) {
        const { chooseLaunchTask } = await import("./tui/home.js");
        const kind = await chooseLaunchTask(workbench);
        command = parseCliArgs(kind === "run" ? ["run"] : ["tests", kind], true);
        if (command.kind !== "run" && command.kind !== "tests") throw new Error("launcher must resolve to run or tests");
        const incomplete = command.kind === "run" ? !command.task.trim() : command.action === "prepare" ? !command.scope?.trim() : command.from === null;
        if (!incomplete && !command.configure) return { command, limitOverrides: limits, pipelineOverrides: pipeline, workbench };
        try {
          const { LaunchWizard } = await import("./tui/configure.js");
          const configured = await new LaunchWizard(workbench, command, limits, pipeline).run();
          return { ...configured, workbench };
        } catch (error) {
          if (!cancelReturnsToMenu(error, interrupted)) throw error;
          // 用户点了配置向导的「取消」→ 回到主菜单，让用户换个方向重新开始；
          // 中断（Ctrl+C）不是取消，见 cancelReturnsToMenu。
        }
      }
    }
    // 显式参数启动：保持原语义（配置向导取消 = 放弃本次运行）。
    if (command.kind !== "run" && command.kind !== "tests") throw new Error("launcher must resolve to run or tests");
    const incomplete = command.kind === "run" ? !command.task.trim() : command.action === "prepare" ? !command.scope?.trim() : command.from === null;
    if (command.configure || incomplete) {
      const { LaunchWizard } = await import("./tui/configure.js");
      const configured = await new LaunchWizard(workbench, command, limits, pipeline).run();
      return { ...configured, workbench };
    }
    return { command, limitOverrides: limits, pipelineOverrides: pipeline, workbench };
  } catch (error) { await workbench.close(); throw error; }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
