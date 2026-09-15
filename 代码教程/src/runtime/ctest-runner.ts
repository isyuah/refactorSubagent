/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/ctest-runner.ts —— 把 CTest 套件真的跑起来，并把输出解析成结构化事实
 *
 * 【这个文件是干什么的】
 *   两件事：
 *   ① runCTest()：拼出一条 ctest 命令行去跑测试（带超时、带进程树清理），
 *      把整个 stdout / stderr 原样收下来；
 *   ② parseCTestOutput()：从那堆文本里"抠"出程序能比对的数字——
 *      顶层测试目标列表、通过/失败/未运行计数、失败用例名单 + 每个失败目标的输出。
 *   它只负责"跑 + 读表"，**不负责判断新旧版本行为是否一致**——那是 ctest-comparator.ts 的事。
 *
 * 【在整个项目里的位置】
 *   上游：src/runtime/workflow-pipeline.ts 里的 runSuite()（教程 §1.3 的第 ⑧ 步）
 *         在 baseline、candidate 两个 worktree 里各调一次 runCTest()；
 *         scripts/demo-libuv.ts 也直接调它做 libuv 全量 CTest。
 *   下游：返回的 CTestSuiteResult 交给 src/runtime/ctest-comparator.ts 的
 *         classifyCTestBaseline()/createCTestCandidate()/compareCTestSuites() 做对比，
 *         对比结果再交给状态机（orchestrator）裁决 ACCEPTED / REJECTED；
 *         原始输出以 base64 存进 artifact，Dashboard（e2e-dashboard.ts）可以回看 CTest 日志。
 *
 * 【先修知识】
 *   · CTest 是 CMake 自带的测试驱动器：一个 ctest 进程会去跑"若干个顶层测试目标"
 *     （比如 libuv 的 uv_test / uv_test_a 两个可执行文件），每个目标内部再用 TAP 格式
 *     打印自己那几百个用例（一行一个 ok / not ok ...）。
 *   · ⚠️ 全项目最容易误解的一点：CTest 最后那行
 *         "  0% tests passed, 2 tests failed out of 2"
 *     说的是 **2 个顶层目标**（uv_test / uv_test_a）全挂了，**不是**目标里的 ~474 个
 *     TAP 用例全挂。本文件的 summary 统计的就是这个"顶层计数"。
 *   · node:child_process 的 spawn（异步起子进程）、Buffer 与 base64、正则的 m / g 标志。
 *
 * 【本文件是教程注释版】
 *   原文件：src/runtime/ctest-runner.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← spawn：异步起一个子进程（不阻塞，靠事件回调收输出）；execFileSync：同步跑一条命令并等它结束（这里只用来杀进程树）
import { spawn, execFileSync } from "node:child_process";
// ← Buffer 是 Node 里装"原始字节"的容器；网络/子进程传来的都是字节，要先变成 Buffer 才能转字符串
import { Buffer } from "node:buffer";
// ← 这些只是"类型"（import type），编译后会被删掉；真正的定义在 src/artifacts/ctest-suite.ts（Zod Schema）
import type {
  CTestFailure,
  CTestSuiteResult,
  CTestSuiteSpec,
  HostPreflight,
} from "../artifacts/index.js";

// ── CTestRunOptions：调用 runCTest 时要给的"作业单" ───────────────────
// 【字段】repoDir     —— ctest 进程的工作目录（一般是 worktree 根，ctest 自己会进 build_dir）
//         spec        —— CTestSuiteSpec（src/artifacts/ctest-suite.ts）：build_dir、configuration、
//                        timeout_ms、parallelism、extra_args、environment
//         host        —— HostPreflight：程序实测的主机事实，这里只用 tools.ctest 这一项
//         onOutput    —— 可选回调：ctest 每吐一段输出就调一次（workflow-pipeline 用它把日志追加进
//                        <run>/logs/<side>-ctest.log，Dashboard 才能实时看到）
//         requiredTopLevelTests —— 可选的 fail-closed 断言：这些顶层目标必须出现在输出里，
//                        少一个就直接按 error/environment 处理（防止"测试根本没跑就静默通过"）
export interface CTestRunOptions {
  repoDir: string;
  spec: CTestSuiteSpec;
  host: HostPreflight;
  /** Called as process output arrives; the runner still retains full output. */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Optional fail-closed assertion for declared top-level tests. */
  requiredTopLevelTests?: readonly string[];
}

