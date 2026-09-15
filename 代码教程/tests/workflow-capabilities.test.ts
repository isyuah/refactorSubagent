/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/workflow-capabilities.test.ts —— 能力 Broker 的沙箱边界
 *
 * 【这个文件是干什么的】
 *   workflow 源码跑在 bun 子进程里，没有 node:fs / child_process / 网络；
 *   想干活必须通过 JSONL 协议向主进程的 Capability Broker 申请。
 *   本文件锁定的就是 Broker 的"放行 / 拒绝"边界：
 *     ① 正面：白名单内的读写 + 实测过的编译器（adapters.compiler）+
 *        受控进程启动/等待，全部能干成，事件流记录 6 次成功调用；
 *     ② 写越界（policy 只许写 build/**，却去写 secrets.txt）→ 拒，
 *        failure 写明 "not writable"，且【磁盘上真的没有这个文件】；
 *     ③ 路径逃逸（读 ../outside.txt）→ 在真正读文件【之前】就被拒
 *        （"escapes workspace"）；
 *     ④ 输出上限：要求 maxOutputBytes: 1 → 进程以 "output_limit" 状态结束，
 *        而不是把子进程输出无限吃进内存；
 *     ⑤ 调用一个"没被测量过/不可用"的工具（cmake）→ 得到一个确定性的失败
 *        （"measured tool is unavailable"），而不是随机的 spawn 错误。
 *   👉 一句话：workflow 也是不可信代码，这份测试就是沙箱的出厂检验单。
 *
 * 【在整个项目里的位置】
 *   被测对象 src/workflow/runner.ts 的 runWorkflow()（spawn worker + 起 Broker）。
 *   policy 里的 readableGlobs / writableGlobs / executableGlobs / allowedTools /
 *   maxOutputBytes / maxFileBytes 就是 Broker 的权限单。
 *
 * 【先修知识】Buffer 与 base64（子进程输出走 base64 通道）、
 *   模板字符串里写 workflow 源码（注意 \\n 是"字符串里的换行转义"）。
 *
 * 【需要真实 gcc/cmake 吗】需要 gcc（①④ 会真的编译/调用 gcc --version）。
 *   ①④ 用 skipCMakeProbe 的 probeHost 来省时间；没装 gcc 的机器上会失败
 *   （本组测试假定 Windows + MinGW 环境）。超时 20~60 秒。
 *
 * 【本文件是教程注释版】原文件 tests/workflow-capabilities.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeHost } from "../src/runtime/host-preflight.js";
import { runWorkflow } from "../src/workflow/runner.js";

// 把一段 workflow 源码写成临时目录里的 workflow.ts，返回 root 和入口路径。
function tempWorkflow(source: string): { root: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), "rfr-capability-"));
  const entry = join(root, "workflow.ts");
  writeFileSync(entry, source);
  return { root, entry };
}

// 能力策略（权限单）：读写都给 " 全部"，但可写只有 build/**；可执行 build/**；
// 只允许实测工具 gcc；输出/文件上限各 1MB。
const policy = {
  readableGlobs: ["**"],
  writableGlobs: ["build/**"],
  executableGlobs: ["build/**"],
  allowedTools: ["gcc"],
  maxOutputBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
};

describe("Workflow Capability Context", () => {
  // 【测什么】正面：白名单内的所有能力都能用，而且行为可预测。
  //   workflow 里依次做了 6 次能力调用：fs.writeFile / fs.readFile /
  //   adapters.compiler.compile / process.start / process.wait / tools.available，
  //   最后把所有结果作为返回值带回主进程断言。
  //   两个值得注意的细节：
  //   · 输出走 base64（ran.stdoutBase64），主进程这边解回字符串，
  //     并把 Windows 的 \r\n 归一成 \n 再比较；
  //   · events 过滤出 ok 的调用正好 6 条 —— 每一次能力申请都被记录（可审计）。
  test("runs allowlisted filesystem and measured compiler capabilities", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ fs, process, tools, adapters }) => {
        await fs.writeFile("build/main.c", "#include <stdio.h>\\nint main(void){puts(\\"ok\\");return 0;}\\n");
        const source = await fs.readFile("build/main.c");
        const compiled = await adapters.compiler.compile({
          args: ["build/main.c", "-o", "build/app.exe"],
          cwd: ".",
          timeoutMs: 10000,
        });
        const started = await process.start({
          program: "build/app.exe",
          cwd: "build",
          timeoutMs: 10000,
        });
        const ran = await process.wait(started);
        return {
          source,
          compiler: await tools.available("gcc"),
          compiled: { status: compiled.status, exitCode: compiled.exitCode },
          ran: {
            status: ran.status,
            exitCode: ran.exitCode,
            stdout: Buffer.from(ran.stdoutBase64, "base64").toString("utf8").replaceAll("\\r\\n", "\\n"),
          },
        };
      };
    `);
    const result = await runWorkflow({
      entry,
      cwd: root,
      facts: { host: probeHost(root, { skipCMakeProbe: true }) },
      policy,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("pass");
    expect(result.result).toEqual({
      source: '#include <stdio.h>\nint main(void){puts("ok");return 0;}\n',
      compiler: true,
      compiled: { status: "exited", exitCode: 0 },
      ran: { status: "exited", exitCode: 0, stdout: "ok\n" },
    });
    expect(result.events.filter((event) => event.ok)).toHaveLength(6);
  }, 60_000);

  // 【测什么】写越界：policy 只许写 build/**，workflow 却想写 secrets.txt。
  //   三重断言：整体 status = "failed"；failure 写明 "not writable"；
  //   events 里恰好一条 fs.writeFile 且 ok: false（失败也要留痕）。
  //   最后一条最硬核：existsSync 确认磁盘上【真的没有】这个文件——
  //   沙箱不是"事后报错"，是"根本没写进去"。
  test("rejects writes outside policy and records failed capability event", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ fs }) => {
        await fs.writeFile("secrets.txt", "must not be written");
        return "unreachable";
      };
    `);
    const result = await runWorkflow({
      entry,
      cwd: root,
      policy,
      timeoutMs: 10_000,
    });

    expect(result.status).toBe("failed");
    expect(result.failure).toContain("not writable");
    expect(result.events).toEqual([
      expect.objectContaining({
        capability: "fs",
        method: "writeFile",
        ok: false,
      }),
    ]);
    expect(existsSync(join(root, "secrets.txt"))).toBeFalse();
  }, 60_000);

  // 【测什么】路径逃逸（../）要在【真正读文件之前】就被拦下。
  //   测试先在工作区外真的放了一个 outside.txt（证明"文件是存在的，
  //   拦它不是因为文件不存在"），然后断言：status = "failed"、
  //   failure 含 "escapes workspace"、第一条事件就是失败的 readFile。
  //   finally 里把这个外部文件删掉，不污染临时区。
  test("rejects path traversal before reading outside the workspace", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ fs }) => await fs.readFile("../outside.txt");
    `);
    const outside = join(root, "..", "outside.txt");
    writeFileSync(outside, "not readable");
    try {
      const result = await runWorkflow({ entry, cwd: root, policy, timeoutMs: 10_000 });
      expect(result.status).toBe("failed");
      expect(result.failure).toContain("escapes workspace");
      expect(result.events[0]).toEqual(expect.objectContaining({ ok: false, method: "readFile" }));
    } finally {
      // The fixture is outside the temporary project and must not remain behind.
      Bun.file(outside).delete();   // ← Bun 专属 API：按路径删文件（异步）
    }
  }, 60_000);

  // 【测什么】输出上限：明明只允许 1MB，workflow 自己要求 maxOutputBytes: 1，
  //   gcc --version 的输出必然超。断言结果里 status = "output_limit" ——
  //   也就是说"输出太大"是一种【被预期、被命名】的结束状态，
  //   而不是内存爆掉或挂死。
  test("enforces the broker output limit for measured tools", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ process }) => process.run({
        program: "gcc",
        args: ["--version"],
        maxOutputBytes: 1,
        timeoutMs: 10000,
      });
    `);
    const result = await runWorkflow({
      entry,
      cwd: root,
      facts: { host: probeHost(root, { skipCMakeProbe: true }) },
      policy,
      timeoutMs: 20_000,
    });

    expect(result.status).toBe("pass");
    expect(result.result).toEqual(expect.objectContaining({ status: "output_limit" }));
  }, 60_000);

  // 【测什么】不可用工具的确定性失败：policy 只允许 gcc，workflow 却调 cmake。
  //   即使 cmake 可能装在机器上，也不许用（不在白名单/未被测量）→
  //   failure 固定为 "measured tool is unavailable"。
  //   👉 "确定性"是关键词：错误必须是可断言的固定文案，不能是每次不同的
  //      底层 spawn 报错——否则上游没法做可靠分类和提示。
  test("returns a deterministic failure for unavailable measured tools", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ process }) => process.run({
        program: "cmake",
        args: ["--version"],
      });
    `);
    const result = await runWorkflow({ entry, cwd: root, policy, timeoutMs: 10_000 });

    expect(result.status).toBe("failed");
    expect(result.failure).toContain("measured tool is unavailable");
  }, 60_000);
});
