/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/ctest-comparator.ts —— 给 CTest 失败"分分类"，再把新旧两份结果对一对
 *
 * 【这个文件是干什么的】
 *   三个函数，对应验证半场的三步：
 *   ① classifyCTestBaseline()：把 baseline 的 CTest 结果加工成"带失败分类"的 ctest-baseline.json
 *      （每个失败标上 environment / unknown、是否与重构范围有关、以及一段人话解释）；
 *   ② createCTestCandidate()：把 candidate 的结果包装成 ctest-candidate.json
 *      （刻意**不带**分类——分类只针对"改动前就有的失败"，candidate 不享受这个待遇）；
 *   ③ compareCTestSuites()：把两份结果放在一起对，得出 consistent / inconsistent。
 *
 * 【在整个项目里的位置】
 *   上游：src/runtime/workflow-pipeline.ts 在 baseline、candidate 各跑完一次 runCTest() 之后
 *         依次调用这三个函数（教程 §1.3 第 ⑨ 步"对比"）。
 *   下游：三个产物都经 Zod 校验后存进 SessionStore（.refactor/sessions/<id>/artifacts/），
 *         comparison 的 overall 交给状态机做裁决：
 *         consistent → 继续走 ACCEPTED，inconsistent → REJECTED（fail-closed 规则 R6）。
 *   观测：workflow-pipeline 还会把它们写成 <run>/artifacts/*.json，Dashboard 能直接看。
 *
 * 【先修知识】
 *   · Zod：.parse(对象) 会"安检"一遍，字段类型/取值不对就当场抛错——模型或代码说什么不算数，
 *     过了 Schema 才算事实。Schema 定义在 src/artifacts/ctest-suite.ts。
 *   · Set（去重集合）与 [...set] 展开回数组。
 *   · CTest 的 summary 数的是**顶层目标**（uv_test / uv_test_a），不是内部 TAP 用例——
 *     见 ctest-runner.ts 文件头的说明。
 *
 * 【本文件是教程注释版】
 *   原文件：src/runtime/ctest-comparator.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← 这里既 import 了"类型"（type 前缀），也 import 了 Zod Schema 常量（没有 type 前缀的那些，
//   比如 CTestBaseline）——后者在运行时真实存在，用来 .parse() 做校验
import {
  CTestBaseline,
  CTestCandidate,
  CTestComparisonResult,
  type CTestFailureClassification,
  type CTestSuiteResult,
} from "../artifacts/index.js";

// ── classifyCTestBaseline：给 baseline 的每个失败"定性" ────────────────
// 【作用】产出 ctest-baseline.json。它回答的问题是："改动之前，哪些测试本来就挂？
//         这些挂法看起来是环境造成的，还是和我要改的代码有关？"
// 【参数】result：runCTest() 的产出。
//         options.scopeFiles / scopeSymbols —— 修改范围内的文件名与符号名（来自 ScopeManifest），
//                 用来判断失败输出里是否提到了范围内代码（related_to_scope）；
//         options.knownEnvironmentPatterns —— 调用方额外提供的"已知环境问题"正则清单
//                 （workflow-pipeline 传入 request.knownEnvironmentPatterns，比如 libuv 那几个
//                 DNS/短路径/flaky 用例）。
// 【返回】CTestBaseline（过 Zod 校验）。
// 【⚠️ 关键】这里只是"收集证据"，绝不把失败改成通过——看下面 notes 那句话。
//         baseline 的分类在后面的 compareCTestSuites() 里**目前完全没被用到**（见那边的 ⚠️）。
export function classifyCTestBaseline(
  result: CTestSuiteResult,
  options: {
    readonly scopeFiles?: readonly string[];
    readonly scopeSymbols?: readonly string[];
    readonly knownEnvironmentPatterns?: readonly RegExp[];
  } = {},                             // ← 默认参数：调用方一个都不传时就用空对象
): CTestBaseline {
  // ← 三元嵌套：
  //   ① 有失败清单 → 直接用；
  //   ② 没有失败清单但 status 是 pass → 空数组（没有失败可分类）；
  //   ③ 没有失败清单但套件确实失败了（比如整个 ctest 崩了/超时）→ 合成一个名叫 "__suite__"
  //     的假失败，把 failure.explanation 当它的输出。
  //   为什么要合成？因为 CTestBaseline 的 Schema（ctest-suite.ts 的 superRefine）要求：
  //   "只要套件失败，每个失败都必须有一条分类"——一个名字都不给就没法分类，校验会直接打回。
  const failures = result.failed_tests.length > 0
    ? result.failed_tests
    : result.status === "pass"
      ? []
      : [{ name: "__suite__", output: result.failure?.explanation ?? "CTest suite failed" }];

  // ← 对每个失败逐个产出四元组：测试名、类别、是否与范围相关、解释
  const classifications: CTestFailureClassification[] = failures.map((failure) => ({
    test: failure.name,
    category: classifyFailure(failure.output, options.knownEnvironmentPatterns),
    related_to_scope: appearsScopeRelated(failure.output, options.scopeFiles ?? [], options.scopeSymbols ?? []),
    explanation: explainFailure(failure.output),
  }));

  // ← .parse()：Zod 安检。不过关就抛异常 → 上游 pipeline 直接中断（fail-closed）
  return CTestBaseline.parse({
    kind: "ctest-baseline",
    version: 1,
    result,
    failure_classifications: classifications,
    notes: [
      "Classification is evidence for fail-closed baseline gating; it does not turn a failed suite into a pass.",
    ],
  });
}

// ── createCTestCandidate：给 candidate 的结果盖个"没分类"的章 ───────────
// 【作用】产出 ctest-candidate.json。字段比 baseline 少一块：没有 failure_classifications。
// 【为什么】分类的语义是"改动前就存在的失败"，给 candidate 也分类会让两边语义混淆；
//          对比阶段只需要 candidate 的失败名单和状态。
// 【关系】workflow-pipeline 在 candidate 侧跑完 runCTest() 后调用它，然后提交状态机。
export function createCTestCandidate(result: CTestSuiteResult): CTestCandidate {
  return CTestCandidate.parse({
    kind: "ctest-candidate",
    version: 1,
    result,
    notes: ["Candidate ran the same program-materialized CTestSuiteSpec as baseline."],
  });
}

// ── compareCTestSuites：新旧两份 CTest 结果的"对账" ───────────────────
// 【作用】判定 candidate 是否与 baseline 行为一致。三条同时成立才算 consistent：
//         ① 顶层目标集合完全一样；② status 一样；③ 失败集合一模一样（added/removed 都为空）。
// 【参数】baseline：上面 classifyCTestBaseline 的产物；candidate：createCTestCandidate 的产物。
// 【返回】CTestComparisonResult（ctest-suite.ts），核心是 overall: consistent | inconsistent。
// 【关系】workflow-pipeline 把 overall 交给状态机 → consistent 走 ACCEPTED，否则 REJECTED。
//
// ⚠️ 注释重点一（对应教程任务 #9）：两侧失败集合**完全相同**时，今天的结果就是
//    consistent → ACCEPTED，而且**没有任何提示**。也就是说"新版本和旧版本一样挂"被静默放行。
//    计划中的做法是在 CTestComparisonResult 上加 warnings 字段，把"两侧同失败"
//    （尤其是分类为 environment 的）作为警告附在 artifact 和 transition note 里，
//    裁决仍然是 ACCEPTED——本文件就是这个警告的"产生点"，也是任务 #9 的主要改动位置。
//
// ⚠️ 注释重点二：baseline 侧辛苦算出来的 failure_classifications（哪些是 environment、
//    哪些与范围相关）在这里**一行都没被用到**——只用了 baseline.result 的原始字段。
//    任务 #4 / #9 想利用这份分类（比如"环境敏感失败保持稳定就给个警告"），就得把
//    classification 传进对比逻辑。
//
// 🔗 另外注意：旧版对比器 src/runtime/comparator.ts 对失败的要求更严——它要求 baseline
//    的失败在 candidate **复现**才算匹配；而这条 CTest 路径不要求复现，只要"集合没变大"。
//    两条路径语义不一致，是教程任务清单里点名要写清楚的一处。
export function compareCTestSuites(
  baseline: CTestBaseline,
  candidate: CTestCandidate,
): CTestComparisonResult {
  // ← 各自拿到"失败名字集合"；空集合 + 套件失败时会合成 "__suite__"（见下面 failureNames）
  const baselineFailures = failureNames(baseline.result);
  const candidateFailures = failureNames(candidate.result);
  // ← 差集：candidate 多出来的失败（新增，最危险）和少掉的失败（"修好了"，其实也可疑）
  const added = difference(candidateFailures, baselineFailures);
  const removed = difference(baselineFailures, candidateFailures);
  // ← 顶层目标必须一个不多一个不少：如果 candidate 少了一个目标（比如编译失败导致目标没生成），
  //   即使"失败集合相同"也不能算一致
  const topLevelMatch = sameSet(
    new Set(baseline.result.top_level_tests),
    new Set(candidate.result.top_level_tests),
  );
  const statusMatch = baseline.result.status === candidate.result.status;
  const overall = topLevelMatch && added.length === 0 && removed.length === 0 && statusMatch
    ? "consistent"
    : "inconsistent";

  // ← 产物同样要过 Zod 才算数；reason 是给人看的一句话（状态机 history 和 Dashboard 都会展示）
  return CTestComparisonResult.parse({
    kind: "ctest-comparison-result",
    version: 1,
    baseline_status: baseline.result.status,
    candidate_status: candidate.result.status,
    baseline_top_level_tests: [...baseline.result.top_level_tests],
    candidate_top_level_tests: [...candidate.result.top_level_tests],
    baseline_failed_tests: [...baselineFailures],
    candidate_failed_tests: [...candidateFailures],
    added_failures: added,
    removed_failures: removed,
    overall,
    reason: overall === "consistent"
      ? "candidate has the same CTest status, top-level targets, and failure set as baseline"
      : `CTest drift: added=[${added.join(", ")}] removed=[${removed.join(", ")}] ` +
        `top_level_match=${String(topLevelMatch)} status_match=${String(statusMatch)}`,
  });
}

// ── classifyFailure：只看失败输出文本，判它是不是"环境造成的" ───────────
// 【作用】二选一：environment 或 unknown。
// 【语法】patterns?.some(...) 是可选链 + 数组.some 的组合：
//         patterns 是 undefined 时整个表达式短路成 undefined（falsy），不会报错；
//         some 只要有任意一个正则命中就返回 true。
//         后面那条内置正则命中的是 libuv 实测中常见的环境敏感词：IPv6/UDP/DNS/timeout/
//         short path/unavailable/refused。
// 【关系】结果写进 CTestFailureClassification.category；目前只影响 baseline 证据，
//         不影响裁决（见上面 compareCTestSuites 的 ⚠️ 重点二）。
function classifyFailure(output: string, patterns: readonly RegExp[] | undefined): CTestFailureClassification["category"] {
  if (patterns?.some((pattern) => pattern.test(output)) || /IPv6|UDP|DNS|timeout|short path|unavailable|refused/i.test(output)) {
    return "environment";
  }
  return "unknown";
}

// ── appearsScopeRelated：失败输出里有没有提到"我要改的文件/符号" ────────
// 【作用】辅助判断"这个失败是不是我的改动引起的"。
// 【实现】把文件名和符号名合并成一个数组，只要有一个非空值出现在输出文本里就算相关。
//         这是相当粗的字面子串匹配（includes），不是语法级分析——宁可误报也不漏报。
function appearsScopeRelated(output: string, files: readonly string[], symbols: readonly string[]): boolean {
  return [...files, ...symbols].some((value) => value.length > 0 && output.includes(value));
}

// ── explainFailure：把失败输出压成一句 ≤1000 字符的人话 ───────────────
// 【作用】塞进 artifact 的 explanation 字段。先 trim 掉首尾空白，再把所有空白（含换行）
//         压成单个空格——这样一段几十行的 CTest 报错也能塞进一行 JSON 字符串。
// 【细节】输出为空时给一句占位说明，保证 Schema 的 min(1) 校验能过。
function explainFailure(output: string): string {
  const normalized = output.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, 1000) : "CTest reported a failure without diagnostic output";
}

// ── failureNames：拿"失败集合"，必要时合成 __suite__ ───────────────────
// 【作用】把 CTestSuiteResult 压成一个 Set<string>（失败名字的集合，Set 自带去重）。
// 【坑】failed_tests 为空但 status 不是 pass（套件级崩溃/超时/环境错误）时，
//       合成一个虚拟名字 "__suite__"。这样"baseline 整个崩了"也能和 candidate 正常比较：
//       如果 candidate 跑通了，就会出现 removed=["__suite__"] → inconsistent（修好也算漂移）。
//       它和 classifyCTestBaseline 里那个 __suite__ 是同一个约定（Schema 的 superRefine 也这么查）。
function failureNames(result: CTestSuiteResult): Set<string> {
  const names = new Set(result.failed_tests.map((failure) => failure.name));
  if (names.size === 0 && result.status !== "pass") names.add("__suite__");
  return names;
}

// ── difference：排序后的差集 left - right ────────────────────────────
// 【作用】返回"在 left 里、但不在 right 里"的元素，按字典序排好。
// 【为什么要排序】集合没有顺序，直接输出会让对比结果时有时无；排序后 artifact 才是确定性的，
//                 两次运行能逐字节比对人还是机器。
function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

// ── sameSet：两个集合内容是否完全一样 ────────────────────────────────
// 【实现】数量相同 + 左边每个元素右边都有 ⇒ 相等。（不用 JSON 比较是因为 Set 没法直接序列化。）
function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
