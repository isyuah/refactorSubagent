import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  BuildAdapterId,
  EnvironmentSpec,
  HostPreflight,
} from "../artifacts/index.js";

export interface BuildResult {
  ok: boolean;
  log: string;
  binaryAbs: string;
}

export interface BuildCommand {
  program: string;
  args: string[];
}

/** A multi-step argv-only plan. Commands execute in order, without a shell. */
export interface BuildPlan {
  adapter: BuildAdapterId;
  commands: BuildCommand[];
  output: string;
  outputCandidates?: string[];
}

export interface BuildAdapter {
  readonly id: BuildAdapterId;
  plan(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildPlan;
  build(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildResult;
}

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
      ...sanitizerFlags(env, host),
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
      commands: [{ program: compiler.path, args }],
      output,
    };
  }

  build(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildResult {
    return executePlan(worktreeDir, this.plan(worktreeDir, env, host));
  }
}

export class CMakeAdapter implements BuildAdapter {
  readonly id = "cmake" as const;

  plan(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildPlan {
    if (!("kind" in env.build) || env.build.kind !== "cmake") {
      throw new Error("cmake adapter received a non-cmake build spec");
    }
    const cmake = host.tools.cmake;
    if (!cmake?.available || cmake.path === null) {
      throw new Error("cmake is not available in HostPreflight");
    }
    const build = env.build;
    const configureArgs = ["-S", build.source_dir, "-B", build.build_dir];
    if (build.generator !== null) configureArgs.push("-G", build.generator);
    configureArgs.push(...build.configure_flags);

    const sanitizer = sanitizerFlags(env, host);
    const cFlags = [
      ...sanitizer,
      ...env.determinism.intercept_headers
        .map((header) => `-include "${join(worktreeDir, header).replaceAll("\\", "/")}"`),
    ].join(" ");
    if (cFlags.length > 0) configureArgs.push(`-DCMAKE_C_FLAGS=${cFlags}`);
    if (sanitizer.length > 0) {
      const linkerFlags = sanitizer.join(" ");
      configureArgs.push(`-DCMAKE_EXE_LINKER_FLAGS=${linkerFlags}`);
      configureArgs.push(`-DCMAKE_SHARED_LINKER_FLAGS=${linkerFlags}`);
    }

    const buildArgs = ["--build", build.build_dir, ...build.build_flags];
    if (build.target !== null) buildArgs.push("--target", build.target);
    return {
      adapter: this.id,
      commands: [
        { program: cmake.path, args: configureArgs },
        { program: cmake.path, args: buildArgs },
      ],
      output: withExecutableSuffix(build.output, host),
      outputCandidates: cmakeOutputCandidates(build.output, host),
    };
  }

  build(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildResult {
    return executePlan(worktreeDir, this.plan(worktreeDir, env, host));
  }
}
export class NinjaAdapter implements BuildAdapter {
  readonly id = "ninja" as const;

  plan(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildPlan {
    if (!("kind" in env.build) || env.build.kind !== "ninja") {
      throw new Error("ninja adapter received a non-ninja build spec");
    }
    if (env.sanitizers.length > 0 || env.determinism.intercept_headers.length > 0) {
      throw new Error(
        "ninja adapter cannot inject sanitizer or determinism flags into an existing build graph",
      );
    }
    const ninja = host.tools.ninja;
    if (!ninja?.available || ninja.path === null) {
      throw new Error("ninja is not available in HostPreflight");
    }
    const args = ["-C", env.build.build_dir, ...env.build.build_flags];
    if (env.build.target !== null) args.push(env.build.target);
    return {
      adapter: this.id,
      commands: [{ program: ninja.path, args }],
      output: withExecutableSuffix(env.build.output, host),
    };
  }

  build(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildResult {
    return executePlan(worktreeDir, this.plan(worktreeDir, env, host));
  }
}

function executePlan(worktreeDir: string, plan: BuildPlan): BuildResult {
  const candidates = plan.outputCandidates ?? [plan.output];
  const firstOutput = join(worktreeDir, candidates[0]!);
  mkdirSync(dirname(firstOutput), { recursive: true });
  let log = "";

  for (const command of plan.commands) {
    const result = spawnSync(command.program, command.args, {
      cwd: worktreeDir,
      encoding: "utf8",
      shell: false,
    });
    const rendered = [command.program, ...command.args].map(shellQuote).join(" ");
    log += `$ ${rendered}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`;
    if (result.status !== 0) return { ok: false, log, binaryAbs: firstOutput };
  }

  const actual = candidates
    .map((candidate) => join(worktreeDir, candidate))
    .find((candidate) => existsSync(candidate));
  return {
    ok: actual !== undefined,
    log,
    binaryAbs: actual ?? firstOutput,
  };
}

function sanitizerFlags(env: EnvironmentSpec, host: HostPreflight): string[] {
  const flags: string[] = [];
  for (const kind of env.sanitizers) {
    const capability = host.sanitizers[kind];
    if (!capability?.available) {
      throw new Error(
        `sanitizer '${kind}' unavailable: ${capability?.reason ?? "no measured capability"}`,
      );
    }
    flags.push(...capability.flags);
  }
  return [...new Set(flags)];
}

export function resolveBinaryPath(worktreeDir: string, env: EnvironmentSpec): string {
  if ("kind" in env.build && env.build.kind === "workflow-driven") {
    throw new Error("workflow-driven builds declare artifacts at runtime; binary path is not statically known");
  }
  const output = "output" in env.build ? env.build.output : env.build.binary;
  const candidates = "kind" in env.build && env.build.kind === "cmake"
    ? cmakeOutputCandidates(output, {
        executable_suffix: process.platform === "win32" ? ".exe" : "",
      } as HostPreflight)
    : [
        output,
        process.platform === "win32" && !output.toLowerCase().endsWith(".exe")
          ? `${output}.exe`
          : output,
      ];
  return candidates
    .map((candidate) => join(worktreeDir, candidate))
    .find((candidate) => existsSync(candidate)) ?? join(worktreeDir, candidates[0]!);
}

function cmakeOutputCandidates(output: string, host: HostPreflight): string[] {
  const base = withExecutableSuffix(output, host);
  const parent = dirname(base);
  const file = basename(base);
  const configurations = ["Debug", "Release", "RelWithDebInfo", "MinSizeRel"];
  return [base, ...configurations.map((configuration) => join(parent, configuration, file))];
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
      if (normalizedHeaders.some((header) => candidate === header || header.endsWith(`/${candidate}`))) {
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
