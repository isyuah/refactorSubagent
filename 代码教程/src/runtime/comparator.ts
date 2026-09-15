/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/comparator.ts —— 旧版"逐通道"差分比较器
 *
 * 【这个文件是干什么的】
 *   拿到 baseline（改动前）和 candidate（改动后）两次运行的观测记录，
 *   按"行为契约"（BehaviorContract）里规定的严格程度，一个通道一个通道地比：
 *   退出码、信号、stdout、stderr（filesystem 的对比函数也在这里，只是目前没接进主流程）。
 *   输出是一张"每个用例 × 每个通道 = match / mismatch / not_compared"的表，
 *   总结论 overall 不在这里算——由 Zod Schema 的 .transform 自动推导（见下方【关系】）。
 *
 * 【在整个项目里的位置】
 *   全仓库只有一处调用它：src/runtime/pipeline.ts（旧版无 workflow 的差分路径，
 *   `bun run e2e:differential:*` 走的就是它）。它吃 runner.ts 的 captureTrace() 产出
 *   的 ObservationTrace，产出 ComparisonResult 的**输入形状**（ComparisonResultInput），
 *   提交给状态机时由 src/artifacts/comparison-result.ts 的 .transform 自动补上
 *   overall = consistent / inconsistent。
 *
 * ⚠️【和另一条对比路径语义不一样，读代码前必须知道】
 *   本文件（旧路径）：baseline 上失败的用例，**必须在 candidate 上原样复现**（状态非 observed
 *   且退出码相同）才算 match；复现不出来就是 mismatch → 整个裁决走向 REJECTED。
 *   而 src/runtime/ctest-comparator.ts（新 workflow 路径）的判定是：
 *   "顶层测试集合相同 + status 相同 + added/removed 失败都为空 → consistent → ACCEPTED"，
 *   两侧一模一样的失败集合今天就直接通过，而且没有任何提示（这正是零基础教程任务 9
 *   要加 warnings 的原因）。两条路径语义不一致是已知事实，看这个文件时别把规则记串了。
 *
 * 【先修知识】
 *   · Map（用 case_id 快速查 baseline 的那条记录）、泛型、联合类型、可选属性 ?;
 *   · Base64：二进制内容用文本安全传输的编码方式，本项目的 stdout/stderr 都存成 *_b64；
 *   · 可选链 ?. 与 ?? （空值兜底）。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/comparator.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import type {
  BehaviorContract,
  ComparisonResultInput,
  ObservationTrace,
  FsEffect,
} from "../artifacts/index.js";

/**
 * Comparator — applies the Behavior Contract's per-channel policy to align
 * baseline/candidate observations. Emits ComparisonResult INPUT; `overall`
 * is derived by the schema transform.
 */

// ← 索引类型写法：keyof BehaviorContract["channels"] 取出"channels 对象有哪些键"，
//   也就是 "exit_code" | "signals" | "stdout" | "stderr" | "filesystem"。
//   （⚠️ 这个类型别名声明后目前没有被用到，留着表达"通道名来自契约"这层意思。）
type Channel = keyof BehaviorContract["channels"];
// ← 三值判定：match=一样；mismatch=不一样（会导致 REJECTED）；not_compared=这一通道契约说不用比
type Verdict = "match" | "mismatch" | "not_compared";

// ── compareBytes：比较一个"字节流"通道（stdout 或 stderr）──────────────
// 【作用】按契约模式比 Base64 编码的输出内容。
// 【参数】mode：契约里该通道的策略（exact / normalize / ignore，见 behavior-contract.ts）；
//        a、b：两条 Base64 字符串（baseline 在前）。
// 【返回】Verdict。
// 【语法】参数写 mode: string 而不是枚举——因为契约 schema 里 mode 是 z.enum，
//        这里用宽松类型 + 运行时判断兜底。
function compareBytes(
  mode: string,
  a: string,
  b: string,
): Verdict {
  // ← 契约说 ignore：这个通道不参与裁决
  if (mode === "ignore") return "not_compared";
  if (a === b) return "match";
  // ← normalize：先做文本规范化（见下面的 canonicalText）再比
  if (mode === "normalize") {
    return canonicalText(a) === canonicalText(b) ? "match" : "mismatch";
  }
  return "mismatch"; // exact
}

