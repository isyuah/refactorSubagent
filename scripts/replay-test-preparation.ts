/** Real host execution with offline source delivery; never calls a model. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { TestPreparation } from "../src/testing/preparation.js";
import { TestReviewTerminal, preparationPages } from "../src/cli/test-review.js";
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
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; return this; } });
  const frames: string[] = [];
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { frames.push(String(chunk)); done(); } }), { isTTY: true, columns: 108, rows: 36 });
  const terminal = new TestReviewTerminal(preparation, { color: true, env: {}, input, output });
  const completion = terminal.run();
  const plain: string[] = [];
  for (let page = 1; page <= 4; page++) {
    input.emit("keypress", String(page), { name: String(page) });
    plain.push(stripVTControlCharacters(frames.at(-1)!));
  }
  input.emit("keypress", "q", { name: "q" });
  await completion;
  writeFileSync(join(destination, "review.ansi"), frames.join(""));
  writeFileSync(join(destination, "review.txt"), plain.join("\n\n"));
  for (const mode of ["detailed", "summary"] as const) {
    const style = new TerminalStyle({ color: true, output: { isTTY: true }, env: {} });
    const pages = preparationPages(preparation.view()).filter((_page, index) => mode === "detailed" || index === 0 || index === 2);
    const report = pages.flatMap(page => [style.render([styled(page.title, "heading")]), ...page.lines.map(line => style.render(line))]).join("\n") + "\n";
    writeFileSync(join(destination, `${mode}.ansi`), report);
    writeFileSync(join(destination, `${mode}.txt`), stripVTControlCharacters(report));
  }
  console.log(JSON.stringify({ mode: "offline-replay", status: preparation.view().content.metadata.trial.status, bundle: saved.directory,
    tui: join(destination, "review.ansi"), text: join(destination, "review.txt") }, null, 2));
} finally { preparation.close(); }
