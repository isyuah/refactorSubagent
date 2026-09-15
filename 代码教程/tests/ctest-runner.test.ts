/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/ctest-runner.test.ts —— CTest 文本输出 → 结构化事实
 *
 * 【这个文件是干什么的】
 *   只测一件事：parseCTestOutput() 能不能从 ctest 的一坨文本里把程序能
 *   比对的数字抠出来。锁定三个行为：
 *     ① "Not Run"（没跑起来的顶层测试）要单独计数，不能混进 passed/failed
 *        的判断路径里——否则"环境坏了导致没跑"会被误读成"测试失败但行为一致"；
 *     ② 标准的 Passed 行（没有 *** 失败星号）要能正确解析出顶层目标名单和计数；
 *     ③ 顶层目标内部的 TAP 用例失败（not ok 53 - ...）要被保留下来，
 *        而且要带上"哪个目标 + 上下文输出"作为证据。
 *
 * 【在整个项目里的位置】
 *   被测对象 src/runtime/ctest-runner.ts 的 parseCTestOutput()。
 *   它的返回值直接喂给 ctest-comparator.ts 做新旧对比，进而决定 ACCEPTED /
 *   REJECTED——所以"解析错了"就等于"裁决错了"，这是整条链上最不该出错的一环。
 *
 * 【先修知识】CTest / TAP 格式（见 ctest-runner.ts 的文件头注释，那里讲得更细）；
 *   ⚠️ 最容易误解的点：`0% tests passed, 2 tests failed out of 2` 说的是
 *      2 个【顶层目标】（比如 libuv 的 uv_test / uv_test_a），
 *      不是目标里那 ~474 个 TAP 用例。
 *
 * 【需要真实 gcc/cmake 吗】不需要。输入是手写文本、纯字符串解析，
 *   是纯粹的逻辑单测（甚至不需要临时目录）。
 *
 * 【本文件是教程注释版】原文件 tests/ctest-runner.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
import { parseCTestOutput } from "../src/runtime/ctest-runner.js";   // ← 被测对象：纯函数

describe("CTest output parsing", () => {
  // 【测什么】两个顶层测试：一个 Failed、一个 Not Run。
  //   关键断言在 summary：total 2 / passed 0 / failed 2 / not_run 1。
  //   注意 failed 计 2 但 not_run 也计 1 —— "Not Run" 同时被算进 failed
  //   总账里（ctest 自己就是这么报的），但单独的 not_run 计数让上游能
  //   区分"真的跑了但失败"和"压根没跑起来"。
  // 【语法】[...].join("\n")：把多行文本用换行符拼成一个字符串，模拟命令输出。
  test("keeps not-run top-level tests out of the pass path", () => {
    const result = parseCTestOutput([
      "    Start 1: shared",
      "1/2 Test #1: shared .........................***Failed    0.20 sec",
      "    Start 2: static",
      "2/2 Test #2: static .........................***Not Run   0.00 sec",
      "0% tests passed, 2 tests failed out of 2",
      "The following tests FAILED:",
      "  1 - shared (Failed)",
      "  2 - static (Not Run)",
    ].join("\n"));

    expect(result.summary).toEqual({ total: 2, passed: 0, failed: 2, not_run: 1 });
  });
  // 【测什么】一切正常的形态：一行 Passed、总结行没有 *** 星号。
  //   断言两件事：顶层目标名单 ["trim_behavior"]、计数 1/1/0/0。
  //   这是 happy path 的基线，防止解析器"把成功也当成失败"。
  test("recognizes standard passed output without failure stars", () => {
    const result = parseCTestOutput([
      "    Start 1: trim_behavior",
      "1/1 Test #1: trim_behavior ....................   Passed    0.54 sec",
      "100% tests passed, 0 tests failed out of 1",
    ].join("\n"));

    expect(result.topLevelTests).toEqual(["trim_behavior"]);
    expect(result.summary).toEqual({ total: 1, passed: 1, failed: 0, not_run: 0 });
  });

  // 【测什么】真实世界最复杂的形态（libuv 就是这样的）：两个顶层目标都失败，
  //   各自的 TAP 输出里混着 stderr 行和 not ok 行。断言：
  //   · 失败用例名要带目标前缀："uv_test:fs_event_watch_dir_short_path"——
  //     不然两个目标里同名的用例会撞车；
  //   · 每条失败都要保留上下文输出（"short path unavailable"），
  //     这是"拒绝时给出证据"的原始材料。
  // 【语法】expect.objectContaining({...})：只要求"包含这些字段"，
  //   不要求整个对象完全相等——适合字段很多、只关心其中几个的断言；
  //   expect.stringContaining(...) 同理，对字符串做"包含"判断。
  test("retains TAP failures with target output evidence", () => {
    const result = parseCTestOutput([
      "    Start 1: uv_test",
      "1/2 Test #1: uv_test .........................***Failed    1.20 sec",
      "stderr: short path unavailable",
      "not ok 53 - fs_event_watch_dir_short_path",
      "    Start 2: uv_test_a",
      "2/2 Test #2: uv_test_a .......................***Failed    1.30 sec",
      "stderr: dns provider refused",
      "not ok 55 - getaddrinfo_fail",
      "0% tests passed, 2 tests failed out of 2",
    ].join("\n"));

    expect(result.failedTests).toEqual([
      expect.objectContaining({
        name: "uv_test:fs_event_watch_dir_short_path",
        output: expect.stringContaining("short path unavailable"),
      }),
      expect.objectContaining({
        name: "uv_test_a:getaddrinfo_fail",
        output: expect.stringContaining("dns provider refused"),
      }),
    ]);
  });
});
