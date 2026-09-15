/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/runner.ts —— 旧版"差分运行采集器"
 *
 * 【这个文件是干什么的】
 *   把测试规格（TestSpec）里的每一个用例，真正跑一遍：给程序喂参数（argv）、
 *   喂标准输入（stdin）、开一个全新的一次性工作目录，然后把所有"可观察行为"都记下来——
 *   退出码、stdout、stderr、以及文件系统副作用（运行前后各拍一张目录快照再对比）。
 *   产出的 ObservationTrace 就是 comparator.ts 做新旧对比的原料。
 *
 * 【在整个项目里的位置】
 *   · 上游：只有 src/runtime/pipeline.ts（旧版无 workflow 差分路径，`e2e:differential`）
 *     调用 captureTrace()，baseline 和 candidate 各调一次。
 *   · 下游：它 import 了 fs-snapshot.ts（拍快照/比差异）和 builder.ts 的 resolveBinaryPath()
 *     （算出"这次到底跑哪个可执行文件"）。
 *   · ⚠️ 新的 workflow 路径已经不用它了：自驱动 TestWorkflow 走 src/workflow/test-executor.ts
 *     + capabilities.ts（子进程自己跑测试、用 ctx.expect 声明观测值），
 *     声明式 CTest 路径走 ctest-runner.ts。本文件属于"旧路径仍在用"的模块。
 *
 * 【先修知识】
 *   · node:child_process 的 spawnSync（同步启动子进程，拿到退出码和输出）；
 *   · Buffer 与 Base64（输出内容统一存成 *_b64 字符串，避免二进制塞进 JSON 出问题）；
 *   · try/finally（无论成功失败都清理临时目录）。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/runner.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← spawnSync：同步地"启动另一个程序并等它结束"。返回值里有 status（退出码）、stdout、stderr
import { spawnSync } from "node:child_process";
// ← mkdirSync 建目录、mkdtempSync 建"带随机后缀的临时目录"、rmSync 删除、writeFileSync 写文件
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// ← tmpdir() 返回系统临时目录（Windows 上一般是 %TEMP%）
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EnvironmentSpec,
  ObservationTrace,
  TestSpec,
} from "../artifacts/index.js";
import { diffSnapshots, snapshotDir } from "./fs-snapshot.js";
import { resolveBinaryPath } from "./builder.js";

// ← 单个用例的超时：10_000 是数字分隔符写法，等于 10000，单位**毫秒**（也就是 10 秒）。
//   ⚠️ 这个值在零基础教程"任务 6C 超时配置表"里被点过名：全仓库的超时散落各处，
//   计划统一成一个配置对象。新路径里对应的值是 capabilities.ts 的 60_000 等。
const CASE_TIMEOUT_MS = 10_000;

/**
 * Differential Runner — executes every test case against one build in a
 * fresh throwaway cwd, capturing all observable channels:
 * exit code, stdout/stderr, filesystem effects (before/after snapshot).
 *
 * Convention: `argv[0]` of a case is the program-name placeholder and is not
 * passed to the executable; the real executable comes from EnvironmentSpec.
 */
