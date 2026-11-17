import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseCliArgs, RunTaskRequiredError, type CliCommand, type RunCommand } from "./args.js";
import { styled, TerminalStyle } from "./terminal.js";

export interface CliInputOptions {
  readonly input?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly output?: NodeJS.WritableStream & { readonly isTTY?: boolean };
  readonly env?: Record<string, string | undefined>;
}

/** Cancellation is a launch outcome, not a failed refactoring session. */
export class CliInputCancelled extends Error {
  constructor(readonly exitCode = 130, message = "已取消运行；未创建会话，也未调用模型。") {
    super(message);
    this.name = "CliInputCancelled";
  }
}

/** Randomness keeps concurrent launches unique even within the same millisecond. */
export function createRunSessionId(): string {
  return `run-${Date.now().toString(36)}-${randomUUID()}`;
}

/** Complete only a missing task; explicit or invalid commands never open a prompt. */
export async function resolveCliInput(argv: readonly string[], options: CliInputOptions = {}): Promise<CliCommand> {
  try {
    return parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof RunTaskRequiredError)) throw error;
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stderr;
    const env = options.env ?? process.env;
    const ci = Boolean(env.CI) && !/^(false|0)$/i.test(env.CI!);
    if (error.command.noInteractive || !input.isTTY || !output.isTTY || ci) throw error;
    return promptForTask(error.command, input, output, env);
  }
}

async function promptForTask(
  command: Omit<RunCommand, "task">,
  input: NonNullable<CliInputOptions["input"]>,
  output: NonNullable<CliInputOptions["output"]>,
  env: NonNullable<CliInputOptions["env"]>,
): Promise<RunCommand> {
  const style = new TerminalStyle({ color: command.color, output, env });
  const reader = createInterface({ input, output, terminal: true, historySize: 0, crlfDelay: Infinity });
  const controller = new AbortController();
  let exitCode = 130;
  let inputError: Error | undefined;
  const cancel = (): void => { controller.abort(); reader.close(); };
  const terminate = (): void => { exitCode = 143; cancel(); };
  const closed = (): void => { controller.abort(); };
  const failed = (error: Error): void => { inputError = error; cancel(); };
  reader.on("SIGINT", cancel);
  reader.on("close", closed);
  reader.on("error", failed);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", terminate);
  const ask = async (prompt: string): Promise<string> => {
    if (controller.signal.aborted) throw inputError ?? new CliInputCancelled(exitCode);
    try {
      return (await reader.question(style.render([styled(prompt, "accent")]), { signal: controller.signal })).trim();
    } catch (error) {
      if (inputError) throw inputError;
      if (controller.signal.aborted) throw new CliInputCancelled(exitCode);
      throw error;
    }
  };
  try {
    output.write(style.render([styled("尚未提供重构任务\n", "heading"),
      "请输入一行需求；输入 /cancel 或按 Ctrl+C / Ctrl+D 取消。\n"]));
    for (;;) {
      const task = await ask("重构任务 > ");
      if (task === "/cancel") throw new CliInputCancelled();
      if (!task) {
        output.write(style.render([styled("任务不能为空，请输入需求或取消。\n", "warning")]));
        continue;
      }
      output.write(style.render([styled("仓库: ", "accent"), resolve(command.repo), "\n",
        styled("任务: ", "accent"), task, "\n", styled("会话: ", "accent"), command.session ?? "自动生成唯一编号", "\n",
        ...(command.resume ? [styled("恢复自会话: ", "accent"), command.resume, "\n"] : [])]));
      for (;;) {
        const choice = await ask("[1] 开始运行  [2] 重新输入  [0] 取消（回车取消） > ");
        if (choice === "1") return { ...command, task };
        if (choice === "2") break;
        if (!choice || choice === "0" || choice === "/cancel") throw new CliInputCancelled();
        output.write(style.render([styled("请输入 1、2 或 0。\n", "warning")]));
      }
    }
  } finally {
    reader.off("SIGINT", cancel);
    reader.off("close", closed);
    reader.off("error", failed);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", terminate);
    reader.close();
  }
}