/** Canonicalize text: UTF-8, CRLF→LF, drop trailing whitespace per line. */
// ── canonicalText：把 Base64 输出还原成"规范化文本" ───────────────────
// 【作用】消除两类无意义差异：Windows 的 \r\n 换行 vs Linux 的 \n；行尾多余空格。
// 【为什么需要】重构不应该改变这些"排版级"字节，但不规范化的话会把它们误判成行为变化。
// 【语法】Buffer.from(b64, "base64") 把 Base64 解回原始字节；toString("utf8") 解码成文本。
function canonicalText(b64: string): string {
  const text = Buffer.from(b64, "base64").toString("utf8");
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trimEnd())
    .join("\n");
}

// ── compareFilesystem：文件系统副作用通道的对比 ───────────────────────
// 【作用】按契约模式比 FsEffect 数组（create/modify/delete 列表）。
// ⚠️ 注意：compare() 目前只比 exit_code / signals / stdout / stderr 四个通道，
//    这个函数（连同下面的 eqEffect）现在没有任何调用者——它是给契约的 filesystem
//    通道预留的实现，属于"写了但没接线"的代码，读的时候不要以为它已经在跑。
// 【参数】policy：{ mode, comparator? }；comparator 只有在 mode==="semantic" 时才必须有
//        （契约 schema 里有 refine 强制这一点），约定值是 "fs-effects-v1"。
function compareFilesystem(
  policy: { mode: string; comparator?: string },
  a: FsEffect[],
  b: FsEffect[],
): Verdict {
  if (policy.mode === "ignore") return "not_compared";
  if (policy.mode === "semantic") {
    // ← 语义模式必须指名用哪个比较器；不是 fs-effects-v1 就直接判不一致（fail-closed 风格）
    if (policy.comparator !== "fs-effects-v1") return "mismatch";
    // fs-effects-v1: multiset equality of (path, op, sha) — order-insensitive.
    // ← "多重集合相等"：先把手上的每条副作用拼成一个字符串 key，两边各自排序，
    //   再逐位比。排序之后顺序就无所谓了，剩下的就是"集合内容是否完全一致"。
    const key = (e: FsEffect) => `${e.path}|${e.op}|${e.sha256}`;
    const sa = [...a].map(key).sort();
    const sb = [...b].map(key).sort();
    return sa.length === sb.length && sa.every((k, i) => k === sb[i])
      ? "match"
      : "mismatch";
  }
  if (policy.mode === "normalize") {
    // normalize: compare sorted by path but allow sha drift on text files —
    // MVP treats identical effect sets as equal regardless of content hash.
    // ← 归一化模式只看"动了哪些文件、干了哪种操作"，不比内容哈希。
    //   （MVP 阶段的取舍：内容可能因为行尾/时间戳漂移，先不把哈希算进判定。）
    const ka = a.map((e) => `${e.path}|${e.op}`).sort();
    const kb = b.map((e) => `${e.path}|${e.op}`).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i])
      ? "match"
      : "mismatch";
  }
  // ← exact：既要比顺序也要比哈希，一条都不能差
  return a.length === b.length && a.every((e, i) => eqEffect(e, b[i]!))
    ? "match"
    : "mismatch"; // exact: ordered, hash-identical
}

// ── eqEffect：两条副作用是否完全相同 ─────────────────────────────────
// 【作用】逐字段比较（路径、操作、内容哈希）。BFS：只被上面的 exact 分支用。
// 【语法】参数类型直接写成内联对象形状（不建 interface）；b[i]! 末尾的感叹号是
//        TS 的"非空断言"——告诉编译器"我保证这里不是 undefined"，好关掉数组索引的告警。
function eqEffect(
  x: { path: string; op: string; sha256: string | null },
  y: { path: string; op: string; sha256: string | null },
): boolean {
  return x.path === y.path && x.op === y.op && x.sha256 === y.sha256;
}

