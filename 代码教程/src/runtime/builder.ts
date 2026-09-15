/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/builder.ts —— 构建入口（新版适配器 + 旧版 shell 兼容）
 *
 * 【这个文件是干什么的】
 *   它是一个**分发器**：拿到 EnvironmentSpec 之后，看看 build 字段是哪种 kind，
 *   就交给对应的适配器去编（direct-compiler / cmake / ninja）；
 *   如果三样都不是（比如旧会话遗留的 shell-command 规格），就退回 buildLegacyShell——
 *   也就是把一句 shell 命令字符串原样丢给 cmd.exe/bash 去跑的老办法。
 *
 * 【在整个项目里的位置】
 *   · 上游：src/runtime/pipeline.ts（旧版差分路径）调用 buildWorktree()；
 *     src/runtime/runner.ts 用它 re-export 的 resolveBinaryPath() 找可执行文件。
 *   · 它同时把 build-adapter.ts 里的三个类和 resolveBinaryPath **原样再导出**一遍
 *     （re-export），这样别的文件只 import builder.js 就够了。
 *   · ⚠️ 新 workflow 路径不用它：构建由 src/workflow/build-executor.ts 驱动。
 *     本文件属于"旧路径仍在用"的模块（`e2e:differential` 还会走到）。
 *
 * 【为什么 legacy 分支处处设卡】
 *   shell: true 意味着命令字符串会被 shell 解析——参数拼接、引号、路径里的空格都成了雷区，
 *   也无法证明 sanitizer 旗标真的生效了。所以 legacy 路径明确拒绝 sanitizer 请求，
 *   并且只在"规格里确实写着 command 字符串"时才肯干活。这体现了全项目一贯的
 *   fail-closed 姿态：宁可少做，不可做错。
 *
 * 【先修知识】
 *   · class 实例化（new XxxAdapter()）、默认参数值、字符串正则替换 replace；
 *   · `"kind" in obj` 类型收窄（因为 BuildSpec 是联合类型）；
 *   · spawnSync 的 shell: true / false 区别。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/builder.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BuildSpec,
  EnvironmentSpec,
  HostPreflight,
} from "../artifacts/index.js";
import { probeHost } from "./host-preflight.js";
import {
  CMakeAdapter,
  DirectCompilerAdapter,
  NinjaAdapter,
  resolveBinaryPath,
  type BuildResult,
} from "./build-adapter.js";
export {
  CMakeAdapter,
  DirectCompilerAdapter,
  NinjaAdapter,
  resolveBinaryPath,
} from "./build-adapter.js";
export type { BuildResult } from "./build-adapter.js";

// ← 模块级创建三个适配器实例（单例式的用法）：适配器本身没有状态，全程共用一份即可，
//   免得每次构建都 new 一个新对象。
const directCompiler = new DirectCompilerAdapter();
const cmake = new CMakeAdapter();
const ninja = new NinjaAdapter();

/**
 * Build entry point. New direct-compiler plans use an argv-only Adapter;
 * legacy shell plans remain a compatibility fallback.
 */
// ── buildWorktree：构建一个 worktree（本文件唯一对外的函数）──────────
// 【作用】按 EnvironmentSpec.build.kind 分发到对应适配器；都不认识就走 legacy shell；
//        任何"规划阶段"抛出的异常都被兜住，转成 ok:false 的结果（而不是让整个进程崩掉）。
// 【参数】
//   worktreeDir：要在这个目录里构建（也是命令的 cwd、相对路径的基准）；
//   env：环境规格（build 描述 + sanitizer 要求 + 确定性拦截头 + 沙箱策略）；
//   host：主机实测事实，**默认参数是 probeHost(worktreeDir)**。
// ⚠️ 注意这个默认值：调用方如果不传 host，每次构建都会重新探测一遍主机
//   （包括可能很慢的 CMake 配置/编译冒烟探针）。两条 pipeline 都是在开头探测一次，
//   然后把同一个 host 传给 baseline 和 candidate 两次构建，就是为了避免这份重复开销。
// 【返回】BuildResult { ok, log, binaryAbs }。
// 【语法】try/catch 里 `error instanceof Error ? error.message : String(error)` 是
//        "安全地取异常信息"的惯用写法——抛上来的东西不一定是 Error 对象。
// 【关系】baseline、candidate 各调一次（两次构建必须在不同目录、互不污染）。
export function buildWorktree(
  worktreeDir: string,
  env: EnvironmentSpec,
  host = probeHost(worktreeDir),
): BuildResult {
  try {
    // ← 下面三个 if 就是分发逻辑。`"kind" in env.build` 先收窄联合类型，再比较 kind 的值。
    if ("kind" in env.build && env.build.kind === "direct-compiler") {
      return directCompiler.build(worktreeDir, env, host);
    }
    if ("kind" in env.build && env.build.kind === "cmake") {
      return cmake.build(worktreeDir, env, host);
    }
    if ("kind" in env.build && env.build.kind === "ninja") {
      return ninja.build(worktreeDir, env, host);
    }
    // ← 以上都不匹配（shell-command / legacy 规格）→ 走老路
    return buildLegacyShell(worktreeDir, env);
  } catch (error) {
    // ← 规划失败（比如"指定的编译器不存在""sanitizer 没测到可用"）不算崩溃，
    //   而是变成一次失败的构建，让上层继续往下走并留下完整日志。
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      binaryAbs: join(worktreeDir, ""),
      log: `build planning failed: ${detail}\n`,
    };
  }
}

