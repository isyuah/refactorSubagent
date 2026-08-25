import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BuildAdapterId,
  DirectCompilerBuild,
  EnvironmentSpec,
  HostPreflight,
} from "../artifacts/index.js";

export interface BuildResult {
  ok: boolean;
  log: string;
  binaryAbs: string;
}

/** Resolved process invocation produced by an adapter, never a shell string. */
export interface BuildPlan {
  adapter: BuildAdapterId;
  program: string;
  args: string[];
  output: string;
}

/** Build backend contract. Adapters own planning/execution; acceptance stays in Orchestrator. */
export interface BuildAdapter {
  readonly id: BuildAdapterId;
  plan(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildPlan;
  build(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildResult;
}

/** Structured C compiler adapter: plans and executes argv-only invocations. */
export class DirectCompilerAdapter implements BuildAdapter {
  readonly id = "direct-compiler" as const;

  plan(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildPlan {
    if (!("kind" in env.build) || env.build.kind !== "direct-compiler") {
      throw new Error("direct-compiler adapter received a non-direct build spec");
    }

    const output = withExecutableSuffix(env.build.output, host);
    const compiler = host.tools[env.build.compiler];
    if (!compiler?.available || compiler.path === null) {
      throw new Error(`direct compiler unavailable: ${env.build.compiler}`);
    }

    const args = [
      ...removeInterceptFlags(env.build.flags, env.determinism.intercept_headers),
      ...Object.entries(env.build.defines).map(([key, value]) => `-D${key}=${value}`),
    ];
    for (const header of env.determinism.intercept_headers) {
      if (!existsSync(join(worktreeDir, header))) {
        throw new Error(`determinism header not found: ${header}`);
      }
      args.push("-include", header);
    }
    args.push(...env.build.sources, "-o", output);

    return {
      adapter: this.id,
      program: compiler.path,
      args,
      output,
    };
  }

  build(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildResult {
    const output = "output" in env.build ? env.build.output : "";
    const outputAbs = join(worktreeDir, withExecutableSuffix(output, host));
    mkdirSync(dirname(outputAbs), { recursive: true });

    let plan: BuildPlan;
    try {
      plan = this.plan(worktreeDir, env, host);
    } catch (error) {
      return {
        ok: false,
        binaryAbs: outputAbs,
        log: `${error instanceof Error ? error.message : String(error)}\n`,
      };
    }

    const result = spawnSync(plan.program, plan.args, {
      cwd: worktreeDir,
      encoding: "utf8",
      shell: false,
    });
    const command = [plan.program, ...plan.args].map(shellQuote).join(" ");
    const log =
      `$ ${command}\n` +
      (result.stdout ?? "") +
      (result.stderr ?? "") +
      (result.error ? String(result.error) : "");

    return {
      ok: result.status === 0 && existsSync(join(worktreeDir, plan.output)),
      log,
      binaryAbs: join(worktreeDir, plan.output),
    };
  }
}

export function resolveBinaryPath(
  worktreeDir: string,
  env: EnvironmentSpec,
): string {
  const output = "output" in env.build ? env.build.output : env.build.binary;
  const requested = join(worktreeDir, output);
  if (existsSync(requested)) return requested;
  if (process.platform === "win32" && !requested.toLowerCase().endsWith(".exe")) {
    const exe = `${requested}.exe`;
    if (existsSync(exe)) return exe;
  }
  return requested;
}

function withExecutableSuffix(output: string, host: HostPreflight): string {
  return host.executable_suffix.length > 0 &&
    !output.toLowerCase().endsWith(host.executable_suffix)
    ? `${output}${host.executable_suffix}`
    : output;
}

function removeInterceptFlags(flags: readonly string[], headers: readonly string[]): string[] {
  const normalizedHeaders = headers.map((header) => header.replaceAll("\\", "/"));
  const output: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag === "-include" && i + 1 < flags.length) {
      const candidate = flags[i + 1]!.replaceAll("\\", "/");
      const duplicate = normalizedHeaders.some(
        (header) => candidate === header || header.endsWith(`/${candidate}`),
      );
      if (duplicate) {
        i++;
        continue;
      }
    }
    output.push(flag);
  }
  return output;
}

function shellQuote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
