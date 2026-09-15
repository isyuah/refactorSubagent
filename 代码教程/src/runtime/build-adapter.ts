/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/build-adapter.ts —— "怎么把 C 代码编出来"的适配器们
 *
 * 【这个文件是干什么的】
 *   把"构建一个 C 工程"抽象成统一的两个动作：plan（先算出要执行哪些命令）和
 *   build（真的去执行）。每种构建系统一个适配器：
 *     · DirectCompilerAdapter —— 直接调 gcc/clang 编译，参数就是一个 argv 数组，完全不走 shell；
 *     · CMakeAdapter    —— cmake 两步走（configure + build），并兼容 VS 多配置生成器把
 *                          产物放进 build/Debug/ 这种"额外一层目录"的行为；
 *     · NinjaAdapter    —— ninja -C <目录>。⚠️ 它没法把 sanitizer / 确定性拦截头注入一个
 *                          **已经生成好的**构建图，所以这两种需求直接抛错（fail-closed），
 *                          而不是悄悄忽略。
 *
 * 【在整个项目里的位置】
 *   · 上游：src/runtime/builder.ts（把三个适配器实例化并按 EnvironmentSpec.build.kind 分发）、
 *     src/runtime/sanitizer-runner.ts（只用 BuildResult 类型和 resolveBinaryPath()）。
 *   · ⚠️ 这是**旧路径 / sanitizer 阶段**在用的模块：新 workflow 路径的构建由
 *     src/workflow/build-executor.ts 驱动（一段 TypeScript workflow 源码自己跑构建，
 *     产物由它声明），不再走这些适配器。
 *   · 下游：spawnSync（node:child_process）执行真正的编译命令；探测数据来自 host-preflight.ts。
 *
 * 【一个贯穿全文件的设计原则】
 *   plan() 是"纯计算"：只根据 EnvironmentSpec + HostPreflight 算出命令，不执行任何东西；
 *   build() 才有副作用。这让人可以在不碰机器的情况下检查"到底打算跑什么命令"，
 *   也让日志里能打印出一条可复现的命令行。
 *
 * 【先修知识】
 *   · class 与 implements（TS 的接口实现声明）、readonly、非空断言 !；
 *   · 展开运算符 ...（把数组摊平塞进另一个数组）、Set 去重、Object.entries；
 *   · spawnSync 的同步执行模型（拿到 status/stdout/stderr，不写回调）。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/build-adapter.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  BuildAdapterId,
  EnvironmentSpec,
  HostPreflight,
} from "../artifacts/index.js";

// ← 一次构建的结论：ok 成不成功、log 是完整命令行+输出、binaryAbs 是产物绝对路径。
//   注意 ok 只表示"编译成功且产物存在"，不表示行为正确（那是测试和对比阶段的事）。
export interface BuildResult {
  ok: boolean;
  log: string;
  binaryAbs: string;
}

// ← 一条要执行的命令：程序 + 参数数组。
//   ⚠️ 关键点：这里**没有** shell 字符串拼接，参数就是参数——不存在"文件名里带空格被拆开"这类注入问题。
export interface BuildCommand {
  program: string;
  args: string[];
}

/** A multi-step argv-only plan. Commands execute in order, without a shell. */
// ← 构建计划：按顺序执行的若干条命令 + 预期产物路径。
//   outputCandidates 是可选的"备选产物路径列表"——VS 多配置生成器会把产物放进
//   build/Debug/ 这种子目录，事先说不准到底在哪，所以给一组候选让程序挨个找。
export interface BuildPlan {
  adapter: BuildAdapterId;
  commands: BuildCommand[];
  output: string;
  outputCandidates?: string[];
}