// ← 解析结果的三件套：计数、失败用例、顶层目标名单。
//   注意 total/passed/failed 数的是"顶层目标"，not_run 数的是被 CTest 标成 Not Run 的目标
export interface ParsedCTestOutput {
  summary: { total: number; passed: number; failed: number; not_run: number };
  failedTests: CTestFailure[];
  topLevelTests: string[];
}


// ── runCTest：把一个 CTest 套件当成"一次有边界的进程树操作"跑完 ─────────
// 【作用】拼 argv → 起 ctest → 收满输出/等退出或超时 → 解析 → 产出 CTestSuiteResult。
// 【参数】见上面 CTestRunOptions 的逐字段说明。
// 【返回】Promise<CTestSuiteResult>（src/artifacts/ctest-suite.ts）：
//         status: pass | fail | timeout | error；exit_code（超时/启动失败时是 null）；
//         duration_ms（毫秒）；summary；top_level_tests；failed_tests[{name, output}]；
//         stdout_b64 / stderr_b64（原始输出转 base64，塞进 artifact 不怕换行/中文坏掉）；
//         failure: null 或 { category, explanation }（environment / test_failure / unknown）。
// 【语法】async/await：函数标记成 async 后才能用 await"等"一个 Promise 结束；
//         下面那个 new Promise(...) 是把"回调风格"的事件包装成"可以 await 的结果"。
// 【关系】上游 workflow-pipeline.runSuite() 在两个 worktree 各调一次；结果交给 comparator 对比。
//         这个函数**永远不抛异常**——跑不起来也返回一个 status:"error" 的结果（fail-closed：
//         "没跑成"也是一种要被记录的事实，而不是让程序崩掉）。
/** Run the CTest suite as one bounded process-tree operation. */
export async function runCTest(
  options: CTestRunOptions,
): Promise<CTestSuiteResult> {
  // ← host.tools.ctest 是 preflight 实测过的 ctest 可执行文件路径。
  //   ?. 叫"可选链"：如果 ctest 是 undefined，不去取 .available，直接得到 undefined，不会报错
  const ctest = options.host.tools.ctest;
  if (!ctest?.available || ctest.path === null) {
    // ← 主机上根本没有 ctest：这不是测试失败，是"环境问题"，所以 category 给 environment
    return resultError("ctest is not available in HostPreflight", "environment");
  }

  // ← 拼结构化的 argv（数组，而不是拼字符串，免得路径里有空格被拆错）：
  //   --test-dir 指构建目录（ctest 要去那里找 CTestTestfile.cmake）
  //   -C 指多配置生成器下的配置名（VS/Ninja Multi-Config 需要，比如 Debug）
  //   --output-on-failure 让 ctest 在某个目标失败时把它内部的完整输出打印出来（解析内层 TAP 全靠它）
  const args = [
    "--test-dir",
    options.spec.build_dir,
    "-C",
    options.spec.configuration,
    "--output-on-failure",
    ...options.spec.extra_args,          // ← ... 展开运算符：把数组里的元素逐个铺进这个位置
  ];
  // ← parallelism 是"同时跑几个测试"，为 null 表示不传 -j（由 ctest 用默认值）；-j 4 就是 4 路并行
  if (options.spec.parallelism !== null) args.push("-j", String(options.spec.parallelism));

  const started = Date.now();            // ← 记个起点，最后算 duration_ms 用（毫秒）
  // ← spawn 起子进程。detached: 在非 Windows 上把子进程放进独立的"进程组"，
  //   这样超时时才能用 process.kill(-pid) 一口气杀掉整组（见下面 terminateTree）。
  //   stdio: ["ignore","pipe","pipe"] = 不给它 stdin，stdout/stderr 用管道接回来；
  //   windowsHide: true 不弹黑窗口。
  const child = spawn(ctest.path, args, {
    cwd: options.repoDir,
    env: { ...process.env, ...options.spec.environment },  // ← 继承当前环境变量，再覆盖 spec 指定的那些
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  // ← 用数组把输出一段段攒起来（子进程输出是一块一块到的，不是一次性给的）
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    // ← options.onOutput?.(...) 又是可选链的另一种用法："有就调，没有就跳过"
    options.onOutput?.("stdout", chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    options.onOutput?.("stderr", chunk.toString("utf8"));
  });

  // ← 超时开关：到点就把 timedOut 置真，并杀掉整棵进程树。
  //   timeout_ms 的默认值在 CTestSuiteSpec Schema 里是 600_000（10 分钟）；
  //   workflow-pipeline 物化套件时会用 1_200_000（20 分钟）覆盖它（见教程任务 6C 的"超时散落各处"）。
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child.pid);
  }, options.spec.timeout_ms);

  // ← 把"子进程结束"包装成 Promise：error（根本没启动起来）和 close（跑完了）只会有一个先来，
  //   谁先来谁 resolve。code 是 null 表示"没有正常退出码"（被信号杀死或启动失败）。
  const exit = await new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code, error: null }));
  });
  clearTimeout(timer);                   // ← 正常结束后把定时器拆掉，免得它挂着不放

  // ← Buffer.concat 把一堆小 Buffer 拼成一个大的，再转成完整字符串
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  // ← stdout 和 stderr 拼在一起解析：ctest 的汇总表在 stdout，但有些报错会混进 stderr
  const parsed = parseCTestOutput(`${out}\n${err}`);
  const duration = Date.now() - started;
  // ← 公共字段先攒成对象，后面各种 return 用 ...common 展开（避免每处都抄一遍）
  const common = {
    kind: "ctest-suite-result" as const,   // ← as const：把字符串定成字面量类型，好过 Zod 的 literal 校验
    version: 1 as const,
    duration_ms: duration,
    summary: parsed.summary,
    top_level_tests: parsed.topLevelTests,
    failed_tests: parsed.failedTests,
    stdout_b64: Buffer.from(out).toString("base64"),   // ← base64：把任意字节编码成纯文本，方便进 JSON
    stderr_b64: Buffer.from(err).toString("base64"),
  };
  // ← fail-closed 断言：声明里说要有的顶层测试，输出里一个都不能少。
  //   比如 workflow 声明 required_top_level_tests = ["uv_test","uv_test_a"]，
  //   如果 ctest 因为构建产物缺失只跑了 1 个，这里直接判 error/environment，绝不当作"通过"
  const missingRequired = (options.requiredTopLevelTests ?? [])   // ← ?? 空值合并：左边是 null/undefined 才用右边
    .filter((name) => !parsed.topLevelTests.includes(name));
  if (missingRequired.length > 0) {
    return {
      ...common,
      status: "error",
      exit_code: exit.error === null ? exit.code : null,
      failure: {
        category: "environment",
        explanation: `required CTest test(s) were not observed: ${missingRequired.join(", ")}`,
      },
    };
  }

  // ← 超时：exit_code 记 null（没有可信的退出码），分类归 environment（是"跑不完"，不是"测出 bug"）
  if (timedOut) {
    return {
      ...common,
      status: "timeout",
      exit_code: null,
      failure: {
        category: "environment",
        explanation: `ctest exceeded timeout ${options.spec.timeout_ms}ms; process tree was terminated`,
      },
    };
  }
  // ← 子进程根本没启动起来（比如可执行文件坏了）：也是环境错误
  if (exit.error !== null) {
    return {
      ...common,
      status: "error",
      exit_code: null,
      failure: { category: "environment", explanation: exit.error.message },
    };
  }

  // ← 真正的"通过"判定，三个条件缺一不可：
  //   ① 退出码为 0；② summary.failed 为 0；③ summary.not_run 也为 0（有测试没跑也绝不放行）
  const status = exit.code === 0 && parsed.summary.failed === 0 && parsed.summary.not_run === 0
    ? "pass"
    : "fail";
  return {
    ...common,
    status,
    exit_code: exit.code,
    // ← 三元运算符嵌套：先看有没有失败目标，再看是不是有 Not Run，最后才是退出码
    failure: status === "pass"
      ? null
      : {
          category: parsed.summary.failed > 0 ? "test_failure" : "environment",
          explanation: parsed.summary.failed > 0
            ? `${parsed.summary.failed} CTest test(s) failed`
            : parsed.summary.not_run > 0
              ? `${parsed.summary.not_run} CTest test(s) were not run`
              : `ctest exited with code ${String(exit.code)}`,
        },
  };
}

