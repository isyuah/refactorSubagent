/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/sanitizer.test.ts —— sanitizer（内存/未定义行为检测）这一层的安全闸
 *
 * 【这个文件是干什么的】
 *   sanitizer 是编译器的"调试加强版"：加上 -fsanitize=address 之类标志
 *   重新编译，程序一旦越界访问/内存泄漏/有符号溢出，运行时就会立刻报错。
 *   本文件锁定四个门槛行为：
 *     ① 环境规格里要求了 sanitizer，但主机实测"编不出 sanitizer 程序"
 *        → 编译前就拒绝（fail-closed：不试了再说，直接判不可行）；
 *     ② 能力可用时，必须把实测到的标志位真的塞进编译命令行；
 *     ③ 能力不支持时，产出一个"schema 合法的独立结果"（status=unsupported），
 *        而不是抛异常让整条流水线崩掉；
 *     ④ baseline 与 candidate 的 sanitizer 结果必须分开存、分开取；
 *     ⑤ sanitizer 的诊断文本要从普通 stderr 里单独分类出来。
 *
 * 【在整个项目里的位置】
 *   涉及 src/runtime/builder.js（编译）、src/runtime/sanitizer-runner.js
 *   （跑 + 解析）、src/orchestrator/store.js（存取）。教程 §1.8 提到：
 *   本机（Windows/MinGW）缺 -lasan/-lubsan，所以阶段三真实运行时是
 *   UNSUPPORTED——①③ 两个用例锁定的正是这种"诚实地报告做不到"。
 *
 * 【先修知识】ASan/UBSan 的基本概念、Zod 的 parse/safeParse。
 *
 * 【需要真实 gcc/cmake 吗】部分需要。①② 会真的调 gcc（不加 sanitizer 标志
 *   时直接编译也能过），③④⑤ 不编译。host() 辅助函数是【手工伪造】的
 *   HostPreflight——这正是单测的妙处：不用真的装 ASan，就能测"探测结果
 *   说不可用"时的行为。
 *
 * 【本文件是教程注释版】原文件 tests/sanitizer.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EnvironmentSpec,
  HostPreflight,
  SanitizerResult,
  TestSpec,
} from "../src/artifacts/index.js";          // ← 这里导入的是 Zod Schema（可 parse），不是纯类型
import { SessionStore } from "../src/orchestrator/store.js";
import { buildWorktree, DirectCompilerAdapter } from "../src/runtime/builder.js";
import { parseSanitizerDiagnostics, runSanitizers } from "../src/runtime/sanitizer-runner.js";

// 造一个最小 C 项目：一个 main.c + 一个 build 目录。
function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-sanitizer-"));
  writeFileSync(join(root, "main.c"), "int main(void) { return 0; }\n");
  mkdirSync(join(root, "build"), { recursive: true });   // ← recursive：父目录不存在就一起建
  return root;
}

// 环境规格：要求 address sanitizer。这是"我们想要什么"。
function env(): EnvironmentSpec {
  return {
    kind: "environment-spec",
    version: 1,
    build: {
      kind: "direct-compiler",
      compiler: "gcc",
      flags: [],
      defines: {},
      sources: ["main.c"],
      output: "build/app",
    },
    sanitizers: ["address"],
    determinism: {
      frozen_time_epoch_ms: null,
      random_seed: null,
      intercept_headers: [],
    },
    sandbox: { run_cwd_strategy: "fresh_temp_dir" },
  };
}

function tests(): TestSpec {
  return {
    kind: "test-spec",
    version: 1,
    cases: [{ id: "d1", kind: "differential", argv: ["app"], stdin: "", fixtures: [] }],
  };
}

// ── host()：手工伪造的主机探测结果 ────────────────────────────────────
// 【作用】单测的核心技巧：把"主机能不能编 sanitizer 程序"变成一个参数。
//        available=true 表示能力可用，false 表示探测失败（比如缺 -lasan）。
// 【语法】HostPreflight.parse({...})：用 Zod 造一个【合法】的假数据——
//        字段名/取值范围都由 Schema 把关，伪造错了当场报错。
function host(root: string, available: boolean): HostPreflight {
  return HostPreflight.parse({
    kind: "host-preflight",
    version: 1,
    platform: process.platform,
    arch: process.arch,
    shell: process.platform === "win32" ? "cmd.exe" : "bash",
    supports_posix_shell: process.platform !== "win32",
    executable_suffix: process.platform === "win32" ? ".exe" : "",
    working_directory: root,
    tools: {
      gcc: { available: true, path: "gcc", version: null },
    },
    sanitizers: {
      address: {
        available,
        compiler: "gcc",
        flags: ["-fsanitize=address"],
        reason: available ? "test capability" : "test: libasan unavailable",
      },
      undefined: {
        available: false,
        compiler: "gcc",
        flags: ["-fsanitize=undefined"],
        reason: "not requested",
      },
    },
  });
}

