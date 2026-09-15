/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/e2e-dashboard.ts —— 起观测看板（SSE 实时推流）
 *
 * 【这个文件是干什么的】
 *   启动 Dashboard 的 HTTP 服务。它本身不做任何业务判断，只是把命令行参数
 *   收拾成 E2EDashboardOptions，然后交给 src/runtime/e2e-dashboard.ts 的
 *   createE2EDashboardServer()（内部用 Bun.serve 起服务）。
 *   看板能看什么：运行列表、当前状态机阶段、失败原因、artifact 预览、
 *   CTest 原始日志 —— 数据全部来自磁盘上的
 *   <root>/<run-id>/{state.json, run.jsonl, artifacts/, logs/}，
 *   并通过 SSE（Server-Sent Events）增量推给浏览器。
 *
 * 【跑什么 / 要不要 Claude / 多久 / 期望输出】
 *   命令：bun run scripts/e2e-dashboard.ts --root <e2e根目录> --port 8080
 *   （root 一般填 .refactor/e2e，也就是各脚本 E2ELogger 落盘的那个目录；
 *     --port 不给或给 0 = 让系统随便挑一个空闲端口）
 *   典型用法是开两个终端：
 *     终端 1：bun run scripts/e2e-dashboard.ts --root .refactor/e2e
 *     终端 2：bun run e2e:generated-workflow     （然后浏览器打开终端 1 打印的 URL）
 *   要不要 Claude：不要（它只是个旁观者）。耗时：常驻，直到 Ctrl+C。
 *   期望输出：两行提示（URL 和观测根目录），之后浏览器里能实时看到运行；
 *   参数写错 → 退出码 2 并打印用法。
 *
 * 【在整个项目里的位置】
 *   上游：手工运行（package.json 没给它起别名）。
 *   下游：src/runtime/e2e-dashboard.ts（HTTP 路由 + SSE）+ web/e2e-dashboard.html（前端）。
 *   读的是 src/runtime/e2e-log.ts（E2ELogger）写下的文件。
 *
 * 【先修知识】
 *   ① 《零基础看懂教程.md》§1.6（数据都落在磁盘哪里）；
 *   ② 代码教程/src/runtime/e2e-log.ts（事件是怎么写进 run.jsonl 的）；
 *   ③ 语法：never 返回类型、for 循环手写参数解析（下文第一次出现会讲）。
 * 【本文件是教程注释版】
 *   原文件：scripts/e2e-dashboard.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

import { createE2EDashboardServer } from "../src/runtime/e2e-dashboard.js";

// ── DashboardCliOptions：这个脚本自己的参数包 ──────────────────────
// 【语法】readonly：TS 的"只读"标记，编译期禁止给这些字段重新赋值（运行时无开销）
interface DashboardCliOptions {
  readonly root: string;      // ← 观测根目录（里面每个子目录就是一次运行）
  readonly port: number;      // ← 0 表示交给系统分配
  readonly hostname: string;  // ← 默认只监听本机回环地址，不对外暴露
}

// ── usage：打印用法并退出 ────────────────────────────────────────
// 【语法】返回类型 never：这个函数【永远不正常返回】（里面必然 process.exit），
//   编译器因此知道"调用 usage() 之后的代码不用做类型收窄"，例如
//   if (root === null) usage(); 之后 root 就可以当作 string 用。
function usage(): never {
  console.error("用法: bun run scripts/e2e-dashboard.ts --root <e2e-root> --port <port>");
  process.exit(2);
}

// ── parseOptions：手写的参数解析器 ───────────────────────────────
// 【作用】逐个识别 --root / --port / --host / --help，任何不认识的参数都算用错。
//   ⚠️ 注意最后一行是裸的 usage() —— 也就是说这个脚本【必须】带 --root，
//   什么都不传会直接打印用法退出。
// 【语法】for 循环里手动 index += 1 跳过已消费的值（比第三方参数库少一个依赖）。
function parseOptions(args: readonly string[]): DashboardCliOptions {
  let root: string | null = null;
  let port = 0;
  let hostname = "127.0.0.1";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) usage();
      root = value;
      index += 1;        // ← 这个值已经被消费了，跳过它
      continue;
    }
    if (arg === "--port") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || !/^\d+$/.test(value)) usage();
      // ↑ 正则 ^\d+$：必须全是数字
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) usage();
      // ← 端口合法范围是 0~65535
      port = parsed;
      index += 1;
      continue;
    }
    if (arg === "--host" || arg === "--hostname") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) usage();
      hostname = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage();
    usage();
  }

  if (root === null) usage();
  return { root, port, hostname };
  // ↑ root 在这里已经过 usage() 收窄，TS 知道它不是 null
}

// ── 顶层执行块：解析 → 起服务 → 等待 Ctrl+C ──────────────────────
try {
  const options = parseOptions(Bun.argv.slice(2));
  const server = createE2EDashboardServer(options);
  // ↑ 返回 Bun.serve() 的 Server 对象；server.url 是它实际监听的地址
  //   （port 传 0 时只有这里能看到真正分配到的端口号）
  console.log(`E2E dashboard listening at ${server.url.toString()}`);
  console.log(`观测根目录: ${options.root}`);
  // ↑ 把这行 URL 粘到浏览器里就能看了（Windows 上也可以用 start <url>）

  const stop = (): void => {
    server.stop(true);   // ← true = 连正在挂着的 SSE 长连接一起主动关掉
    process.exit(0);
  };
  process.once("SIGINT", stop);    // ← Ctrl+C（Windows 上也能触发）
  process.once("SIGTERM", stop);   // ← kill 命令发来的终止信号
  // 【语法】once：只监听一次，触发后自动解除
} catch (cause) {
  // ← 主要是参数解析抛错 / 端口被占用这类启动期失败
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`E2E dashboard 启动失败: ${message}`);
  process.exitCode = 1;
}
