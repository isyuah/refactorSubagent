/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/environment.test.ts —— 主机探测 + 进程边界契约
 *
 * 【这个文件是干什么的】
 *   很短但很关键的三个锁定：
 *     ① probeHost() 必须真的去测量本机，并返回"归一化的工具表"——
 *        不管 gcc 装没装，host.tools.gcc 这个字段一定要存在（只是
 *        available 可能是 false）。这就是教程说的"程序只认测量结果，
 *        不许猜"。
 *     ② 参数在进程边界上不允许出现 NUL 字节（\0）——操作系统 API 层面
 *        argv 是以 \0 分隔的，带 \0 的参数要么被截断要么报错，必须在上游
 *        Schema 阶段就拒绝（fail-closed）。
 *     ③ sanitizer 探测很贵（要真的编一个小程序），默认不做——
 *        quick 探测返回空对象，只有显式要求才编探针。
 *
 * 【在整个项目里的位置】
 *   probeHost() 是整条流水线的第 ① 步（教程 §1.3），它的产物
 *   host-preflight.json 会被原文注入给每一个 AI 会话。
 *
 * 【先修知识】process.platform / process.arch / process.cwd()、
 *   Zod 的 safeParse（失败不抛异常，返回 { success: false }）。
 *
 * 【需要真实 gcc/cmake 吗】部分需要。本文件会真的跑 gcc --version / cmake
 *   探测，属于"轻量集成测试"：gcc 不在时 ① 的断言依然成立（字段存在即可），
 *   所以不会因缺工具而误报失败。两个用例都给了 30 秒超时。
 *
 * 【本文件是教程注释版】原文件 tests/environment.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
import { TestCase } from "../src/artifacts/test-spec.js";        // ← 测试用例的 Zod Schema
import { probeHost } from "../src/runtime/host-preflight.js";    // ← 被测对象：主机探测

describe("host preflight and execution-boundary contracts", () => {
  // 【测什么】测量结果的"形状契约"：
  //   · kind/version 这些身份证字段要对；
  //   · tools.gcc 必须有定义（哪怕 available: false）——归一化的意义就在于
  //     下游不用写 "如果字段不存在" 的分支；
  //   · working_directory 必须等于调用时传入的目录；
  //   · 可执行文件后缀跟平台走：Windows 是 .exe，其他平台是空串。
  //   最后的 if 是"条件断言"：只有 cmake 双探针都通过时，才进一步要求
  //   默认生成器和 C 编译器非空——探针失败时这两个字段允许是 null。
  // 【语法】test(名字, 函数, 30_000)：第三个参数把这个用例的超时放宽到 30 秒
  //   （子进程探测可能很慢）；数字里的下划线 _ 只是分隔符，便于读大数。
  test("measures the current host with a normalized tool map", () => {
    const host = probeHost(process.cwd());
    expect(host.kind).toBe("host-preflight");
    expect(host.tools.gcc).toBeDefined();
    expect(host.working_directory).toBe(process.cwd());
    expect(host.executable_suffix).toBe(process.platform === "win32" ? ".exe" : "");
    if (host.cmake.configure_probe === "pass" && host.cmake.build_probe === "pass") {
      expect(host.cmake.default_generator).not.toBeNull();
      expect(host.cmake.c_compiler).not.toBeNull();
    }
  }, 30_000);

  // 【测什么】进程边界契约：argv 里不允许出现 NUL 字节。
  //   用 safeParse（不抛异常、返回 { success }）而不是 parse，
  //   这样断言写起来直接：success 必须是 false。
  // 👉 为什么要在 Schema 层管这事？因为参数最终要传给 spawn 去启动进程，
  //    \0 在 C 字符串里就是"字符串结束"，任何含糊都会变成难查的怪 bug。
  test("rejects NUL bytes at the argv process boundary", () => {
    const result = TestCase.safeParse({
      id: "nul",
      kind: "differential",
      argv: ["program", "bad\0arg"],
      stdin: "",
      fixtures: [],
    });
    expect(result.success).toBeFalse();
  });
  // 【测什么】默认不做昂贵的 sanitizer 探测（那要真的用 -fsanitize 编译一个
  //   小程序）。所以快速探测返回空对象 {}。toEqual({}) 表示"必须一个键都没有"。
  //   真正的 sanitizer 能力探测在 sanitizer.test.ts 里用假 host 测。
  test("does not compile sanitizer probes unless explicitly requested", () => {
    const quick = probeHost(process.cwd());
    expect(quick.sanitizers).toEqual({});
  }, 30_000);
});