// ── captureTrace：对一个构建产物，把所有用例各跑一遍并采集观测 ────────
// 【作用】本文件唯一导出的函数。逐个用例：备料（fixtures）→ 拍快照 → 起进程 → 收结果 → 清理。
// 【参数】
//   worktreeDir：该侧（baseline 或 candidate）的 worktree 绝对路径，可执行文件在这里面；
//   env：EnvironmentSpec（含 build 描述、sanitizer 要求、determinism 拦截头等）；
//   spec：TestSpec，用例列表（每个用例就是一次"argv + stdin + fixtures"的组合）；
//   build："baseline" | "candidate" —— 只是打在产物上的标签，说明这次跑的是哪一侧；
//   envId：环境标识字符串，原样写进结果，用来在对比时确认两侧是在同一环境设定下跑的。
// 【返回】ObservationTrace：observations 数组 + failures 数组。
//   ⚠️ 这里 failures 恒为空 []：失败分类是模型的事，状态机 schema 会要求
//   每个 status !== "observed" 的用例都必须有分类，所以 pipeline 在提交前要补上（fail-closed）。
// 【语法】`build: "baseline" | "candidate"` 是字面量联合类型——参数只接受这两个字符串。
// 【关系】baseline / candidate 各产一条 trace，一起交给 comparator.ts 的 compare()。
export function captureTrace(
  worktreeDir: string,
  env: EnvironmentSpec,
  spec: TestSpec,
  build: "baseline" | "candidate",
  envId: string,
): ObservationTrace {
  // ← 找到这次要执行的可执行文件绝对路径（会处理 .exe 后缀、CMake 的 build/Debug/ 等情况）
  const binaryAbs = resolveBinaryPath(worktreeDir, env);
  // ← 注意这里没写类型标注：TS 的"演化数组"特性——先声明为 []，
  //   之后根据 push 进去的东西自动推断元素类型。可读性不如显式标注，但这里够用。
  const observations = [];

  // ← for...of 逐个用例。注意是**串行**执行：一个跑完再跑下一个，顺序固定才能保证可复现。
  for (const c of spec.cases) {
    // ← 每个用例都开一个全新的临时目录当工作目录（对应 EnvironmentSpec.sandbox
    //   的 run_cwd_strategy: "fresh_temp_dir"）——上一个个用例留下的文件不会影响下一个。
    const runDir = mkdtempSync(join(tmpdir(), "rfrun-"));
    try {
      // ← 备料：把用例声明的 fixtures 写到临时目录里（内容在 TestSpec 里是 Base64 存的）。
      //   Buffer.from(..., "base64") 把字符串解回原始字节。
      for (const f of c.fixtures) {
        const dest = join(runDir, f.path);
        // ← join(dest, "..") 是"取上一级目录"的小技巧：先确保父目录存在
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, Buffer.from(f.content_b64, "base64"));
      }
      // ← 运行前拍一张目录快照（相对路径 → SHA-256）
      const before = snapshotDir(runDir);
      // ← 约定：argv[0] 只是"程序名占位符"，不传给真正的可执行文件
      //   （操作系统里 argv[0] 通常是程序自己的名字，这里由 EnvironmentSpec 决定跑谁）。
      const args = c.argv.slice(1);
      // ← argv 里不允许出现 NUL 字节：操作系统创建进程的 API（CreateProcess/exec）
      //   用 NUL 当字符串结束符，带 NUL 的参数根本传不过去，所以提前拦下来。
      if (args.some((arg) => arg.includes("\0"))) {
        observations.push({
          case_id: c.id,
          status: "error" as const,
          exit_code: -1,
          signal: null,
          stdout_b64: "",
          stderr_b64: Buffer.from("argv contains NUL bytes").toString("base64"),
          filesystem: [],
          duration_ms: 0,
        });
        continue;
      }

      // ← 真正执行：cwd 设为一次性临时目录，stdin 用 Base64 解出来的字节，超时 10 秒，
      //   超时后用 SIGKILL 强杀（SIGKILL 在 Windows 上由运行时模拟成强制终止）。
      const r = spawnSync(binaryAbs, args, {
        cwd: runDir,
        timeout: CASE_TIMEOUT_MS,
        input: Buffer.from(c.stdin, "base64"),
        killSignal: "SIGKILL",
      });

      // ← 判断是不是"超时被杀"：spawnSync 超时会把 error 设成 code 为 ETIMEDOUT 的错误对象。
      //   ?. 是可选链（r.error 可能是 undefined）；?? 是空值兜底（code 取不到就用空字符串）。
      const killed =
        r.error != null &&
        String((r.error as NodeJS.ErrnoException).code ?? "") === "ETIMEDOUT";
      if (killed) {
        observations.push({
          case_id: c.id,
          status: "error" as const,
          exit_code: -1,
          signal: "SIGKILL",
          stdout_b64: "",
          stderr_b64: Buffer.from(`timeout after ${CASE_TIMEOUT_MS}ms`).toString("base64"),
          filesystem: [],
          duration_ms: CASE_TIMEOUT_MS,
        });
        continue;
      }

      // ← status 的取值逻辑：
      //   · regression 用例自带"期望退出码"，跑出来不一致 → "fail"（状态机 R3 会要求
      //     模型给这个失败一个解释，解释不了就卡死在这里）；
      //   · differential 用例没有本地期望，只记录 "observed"，等和 baseline 对比。
      //   （代码里的英文注释说的就是这件事：regression 用例违背期望就是 'fail'，
      //    必须由失败分类给出解释。）
      observations.push({
        case_id: c.id,
        // Regression cases carry an expectation; violating it is a 'fail'
        // that R3 forces the failure classifier to explain.
        status:
          c.kind === "regression" && r.status !== c.expect_exit_code
            ? ("fail" as const)
            : ("observed" as const),
        exit_code: r.status ?? -1,   // ← r.status 可能为 null（进程没正常结束），这里兜底成 -1
        signal: null,
        stdout_b64: Buffer.from(r.stdout ?? "").toString("base64"),   // ← 输出统一转 Base64 存进 JSON
        stderr_b64: Buffer.from(r.stderr ?? "").toString("base64"),
        filesystem: diffSnapshots(before, snapshotDir(runDir)),   // ← 文件系统副作用 = 运行后快照 vs 运行前快照 的差异
        duration_ms: 0,   // ⚠️ 旧路径并没有真正计时，这里固定写 0（schema 只要求非负数，所以能过校验）
      });
    } finally {
      // ← finally 保证"不管成功、报错还是 continue，临时目录都会被删掉"
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  return {
    kind: "observation-trace",
    version: 1,
    build,
    env_id: envId,
    observations,
    // ← 提交前的形状：failures 留空。ObservationTrace schema 的 refine 会检查
    //   "每个非 observed 的用例都必须有分类"，所以 pipeline 提交前必须补齐这一栏。
    failures: [],
  };
}
