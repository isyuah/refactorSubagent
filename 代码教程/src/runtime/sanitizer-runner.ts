/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/sanitizer-runner.ts —— 用"内存/未定义行为检测版"的二进制逐用例跑一遍
 *
 * 【这个文件是干什么的】
 *   Sanitizer（消毒器）是编译器自带的一类插桩工具：给 C 代码加上检测逻辑再编译，
 *   程序一越界、一有未定义行为，运行时会直接在 stderr 上打出诊断并自杀。
 *   本文件做的就是这件事：
 *     ① 先确认主机真的"能编出"这种二进制（看 HostPreflight 里的实测能力，不是猜）；
 *     ② 再把已经构建好的 sanitizer 版二进制，对着 TestSpec 里的每个用例各跑一次；
 *     ③ 从输出里认出 AddressSanitizer / UndefinedBehaviorSanitizer 的诊断行，
 *        归类成 unsupported / build_failure / runtime_failure / timeout / findings / pass。
 *   核心立场写在 runSanitizers 的 doc 注释里：**sanitizer 的诊断是"证据"，
 *   不是普通的 stderr 差异**——它比旧版"逐字节比输出"更严格也更专一。
 *
 * 【在整个项目里的位置】
 *   上游：src/runtime/pipeline.ts 的 saveSanitizerResult()（旧版差分路径的阶段三）调用它，
 *         baseline、candidate 两个 worktree 各跑一次（build 参数分别是 "baseline"/"candidate"），
 *         结果各自存成 sanitizer-result artifact；
 *         新的 workflow 路径（workflow-pipeline.ts）目前不跑 sanitizer。
 *   下游：产物交给状态机与 comparator；原始 stdout/stderr 同样以 base64 进 artifact。
 *   能力来源：host.sanitizers 由 src/runtime/host-preflight.ts 的 probeSanitizers() 实测——
 *         它会真的写一个 int main(void){return 0;}，带 -fsanitize=address/undefined 编译链接一次，
 *         编不过就 available:false 并给出原因（本机 Windows 就是因为缺 -lasan/-lubsan 探针失败，
 *         所以教程 §1.8 说"阶段三 UNSUPPORTED"）。
 *
 * 【先修知识】
 *   · spawnSync：同步起子进程（阻塞到它结束才往下走），和 ctest-runner 用的 spawn（异步）相对；
 *   · Buffer + base64（把字节编码成文本塞进 JSON）；try/finally（无论成败都清理临时目录）；
 *   · TestSpec / 用例（src/artifacts/test-spec.ts）：每个用例有 id、argv、stdin、fixtures（输入文件）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/runtime/sanitizer-runner.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← spawnSync：同步执行一个程序；这里每个用例都是"跑完再看"，同步写法最简单
import { spawnSync } from "node:child_process";
// ← existsSync 存在吗 / mkdirSync 建目录 / mkdtempSync 建一次性临时目录 / rmSync 删 / writeFileSync 写
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
// ← dirname 取"一个路径的目录部分"；join 拼路径
import { dirname, join } from "node:path";
// ← tmpdir 返回系统临时目录（Windows 一般是 %TEMP%）
import { tmpdir } from "node:os";
// ← 一组类型（import type，编译后消失），真正的 Schema 在 src/artifacts/
import type {
  EnvironmentSpec,
  HostPreflight,
  SanitizerFinding,
  SanitizerKind,
  SanitizerResult,
  TestSpec,
} from "../artifacts/index.js";
// ← 复用构建适配器里的类型和"找产物二进制路径"的函数
import type { BuildResult } from "./build-adapter.js";
import { resolveBinaryPath } from "./build-adapter.js";

// ← 单个用例的默认超时：10 秒（10_000 是 TS 允许的数字下划线写法，纯粹为了好读）
//   🔗 全仓的超时散落在十几个地方（教程任务 6C 的清单里，本文件 :22 就是其中之一）
const DEFAULT_CASE_TIMEOUT_MS = 10_000;
// ← 每种 sanitizer 对应"输出里出现这种字样就算命中"的正则。
//   Record<K, V> 是"键为 K、值为 V 的对象"类型：这里键必须是 SanitizerKind（address/undefined），
//   写错键名编译期就报错
const DIAGNOSTIC_MARKERS: Record<SanitizerKind, RegExp[]> = {
  address: [/AddressSanitizer/i],
  undefined: [/UndefinedBehaviorSanitizer/i, /runtime error:/i],
};

