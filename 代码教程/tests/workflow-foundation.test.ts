/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/workflow-foundation.test.ts —— CLI 与 workflow 执行器的"地基测试"
 *
 * 【这个文件锁定了哪些行为】
 *   ① CLI 参数解析：正常解析出完整命令对象；互斥选项（--input-json 与
 *      --input-file）同给必报 CliUsageError；
 *   ② runWorkflow 能执行一个纯 workflow 并拿到结构化返回值；
 *   ③ ★ 安全基石：workflow 源码访问宿主 API（process）会在执行前被 source-policy
 *      静态拒绝（status="rejected"，failure 里含 "host API"）；
 *   ④ 超时的 workflow 会得到 status="timeout"。
 *
 * 【为什么重要】
 *   ③ 是整个"workflow 也是不可信代码"安全模型的第一道闸——没有它，
 *   沙箱、Broker、能力白名单全都无从谈起。
 *
 * 【怎么跑】bun test tests/workflow-foundation.test.ts
 *   纯逻辑测试 + 真实子进程（不需要 gcc/cmake，但需要 Bun）。
 *
 * 【本文件是教程注释版】原文件 tests/workflow-foundation.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

// bun:test：Bun 内置测试框架。describe 分组、test 单测、expect 断言——和 Jest 语法几乎一样。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCliArgs, CliUsageError } from "../src/cli/args.js";
import { runWorkflow } from "../src/workflow/runner.js";

// ── tempWorkflow：测试辅助函数——把一段源码写成临时 workflow 文件 ─────────
// mkdtempSync：建"带随机后缀"的临时目录（防止多个测试互相踩）。
function tempWorkflow(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-workflow-"));
  const entry = join(root, "workflow.ts");
  writeFileSync(entry, source);
  return entry;
}

describe("CLI and Workflow foundation", () => {
  // ── 测试①：CLI 解析的"开心路径"+ 互斥校验 ─────────────────────────────
  test("parses workflow options and mutually exclusive input sources", () => {
    const command = parseCliArgs([
      "workflow",
      "run",
      "workflow.ts",
      "--cwd",
      "repo",
      "--input-json",
      "{\"x\":1}",          // 字符串里的 \" 是转义引号——模拟用户传入的 JSON 文本
      "--timeout-ms",
      "2500",
      "--format",
      "json",
    ]);
    // toEqual：深度相等断言（逐字段比较对象，不看内存地址）。
    expect(command).toEqual({
      kind: "workflow-run",
      entry: "workflow.ts",
      cwd: "repo",
      inputJson: "{\"x\":1}",
      inputFile: null,
      timeoutMs: 2500,
      format: "json",
    });
    // expect(() => …).toThrow(CliUsageError)：断言"调用会抛出指定类型的错误"。
    //   这里锁定：两个互斥的输入来源同时给 → 必须报 CliUsageError（而不是静默选一个）。
    expect(() => parseCliArgs(["workflow", "run", "x.ts", "--input-json", "{}", "--input-file", "x.json"]))
      .toThrow(CliUsageError);
  });

  // ── 测试②：最简单的 workflow 真能跑通并拿到返回值 ─────────────────────
  // workflow 源码：默认导出一个函数，收 { input }，返回 { doubled }。
  // (input as number) 是 TS 类型断言——workflow 作者告诉编译器"这个 input 是数字"。
  test("runs a pure workflow and returns structured output", async () => {
    const entry = tempWorkflow("export default ({ input }) => ({ doubled: (input as number) * 2 });\n");
    const result = await runWorkflow({
      entry,
      cwd: process.cwd(),
      input: 21,
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("pass");                 // toBe：严格相等（=== 语义）
    expect(result.result).toEqual({ doubled: 42 });     // 21 * 2 = 42，子进程算的
  });

  // ── 测试③（★ 全文件最重要）：宿主 API 访问被静态拒绝 ───────────────────
  // workflow 源码只有一行：访问 process.cwd()。它【还没执行】就应该被
  // source-policy 的静态检查拦下（禁 process 关键字），所以 status 是 "rejected"
  // 而不是 "failed"——rejected 表示"根本不让你上场"。
  test("rejects direct host access before execution", async () => {
    const entry = tempWorkflow("export default () => process.cwd();\n");
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 5_000 });
    expect(result.status).toBe("rejected");
    expect(result.failure).toContain("host API");       // 失败信息要能说明原因
  });

  // ── 测试④：超时会被如实报告 ──────────────────────────────────────────
  // workflow 源码：一个永不 resolve 的 Promise（await 卡死）。
  // new Promise(() => {})：executor 函数永不调用 resolve/reject → 永远 pending。
  // timeoutMs 只有 100ms → 宿主杀进程树 → status="timeout"。
  test("reports workflow timeout", async () => {
    const entry = tempWorkflow("export default async () => { await new Promise(() => {}); };\n");
    const result = await runWorkflow({ entry, cwd: process.cwd(), timeoutMs: 100 });
    expect(result.status).toBe("timeout");
  });
});
