/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/project-detector.ts —— "这是个什么 C 项目"探测器
 *
 * 【这个文件是干什么的】
 *   在让任何 AI 提构建方案**之前**，程序自己先扫一遍仓库，用纯文件系统的事实回答：
 *   这个项目是用 CMake？Ninja？Make？MSVC？还是根本没有构建系统（一堆裸 .c 文件）？
 *   结论落成一个 ProjectDetection artifact（kind: "project-detection"），
 *   原文注入给每一个 Claude 会话——模型只许基于测量结果提方案，不许猜。
 *
 * 【在整个项目里的位置】
 *   · 上游（谁调用 detectCProject）：
 *     - src/runtime/workflow-agent-pipeline.ts（新 workflow 主路径，第 74 行）；
 *     - src/runtime/agent-pipeline.ts（旧路径）；
 *     - scripts/cli.ts、scripts/e2e-cmake.ts、scripts/demo-libuv.ts、scripts/e2e-libuv-generate.ts。
 *   · 下游：它 import 的是 artifacts/index.js 里的 Schema；探测结果会作为
 *     project-detection.json 存盘，并作为 resolveWorkflows() 的输入（workflow 子系统靠它
 *     决定走哪条生成策略）。⇒ 新旧两条路径都在用它。
 *   · 典型入参：detectCProject(repoRoot, host) —— 第二个参数是 host-preflight.ts 测出的主机事实，
 *     用来判断"探测到的构建系统，这台机器上真的能跑起来吗"。
 *
 * 【fail-closed 在这里长什么样】
 *   状态有三种：ready / needs-adapter / no-c-sources。
 *   探测到 Make 或 MSVC 这类"系统存在、但本项目没实现适配器"的工程时，状态是 needs-adapter，
 *   上游 workflow-agent-pipeline.ts 第 83 行看到 status !== "ready" 就直接中止整次运行。
 *   ⚠️ 绝不会"反正有 .c 文件，那就当裸 C 编译吧"——那种静默降级会掩盖真实构建系统，
 *   编出来的产物和项目真正的构建方式不一致，对比结果就不可信了。
 *   （这句话也写在 src/artifacts/project-detection.ts 的注释里。）
 *
 * 【先修知识】
 *   · Set（去重集合）、Record<string, X>（键值对类型）、递归函数；
 *   · `??`（空值兜底）、`?.`（可选链）、嵌套三元表达式；
 *   · 类型守卫写法 `(value): value is string => ...`。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/project-detector.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ProjectDetection,
  type BuildAdapterId,
  type BuildSystem,
  type HostPreflight,
} from "../artifacts/index.js";

// ← 递归下钻时要跳过的目录。build/ dist/ out/ 这些是生成物目录——跳过它们，
//   一是不浪费 IO，二是避免把"构建系统生成的副本"误当成项目源码。
//   （Set 的 has() 比 Array 的 includes() 快，且语义上就是"成员判断"。）
const SKIP_DIRS = new Set([
  ".git",
  ".refactor",
  "node_modules",
  "build",
  "dist",
  "out",
  "cmake-build-debug",
  "cmake-build-release",
]);

// ← 已知的"构建产物目录"名单。这里单独列一份，是为了做下面那件特殊的事（见 collectKnownBuildMarkers）。
const KNOWN_BUILD_DIRS = ["build", "out", "cmake-build-debug", "cmake-build-release"];

// ← 文件名 → 构建系统的对照表。Record<string, BuildSystem> 表示"键是字符串、值是
//   BuildSystem 枚举之一"的对象。注意 Makefile 有大小写三种拼法（GNU make 三兄弟）。
const MARKER_SYSTEM: Record<string, BuildSystem> = {
  "CMakeLists.txt": "cmake",
  "build.ninja": "ninja",
  Makefile: "make",
  makefile: "make",
  GNUmakefile: "make",
};

