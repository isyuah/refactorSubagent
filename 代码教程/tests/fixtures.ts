/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/fixtures.ts —— 测试夹具（fixture）工厂
 *
 * 【这个文件是干什么的】
 *   先解释"夹具"这个词：夹具 = 测试用的标准样例数据，就像工厂里固定零件的
 *   夹具一样，让每次测试都从同一个已知起点出发。本文件手工构造了一整套
 *   "合法的 artifact"：行为契约、范围清单、依赖清单、测试规格、环境规格、
 *   观测轨迹、补丁记录、对比结果——它们描述的都是同一个假想小项目：
 *   src/util.c 里有个 trim() 函数，配上 main.c 组成一个可执行程序。
 *
 *   ⚠️ 一个关键设计：这里每个导出都是【函数】而不是常量对象（contract()
 *   而不是 contract）。为什么？因为测试会随手改这些对象（比如
 *   state-machine.test.ts 里 `partial.observations = ...`）。如果所有测试
 *   共享同一个对象，一个测试的改动就会污染下一个测试。每次调用都返回
 *   【全新副本】，测试之间就互不干扰了。这就是"工厂函数"式夹具。
 *
 * 【在整个项目里的位置】
 *   被同目录的测试文件 import（最主要的是 state-machine.test.ts 的旧版
 *   差分路径测试）。这些样例的"形状"必须与 src/artifacts/ 下的 Zod Schema
 *   完全对齐——Schema 改了，这里的夹具就得跟着改，否则状态机会拒绝它们。
 *   🔗 新版（自驱动 TestWorkflow）的夹具没有放在这里，而是内联在
 *      expectation-state-machine.test.ts 的 prefixArtifacts() 里。
 *
 * 【先修知识】src/artifacts/index.ts 的导出清单、Zod 的 parse/safeParse、
 *   TS 箭头函数返回对象的写法 `() => ({ ... })`。
 *
 * 【需要真实 gcc/cmake 吗】不需要。本文件纯内存构造数据、零 IO，
 *   属于"纯逻辑单测"的支撑件。
 *
 * 【本文件是教程注释版】原文件 tests/fixtures.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */

// import type —— 只导入"类型"，不导入运行时代码，编译后整行消失。
// 这 9 个类型全部来自 src/artifacts/（由同名 Zod Schema 用 z.infer 推导出来）。
import type {
  AnyArtifact,        // 全部 artifact 的联合类型（happyPath() 的返回元素类型）
  BehaviorContract,   // 行为契约：哪些可观察行为必须保持
  ComparisonResult,   // 新旧版本逐用例对比结果（旧版 comparator 的产物）
  DependencyManifest, // 依赖清单：时间/随机/文件系统…怎么隔离
  EnvironmentSpec,    // 环境规格：怎么编译、要不要 sanitizer、怎么保证确定性
  TestSpec,           // 测试规格：要跑哪些用例
  PatchRecord,        // 补丁记录：Claude 到底改了哪些文件
  ScopeManifest,      // 范围清单：能改什么、能读什么、禁止读什么
  ObservationTrace,   // 观测轨迹：实际跑一次程序看到了什么
} from "../src/artifacts/index.js";

const SHA = "a".repeat(64);
// ← "a".repeat(64)：把字符 a 重复 64 次，凑一个假的 sha256 长度（64 个十六进制字符）。
//   ⚠️ 本文件其实没有任何地方用到 SHA，它只是个占位提示："真 hash 由注册表算"。

/** Sample artifacts describing a small C project: `trim()` in src/util.c. */

// ── contract()：一张"最小但合法"的行为契约 ─────────────────────────────
// 【作用】声明哪些"通道"（可观察行为的维度）必须保持。这 5 个通道正好是
//        本项目能观测的全部维度；mode 决定怎么比：
//          exact     —— 逐字节必须一样（最严格）
//          normalize —— 归一化之后再比（stderr 常有 \r\n / 结尾换行的差异）
//          semantic  —— 按"语义"比，filesystem 通道指定了 fs-effects-v1 比较器
// 【语法】`() => ({ ... })`：箭头函数返回对象字面量必须加括号，
//        否则开头的 `{` 会被当成函数体的大括号而不是"返回一个对象"。
// 【关系】它是 happyPath() 的第 1 个元素，对应状态机 INIT → CONTRACT_READY。
export const contract = (): BehaviorContract => ({
  kind: "behavior-contract",                            // ← artifact 的"身份证"：类型名
  version: 1,                                           // ← Schema 版本号（字段变了就 bump）
  channels: {
    exit_code: { mode: "exact" },
    signals: { mode: "exact" },
    stdout: { mode: "exact" },
    stderr: { mode: "normalize" },
    filesystem: { mode: "semantic", comparator: "fs-effects-v1" },
  },
  allowed_change: { internal_structure: true, execution_time: true },  // ← 允许变：内部结构、耗时
  notes: [],
});