// ── buildLegacyShell：老式"shell 命令字符串"构建（兼容用）────────────
// 【作用】把规格里的命令字符串交给 shell 执行。
// 【⚠️ 与三个适配器的本质区别】spawnSync 的第一个参数直接是命令**字符串**且 shell: true，
//   所以会经过 cmd.exe / bash 解析。这是三条 argv-only 路径之外唯一的例外，也因此处处受限：
//   · 要 sanitizer？拒绝——因为没法证明一句 shell 命令里真的加上了那些旗标；
//   · 规格里没有 command 字段？拒绝——不知道要执行什么。
// 【关系】只有 buildWorktree 的兜底分支会走到它。
function buildLegacyShell(worktreeDir: string, env: EnvironmentSpec): BuildResult {
  if (env.sanitizers.length > 0) {
    return {
      ok: false,
      binaryAbs: join(worktreeDir, ""),
      log: "legacy shell adapter cannot prove sanitizer flags; use a structured build adapter\n",
    };
  }
  if (!("command" in env.build)) {
    return {
      ok: false,
      binaryAbs: join(worktreeDir, ""),
      log: "legacy shell adapter received a non-shell build spec\n",
    };
  }

  // ← 产物相对路径（先算出来，好提前建目录）
  const output = buildOutput(env.build);
  const requestedBinary = join(worktreeDir, output);
  mkdirSync(dirname(requestedBinary), { recursive: true });
  // ← Windows 上做点"宽容"的命令改写（见下面 normalizeBuildCommand）
  const baseCommand = normalizeBuildCommand(env.build.command);
  // ← 确定性拦截头：只保留"文件真的存在"且"命令里还没写"的那些，拼成 -include "路径" 串
  const includes = env.determinism.intercept_headers
    .filter((h) => existsSync(join(worktreeDir, h)))
    .filter((h) => !hasInclude(baseCommand, h))
    .map((h) => `-include "${join(worktreeDir, h)}"`)
    .join(" ");
  const command = `${baseCommand}${includes ? " " + includes : ""}`;
  // ← ⚠️ shell: true：命令字符串交给 shell。这是整个文件里唯一一处这么干的地方。
  const result = spawnSync(command, {
    cwd: worktreeDir,
    encoding: "utf8",
    shell: true,
  });
  const log =
    `$ ${command}\n` +
    (result.stdout ?? "") +
    (result.stderr ?? "") +
    (result.error ? String(result.error) : "");
  // ← 用"候选路径里谁真实存在"的方式再定位一次产物（处理 .exe 后缀、CMake 子目录等）
  const binaryAbs = resolveBinaryPath(worktreeDir, env);

  // ← 成功 = 退出码 0 **并且**产物文件确实出现了（只看退出码会被某些构建脚本骗过）
  return { ok: result.status === 0 && existsSync(binaryAbs), log, binaryAbs };
}

// ── buildOutput：从构建规格里取出"产物相对路径" ─────────────────────
// 【抛错】workflow-driven 的构建产物要到运行时才知道，规划期取不到 → 直接拒绝。
// 【语法】`"kind" in build && build.kind === "workflow-driven"`、
//        `"output" in build ? build.output : build.binary` 都是用 in 来区分联合类型的成员。
function buildOutput(build: BuildSpec): string {
  if ("kind" in build && build.kind === "workflow-driven") {
    throw new Error("workflow-driven builds declare artifacts at runtime");
  }
  return "output" in build ? build.output : build.binary;
}

// ── hasInclude：命令里是不是已经写了 -include 这个头 ────────────────
// 【作用】避免重复注入同一个拦截头。
// 【语法】反引号是模板字符串。注意 `\"` 这种写法：在模板字符串里反斜杠是多余的转义，
//        得到的就是普通的双引号字符——所以第二个判断其实是在找 `-include "路径"`（带引号版本）。
// 【细节】比较前把两种路径分隔符都归一成正斜杠，Windows 上才比得上。
function hasInclude(command: string, header: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  const target = header.replaceAll("\\", "/");
  return normalized.includes(`-include ${target}`) ||
    normalized.includes(`-include \"${target}\"`);
}

// ── normalizeBuildCommand：Windows 上的两句"人话改写" ───────────────
// 【作用】让一些只会在 Linux 上跑通的命令字符串在 Windows 上也能工作：
//   ① 去掉开头的 `mkdir -p xxx && `（Windows 的 cmd 没有 mkdir -p，而且目录程序已经建好了）；
//   ② 把独立的 `cc` 换成 `gcc`（\b 是正则的"单词边界"，所以 -lcc、acc 这种不会被误伤）。
// 【语法】正则字面量 /^\s*mkdir\s+-p\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/i：
//        ^ 开头、\s* 任意空白、(?:...) 不捕获分组、[^"]* 除引号外任意字符、
//        \S+ 一段非空白、i 标志表示大小写不敏感。
// 【返回】非 Windows 平台原样返回，不做任何处理。
function normalizeBuildCommand(command: string): string {
  if (process.platform !== "win32") return command;
  const withoutMkdir = command.replace(
    /^\s*mkdir\s+-p\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/i,
    "",
  );
  return withoutMkdir.replace(/\bcc\b/g, "gcc");
}