/** Detect the project build system before an agent proposes a build plan. */
// ── detectCProject：本文件唯一导出的函数（探测入口） ─────────────────
// 【作用】扫一遍仓库 → 找出构建标记文件和所有 .c 源文件 → 推出构建系统、适配器和状态。
// 【参数】repoRoot：仓库根目录绝对路径；host：可选的 HostPreflight（主机实测事实）。
//        ⚠️ 不传 host 时 adapterAvailable() 一律返回 false，所以状态会变成 needs-adapter
//        而不是 ready——也就是说：想得到 ready 的结论，必须把主机探测结果一起给进来。
// 【返回】ProjectDetection（先经过 ProjectDetection.parse 的 Zod 校验，字段不对直接抛错）。
// 【关系】被两条 pipeline 调用；结果存成 project-detection.json，并喂给 workflow 决策与 AI 提示词。
export function detectCProject(
  repoRoot: string,
  host?: HostPreflight,
): ProjectDetection {
  const markers: string[] = [];
  const sourceFiles: string[] = [];
  // ← 两个动作：walk 递归扫源码/根目录标记；collectKnownBuildMarkers 补"生成目录里的 Ninja 标记"
  walk(repoRoot, repoRoot, markers, sourceFiles);
  collectKnownBuildMarkers(repoRoot, markers);

  // ← 把标记文件翻译成构建系统名，并去重（systems.includes 判断 + push）
  const systems: BuildSystem[] = [];
  for (const marker of markers) {
    const system = systemForMarker(marker);
    if (system !== null && !systems.includes(system)) systems.push(system);
  }

  // ← 一个构建标记都没有、但确实有 .c 文件 → 归类为 direct-c（裸 C 工程）
  if (systems.length === 0 && sourceFiles.length > 0) systems.push("direct-c");

  const primary = choosePrimary(systems);
  const adapter = chooseAdapter(primary, sourceFiles.length > 0);
  // ← 嵌套三元表达式，从上往下读：
  //   ① 一个 .c 文件都没有 → no-c-sources；
  //   ② 适配器是 direct-compiler / unsupported（不需要外部工具，或根本没法做）→ ready；
  //   ③ 其余情况要问 host："这个构建系统这台机器真的能跑吗？"能 → ready，不能 → needs-adapter。
  const status = sourceFiles.length === 0
    ? "no-c-sources"
    : adapter === "direct-compiler" || adapter === "unsupported" || adapterAvailable(adapter, host)
      ? "ready"
      : "needs-adapter";

  // ← reason：给人和给模型看的"为什么是这个结论"。整段是一串三元表达式，逐层匹配 status。
  const reason = status === "ready" && adapter === "direct-compiler"
    ? "no supported project build marker; direct C compilation is available"
    : status === "ready"
      ? `${primary} project detected and ${adapter} adapter is available`
      : status === "needs-adapter"
        ? `project declares ${primary} but its adapter or host tool is unavailable`
        : status === "no-c-sources"
          ? "no .c translation units were found"
          : `detected ${primary ?? "unknown"} project markers`;

  // ← 最后过一遍 Zod：parse 通过才返回。这是"程序产出的数据也必须过同一套 Schema"的纪律。
  return ProjectDetection.parse({
    kind: "project-detection",
    version: 1,
    repo_root: repoRoot,
    language: "c",
    build_systems: systems,
    primary_build_system: primary,
    markers,
    source_files: sourceFiles,
    adapter,
    status,
    reason,
  });
}

// ── walk：递归遍历目录，收集"标记文件"和".c 源文件" ─────────────────
// 【作用】readdirSync 只列一层，所以要自己递归。收集结果通过传入的数组"带出去"（引用传递）。
// 【细节】
//   · 标记文件只在**仓库根目录**算数（dir === root 这个条件）——
//     子目录里出现一个 CMakeLists.txt 不代表整个项目是 CMake 工程；
//   · .c 文件则是在所有未跳过的子目录里都算数。
// 【语法】readdirSync(dir, { withFileTypes: true }) 直接返回带 isDirectory() 的 Dirent 对象，
//        省得再对每个条目 stat 一次。
function walk(
  root: string,
  dir: string,
  markers: string[],
  sourceFiles: string[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // ← 跳过黑名单目录，以及一切以 cmake-build- 开头的目录（CLion 的默认构建目录）
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith("cmake-build-")) {
        walk(root, join(dir, entry.name), markers, sourceFiles);
      }
      continue;
    }

    // ← 相对路径统一成正斜杠（Windows 上 relative() 返回反斜杠，会破坏可复现性）
    const rel = relative(root, join(dir, entry.name)).split("\\").join("/");
    // ← 标记文件：只在根目录认（msvcSystem 判断 .sln / .vcxproj）
    if (dir === root && (MARKER_SYSTEM[entry.name] !== undefined || msvcSystem(entry.name) !== null)) {
      markers.push(rel);
    }
    // ← 所有 .c 文件都记下来（不分大小写后缀）
    if (entry.name.toLowerCase().endsWith(".c")) sourceFiles.push(rel);
  }
}