// ── compare：本文件对外的唯一入口 ───────────────────────────────────
// 【作用】把 baseline / candidate 两条 ObservationTrace 按 case_id 配对，逐用例逐通道判定。
// 【参数】contract：行为契约（每个通道用什么模式比）；baseline / candidate：runner.ts 采到的观测。
// 【返回】ComparisonResultInput：注意这是 ComparisonResult **提交前的形状**——
//        没有 overall 字段；等状态机提交时 Zod 的 .transform 会自动算出 overall。
// 【关系】唯一调用者是 pipeline.ts（旧差分路径）。verdict 里只要有一个 mismatch，
//        overall 就是 inconsistent，状态机因此 REJECT（fail-closed 规则 R6：对比结果决定裁决）。
// 【遍历方向】注意循环是**以 candidate 为基准**遍历的（map over candidate.observations），
//        所以"candidate 多出来的用例"和"candidate 少掉的用例"待遇不一样，见下面两处注释。
export function compare(
  contract: BehaviorContract,
  baseline: ObservationTrace,
  candidate: ObservationTrace,
): ComparisonResultInput {
  // ← 把 baseline 的观测按 case_id 建成一张查找表，下面 O(1) 查询
  const baseById = new Map(baseline.observations.map((o) => [o.case_id, o]));

  const per_case = candidate.observations.map((cand) => {
    const base = baseById.get(cand.case_id);
    // ← 情况一：candidate 里冒出一个 baseline 没跑过的用例 → 直接 mismatch。
    //   （channels 给空对象，因为根本没有可配对的 baseline 通道值。）
    if (!base) {
      return {
        case_id: cand.case_id,
        verdict: "mismatch" as const,
        channels: {},
        detail: "no baseline observation for this case",
      };
    }
    // Baseline-side failures are skipped (R3 already gated scope-related ones);
    // preexisting_behavior must REPRODUCE in the candidate.
    // ← 情况二：baseline 这一用例本身就失败/出错。
    //   ⚠️ 这里就是本文件与 ctest-comparator.ts 语义分叉的地方：
    //   规则是"旧版本的失败必须在候选版本上**原样复现**（状态非 observed 且退出码一致）
    //   才算 match"——否则视为行为变化 → mismatch → REJECTED。
    //   （R3 指状态机规则：baseline 失败必须先由模型给出失败分类，范围相关的会被拦下。）
    if (base.status !== "observed") {
      const reproduced =
        cand.status !== "observed" && cand.exit_code === base.exit_code;
      return {
        case_id: cand.case_id,
        verdict: reproduced ? ("match" as const) : ("mismatch" as const),
        channels: {},
        detail: reproduced
          ? "baseline failure reproduced identically"
          : `baseline ${base.status} (exit ${base.exit_code}) not reproduced (candidate exit ${cand.exit_code}, status ${cand.status})`,
      };
    }

    // ← 情况三：baseline 正常 → 逐通道严格对比。
    const channels: Record<string, Verdict> = {};
    const exitPolicy = contract.channels.exit_code.mode;
    // ← 退出码：ignore 就不比，否则要求整数完全相等
    channels["exit_code"] =
      exitPolicy === "ignore"
        ? "not_compared"
        : cand.exit_code === base.exit_code
          ? "match"
          : "mismatch";
    // ← 信号（被哪个 Unix 信号杀掉的，POSIX 语义；Windows 上一般是 null）
    channels["signals"] =
      cand.signal === base.signal ? "match" : "mismatch";
    // ← 标准输出 / 标准错误：交给 compareBytes，按契约模式比 Base64 内容
    channels["stdout"] = compareBytes(
      contract.channels.stdout.mode,
      base.stdout_b64,
      cand.stdout_b64,
    );
    channels["stderr"] = compareBytes(
      contract.channels.stderr.mode,
      base.stderr_b64,
      cand.stderr_b64,
    );

    // ← 把判定为 mismatch 的通道名挑出来，写进 detail 方便人看
    const mismatched = Object.entries(channels)
      .filter(([, v]) => v === "mismatch")
      .map(([k]) => k);

    return {
      case_id: cand.case_id,
      // ← 只要有一个通道不一致，这个用例就算 mismatch（一票否决）
      verdict: mismatched.length > 0 ? ("mismatch" as const) : ("match" as const),
      channels,
      detail:
        mismatched.length > 0 ? `channels differ: ${mismatched.join(", ")}` : "",
    };
  });

  // ← 返回"提交前的形状"。注意：这里**没有** overall 字段——ComparisonResult schema 的
  //   .transform 会根据 per_case 里有没有 mismatch 自动推导 consistent / inconsistent。
  return {
    kind: "comparison-result",
    version: 1,
    baseline_env_id: baseline.env_id,
    candidate_env_id: candidate.env_id,
    per_case,
  };
}
