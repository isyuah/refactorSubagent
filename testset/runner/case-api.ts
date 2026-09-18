/**
 * Case API: what a case's `prepare.ts` needs and nothing more.
 *
 * A prepare script is handed one directory (argv[2], also the cwd) and prepares
 * the case's environment inside it — clone, patch, prebuild, hide. These
 * helpers keep that script short: resolve a shared source pin, clone it
 * shallowly (so nothing the candidate must not see travels with the
 * environment), run git, or report the case blocked on this host.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Exit code the runner reads as "this host cannot run me": skip, do not fail. */
export const BLOCKED_EXIT_CODE = 78;

export interface SourceSpec {
  readonly id: string;
  /** Local checkout (absolute, or relative to the test root) used when present. */
  readonly repo: string;
  /** Upstream URL for machines that never cloned the source themselves. */
  readonly remote?: string | null;
  readonly ref: string;
  readonly commit: string | null;
  readonly note: string | null;
}

export interface CloneOptions {
  /** Where to clone; relative names resolve inside the environment directory. */
  readonly into?: string;
  /** Override the pinned ref (branch or tag). */
  readonly ref?: string;
}

export function testRoot(): string {
  const root = process.env["TEST_ROOT"];
  if (root === undefined || root === "") throw new Error("TEST_ROOT is not set; run this script through testset/run.ts");
  return root;
}

export function envDir(): string {
  const dir = process.argv[2];
  if (dir === undefined || dir === "") throw new Error("prepare.ts expects the environment directory as its first argument");
  return resolve(dir);
}

export function git(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim().slice(-400)}`);
  }
  return (result.stdout ?? "").trim();
}

/** Read a shared source pin from `resources/sources/<id>.json`. */
export function readSource(id: string): SourceSpec {
  const path = resolve(testRoot(), "resources", "sources", `${id}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as SourceSpec;
}

/**
 * Clone a pinned source into the environment, shallowly: the environment must
 * carry the source the task needs and none of the history the candidate must
 * not see.
 */
export function cloneSource(id: string, options: CloneOptions = {}): string {
  const spec = readSource(id);
  const into = resolve(envDir(), options.into ?? ".");
  const ref = options.ref ?? spec.ref;
  const local = isAbsolute(spec.repo) ? spec.repo : resolve(testRoot(), spec.repo);
  // A fresh checkout of this repository has no local source copy (it is
  // gitignored), so the pin carries the upstream URL for exactly that machine.
  const origin = existsSync(local) ? local : spec.remote ?? null;
  if (origin === null) {
    throw new Error(
      `source '${id}': no checkout at ${local} and the pin declares no 'remote' fallback`,
    );
  }
  mkdirSync(into, { recursive: true });
  // Check out only after disabling EOL conversion: the judgement pins and the
  // candidate patches are byte-exact, so a CRLF working tree is a corrupted
  // environment (patches would not apply and digests would be about the wrong
  // bytes).
  git(["clone", "--no-local", "--depth", "1", "--branch", ref, "--single-branch", "--no-checkout", origin, into], testRoot());
  git(["config", "core.autocrlf", "false"], into);
  git(["checkout", "--detach", spec.commit ?? ref], into);
  const head = git(["rev-parse", "HEAD"], into);
  if (spec.commit !== null && head !== spec.commit) {
    throw new Error(`cloned ${id} at ${head}, expected ${spec.commit}`);
  }
  return into;
}

/** Skip this case on this host: write the reason and exit with the blocked code. */
export function blocked(reason: string): never {
  const dir = envDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "blocked.json"), JSON.stringify({ reason }, null, 2) + "\n", "utf8");
  process.stderr.write(`blocked: ${reason}\n`);
  process.exit(BLOCKED_EXIT_CODE);
}