// ── parseCTestOutput：把 ctest 的整段文本解析成结构化数据 ──────────────
// 【作用】三路解析：顶层目标行 → 计数汇总；"The following tests FAILED"/TAP → 失败清单。
// 【参数】output：stdout + stderr 拼起来的全文。
// 【返回】ParsedCTestOutput（见上）。
// 【关系】runCTest 内部用它；tests/ctest-runner.test.ts 直接拿各种样例文本喂它做单测，
//         所以"输出长什么样 → 解析成什么"这件事是被测试钉死的。
export function parseCTestOutput(output: string): ParsedCTestOutput {
  const topLevel = parseTopLevelTests(output);
  return {
    summary: parseSummary(output, topLevel),
    failedTests: parseFailures(output),
    topLevelTests: topLevel.map((test) => test.name),   // ← map：把 [{name,status}] 转成 ["name",...]
  };
}

// ── parseTopLevelTests：抓"Test #N: 名字 状态 耗时"这些行 ─────────────
// 【作用】ctest 每跑完一个顶层目标就打一行，形如：
//           "  1/2 Test   #1: uv_test ***Failed   368.12 sec"
//         这里把每个目标的名字和状态抠出来。
// 【语法】正则逐段拆解：
//   ^ … $        配上末尾的 m 标志（multiline），^ 和 $ 改成"每一行的开头/结尾"，而不是整篇文本的
//   末尾的 g     global，配合 matchAll 把**所有**匹配行都找出来（不加 g 只会找到第一个）
//   \s*          任意空白；\d+ 一串数字（1/2 的进度）；Test\s+#\d+ 字面量 Test #3
//   (.+?)        第 1 个捕获组，非贪婪匹配目标名（尽量少吞字符）
//   \*{0,3}      0 到 3 个星号（ctest 用 ***Failed / ***Timeout 标状态）
//   ([A-Za-z ]+?) 第 2 个捕获组：状态词（Failed / Passed / Not Run / Timeout）
//   \d+(?:\.\d+)? 整数或小数（368 或 368.12）；(?:…) 是"只分组不捕获"
function parseTopLevelTests(output: string): Array<{ name: string; status: string }> {
  const tests: Array<{ name: string; status: string }> = [];
  const pattern = /^\s*\d+\/\d+\s+Test\s+#\d+:\s+(.+?)\s+\.*\s*\*{0,3}\s*([A-Za-z ]+?)\s+\d+(?:\.\d+)?\s*sec\s*$/gm;
  // ← matchAll 返回的是迭代器，for...of 逐个取出；match[1]/match[2] 就是上面两个括号里抓到的东西
  for (const match of output.matchAll(pattern)) {
    const name = match[1]?.trim();      // ← ?. 防止正则没匹配到该组时直接读属性报错
    // ← 状态统一成小写下划线格式："Not Run" → "not_run"，方便后面用 Set 精确比较
    const status = match[2]?.trim().toLowerCase().replace(/\s+/g, "_");
    if (name && status) tests.push({ name, status });
  }
  return tests;
}

