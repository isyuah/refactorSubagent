/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/host-preflight.ts —— 主机环境"测量员"（preflight 阶段）
 *
 * 【这个文件是干什么的】
 *   一次运行开始时，程序要搞清楚"这台机器到底有什么"：gcc 在不在、cmake 能不能
 *   真的配置并编译一个 C 程序、有没有 bash/wsl、sanitizer 可不可用。
 *   probeHost() 动手实测这些事实，产出一个 host-preflight artifact。
 *
 * 【为什么它重要】
 *   项目铁律是"AI 只许基于测量事实提方案，不许猜"。本文件的产出会原文注入给
 *   所有 Claude 会话——AI 说"用 cmake"，必须是因为测量说 cmake 可用。
 *
 * 【在整个项目里的位置】
 *   上游：workflow-agent-pipeline.ts（PREFLIGHT 阶段调用）、pipeline.ts；
 *   下游：产出存为 host-preflight.json，被 analyze/workflow-generator 等
 *         prompt 组装函数、build-adapter、capabilities 的工具白名单消费。
 *
 * 【先修知识】node:child_process 的 spawnSync（同步跑子进程）、正则、泛型 Record。
 *
 * 【本文件是教程注释版】原文件 src/runtime/host-preflight.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */
// spawnSync：同步地启动一个子进程并等它结束（返回码/标准输出都拿回来再继续往下走）。
import { spawnSync } from "node:child_process";
// delimiter：PATH 环境变量的分隔符——Windows 是 ";"，Linux/macOS 是 ":"。
// 这就是为什么不能硬编码 ":"：同一份代码要跨平台。
import { delimiter, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";          // 系统临时目录（Windows 上是 %TEMP%）
import process from "node:process";
import {
  HostPreflight,                            // 产出物的 Zod Schema（最终要过它的校验）
  type CMakePreflight,
  type ToolProbe,
} from "../artifacts/host-preflight.js";
import {
  SanitizerKind,
  type SanitizerCapability,
} from "../artifacts/sanitizer.js";

// as const：把数组变成"只读字面量元组"，元素类型是具体的字符串字面量而不是宽泛的 string。
// 好处：TOOLS_NAMES 的元素能直接当类型用，且数组不可被改动。
const TOOL_NAMES = [
  "gcc",       // 编译器（本项目实测的主力）
  "cc",        // 传统 Unix 编译器名——⚠️ Windows 上常常不存在，所以程序不能假设有 cc
  "clang",
  "cl",        // MSVC 编译器（注意：CMake 可能自己找到 VS，但 PATH 未必有 cl——见 e2e 报告 §4.2）
  "cmake",
  "ctest",     // CMake 自带的测试驱动器
  "make",
  "ninja",
  "msbuild",
  "bash",
  "wsl",       // Windows 子系统 Linux
] as const;

// Record<K,V> 类型：键是 K、值是 V 的对象。这里是"每种 sanitizer → 对应的编译 flag"。
const SANITIZER_FLAGS: Record<SanitizerKind, string> = {
  address: "-fsanitize=address",      // ASan：抓内存错误（越界、use-after-free）
  undefined: "-fsanitize=undefined",  // UBSan：抓未定义行为（溢出、错误对齐……）
};

export interface ProbeHostOptions {
  /** Expensive sanitizer probes run only when explicitly requested. */
  // ↑ 贵的探测（要真编译好几次）默认不做，只在调用方明确要求时执行。
  probeSanitizers?: boolean;
  /** Skip the CMake toolchain probe (configure/build smoke test). Speeds up
   *  callers that only need tool availability, and avoids Windows file-lock
   *  flakiness in tests. */
  // ↑ CMake 探针要真的跑一次 configure+build（约几秒），只查"工具在不在"的调用方
  //   可以跳过；另外 Windows 上文件锁偶发抽风会让测试不稳定，测试也用它跳过。
  skipCMakeProbe?: boolean;
}

/** Measure host facts once at workflow start. No model/tool call is involved. */
// ── probeHost：本文件唯一的导出函数（测量总入口）────────────────────────
// 【作用】测量主机 → 组装一个符合 Schema 的事实对象并校验返回。
// 【参数】cwd 工作目录（默认当前目录）；options 两个可选开关（见上）。
// 【返回】HostPreflight —— 过了 Zod 校验的强类型对象。
// 【关系】PREFLIGHT 阶段第一步；结果被 saveHostPreflight 落盘并注入所有 AI 会话。
// 【语法】cwd = process.cwd() 是"参数默认值"：调用方不传就用默认。
export function probeHost(
  cwd = process.cwd(),
  options: ProbeHostOptions = {},
): HostPreflight {
  const tools: Record<string, ToolProbe> = {};
  for (const name of TOOL_NAMES) tools[name] = probeTool(name);   // 逐个工具探测

  const shell = detectShell(tools);
  // 三元表达式链：条件 ? A : B。这里表达"满足三个条件才做 CMake 深度探针"。
  const cmake = !options.skipCMakeProbe && tools.cmake?.available && tools.cmake.path !== null
    ? probeCMake(tools.cmake.path)
    : {                       // 跳过/不可用时给一个"诚实占位"：version 为 null + 原因
        version: null,
        generators: [],
        default_generator: null,
        c_compiler: null,
        configure_probe: "not-run" as const,   // as const：把字符串锁定为字面量类型 "not-run"
        build_probe: "not-run" as const,
        reason: options.skipCMakeProbe ? "cmake probe skipped by request" : "cmake executable is not available on PATH",
      };
  // 深度探针拿到了真实版本号，就回填到工具表里（ {...展开, 改字段} 的对象更新写法）。
  if (tools.cmake !== undefined && cmake.version !== null) {
    tools.cmake = { ...tools.cmake, version: cmake.version };
  }

  return HostPreflight.parse({      // 最终过 Schema 校验：形状不对直接抛错（fail-closed）
    kind: "host-preflight",
    version: 1,
    platform: process.platform,     // 'win32' / 'linux' / 'darwin'
    arch: process.arch,             // 'x64' 等
    shell,
    supports_posix_shell: shell === "bash",
    executable_suffix: process.platform === "win32" ? ".exe" : "",  // Windows 产物带 .exe
    working_directory: cwd,
    tools,
    cmake,
    sanitizers: options.probeSanitizers === true ? probeSanitizers(tools) : {},
  });
}

/** Resolve PATH entries directly; spawning `where.exe` is unexpectedly slow on Windows. */
// ── probeTool：单工具探测 ──────────────────────────────────────────────
// 【为什么自己扫 PATH 而不调 where/which】官方注释明说：Windows 上 spawn where.exe
//   慢得出奇。直接遍历 PATH 目录找文件又快又没有子进程开销。
function probeTool(name: string): ToolProbe {
  const path = resolveOnPath(name);
  // 注意 version: null —— 普通探测不跑 --version（那要起子进程，慢）；
  // 版本号只有 cmake 的深度探针会回填。这是"普通分析路径保持低延迟"的取舍。
  return { available: path !== null, path, version: null };
}

// ── resolveOnPath：纯文件系统版的 PATH 查找 ────────────────────────────
// 【逻辑】外层遍历 PATH 的每个目录 × 内层遍历候选扩展名（Windows: .EXE/.CMD/.BAT…），
//   拼出"目录/名字+扩展名"逐个 existsSync，找到即返回绝对路径。
// 【语法】?? 空值合并：PATH 环境变量不存在时用 "" 兜底。
function resolveOnPath(name: string): string | null {
  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")   // Windows 可执行后缀列表
    : [""];                                                   // 非 Windows 无后缀概念
  for (const directory of pathEntries) {
    if (directory.length === 0) continue;   // PATH 里可能有空项（比如 ";;"）
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ── detectShell：判断默认 shell ───────────────────────────────────────
// 【为什么重要】后续所有"跑命令"的代码都要知道自己在什么 shell 环境，
//   cmd.exe 不认识 mkdir -p 这类 POSIX 语法。
function detectShell(tools: Record<string, ToolProbe>): "cmd.exe" | "powershell.exe" | "bash" | "unknown" {
  if (process.platform !== "win32") {
    return tools.bash?.available ? "bash" : "unknown";   // ?. 可选链：tools.bash 可能不存在
  }
  // ComSpec 是 Windows 的"默认命令解释器"环境变量。
  if (process.env.ComSpec?.toLowerCase().endsWith("powershell.exe")) {
    return "powershell.exe";
  }
  return "cmd.exe";    // 默认就是它
}

// ── probeCMake：CMake 深度探测 ────────────────────────────────────────
// 【作用】三个动作：--version 拿版本；-E capabilities 拿生成器列表（JSON）；
//   再做一次"迷你工程 configure+build"冒烟（见下）。任何一步失败都记进 reason。
function probeCMake(cmakePath: string): CMakePreflight {
  const versionRun = spawnSync(cmakePath, ["--version"], nativeProbeOptions());
  const capabilitiesRun = spawnSync(cmakePath, ["-E", "capabilities"], nativeProbeOptions());
  // 正则解读：^cmake version 开头，\s+ 一个以上空白，([^\r\n]+) 捕获到行尾的版本号。
  // /i 不分大小写 /m 多行模式；?.[1] 可选链取捕获组；?? null 兜底。
  const version = outputText(versionRun).match(/^cmake version\s+([^\r\n]+)/im)?.[1]?.trim() ?? null;
  const generators = parseCMakeGenerators(outputText(capabilitiesRun));
  const probe = runCMakeToolchainProbe(cmakePath);
  // 数组 + filter：把三步各自的失败原因收集起来（status !== 0 即失败）；
  // (value): value is string 是类型谓词——filter 之后 TS 知道数组里只剩非 null 的 string。
  const failures = [
    versionRun.status === 0 ? null : `cmake --version failed: ${probeOutput(versionRun)}`,
    capabilitiesRun.status === 0 ? null : `cmake -E capabilities failed: ${probeOutput(capabilitiesRun)}`,
    probe.reason,
  ].filter((value): value is string => value !== null);

  return {
    version,
    generators,
    default_generator: probe.defaultGenerator,
    c_compiler: probe.compiler,
    configure_probe: probe.configureStatus,
    build_probe: probe.buildStatus,
    // 三步全过给一句成功原因；否则把失败原因拼接并截断到 1000 字符（防止日志爆炸）。
    reason: failures.length === 0
      ? "CMake version, generators, and minimal C configure/build probes succeeded"
      : failures.join("; ").slice(0, 1000),
  };
}

// ── runCMakeToolchainProbe：CMake 真刀真枪的冒烟测试 ───────────────────
// 【作用】在系统临时目录里现场生成一个最小 C 工程（main.c + CMakeLists.txt），
//   真跑一遍 cmake -S . -B build（configure）和 cmake --build（编译），
//   用事实回答"这台机器的 cmake 到底能不能干活"。
// 【返回】configure/build 各自 pass|fail（build 可能 not-run = configure 都没过），
//   顺带抓出默认生成器（如 "Visual Studio 18 2026"）和 C 编译器路径。
// 【语法】try {…} catch {…} finally {…}：finally 里的清理（删临时目录）必被执行。
function runCMakeToolchainProbe(cmakePath: string): {
  configureStatus: "pass" | "fail";
  buildStatus: "pass" | "fail" | "not-run";
  defaultGenerator: string | null;
  compiler: string | null;
  reason: string | null;
} {
  // mkdtempSync：创建"带随机后缀"的临时目录（前缀 rfr-cmake-preflight-），避免并发冲突。
  const root = mkdtempSync(join(tmpdir(), "rfr-cmake-preflight-"));
  const source = join(root, "main.c");
  const project = join(root, "CMakeLists.txt");
  const build = join(root, "build");
  try {
    writeFileSync(source, "int main(void) { return 0; }\n", "utf8");   // 世界最简 C 程序
    writeFileSync(
      project,
      "cmake_minimum_required(VERSION 3.15)\nproject(rfr_cmake_probe C)\nadd_executable(rfr_cmake_probe main.c)\n",
      "utf8",
    );
    const configure = spawnSync(
      cmakePath,
      ["-S", ".", "-B", "build"],          // -S 源码目录 -B 构建目录（现代 CMake 用法）
      { ...nativeProbeOptions(), cwd: root },   // {...展开, 覆盖项}：复用默认选项但改 cwd
    );
    const configureOutput = outputText(configure);
    const cache = join(build, "CMakeCache.txt");
    // 生成器优先从 configure 输出 "-- Building for: XXX" 抓；抓不到再查 CMakeCache 缓存文件。
    const defaultGenerator = configureOutput.match(/^-- Building for:\s*(.+)$/m)?.[1]?.trim()
      ?? readCacheValue(cache, "CMAKE_GENERATOR:INTERNAL");
    // 编译器优先查缓存键 CMAKE_C_COMPILER:FILEPATH；再退回从输出文本解析。
    const compiler = configure.status === 0
      ? readCacheValue(cache, "CMAKE_C_COMPILER:FILEPATH") ?? parseWorkingCCompiler(configureOutput)
      : null;
    if (configure.status !== 0) {
      return {
        configureStatus: "fail",
        buildStatus: "not-run",            // configure 都失败了，build 没意义
        defaultGenerator,
        compiler,
        reason: `minimal CMake configure failed: ${probeOutput(configure)}`,
      };
    }

    const built = spawnSync(
      cmakePath,
      ["--build", "build", "--config", "Debug"],   // 多配置生成器（VS）需要指明 Debug
      { ...nativeProbeOptions(), cwd: root },
    );
    if (built.status !== 0) {
      return {
        configureStatus: "pass",
        buildStatus: "fail",
        defaultGenerator,
        compiler,
        reason: `minimal CMake build failed: ${probeOutput(built)}`,
      };
    }
    // ← 全部通过：configure 与 build 两个探针都是 pass，reason 为 null（没有失败原因）
    return {
      configureStatus: "pass",
      buildStatus: "pass",
      defaultGenerator,
      compiler,
      reason: null,
    };
  } catch (error) {
    return {
      configureStatus: "fail",
      buildStatus: "not-run",
      defaultGenerator: null,
      compiler: null,
      reason: `CMake toolchain probe errored: ${errorMessage(error)}`,
    };
  } finally {
    // force + recursive：无论如何把临时目录整个删掉（probe 不留垃圾）。
    rmSync(root, { recursive: true, force: true });
  }
}

// ── readCacheValue：从 CMakeCache.txt 里读一个键 ───────────────────────
// 亮点：key 里可能有正则特殊字符（如 (){}），先 replace 全部转义再嵌进 RegExp——
// [.*+?^${}()|[\]\\] 是"正则特殊字符集合"，\\$& 表示"在前面加个反斜杠的原字符"。
function readCacheValue(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // /m 多行模式：^ 定位到任意行首（cache 文件每行是 KEY=value）。
  return readFileSync(path, "utf8").match(new RegExp(`^${escaped}=(.*)$`, "m"))?.[1]?.trim() ?? null;
}

// ── parseCMakeGenerators：解析 cmake -E capabilities 的 JSON 输出 ──────
// as {generators?: Array<{name?: unknown}>}：类型断言说明期望的 JSON 形状（运行时不校验）。
// 生成器列表形如 [{name: "Visual Studio 17 2022"}, {name: "Ninja"}, …]。
function parseCMakeGenerators(output: string): string[] {
  try {
    const value = JSON.parse(output) as { generators?: Array<{ name?: unknown }> };
    return (value.generators ?? [])
      .map((generator) => generator.name)   // map：把每个元素换成 name
      // 类型谓词过滤：只留"真的是非空字符串"的名字。
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  } catch {
    return [];     // 输出不是合法 JSON（版本太老/报错）→ 空列表，不算致命
  }
}

// ── parseWorkingCCompiler：从 configure 输出抠出 C 编译器路径 ──────────
// CMake 检查编译器时输出形如 "-- Check for working C compiler: E:/.../gcc.exe -- works"，
// 所以抓到后要把尾部 " - skipped/- works" 去掉（(?:skipped|works?) 非捕获组 + $ 行尾 /i）。
function parseWorkingCCompiler(output: string): string | null {
  const match = output.match(/^-- Check for working C compiler:\s*(.+)$/im);
  if (match === null) return null;
  // match[1]!：非空断言（正则有一个捕获组时 [1] 必存在）。
  const compiler = match[1]!.replace(/\s+-\s+(?:skipped|works?)\s*$/i, "").trim();
  return compiler.length === 0 ? null : compiler;
}

// ── nativeProbeOptions：所有探针共用的子进程选项 ────────────────────────
// shell: false —— 直接执行可执行文件、不经过 shell 解释（防注入、也更快）；
// windowsHide: true —— 不弹出黑窗口；timeout: 30_000 —— 单探针最多等 30 秒（防卡死）。
// 返回类型是手写的对象类型字面量（不叫别的名字，直接内联声明）。
function nativeProbeOptions(): {
  encoding: "utf8";
  shell: false;
  windowsHide: boolean;
  timeout: number;
} {
  return { encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 };
}

// 拼接 stdout + stderr（ ?? "" 处理 undefined）。
function outputText(result: { stdout?: string | Buffer; stderr?: string | Buffer }): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

// 取"人类可读的失败摘要"：优先输出文本，其次错误消息，再退到退出码；一律截 400 字符。
function probeOutput(result: {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error | null;
  status?: number | null;
}): string {
  const output = outputText(result).trim();
  return (output || result.error?.message || `exit code ${String(result.status)}`).slice(0, 400);
}

// ── probeSanitizers：sanitizer 能力测量 ────────────────────────────────
// 【核心思想】"flag 写得出"不等于"链得起来"——必须真的编译一个探针程序验证。
// 本机实测：gcc 有，但 -fsanitize=address 链接缺 -lasan → UNSUPPORTED，流程如实记录，
// 绝不伪造 sanitizer pass（libuv 阶段三因此保持 UNSUPPORTED）。
function probeSanitizers(tools: Record<string, ToolProbe>): Record<string, SanitizerCapability> {
  const compiler = selectSanitizerCompiler(tools);
  const result: Record<string, SanitizerCapability> = {};
  // SanitizerKind.options：Zod enum 的"合法值列表"（z.enum 自带的工具属性）。
  for (const kind of SanitizerKind.options) {
    result[kind] = compiler === null
      ? {  // 连编译器都没有：直接给"不可用 + 原因"
          available: false,
          compiler: null,
          flags: [SANITIZER_FLAGS[kind]],
          reason: "no gcc or clang compiler is available on PATH",
        }
      : probeSanitizer(kind, compiler.name, compiler.path);
  }
  return result;
}

// 选 sanitizer 用的编译器：优先 gcc，其次 clang，都没有返回 null。
function selectSanitizerCompiler(
  tools: Record<string, ToolProbe>,
): { name: string; path: string } | null {
  for (const name of ["gcc", "clang"] as const) {
    const tool = tools[name];
    if (tool?.available && tool.path !== null) return { name, path: tool.path };
  }
  return null;
}

// ── probeSanitizer：单种 sanitizer 的实测 ─────────────────────────────
// 【动作】临时目录里写一个 main.c，用"编译器 + sanitizer flag + -g -O1"编译链接，
//   退出码 0 且产物存在 → available: true；否则记录 stderr 摘要为理由。
// 【语法】Bun.spawnSync：Bun 自己的子进程 API（和 node:child_process 并存的项目现状）；
//   Buffer.from(result.stdout).toString("utf8")：把 Buffer 二进制转字符串。
function probeSanitizer(
  kind: SanitizerKind,
  compilerName: string,
  compilerPath: string,
): SanitizerCapability {
  const root = mkdtempSync(join(tmpdir(), "rfr-sanitizer-probe-"));
  const source = join(root, "probe.c");
  const output = join(root, process.platform === "win32" ? "probe.exe" : "probe");  // Windows 带 .exe
  try {
    writeFileSync(source, "int main(void) { return 0; }\n");
    const result = Bun.spawnSync([
      compilerPath,
      SANITIZER_FLAGS[kind],
      "-g",      // 带调试信息
      "-O1",     // 轻度优化（接近真实构建）
      source,
      "-o",
      output,
    ], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const stdout = Buffer.from(result.stdout).toString("utf8").trim();
    const stderr = Buffer.from(result.stderr).toString("utf8").trim();
    if (result.exitCode === 0 && existsSync(output)) {
      return {
        available: true,
        compiler: compilerName,
        flags: [SANITIZER_FLAGS[kind]],
        reason: `${compilerName} compiled and linked a ${kind} sanitizer probe`,
      };
    }
    const detail = (stderr || stdout || `exit code ${String(result.exitCode)}`).slice(0, 400);
    return {
      available: false,
      compiler: compilerName,
      flags: [SANITIZER_FLAGS[kind]],
      reason: `${compilerName} cannot build ${kind} sanitizer probe: ${detail}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