// ← 内部用的"一次用例运行"的原始记录（还没变成 artifact 形状）
interface CaseExecution {
  status: number | null;   // ← 进程退出码；null 表示没拿到（被杀/没起来）
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// ── SanitizerRunOptions：跑一轮 sanitizer 验证需要的材料 ──────────────
// 【字段】worktreeDir —— 在哪个 worktree 里找二进制（baseline/candidate 各一个目录）
//         env        —— EnvironmentSpec，这里只用 env.sanitizers（要启用哪些 sanitizer）
//         spec       —— TestSpec，要跑哪些用例
//         build      —— 这次的身份标签："baseline" 或 "candidate"（写进产物，两边各自独立一份结果）
//         envId      —— 环境标识字符串（产物里用于追溯"在哪个环境下测的"）
//         host       —— HostPreflight，看 host.sanitizers[kind] 的实测能力
//         buildResult —— 可选：如果调用方刚构建完，直接把产物路径带过来，免得再猜
//         caseTimeoutMs —— 可选：单用例超时（毫秒），不给就用上面的 10 秒
export interface SanitizerRunOptions {
  worktreeDir: string;
  env: EnvironmentSpec;
  spec: TestSpec;
  build: "baseline" | "candidate";
  envId: string;
  host: HostPreflight;
  buildResult?: BuildResult;
  caseTimeoutMs?: number;
}

// ── runSanitizers：核心函数（同步，整个过程一口气跑完） ────────────────
// 【作用】能力检查 → 构建检查 → 逐用例运行 → 汇总成一个 SanitizerResult。
// 【返回】SanitizerResult（src/artifacts/sanitizer.ts），status 六选一：
//         pass / findings / unsupported / build_failure / runtime_failure / timeout。
//         Schema 上还有两条硬约束：status=findings 必须真的有 findings；
//         非 pass 必须带 failure（fail-closed：不允许"含糊地失败"）。
// 【语法】注意它**不是** async —— 上游直接同步调用，结果立即可用。
// 【关系】被旧路径 pipeline.ts 调用；baseline 与 candidate 各得一份独立结果，互不共享状态。
/**
 * Execute an already-built sanitizer-instrumented binary against every case.
 * Sanitizer diagnostics are evidence, not ordinary stderr differences.
 */
export function runSanitizers(options: SanitizerRunOptions): SanitizerResult {
  const requested = options.env.sanitizers;
  // ← 这是"调用方编程错误"而不是"环境问题"，所以直接抛异常，而不是返回一个失败结果
  if (requested.length === 0) {
    throw new Error("runSanitizers requires at least one requested sanitizer");
  }

  // ← 先把所有结果共有的字段攒起来。case_results/findings 先给空数组，后面各分支再展开覆盖。
  //   duration_ms: 0 这个占位在 unsupported/build_failure 分支会保留（因为根本没跑用例）
  const base = {
    kind: "sanitizer-result" as const,
    version: 1 as const,
    build: options.build,
    env_id: options.envId,
    requested,
    duration_ms: 0,
    case_results: [],
    findings: [],
    stdout_b64: "",
    stderr_b64: "",
  };

  // ← 第 1 道闸：能力检查。
  //   把请求的每种 sanitizer 映射到 host 实测能力，再 filter 出"不可用"的那些。
  //   capability?.available !== true 的意思是：只有 available 严格为 true 才算过，
  //   "没测过"（capability 是 undefined）也按不可用处理 —— 典型的 fail-closed。
  const unsupported = requested
    .map((kind) => ({ kind, capability: options.host.sanitizers[kind] }))
    .filter(({ capability }) => capability?.available !== true);
  if (unsupported.length > 0) {
    // ← 把每种不可用的原因拼成一句话（比如 "address: gcc cannot build address sanitizer probe: ..."）
    const explanation = unsupported
      .map(({ kind, capability }) => `${kind}: ${capability?.reason ?? "not measured"}`)
      .join("; ");
    return {
      ...base,
      status: "unsupported",
      exit_code: null,
      failure: { category: "unsupported", explanation },
    };
  }

  // ← 第 2 道闸：构建结果检查。调用方传了 buildResult 且构建失败 → 直接判 build_failure，
  //   并把完整构建日志放进 stderr_b64（Dashboard 能回看失败原因）
  if (options.buildResult !== undefined && !options.buildResult.ok) {
    return {
      ...base,
      status: "build_failure",
      exit_code: null,
      stderr_b64: Buffer.from(options.buildResult.log).toString("base64"),
      failure: {
        category: "build_failure",
        explanation: "sanitizer-instrumented build failed",
      },
    };
  }

  // ← 决定用哪个二进制：优先用调用方带来的实测产物路径，否则按约定推一个出来。
  //   ?. 在 buildResult 为 undefined 时得到 undefined，?? 再兜底去推算
  const binaryAbs = options.buildResult?.binaryAbs ?? resolveBinaryPath(options.worktreeDir, options.env);
  if (!existsSync(binaryAbs)) {
    // ← 二进制不在 = 构建侧的问题，归 build_failure，绝不假装"跑过了"
    return {
      ...base,
      status: "build_failure",
      exit_code: null,
      failure: {
        category: "build_failure",
        explanation: `sanitizer binary does not exist: ${binaryAbs}`,
      },
    };
  }

  const started = Date.now();
  const timeout = options.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const caseResults: SanitizerResult["case_results"] = [];   // ← 取 artifact 类型里某个字段的类型来用
  const findings: SanitizerFinding[] = [];
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];