// ── collectKnownBuildMarkers：把"生成目录里的 build.ninja"也认作 Ninja 标记 ──
// 【作用】很多项目平时不把 build.ninja 提交进 git（它是 cmake -G Ninja 生成出来的），
//        只躺在 build/ 这种生成目录里。walk() 会跳过这些目录，所以这里单独补一刀：
//        逐个检查 KNOWN_BUILD_DIRS 里的 <目录>/build.ninja 是否真的存在。
//        这正是任务清单里说的"build/ 生成目录里的 build.ninja 也能识别"。
// 【细节】!markers.includes(marker) 防止重复添加同一条标记。
function collectKnownBuildMarkers(root: string, markers: string[]): void {
  for (const directory of KNOWN_BUILD_DIRS) {
    const marker = `${directory}/build.ninja`;
    if (existsSync(join(root, marker)) && !markers.includes(marker)) markers.push(marker);
  }
}

// ── systemForMarker：一个标记文件 → 它代表哪种构建系统 ───────────────
// 【作用】先取文件名（marker 可能是 "build/build.ninja" 这种带路径的形式），
//        再查表；查不到就问 msvcSystem（.sln/.vcxproj）。
// 【语法】lastIndexOf("/") + slice 是"取文件名"的手写实现；?? 是空值兜底。
function systemForMarker(marker: string): BuildSystem | null {
  const filename = marker.slice(marker.lastIndexOf("/") + 1);
  return MARKER_SYSTEM[filename] ?? msvcSystem(filename);
}

// ── msvcSystem：判断是不是 Visual Studio 工程文件 ────────────────────
// 【返回】是 → "msvc"；不是 → null。toLowerCase 让 .SLN/.Vcxproj 也能命中。
function msvcSystem(name: string): BuildSystem | null {
  return name.toLowerCase().endsWith(".sln") || name.toLowerCase().endsWith(".vcxproj")
    ? "msvc"
    : null;
}

// ── choosePrimary：多个构建系统并存时，听谁的 ───────────────────────
// 【作用】按固定优先级排序取第一个：cmake > ninja > make > msvc > direct-c。
// 【为什么】一个 CMake 工程经常同时存在 CMakeLists.txt 和 build/build.ninja（生成物），
//          必须有个确定性的挑选规则，两次运行结果才一致。
// 【语法】数组的 find() 返回第一个满足条件的元素，找不到返回 undefined；?? null 兜底成 null。
//        参数类型 readonly BuildSystem[] 表示"只读数组"——承诺不修改调用方的数组。
function choosePrimary(systems: readonly BuildSystem[]): BuildSystem | null {
  const order: BuildSystem[] = ["cmake", "ninja", "make", "msvc", "direct-c"];
  return order.find((candidate) => systems.includes(candidate)) ?? null;
}

// ── chooseAdapter：探测到的构建系统 → 该用哪个适配器去构建 ─────────
// 【返回】BuildAdapterId 里的一个：cmake / ninja / make / msvc / direct-compiler / unsupported。
// 【逻辑】
//   · 连 .c 文件都没有 → unsupported（没东西可编）；
//   · 没有任何构建系统标记但有源码 → direct-compiler（直接 gcc 一把梭）；
//   · direct-c 系统 → 也是 direct-compiler；
//   · 其他（cmake/ninja/make/msvc）→ 同名适配器。注意 make 和 msvc 目前没有实现适配器，
//     所以后面 adapterAvailable() 必然给 false → needs-adapter → 上游直接阻断。
function chooseAdapter(
  primary: BuildSystem | null,
  hasSources: boolean,
): BuildAdapterId {
  if (!hasSources) return "unsupported";
  if (primary === null) return "direct-compiler";
  return primary === "direct-c" ? "direct-compiler" : primary;
}

// ── adapterAvailable：这台机器真的能跑这个适配器吗（用实测事实回答）──
// 【作用】把"项目需要什么"和"主机有什么"对上。依据全部来自 host-preflight.ts 的**测量结果**，
//        不是猜的。
// 【逻辑】
//   · cmake：光有 cmake 可执行文件还不够，还要求预检时"最小工程 configure 和 build 都真的成功"
//     （configure_probe === "pass" && build_probe === "pass"）——因为 CMake 能找到生成器不等于能编出东西；
//   · ninja：只要 PATH 上有 ninja 可执行文件；
//   · make / msvc / 其他 → false（没有适配器实现）。
//   ⚠️ 这正是 needs-adapter 的来源：探测到 Make/MSVC 工程时会被 fail-closed 阻断，
//      而不是悄悄退化成"把所有 .c 文件编一遍"。
function adapterAvailable(
  adapter: BuildAdapterId,
  host?: HostPreflight,
): boolean {
  if (!host) return false;
  if (adapter === "cmake") {
    return host.tools.cmake?.available === true &&
      host.cmake.configure_probe === "pass" &&
      host.cmake.build_probe === "pass";
  }
  if (adapter === "ninja") return host.tools.ninja?.available === true;
  return false;
}
