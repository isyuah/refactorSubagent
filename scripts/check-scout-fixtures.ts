/** Validate assessment material with trusted probes. No SDK/model invocation. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScoutReferenceSchema, sha256, validateScoutEvidence, type ScoutInput } from "../testset/runner/scout-contract.js";
import { snapshotScoutSources } from "../testset/runner/scout-session.js";
import { loadSuite } from "../testset/runner/suite.js";

const root = resolve(import.meta.dir, "..");
const resources = join(root, "testset/resources/scout");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out" || !args[1])) throw new Error("Usage: bun scripts/check-scout-fixtures.ts [--out <empty directory>]");
const output = args[1] ? resolve(args[1]) : mkdtempSync(join(tmpdir(), "rfr-scout-fixtures-"));
if (existsSync(output) && readdirSync(output).length) throw new Error(`Fixture evidence directory must be empty: ${output}`);
const compiler = process.env.SCOUT_FIXTURE_CC ?? Bun.which("gcc") ?? Bun.which("clang") ?? Bun.which("cc");
if (!compiler) {
  console.error("Fixture validation needs a GCC/Clang-compatible C compiler (SCOUT_FIXTURE_CC). Scout evaluation itself does not.");
  process.exit(78);
}
mkdirSync(output, { recursive: true });
const records: { case: string; status: string; detail: string }[] = [];
const suffix = process.platform === "win32" ? ".exe" : "";
const common = ["-std=c11", "-Wall", "-Wextra", "-Werror"];
let sequence = 0;
function command(program: string, args: string[], cwd: string, expectedFailure = false): string {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", timeout: 20_000, windowsHide: true });
  const log = `${program}\n${JSON.stringify(args)}\nexit=${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
  writeFileSync(join(output, `command-${++sequence}.txt`), log);
  if (result.error || (expectedFailure ? result.status === 0 : result.status !== 0)) throw new Error(log);
  return log;
}
try {
  const { suite } = loadSuite(join(root, "testset"));
  for (const c of suite.cases.filter((c) => c.kind === "scout")) {
    const name = c.id.slice(6);
    const repo = join(resources, "fixtures", name);
    const reference = ScoutReferenceSchema.parse(JSON.parse(readFileSync(c.expect.rubric!.reference!, "utf8")));
    validateScoutEvidence({ sources: snapshotScoutSources(repo), agent: { skill: { path: "check", content: "", sha256: sha256("") } } } as ScoutInput, reference);
    const exe = join(output, name + suffix);
    const includes = ["-I", join(repo, "include"), "-I", join(repo, "src")];
    const check = join(resources, "checks", name + ".c");
    if (name === "missing-provider") {
      if (existsSync(join(repo, "config/device_options.h.in"))) throw new Error("missing-provider template unexpectedly exists");
      const log = command(compiler, [...common, ...includes, "-I", join(repo, "vendor/include"), "-c", "src/device.c", "-o", join(output, "incomplete.o")], repo, true);
      if (!log.includes("device_options.h")) throw new Error("incomplete fixture failed for an unrelated reason");
      records.push({ case: c.id, status: "expected-incomplete", detail: "generated header/template and provider deliberately absent; compilation identifies the header gap" });
      continue;
    }
    if (name === "shared-library") {
      const ext = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
      const library = join(output, "libcounter" + ext);
      const flags = process.platform === "win32"
        ? ["-shared", `-Wl,--out-implib,${join(output, "libcounter.dll.a")}`]
        : process.platform === "darwin" ? ["-dynamiclib", "-Wl,-install_name,@rpath/libcounter.dylib"] : ["-shared", "-fPIC"];
      command(compiler, [...common, ...includes, ...flags, "-DCOUNTER_BUILD", "src/counter.c", "-o", library], repo);
      const rpath = process.platform === "win32" ? [] : [process.platform === "darwin" ? "-Wl,-rpath,@loader_path" : "-Wl,-rpath,$ORIGIN"];
      command(compiler, [...common, ...includes, check, "-L", output, "-lcounter", ...rpath, "-o", exe], repo);
    } else {
      const sources = name === "local-function" ? ["src/text_copy.c", check]
        : name === "existing-tests" ? ["src/key.c", "tests/key_test.c"]
        : name === "allocator-chain" ? ["src/frame.c", "src/wire.c", "src/hex.c", check]
        : name === "file-resource" ? ["src/config.c", check] : null;
      if (!sources) throw new Error(`no material probe defined for ${c.id}`);
      command(compiler, [...common, ...includes, ...sources, "-o", exe], repo);
    }
    command(exe, name === "file-resource" ? [join(output, "config-input.txt")] : [], output);
    records.push({ case: c.id, status: "passed", detail: "real fixture sources compiled and trusted semantic probe exited 0" });
  }
  writeFileSync(join(output, "summary.json"), JSON.stringify({ compiler, platform: process.platform, records }, null, 2) + "\n");
  console.log(JSON.stringify({ output, records }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Evidence: ${output}`);
  process.exitCode = 1;
}
