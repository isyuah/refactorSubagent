import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { LayerOverrides } from "../config/layers.js";
import { TestPreparation } from "../testing/preparation.js";
import type { TestsCommand } from "./args.js";
import { CliUsageError } from "./args.js";
import { CliInputCancelled, createRunSessionId } from "./input.js";
import { preparationPages } from "./test-report.js";
import type { Workbench } from "./tui/workbench.js";
import type { PreparationScreen } from "./tui/preparation.js";
import { cleanText, TerminalStyle } from "./terminal.js";
import { RunDisplay } from "./display.js";
import type { RunProgressEvent } from "../runtime/progress.js";

export async function executeTestsCommand(command: TestsCommand, overrides: LayerOverrides, workbench: Workbench | null = null): Promise<{
  exitCode: number; continuation: { directory: string; task: string } | null;
}> {
  const ci = Boolean(process.env.CI) && !/^(false|0)$/i.test(process.env.CI!);
  const interactive = !command.noInteractive && !ci && Boolean(process.stdin.isTTY && process.stderr.isTTY) && command.format !== "json";
    let scope = command.scope;
  if (command.action === "prepare" && !scope?.trim()) {
    if (!interactive) throw new CliUsageError("tests prepare requires --scope <verification scope> outside an interactive terminal");
    scope = await ask("要保护哪些模块和行为？（/cancel 取消）> ");
    if (!scope) throw new CliInputCancelled();
  }
  let terminal: PreparationScreen | null = null;
  const display = new RunDisplay({ verbosity: command.verbosity, progress: "plain", format: command.format, color: command.color });
  const preparation = new TestPreparation({ repo: resolve(command.repo), sessionRoot: resolve(command.sessionRoot ?? command.repo),
    session: command.session ?? createRunSessionId(), ...(scope === null ? {} : { scope }),
    ...(command.from === null ? {} : { from: resolve(command.from) }), limitOverrides: overrides,
    onProgress: (event: RunProgressEvent) => { if (terminal) terminal.receive(event); else display.receive(event); } });
  const interrupted = (): void => { preparation.cancel(); terminal?.interrupt(); };
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  let continuation: { directory: string; task: string } | null = null;
  try {
    if (workbench) {
      const { PreparationScreen } = await import("./tui/preparation.js");
      terminal = new PreparationScreen(workbench, preparation, { verbosity: command.verbosity, ...(command.out === null ? {} : { out: resolve(command.out) }) });
      const outcome = await terminal.run(command.action === "prepare" ? () => preparation.author() : undefined);
      if (outcome.kind === "continue") continuation = { directory: outcome.directory, task: outcome.task };
    } else {
      if (command.action === "prepare") display.start({ repo: preparation.repo, task: preparation.view().content.metadata.scope,
        session: preparation.view().session, log_dir: preparation.directory, pipeline: "独立测试准备 / 原版试跑 / 人工审阅", pipeline_sources: [],
        limits: preparation.limits, limit_sources: preparation.limitSources, limit_overrides: overrides.values, auto_retry: 0 });
      if (command.action === "prepare") { await preparation.author(); if (preparation.cancelled) throw new CliInputCancelled(130, `已取消测试准备；已有材料和证据：${preparation.directory}`); preparation.save(command.out === null ? undefined : resolve(command.out)); }
      else if (command.out !== null) preparation.save(resolve(command.out));
    }
    preparation.close();
    display.stop();
    const view = preparation.view();
    const result = { kind: "test-preparation", session: view.session, repo: view.repo,
      status: view.content.metadata.trial.status, saved: view.saved, report: view };
    if (continuation !== null) return { exitCode: 0, continuation };
    if (workbench) {
      await workbench.close();
      console.log(cleanText(`测试准备：${view.content.metadata.trial.status}\n${view.saved ? "保存方案：" + view.saved : "方案尚未保存"}\n证据目录：${preparation.directory}`));
      return { exitCode: view.content.metadata.trial.status === "failed" ? 1 : 0, continuation };
    }
    if (command.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      const style = new TerminalStyle({ color: command.color, output: process.stdout });
      for (const page of preparationPages(view)) {
        if (command.verbosity === "summary" && (page.title === "文件与修改" || page.title === "测试场景")) continue;
        console.log(style.render([{ text: page.title, tone: "heading" }]));
        for (const line of page.lines) console.log(style.render(line));
      }
      if (view.saved) console.log(`复用命令：bun scripts/cli.ts run <repo> --task "<重构需求>" --tests "${view.saved}"`);
    }
    return { exitCode: view.content.metadata.trial.status === "failed" ? 1 : 0, continuation };
  } finally { process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted); display.stop(); preparation.close(); }
}

async function ask(prompt: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr, historySize: 0 });
  const cancellation = new AbortController();
  const cancel = (): void => { cancellation.abort(); reader.close(); };
  reader.on("SIGINT", cancel); reader.on("close", cancel);
  try {
    for (;;) {
      let answer: string;
      try { answer = (await reader.question(prompt, { signal: cancellation.signal })).trim(); }
      catch (error) { if (cancellation.signal.aborted) throw new CliInputCancelled(); throw error; }
      if (answer === "/cancel") throw new CliInputCancelled();
      if (answer) return answer;
    }
  } finally { reader.off("close", cancel); reader.close(); }
}