// ── BuildAdapter：所有构建适配器的统一接口 ──────────────────────────
// 【作用】规定一个适配器必须长什么样：有一个 id（对应 BuildAdapterId 枚举），
//        一个 plan()（算计划），一个 build()（真执行）。
// 【关系】"探测该用哪个适配器"不在这个接口里——那是 project-detector.ts 的职责，
//        这里只负责"给我环境规格，我把它编译出来"。
// 【语法】readonly id：属性只在初始化时赋值，之后不可改；
//        接口方法只写签名不写实现（分号结尾）。
export interface BuildAdapter {
  readonly id: BuildAdapterId;
  plan(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildPlan;
  build(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildResult;
}

// ── DirectCompilerAdapter：直接调编译器（最简单也最透明的路径）──────
// 【语法】implements BuildAdapter 表示"这个类承诺实现 BuildAdapter 接口的全部成员"；
//        `readonly id = "direct-compiler" as const` 里的 as const 把类型收紧成字面量
//        "direct-compiler"（而不是宽泛的 string），这样它才能赋给 BuildAdapterId 类型的 id。
export class DirectCompilerAdapter implements BuildAdapter {
  readonly id = "direct-compiler" as const;

  // ── plan：把 EnvironmentSpec 翻译成一条 gcc/clang 命令 ─────────────
  // 【作用】拼出完整的编译 argv：用户 flags → sanitizer flags → -D 宏 → -include 拦截头 → 源文件 → -o 产物。
  // 【抛错】两种情况直接抛异常：传入的不是 direct-compiler 规格；指定的编译器在主机上不存在。
  plan(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildPlan {
    // ← 防御式检查：这个适配器只接受 kind === "direct-compiler" 的构建规格。
    //   `"kind" in env.build` 是"in 运算符"的类型收窄写法——BuildSpec 是个联合类型，
    //   只有先确认有 kind 这个字段，后面才允许读 env.build.kind。
    if (!("kind" in env.build) || env.build.kind !== "direct-compiler") {
      throw new Error("direct-compiler adapter received a non-direct build spec");
    }
    // ← 产物路径补上平台后缀（Windows 是 .exe），并确认编译器真的存在（用的是实测事实）
    const output = withExecutableSuffix(env.build.output, host);
    const compiler = host.tools[env.build.compiler];
    if (!compiler?.available || compiler.path === null) {
      throw new Error(`direct compiler unavailable: ${env.build.compiler}`);
    }
    const args = [
      ...removeInterceptFlags(env.build.flags, env.determinism.intercept_headers),   // ← 先把用户 flags 里可能已有的 -include <拦截头> 对儿拿掉（避免重复注入，见 removeInterceptFlags）
      ...sanitizerFlags(env, host),                                                  // ← sanitizer 旗标来自 HostPreflight 的**实测**能力：没测到可用会直接抛错
      ...Object.entries(env.build.defines).map(([key, value]) => `-D${key}=${value}`),   // ← 宏定义 { A: "1", B: "" } → -DA=1 -DB=。Object.entries 把对象拆成 [键, 值] 数组
    ];
    // ← 确定性拦截头：为了冻结时间/随机数，把项目里的某些头文件强制替换成受控版本。
    //   文件必须真的存在于这个 worktree 里，否则抛错（fail-closed）。
    for (const header of env.determinism.intercept_headers) {
      if (!existsSync(join(worktreeDir, header))) {
        throw new Error(`determinism header not found: ${header}`);
      }
      // ← -include <header> 等价于"在每个编译单元最前面偷偷 #include 它"
      args.push("-include", header);
    }
    // ← 最后是源文件列表和 -o 输出路径
    args.push(...env.build.sources, "-o", output);
    return {
      adapter: this.id,
      commands: [{ program: compiler.path, args }],   // ← this.id：类的实例属性；整条命令只有一个，就是编译器调用
      output,
    };
  }

  // ── build：先算计划，再执行 ───────────────────────────────────────
  // 【关系】三个适配器的 build() 都长一个样：plan() → executePlan()。真正的执行逻辑只有一份。
  build(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildResult {
    return executePlan(worktreeDir, this.plan(worktreeDir, env, host));
  }
}

// ── CMakeAdapter：configure + build 两步走 ──────────────────────────
export class CMakeAdapter implements BuildAdapter {
  readonly id = "cmake" as const;

  // ── plan：生成两条 cmake 命令（先 configure 再 build）────────────
  // 【作用】
  //   ① configure：cmake -S <源码目录> -B <构建目录> [-G 生成器] [额外 flags]，
  //      并把 sanitizer / 拦截头注入到 CMAKE_C_FLAGS 和链接器 flags 里；
  //   ② build：cmake --build <构建目录> [--target 目标]。
  // 【抛错】规格不是 cmake 类型、或 HostPreflight 里说 cmake 不可用。
  plan(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildPlan {
    if (!("kind" in env.build) || env.build.kind !== "cmake") {
      throw new Error("cmake adapter received a non-cmake build spec");
    }
    const cmake = host.tools.cmake;
    if (!cmake?.available || cmake.path === null) {
      throw new Error("cmake is not available in HostPreflight");
    }
    const build = env.build;
    // ← -S 指源码目录、-B 指构建目录（out-of-source：构建产物不和源码混在一起）
    const configureArgs = ["-S", build.source_dir, "-B", build.build_dir];
    // ← generator 为 null 表示"让 CMake 自己挑"（探测阶段已经测过默认生成器是什么）
    if (build.generator !== null) configureArgs.push("-G", build.generator);
    configureArgs.push(...build.configure_flags);

    // ← sanitizer 旗标 + 确定性拦截头，都要变成 C 編譯 flag 才能进 CMake 的构建图
    const sanitizer = sanitizerFlags(env, host);
    const cFlags = [
      ...sanitizer,
      ...env.determinism.intercept_headers   // ← 每个拦截头变成 -include "<绝对路径>"；replaceAll 把 Windows 反斜杠换成正斜杠，因为这些参数会被写进 CMakeCache，反斜杠容易和转义字符打架
        .map((header) => `-include "${join(worktreeDir, header).replaceAll("\\", "/")}"`),
    ].join(" ");
    // ← 只有确实需要注入时才加 -DCMAKE_C_FLAGS=...，避免无谓地改写项目的编译选项
    if (cFlags.length > 0) configureArgs.push(`-DCMAKE_C_FLAGS=${cFlags}`);
    if (sanitizer.length > 0) {
      // ← sanitizer 需要在链接阶段也生效（否则运行库找不到 __asan_* 之类的符号），所以要同时给链接器
      const linkerFlags = sanitizer.join(" ");
      configureArgs.push(`-DCMAKE_EXE_LINKER_FLAGS=${linkerFlags}`);
      configureArgs.push(`-DCMAKE_SHARED_LINKER_FLAGS=${linkerFlags}`);
    }

    const buildArgs = ["--build", build.build_dir, ...build.build_flags];
    // ← target 为 null 就用默认的 all 目标（把所有东西都编出来）
    if (build.target !== null) buildArgs.push("--target", build.target);
    return {
      adapter: this.id,
      commands: [
        { program: cmake.path, args: configureArgs },
        { program: cmake.path, args: buildArgs },
      ],
      output: withExecutableSuffix(build.output, host),
      // ← 备选产物路径：VS 多配置生成器会放到 build/Debug/ 下，这里把可能的都列出来
      outputCandidates: cmakeOutputCandidates(build.output, host),
    };
  }

  build(worktreeDir: string, env: EnvironmentSpec, host: HostPreflight): BuildResult {
    return executePlan(worktreeDir, this.plan(worktreeDir, env, host));
  }
}
// ── NinjaAdapter：跑 ninja -C <构建目录> ────────────────────────────
export class NinjaAdapter implements BuildAdapter {
  readonly id = "ninja" as const;

  // ── plan：一条 ninja 命令 ────────────────────────────────────────
  // 【⚠️ 最重要的设计决定】Ninja 的 build.ninja 是 CMake/项目**预先生成**的构建图，
  //   程序没有办法在不重新生成的情况下往里面塞 sanitizer 旗标或确定性拦截头。
  //   所以只要 EnvironmentSpec 要求了这两样中的任何一样，就直接抛错——
  //   宁可阻断，也不给你一个"看起来构建成功但实际没开 sanitizer"的结果（fail-closed）。
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
    // ← -C 切到构建目录再执行（build.ninja 在那里）；target 为 null 就跑默认目标
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

// ── executePlan：真正执行一个构建计划（三个适配器共用）──────────────
// 【作用】按顺序执行 plan.commands，任何一条失败就立刻停止；全部成功后再去找产物文件。
// 【参数】worktreeDir：执行命令时的工作目录（也就是命令里的相对路径都相对它）。
// 【返回】BuildResult。
// 【语法】candidates[0]! 末尾的 ! 是"非空断言"，告诉编译器这里一定有元素（下标 0 必然存在）。
function executePlan(worktreeDir: string, plan: BuildPlan): BuildResult {
  // ← 有备选清单就用备选清单，否则就只有一个候选
  const candidates = plan.outputCandidates ?? [plan.output];
  const firstOutput = join(worktreeDir, candidates[0]!);
  // ← 提前把产物目录建出来：有些构建系统要求 -o 指向的目录必须已存在
  mkdirSync(dirname(firstOutput), { recursive: true });
  let log = "";

  // ← 逐条执行。顺序很重要：CMake 必须先 configure 再 build。
  for (const command of plan.commands) {
    // ← shell: false —— 不经过 cmd.exe / bash，argv 直接交给操作系统，杜绝注入与转义问题。
    //   注意这里没有设 timeout：构建可能很慢，不加超时上限（这也是任务 6C 想统一的地方）。
    const result = spawnSync(command.program, command.args, {
      cwd: worktreeDir,
      encoding: "utf8",
      shell: false,
    });
    // ← 日志里把命令"渲染"成一条可读的命令行。⚠️ shellQuote 只是为了**好看**，
    //   真正的执行用的是上面的 argv 数组，不经过这个字符串。
    const rendered = [command.program, ...command.args].map(shellQuote).join(" ");
    log += `$ ${rendered}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`;
    // ← 任何一步失败就提前返回（短路），log 里已经攒下了失败前所有输出
    if (result.status !== 0) return { ok: false, log, binaryAbs: firstOutput };
  }

  // ← 全部命令都成功后，挨个检查候选路径，第一个真实存在的就是产物
  const actual = candidates
    .map((candidate) => join(worktreeDir, candidate))
    .find((candidate) => existsSync(candidate));
  return {
    // ← ok 的判定很严格：命令退出码是 0 还不够，产物文件必须真的出现
    ok: actual !== undefined,
    log,
    binaryAbs: actual ?? firstOutput,
  };
}

// ── sanitizerFlags：把"要求的 sanitizer"翻译成编译旗标 ──────────────
// 【作用】逐个检查 HostPreflight 里实测的 sanitizer 能力；没测到可用就抛错。
// 【返回】去重后的旗标数组（比如 address 和 undefined 的旗标不会重复）。
// 【语法】[...new Set(flags)] —— 用 Set 去重再摊回数组的惯用写法。
// 【关系】这是 host-preflight.ts 那个"懒探针"的下游消费者：探针测出来的 flags 就用在这里。
function sanitizerFlags(env: EnvironmentSpec, host: HostPreflight): string[] {
  const flags: string[] = [];
  for (const kind of env.sanitizers) {
    const capability = host.sanitizers[kind];
    if (!capability?.available) {
      // ← fail-closed：本机没验证过能编 sanitizer，就绝不假装加上了 -fsanitize=...
      throw new Error(
        `sanitizer '${kind}' unavailable: ${capability?.reason ?? "no measured capability"}`,
      );
    }
    flags.push(...capability.flags);
  }
  return [...new Set(flags)];
}

// ── resolveBinaryPath：这次到底要运行哪个可执行文件 ─────────────────
// 【作用】构建完了要跑测试，得先知道可执行文件在哪。这个函数负责"找文件"：
//        把候选路径挨个试，谁存在用谁；都不存在就退回第一个候选（让上层报错时也有路径可打印）。
// 【抛错】workflow-driven 的构建在规划期根本不知道产物路径（产物是运行时才声明的），所以直接拒绝。
// 【关系】builder.ts 把它 re-export 出去；runner.ts（旧差分运行）和 sanitizer-runner.ts 都靠它定位二进制。
export function resolveBinaryPath(worktreeDir: string, env: EnvironmentSpec): string {
  if ("kind" in env.build && env.build.kind === "workflow-driven") {
    throw new Error("workflow-driven builds declare artifacts at runtime; binary path is not statically known");
  }
  // ← 不同规格的字段名不一样：direct-compiler/cmake/ninja 叫 output，shell/legacy 叫 binary。
  //   `"output" in env.build ? ... : ...` 就是按字段存在性来取值。
  const output = "output" in env.build ? env.build.output : env.build.binary;
  // ← CMake 有多配置产物的可能，用和 CMakeAdapter 一样的候选清单；
  //   其他情况就只有两个候选：原名，或者原名 + .exe（仅 Windows 且原名没带 .exe 时）。
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
  // ← find() 找第一个真实存在的；一个都没有就用第一个候选兜底（注意这里不算"成功"）
  return candidates
    .map((candidate) => join(worktreeDir, candidate))
    .find((candidate) => existsSync(candidate)) ?? join(worktreeDir, candidates[0]!);
}

// ── cmakeOutputCandidates：CMake 产物可能在哪 ───────────────────────
// 【作用】返回 [原始路径, ...每个配置目录下的同一路径]。
// 【为什么】Visual Studio 这类"多配置生成器"会把 Debug/Release 的产物放进
//          build/Debug/、build/Release/ 子目录，而 Ninja/Make 是单配置、直接放 build/ 下。
//          程序事先不知道生成器是哪种，所以把四种标准配置全列上，运行后按存在性挑。
function cmakeOutputCandidates(output: string, host: HostPreflight): string[] {
  const base = withExecutableSuffix(output, host);
  const parent = dirname(base);
  const file = basename(base);
  const configurations = ["Debug", "Release", "RelWithDebInfo", "MinSizeRel"];
  return [base, ...configurations.map((configuration) => join(parent, configuration, file))];
}

// ── withExecutableSuffix：按平台补 .exe ─────────────────────────────
// 【作用】Windows 上可执行文件要有 .exe 后缀；规格里写的是不带后缀的相对路径，
//        所以这里负责补。已经带了就不重复补（大小写不敏感地判断）。
function withExecutableSuffix(output: string, host: HostPreflight): string {
  return host.executable_suffix.length > 0 &&
      !output.toLowerCase().endsWith(host.executable_suffix)
    ? `${output}${host.executable_suffix}`
    : output;
}

// ── removeInterceptFlags：去掉用户 flags 里已有的 -include 拦截头 ────
// 【作用】AI 提的编译 flags 里可能已经写了 -include header，而程序后面还会再注入一遍。
//        这里把"指向拦截头的那一对 flag"删掉，避免同一个头被 include 两次。
// 【细节】
//   · 逐个扫描 flags，遇到 -include 就看它的"下一个元素"是不是拦截头，
//     是的话两个一起跳过（i++ 跳过配对的下一个，continue 跳过当前这个）；
//   · 比较前都把反斜杠换成正斜杠，兼容"候选名是拦截头的末段路径"的情况。
// 【语法】flags[i]! 的 ! 是非空断言（TS 默认不会因为数组下标报错，这里是为了通过严格检查）。
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

// ── shellQuote：给日志里展示的命令行加引号 ──────────────────────────
// 【作用】参数里有空格或引号时包上引号，让日志里的命令"看起来像人敲的"。
// ⚠️ 它**只**用于日志渲染（见 executePlan 里的 rendered），不参与真实执行。
function shellQuote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