  // ← 逐用例串行执行。每个用例都在一个全新的临时目录里跑（输入文件互不污染）。
  //   注意：没有并行，也意味着用例之间会共享进程级状态（这正是想测的"副作用"）
  for (const testCase of options.spec.cases) {
    // ← mkdtempSync 造一个形如 <tmp>/rfsanitize-XXXXXX 的唯一目录
    const runDir = mkdtempSync(join(tmpdir(), "rfsanitize-"));
    try {
      // ← 把用例声明的输入文件（base64 编码存放）还原到临时目录里
      for (const fixture of testCase.fixtures) {
        const destination = join(runDir, fixture.path);
        // ← recursive: true = 父目录不存在就一路建上去（mkdir -p）
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, Buffer.from(fixture.content_b64, "base64"));
      }

      // ← argv[0] 是"程序自己"，真正要传的参数从第 1 个开始切
      const args = testCase.argv.slice(1);
      // ← 参数里若混进了 \0（NUL 字节），操作系统调用层面会出问题——与其让 spawn 抛出
      //   莫名其妙的错误，不如自己先判掉，构造一个"必然失败"的执行结果
      const execution = args.some((arg) => arg.includes("\0"))
        ? invalidArgumentExecution()
        : executeCase(binaryAbs, args, runDir, testCase.stdin, timeout);
      const output = `${execution.stdout}\n${execution.stderr}`;
      // ← 从输出里认 sanitizer 的诊断行（这才是本文件真正关心的"证据"）
      const diagnosticFindings = parseSanitizerDiagnostics(testCase.id, requested, output);
      findings.push(...diagnosticFindings);
      // ← 把每个用例的输出都打个 [用例id] 标签攒起来，最后合成整份 stdout/stderr
      stdoutParts.push(`[${testCase.id}]\n${execution.stdout}`);
      stderrParts.push(`[${testCase.id}]\n${execution.stderr}`);

      // ← 只有 regression 用例才声明了"期望退出码"；differential 用例没有这个约定
      const expectedExit = testCase.kind === "regression"
        ? testCase.expect_exit_code
        : undefined;
      const exitMatches = expectedExit === undefined || execution.status === expectedExit;
      // ← 用例级状态，优先级从高到低：
      //   有 sanitizer 诊断 > 超时 > 没拿到退出码/退出码不符 > 正常观测到（observed）
      const status = diagnosticFindings.length > 0
        ? "finding"
        : execution.timedOut
          ? "timeout"
          : execution.status === null || !exitMatches
            ? "runtime_failure"
            : "observed";

      caseResults.push({
        case_id: testCase.id,
        status,
        exit_code: execution.timedOut ? null : execution.status,
        stdout_b64: Buffer.from(execution.stdout).toString("base64"),
        stderr_b64: Buffer.from(execution.stderr).toString("base64"),
        duration_ms: execution.timedOut ? timeout : execution.durationMs,
      });
    } finally {
      // ← finally：不管成功、抛错还是 return，都把临时目录删掉（递归 + 忽略不存在）
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  const duration = Date.now() - started;
  const timedOut = caseResults.some((result) => result.status === "timeout");
  const runtimeFailure = caseResults.some((result) => result.status === "runtime_failure");
  // ← 整体状态：只要有任何一条 sanitizer 诊断，就盖过超时/运行失败（证据最重）
  const status = findings.length > 0
    ? "findings"
    : timedOut
      ? "timeout"
      : runtimeFailure
        ? "runtime_failure"
        : "pass";
  // ← 非 pass 时必须给出 failure.category + explanation（Schema 强制）
  const failure = status === "pass"
    ? null
    : status === "findings"
      ? {
          category: "diagnostic" as const,
          explanation: `${findings.length} sanitizer diagnostic(s) found`,
        }
      : status === "timeout"
        ? {
            category: "timeout" as const,
            explanation: `one or more sanitizer cases exceeded ${timeout}ms`,
          }
        : {
            category: "runtime_failure" as const,
            explanation: "one or more sanitizer cases failed without a sanitizer diagnostic",
          };

  return {
    ...base,
    status,
    // ← 只有一个用例时才把它的退出码当整体退出码，否则这个数字没有意义，记 null
    exit_code: caseResults.length === 1 ? caseResults[0]!.exit_code : null,
    duration_ms: duration,
    case_results: caseResults,
    findings,
    stdout_b64: Buffer.from(stdoutParts.join("\n")).toString("base64"),
    stderr_b64: Buffer.from(stderrParts.join("\n")).toString("base64"),
    failure,
  };
}

// ── invalidArgumentExecution：给"参数里带 NUL"造一个假执行结果 ─────────
// 【作用】不出于安全/正确性考虑去真的 spawn 一次注定失败的进程，而是直接给出确定的失败记录。
function invalidArgumentExecution(): CaseExecution {
  return {
    status: null,
    stdout: "",
    stderr: "argv contains NUL bytes",
    timedOut: false,
    durationMs: 0,
  };
}

// ── executeCase：真的把一个用例跑起来（同步） ────────────────────────
// 【参数】binaryAbs 要跑的二进制；args 参数；cwd 工作目录（一次性临时目录）；
//         stdin 是 base64 编码的标准输入；timeout 毫秒。
// 【返回】CaseExecution。
// 【语法】spawnSync 的 timeout 选项：到点就用 killSignal（这里是 SIGKILL，硬杀）干掉进程。
//         超时后 spawnSync 不抛异常，而是在返回值 error 上带一个 code === "ETIMEDOUT"，
//         所以要用字符串比较来判断"是不是超时了"。
function executeCase(
  binaryAbs: string,
  args: string[],
  cwd: string,
  stdin: string,
  timeout: number,
): CaseExecution {
  const started = Date.now();
  const result = spawnSync(binaryAbs, args, {
    cwd,
    encoding: "utf8",                       // ← 让 stdout/stderr 直接是字符串而不是 Buffer
    timeout,
    input: Buffer.from(stdin, "base64"),    // ← 用例的标准输入同样是 base64 存的
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  // ← (result.error as NodeJS.ErrnoException | undefined) 是"类型断言"：
  //   告诉编译器"我知道它是这个形状"，运行时没有任何影响。
  //   ?? "" 再兜底成空字符串，最后 String() 统一转成文本去比较
  const timedOut = String((result.error as NodeJS.ErrnoException | undefined)?.code ?? "") === "ETIMEDOUT";
  return {
    status: timedOut ? null : result.status,
    stdout: result.stdout ?? "",
    // ← stderr 的三种情况：普通错误（把错误对象也拼进去）/ 正常输出 / 超时（补一句超时说明）
    stderr: result.error && !timedOut
      ? `${result.stderr ?? ""}${String(result.error)}`
      : result.stderr ?? (timedOut ? `timeout after ${timeout}ms` : ""),
    timedOut,
    durationMs: Date.now() - started,
  };
}

// ── parseSanitizerDiagnostics：从输出里认出 sanitizer 的诊断 ───────────
// 【参数】caseId 用例名；requested 本次启用的 sanitizer 列表；output 该用例的 stdout+stderr。
// 【返回】SanitizerFinding[]，每条 { case_id, sanitizer, message }。
// 【实现】对每种 sanitizer：先看整体输出里有没有命中标记正则（.find 返回第一个命中的正则）；
//         命中了再按行切，找到第一行命中标记的行，截 500 个字符当 message。
// 【语法】`?.trim().slice(0,500) ?? "..."`：
//         find 找不到匹配行时是 undefined，?. 让后续调用直接返回 undefined，?? 再给默认文案。
// 【关系】被 runSanitizers 每个用例调一次；tests/sanitizer.test.ts 也单独测它。
export function parseSanitizerDiagnostics(
  caseId: string,
  requested: readonly SanitizerKind[],
  output: string,
): SanitizerFinding[] {
  const findings: SanitizerFinding[] = [];
  for (const sanitizer of requested) {
    const marker = DIAGNOSTIC_MARKERS[sanitizer].find((pattern) => pattern.test(output));
    if (!marker) continue;
    const message = output
      .split(/\r?\n/)
      .find((line) => marker.test(line))
      ?.trim()
      .slice(0, 500) ?? `${sanitizer} diagnostic detected`;
    findings.push({ case_id: caseId, sanitizer, message });
  }
  return findings;
}