// ── scope()：范围清单 ──────────────────────────────────────────────────
// 【作用】划定三个维度：editable_files（能改的文件+符号）、readable_globs
//        （能读的）、forbidden_globs（禁止读的）。执行期不是靠 AI 自觉，
//        而是由 PreToolUse Hook 拿这份清单去拦截越界访问。
// 【语法】"src/**" 是 glob 通配：** 表示任意层级的任意路径。
export const scope = (): ScopeManifest => ({
  kind: "scope-manifest",
  version: 1,
  editable_files: [{ file: "src/util.c", symbols: ["trim"] }],  // ← 只许动 util.c 的 trim 函数
  readable_globs: ["src/**"],
  forbidden_globs: ["tests/**"],
});

// ── deps()：依赖清单 ───────────────────────────────────────────────────
// 【作用】列出程序依赖的"不确定来源"，以及隔离策略。这里给了两个经典例子：
//        time() 用 freeze（冻结时钟）、rand() 用 seed（固定随机种子）。
//        隔离的目的：让两次运行（baseline / candidate）只有代码差异、
//        没有环境噪声，对比才有意义。
export const deps = (): DependencyManifest => ({
  kind: "dependency-manifest",
  version: 1,
  dependencies: [
    { name: "time()", kind: "time", strategy: "freeze", evidence: [], notes: "" },
    { name: "rand()", kind: "randomness", strategy: "seed", evidence: [], notes: "" },
  ],
});

// ── tests()：测试规格 ──────────────────────────────────────────────────
// 【作用】定义要跑哪些用例。两种 kind：
//          regression  —— 回归用例：只要旧行为不崩就不崩
//          differential—— 差分用例：新旧两侧输出必须一致（本项目的主打）
// 【关系】它是夹具里的"基准表"：trace() 和 comparison() 都会用 cases() 生成
//        同样 3 条记录（r1/d1/d2），保证两侧观测可以按下标配对。
export const tests = (): TestSpec => ({
  kind: "test-spec",
  version: 1,
  cases: [
    { id: "r1", kind: "regression", argv: ["app"], stdin: "", fixtures: [], expect_exit_code: 0 },
    { id: "d1", kind: "differential", argv: ["app", "  hi  "], stdin: "", fixtures: [] },  // ← 正常输入
    { id: "d2", kind: "differential", argv: ["app", ""], stdin: "", fixtures: [] },        // ← 边界：空串
  ],
});

// ── env()：环境规格 ────────────────────────────────────────────────────
// 【作用】说明"怎么把它编译出来 + 怎么让运行可复现"。command/binary 是
//        旧版 direct-compiler 路径用的；determinism 里的冻结时间戳/随机种子
//        会通过 intercept_headers 里声明的头文件注入到 C 代码里。
export const env = (): EnvironmentSpec => ({
  kind: "environment-spec",
  version: 1,
  build: {
    cc: "gcc",
    flags: ["-O2", "-Wall"],
    defines: {},
    command: "gcc -O2 -Wall src/main.c src/util.c -o bin/app",
    binary: "bin/app",
  },
  sanitizers: [],                                     // ← 不开 ASan/UBSan（本机缺 -lasan）
  determinism: {
    frozen_time_epoch_ms: 1700000000000,              // ← 毫秒级时间戳，冻结到 2023-11-14
    random_seed: 42,
    intercept_headers: ["shim/determinism.h"],
  },
  sandbox: { run_cwd_strategy: "fresh_temp_dir" },    // ← 每个用例在一个全新临时目录里跑
});

