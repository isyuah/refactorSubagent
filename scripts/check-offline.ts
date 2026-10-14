import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadSuite, selectCases } from "../testset/runner/suite.js";
import { installOwnedProcessSignalHandlers, spawnOwnedProcess } from "../shared/owned-process.js";

installOwnedProcessSignalHandlers();

// Select by declared platform before enabling strict environment checks. A
// missing compiler/recipe must fail CI; a Windows-only case on Linux is expected.
const root = resolve(import.meta.dir, "..");
const { suite } = loadSuite(resolve(root, "testset"));
const offline = selectCases(suite, { only: [], exclude: [], subjects: [], tags: ["offline"], filter: null });
const applicable = offline.filter(({ requires }) =>
  requires.platforms.length === 0 || requires.platforms.includes(process.platform));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out" || !args[1])) {
  throw new Error("usage: bun run test:offline [--out <new evidence directory>]");
}
if (applicable.length === 0) throw new Error("no offline cases apply to this platform");
const out = resolve(args[1] ?? resolve(root, "runs", "c-" + randomBytes(3).toString("hex")));
console.log(`Offline checks: ${applicable.length} applicable, ${offline.length - applicable.length} platform skips; evidence: ${out}`);
const owned = spawnOwnedProcess({
  program: process.execPath,
  args: [
    resolve(root, "testset/run.ts"), "--only", applicable.map(({ id }) => id).join(","),
    "--strict-env", "--concurrency", "2", "--out", out,
  ],
  cwd: root, stdin: "ignore", cooperativeShutdown: true,
});
owned.child.stdout!.pipe(process.stdout, { end: false });
owned.child.stderr!.pipe(process.stderr, { end: false });
const exit = await owned.exited;
if (exit.error !== null) console.error(exit.error.message);
process.exitCode ??= exit.error === null ? exit.code ?? 1 : 1;
