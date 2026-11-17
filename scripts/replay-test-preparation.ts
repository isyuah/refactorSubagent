/** Real host execution with offline source delivery; never calls a model. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { stripVTControlCharacters } from "node:util";
import { TestPreparation } from "../src/testing/preparation.js";
import { preparationPages } from "../src/cli/test-report.js";
import { RunScreen } from "../src/cli/tui/run.js";
import { buildStageFlow, Pipeline } from "../src/config/pipeline.js";
import { runStageFlow } from "../src/runtime/stage-flow.js";
import type { RunProgressEvent } from "../src/runtime/progress.js";
import { DEFAULT_LIMITS } from "../src/config/limits.js";
import { Workbench } from "../src/cli/tui/workbench.js";
import { PreparationScreen } from "../src/cli/tui/preparation.js";
import { TerminalStyle, styled } from "../src/cli/terminal.js";
import { cliFixture } from "../tests/helpers/cli-fixture.js";
import { preparationReplay } from "../tests/helpers/test-preparation.js";

const args = Bun.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out") throw new Error("Usage: bun scripts/replay-test-preparation.ts --out <example directory>");
const destination = resolve(args[1]!);
mkdirSync(destination, { recursive: true });
const fixture = cliFixture("accept", destination);
const replay = preparationReplay();
const preparation = new TestPreparation({ repo: fixture.repo, sessionRoot: fixture.sessionRoot,
  session: "offline-preparation", scope: "保护函数返回值和可替代的时钟依赖（离线夹具）", runAgentFn: replay.author });
try {
  await preparation.author();
  const saved = preparation.save(join(destination, "test-plan"));
  const renderer = await createTestRenderer({ width: 120, height: 38, exitOnCtrlC: false, exitSignals: [] });
  const ui = new Workbench(renderer.renderer, true);
  const screen = new PreparationScreen(ui, preparation, { verbosity: "detailed" });
  const completion = screen.run();
  const frames: string[] = [];
  for (let section = 0; section < 4; section++) {
    ui.selectSection(section);
    await renderer.renderOnce(); await Promise.resolve(); await renderer.renderOnce();
    frames.push(renderer.captureCharFrame());
  }
  ui.onExit(); await completion; await ui.close();
  writeFileSync(join(destination, "review.txt"), frames.join("\n\n"));
  for (const mode of ["detailed", "summary"] as const) {
    const style = new TerminalStyle({ color: true, output: { isTTY: true }, env: {} });
    const pages = preparationPages(preparation.view()).filter((_page, index) => mode === "detailed" || index === 0 || index === 2);
    const report = pages.flatMap(page => [style.render([styled(page.title, "heading")]), ...page.lines.map(line => style.render(line))]).join("\n") + "\n";
    writeFileSync(join(destination, `${mode}.ansi`), report);
    writeFileSync(join(destination, `${mode}.txt`), stripVTControlCharacters(report));
  }
  const pipeline = Pipeline.parse({ ...JSON.parse(readFileSync(fixture.pipeline, "utf8")), stages: {
    workflows: { mode: "test-plan", directory: saved.directory }, prepare: { mode: "create" },
    refactor: JSON.parse(readFileSync(fixture.pipeline, "utf8")).stages.refactor,
  } });
  const events: RunProgressEvent[] = [];
  const result = await runStageFlow({ repoPath: fixture.repo, task: "离线演示：应用现成补丁并比较两侧", sessionId: "offline-tui-run", sessionRoot: fixture.sessionRoot,
    flow: buildStageFlow(pipeline), onProgress: event => events.push(event) });
  for (const verbosity of ["detailed", "summary"] as const) {
    const native = await createTestRenderer({ width: 120, height: 38, exitOnCtrlC: false, exitSignals: [] });
    const workbench = new Workbench(native.renderer, true);
    const run = new RunScreen(workbench, verbosity);
    run.start({ repo: fixture.repo, task: "离线演示：应用现成补丁并比较两侧", session: result.report.session,
      log_dir: result.report.log_dir, limits: DEFAULT_LIMITS, limit_sources: [], pipeline: "预置方案与补丁", pipeline_sources: [], pipeline_config: pipeline });
    for (const event of events) run.receive(event);
    const finished = run.finish(result.report); const frames: string[] = [];
    for (let section = 0; section < 8; section++) {
      workbench.selectSection(section);
      await native.renderOnce(); await Promise.resolve(); await native.renderOnce();
      frames.push(native.captureCharFrame());
    }
    workbench.onExit(); await finished; await workbench.close();
    writeFileSync(join(destination, `run.${verbosity}.txt`), frames.join("\n\n"));
  }
  console.log(JSON.stringify({ mode: "offline-replay", status: preparation.view().content.metadata.trial.status, run: result.state, report: result.report.report_path, bundle: saved.directory,
    text: join(destination, "review.txt") }, null, 2));
} finally { preparation.close(); }