describe("sanitizer safety layer", () => {
  // 【测什么】fail-closed 的第一道闸：想要 sanitizer 但主机做不到，
  //   就在【调用编译器之前】停下来。断言两件事：result.ok 是 false，
  //   日志里写明是哪个 sanitizer 不可用（可诊断性）。
  test("refuses an unproven sanitizer request before invoking the compiler", () => {
    const root = tempProject();
    const result = buildWorktree(root, env(), host(root, false));

    expect(result.ok).toBeFalse();
    expect(result.log).toContain("sanitizer 'address' unavailable");
  });

  // 【测什么】能力可用时，实测到的标志必须原样进编译命令行（不自行发挥）。
  //   断言：只排一条命令，且参数数组里包含 "-fsanitize=address"。
  //   注意这里只调 plan()（生成计划），不真的构建——测"计划对不对"就够了。
  test("injects measured sanitizer flags into the direct compiler argv", () => {
    const root = tempProject();
    const plan = new DirectCompilerAdapter().plan(root, env(), host(root, true));

    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]!.args).toContain("-fsanitize=address");
  });

  // 【测什么】"不支持"也要有一种体面的表达方式：不是抛异常，而是产出一个
  //   status = unsupported、failure.category = unsupported 的结果对象，
  //   并且它必须能通过 SanitizerResult 这个 Zod Schema——
  //   也就是说"做不到"这个事实本身也是可以被持久化、被状态机消费的 artifact。
  // 【语法】SanitizerResult.safeParse(result).success：safeParse 不抛异常，
  //   返回 { success: true/false }，用来断言"这数据是合法的"。
  test("records unsupported capability as a schema-valid independent result", () => {
    const root = tempProject();
    const result = runSanitizers({
      worktreeDir: root,
      env: env(),
      spec: tests(),
      build: "baseline",
      envId: "env-baseline-sanitized",
      host: host(root, false),
    });

    expect(result.status).toBe("unsupported");
    expect(result.failure?.category).toBe("unsupported");
    expect(SanitizerResult.safeParse(result).success).toBeTrue();
  });
  // 【测什么】baseline 和 candidate 的 sanitizer 结果不能互相覆盖。
  //   用真实的 SessionStore 各存一次，再分别取回，断言 env_id 对得上——
  //   新旧两版的"内存体检报告"必须是两份独立档案。
  test("keeps baseline and candidate sanitizer results separate", () => {
    const root = tempProject();
    const sessionRoot = mkdtempSync(join(tmpdir(), "rfr-sanitizer-session-"));
    const store = SessionStore.create(sessionRoot, "session");
    const baseline = runSanitizers({
      worktreeDir: root,
      env: env(),
      spec: tests(),
      build: "baseline",
      envId: "env-baseline-sanitized",
      host: host(root, false),
    });
    const candidate = runSanitizers({
      worktreeDir: root,
      env: env(),
      spec: tests(),
      build: "candidate",
      envId: "env-candidate-sanitized",
      host: host(root, false),
    });

    store.saveArtifact(baseline);
    store.saveArtifact(candidate);

    expect(store.sanitizer("baseline")?.env_id).toBe("env-baseline-sanitized");   // ← ?. 取值，可能为 undefined
    expect(store.sanitizer("candidate")?.env_id).toBe("env-candidate-sanitized");
  });

  // 【测什么】诊断分类：同一段输出里，ASan 的报错（AddressSanitizer: ...）
  //   和 UBSan 的报错（runtime error: ...）必须被分别识别、各自标注是哪个
  //   sanitizer 发现的。混在一起就失去了"哪类问题"的信息。
  test("classifies sanitizer diagnostics separately from ordinary stderr", () => {
    const findings = parseSanitizerDiagnostics(
      "d1",
      ["address", "undefined"],
      "AddressSanitizer: heap-use-after-free\nruntime error: signed integer overflow",
    );

    expect(findings).toEqual([
      {
        case_id: "d1",
        sanitizer: "address",
        message: "AddressSanitizer: heap-use-after-free",
      },
      {
        case_id: "d1",
        sanitizer: "undefined",
        message: "runtime error: signed integer overflow",
      },
    ]);
  });
});