// ── parseSummary：解析那一行"xx% tests passed, N tests failed out of M" ─
// 【作用】给出 total / passed / failed / not_run 四个计数。
// 【参数】output 全文；topLevel 是上面解析出的顶层目标（用来数 Not Run 和做兜底统计）。
// 【⚠️ 关键】这里数的是**顶层目标**，不是目标内部的 TAP 用例。
//   libuv 场景：输出写 "0% tests passed, 2 tests failed out of 2"，
//   指的是 uv_test / uv_test_a 两个目标都挂了；它们内部的 ~474 个用例不进这个统计。
//   如果看不懂这一点，就会误以为"整个测试程序一个用例都没跑"。
function parseSummary(
  output: string,
  topLevel: Array<{ name: string; status: string }>,
): ParsedCTestOutput["summary"] {
  // ← 同样是 m 标志的多行匹配；im = 忽略大小写 + 多行
  const match = output.match(/^\s*(\d+)% tests passed, (\d+) tests failed out of (\d+)/im);
  // ← 这些状态都算"失败"：ctest 除了 Failed 还会用 Timeout / Exception / Segfault
  const failedStatuses = new Set(["failed", "timeout", "exception", "segfault"]);
  const notRun = topLevel.filter((test) => test.status === "not_run").length;
  if (!match) {
    // ← 兜底：万一 ctest 的汇总行没打出来（比如中途被杀），就改用逐行状态自己数一遍
    const failed = topLevel.filter((test) => failedStatuses.has(test.status)).length;
    const passed = topLevel.filter((test) => test.status === "passed").length;
    return { total: topLevel.length, passed, failed, not_run: notRun };
  }
  const failed = Number(match[2]);      // ← 正则抓到的是字符串，Number() 转成数字
  const total = Number(match[3]);
  return { total, passed: total - failed, failed, not_run: notRun };
}