// ── trace()：观测轨迹（最重要的夹具，可被测试改写）──────────────────────
// 【作用】描述"跑一次程序实际看到了什么"。同一份夹具函数可以用 build 参数
//        生成 baseline 侧或 candidate 侧，再由测试用 overrides 覆盖个别字段
//        来制造"失败/异常"场景。
// 【参数】build     —— "baseline" | "candidate"，字面量联合类型
//        overrides —— Partial<ObservationTrace>：Partial 让所有字段变成可选，
//                     只写想覆盖的那几个，剩下用默认值
// 【语法】`"observed" as const`：as const 把字符串收窄成字面量类型 "observed"，
//        不然 TS 会推断成宽泛的 string 而匹配不上 Schema。
//        `Buffer.from(...).toString("base64")`：stdout 在 artifact 里一律存 base64，
//        避免二进制/换行符把 JSON 搞乱。Buffer 是 Bun/Node 的全局对象，不用 import。
export function trace(
  build: "baseline" | "candidate",
  overrides: Partial<ObservationTrace> = {},
): ObservationTrace {
  const obs = tests().cases.map((c) => ({
    case_id: c.id,
    status: "observed" as const,
    exit_code: 0,
    signal: null,
    stdout_b64: Buffer.from(`out:${c.id}`).toString("base64"),
    stderr_b64: "",
    filesystem: [],
    duration_ms: 3,
  }));
  const base = {
    kind: "observation-trace" as const,
    version: 1 as const,
    build,
    env_id: "env001",
    observations: obs,
    failures: [] as ObservationTrace["failures"],   // ← 用索引访问取类型：取该类型的 failures 字段类型
  };
  return { ...base, ...overrides };                 // ← 展开合并：overrides 里的字段覆盖默认值
}

// ── patch()：补丁记录 ─────────────────────────────────────────────────
// 【作用】声明 Claude 实际改了什么。状态机规则 R4 会拿 changed_files 去比对
//        scope().editable_files——改了清单外的文件直接拒绝。
// 【参数】changed —— 默认 ["src/util.c"]，正好在 editable 范围内（合法路径）。
//        测试想触发 R4 就传个范围外的路径，比如 ["src/other.c"]。
export const patch = (changed: string[] = ["src/util.c"]): PatchRecord => ({
  kind: "patch-record",
  version: 1,
  branch: "refactor/trim",
  commit_sha: "b".repeat(40),       // ← git commit hash 是 40 位十六进制
  base_commit_sha: "c".repeat(40),
  changed_files: changed,
  summary: "extract helper from trim()",
});

// ── comparison()：逐用例对比结果 ───────────────────────────────────────
// 【作用】给出每个用例的 match/mismatch 判定，并自动汇总出 overall：
//        全部 match → "consistent"，任何一个 mismatch → "inconsistent"。
//        状态机规则 R6 看的就是这个 overall：inconsistent → REJECTED。
// 【参数】verdicts —— 按下标对应 tests() 里的 r1/d1/d2；缺了就当 mismatch
//                   （?? 空值合并：左边是 undefined 才用右边，fail-closed）
// 【语法】`as ComparisonResult`：类型断言，"你别啰嗦，就当它是这个类型"。
//        这里是因为测试夹具的字段没填全（channels/detail 为空对象），
//        用断言绕过类型检查——只发生在测试代码里，生产代码不会这么写。
export function comparison(
  verdicts: Array<"match" | "mismatch"> = ["match", "match", "match"],
): ComparisonResult {
  const per_case = tests().cases.map((c, i) => ({
    case_id: c.id,
    verdict: verdicts[i] ?? "mismatch",
    channels: {},
    detail: "",
  }));
  const overall = per_case.every((p) => p.verdict !== "mismatch")
    ? "consistent"
    : "inconsistent";
  return {
    kind: "comparison-result",
    version: 1,
    baseline_env_id: "env001",
    candidate_env_id: "env002",
    // deno-lint-ignore no-explicit-any
    per_case,
    overall,
  } as ComparisonResult;
}

/** Happy-path artifact sequence, in submission order. */

// ── happyPath()：一条完整的"合法提交序列" ──────────────────────────────
// 【作用】按状态机要求的顺序排好 9 个 artifact，从 CONTRACT 一直到最后一次
//        对比。测试里的 advance(n) 只取前 n 个提交，就能精确停在某一个状态，
//        然后再单独测"第 n+1 步的拒绝/放行"。
// ⚠️ 注意这是【旧版差分路径】的序列（没有 workflow 决策两步）。新版自驱动
//    TestWorkflow 的序列（含 WorkflowResolution ×2 + expectation 三件套）
//    在 expectation-state-machine.test.ts 里自己拼。
export const happyPath = (): AnyArtifact[] => [
  contract(),          // → CONTRACT_READY
  scope(),             // → SCOPE_READY
  deps(),              // → DEPENDENCY_READY
  tests(),             // → TESTS_READY
  env(),               // → ENV_READY
  trace("baseline"),   // → BASELINE_READY
  patch(),             // → PATCH_CREATED
  trace("candidate"),  // → VERIFICATION_RUNNING
  comparison(),        // → ACCEPTED
];