// ── parseFailures：抓出"哪些测试失败了"，并给每个失败配上它所属目标的输出 ─
// 【作用】失败名单来自两处，最后合并去重：
//   ① 内层 TAP 行："not ok 12 - test-name"（这是目标可执行文件自己打的用例级失败）；
//   ② ctest 末尾的汇总段："The following tests FAILED:" 下面列的顶层目标名。
// 【返回】CTestFailure[]，每项 { name, output }。name 有两种形状：
//   "uv_test"                    ← 顶层目标失败
//   "uv_test:not ok 的那个用例名" ← 内层用例失败（用冒号标明归属）
// 【难点】要把内层失败的输出"归"到正确的顶层目标上（uv_test / uv_test_a）。
//   办法：ctest 打印 "Start N: 目标名" 表示开始跑某个目标，之后的所有行都属于它，
//   直到下一个 "Start" 出现。这就是下面 activeTarget / activeLines 在干的事。
function parseFailures(output: string): CTestFailure[] {
  const names: string[] = [];
  // ← Map 是"键值对"容器：目标名 → 该目标那段输出。和普通对象比，键可以是任意类型且顺序稳定
  const outputByTarget = new Map<string, string>();
  let activeTarget: string | null = null;   // ← 当前正在读哪个目标的输出；null 表示还没遇到 Start
  let activeLines: string[] = [];           // ← 攒下的当前目标的行
  // ← "冲水"：把攒的行合成一段文本存进 Map。用 let + 重新赋值而不是 const，是因为要整体清空
  const flush = (): void => {
    if (activeTarget !== null) outputByTarget.set(activeTarget, activeLines.join("\n").trim());
    activeLines = [];
  };

  // ← /\r?\n/ 同时兼容 Windows 的 CRLF（\r\n）和 Linux 的 LF（\n）换行
  for (const line of output.split(/\r?\n/)) {
    // ← "Start 1: uv_test" —— 切换当前目标
    const start = line.match(/^\s*Start\s+\d+:\s*(.+?)\s*$/i);
    if (start?.[1]) {
      flush();                              // ← 上一个目标的输出到此为止，先存起来
      activeTarget = start[1].trim();
      continue;                             // ← 跳过本次循环剩下的部分，直接看下一行
    }
    // ← 还在某个目标内部，这行就算它的输出（注意先 push 再判断 TAP，所以 not ok 那行也在内）
    if (activeTarget !== null) activeLines.push(line);
    // ← TAP 失败行："not ok 12 - fs_event_watch_dir_short_path # SKIP ..."
    //   (?:\s+#.*)? 是可选的尾巴（TAP 允许用 # 写注释/指令）
    const tap = line.match(/^not ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/i);
    if (tap?.[1]) {
      const name = tap[1].trim();
      // ← 内层用例失败时带上目标名前缀，这样才知道它属于 uv_test 还是 uv_test_a
      names.push(activeTarget === null ? name : `${activeTarget}:${name}`);
    }
  }
  flush();                                  // ← 别忘了最后一段

  // ← ctest 自己的失败汇总段，长这样：
  //     "The following tests FAILED:"
  //     "      1 - uv_test (Failed)"
  const marker = output.indexOf("The following tests FAILED:");
  if (marker >= 0) {
    // ← slice(marker) 取从那行到结尾，split 后再 slice(1) 跳过标题行本身
    for (const line of output.slice(marker).split(/\r?\n/).slice(1)) {
      const name = line.match(/^\s*\d+\s*-\s*(.*?)\s+\(/)?.[1]?.trim();
      if (name) names.push(name);
    }
  }

  // ← [...new Set(names)] 用 Set 去重（TAP 里的失败和汇总段里的失败可能重复），
  //   再展开回数组；然后给每个失败名找出它所属目标的输出
  return [...new Set(names)].map((name) => {
    // ← indexOf 找第一个冒号；找不到返回 -1
    const separator = name.indexOf(":");
    // ← 有冒号：冒号前是目标名；没冒号：整个名字就是目标名
    const target = separator < 0 ? name : name.slice(0, separator);
    // ← Map.get 查不到会返回 undefined，?? 兜底成空字符串（比如目标没打任何输出）
    return { name, output: outputByTarget.get(target) ?? "" };
  });
}

// ── resultError：构造一个"跑都没跑成"的结果 ──────────────────────────
// 【作用】ctest 不可用这类情况下，也要返回一个完整的 CTestSuiteResult（fail-closed：
//         缺证据 ≠ 通过，而是显式的 error）。解释文本放进 stderr_b64，方便 Dashboard 回看。
// 【参数】explanation 是给人看的原因；category 只允许 environment / unknown 两种。
function resultError(explanation: string, category: "environment" | "unknown"): CTestSuiteResult {
  return {
    kind: "ctest-suite-result",
    version: 1,
    status: "error",
    exit_code: null,
    duration_ms: 0,
    summary: { total: 0, passed: 0, failed: 0, not_run: 0 },
    top_level_tests: [],
    failed_tests: [],
    stdout_b64: "",
    stderr_b64: Buffer.from(explanation).toString("base64"),
    failure: { category, explanation },
  };
}

// ── terminateTree：把 ctest 及其所有子孙进程一起干掉 ──────────────────
// 【作用】超时清理。难点在于：ctest 会再起测试可执行文件，测试又可能起别的进程——
//         只杀 ctest 本身会留下孤儿进程继续占 CPU/文件句柄。
// 【参数】pid：子进程号；可能是 undefined（进程还没成功起来）。
// 【语法】process.platform === "win32" 判断当前是不是 Windows，两边杀进程的方式完全不同：
//         Windows 用 taskkill /T（连进程树）/F（强制）；
//         POSIX 用 process.kill(-pid)，负数表示"杀整个进程组"（这就是上面 spawn 时要 detached 的原因）。
// 【关系】只被 runCTest 的超时定时器调用。
function terminateTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // ← execFileSync：同步执行、等它结束、不关心输出
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // The process may have exited between timeout and cleanup.
    // ← 定时器到点和真正杀之间，进程可能已经自己退了——这时抛错反而是噪音，所以吞掉
  }
}
