/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/cli.ts —— 通用命令行入口（不依赖 AI，秒级返回）
 *
 * 【这个文件是干什么的】
 *   这是整个项目唯一的"成品 CLI"。它自己不做任何业务判断，只做三件事：
 *     ① 解析命令行参数（交给 src/cli/args.ts 的 parseCliArgs）；
 *     ② 按命令类型调用 src/ 里对应的函数（探测 / 工作流运行 / 工作流注册 / 列表）；
 *     ③ 把结果打印出来（人读的文本或 JSON），并设置退出码。
 *   支持的子命令（完整帮助见 src/cli/args.ts 末尾的 CLI_HELP 字符串）：
 *     preflight      探测主机 + 探测 C 项目（gcc/cmake 在不在、是哪种构建系统）
 *     workflow run   在沙箱 worker 里跑一个 workflow 源文件
 *     workflow build 解析（声明式还会执行一次）BuildWorkflow，可存入注册表
 *     workflow list  列出 .refactorsa/ 注册表里可复用的 BuildWorkflow 候选
 *     config         把 workflow-spec 这个 skill 安装到项目/用户目录
 *
 * 【跑什么场景 / 要不要 Claude / 多久 / 期望输出】
 *   —— 全部命令【都不需要 Claude】（不 import 任何 agents/ 模块），最快的秒级返回。
 *      workflow build 走 resolveBuildWorkflow：声明式 workflow 会在解析期执行一次
 *      函数（spawn 一个 bun 子进程 + 能力代理），通常几秒；workflow-driven 的
 *      解析期不执行，直接返回 output: null。
 *   最小复现：
 *     bun run cli preflight examples/trim-app/base
 *     bun run cli workflow list --cwd examples/trim-app/base
 *     bun run cli workflow build examples/workflows/direct-build.ts --id demo --revision 1
 *   期望输出/退出码：preflight 在项目 status === "ready" 时退出 0，否则 1；
 *   workflow run 在 result.status === "pass" 时退出 0，否则 1；参数写错退出 2。
 *
 * 【在整个项目里的位置】
 *   上游：用户终端 / package.json 的 "cli" 脚本。
 *   下游：src/cli/args.ts（参数→结构化命令）、src/runtime/{host-preflight,project-detector}、
 *         src/workflow/{build-workflow,registry,runner}。
 *   注意：真正"AI 生成 workflow"的全流程入口不是这里，而是 scripts/e2e-*.ts
 *   （它们直接调 runAgentWorkflowVerification）。CLI 目前没有 analyze/run/resume
 *   这类面向最终用户的命令——这正是《零基础看懂教程.md》任务 7 / 3.5-11 提到的缺口。
 *
 * 【先修知识】
 *   ① src/cli/args.ts（命令被解析成什么样）；
 *   ② 代码教程/src/workflow/registry.ts（注册表 .refactorsa/ 的目录结构与 hash 校验）；
 *   ③ Bun.argv / 顶层 await / process.exitCode 这几个 Bun 语法（本文件第一次遇到会讲）。
 * 【本文件是教程注释版】
 *   原文件：scripts/cli.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// ← 一次性导入 node:fs 里要用到的 6 个函数（Bun 完全兼容 node: 前缀的标准库）
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";                        // ← homedir() = 当前用户主目录（装用户级 skill 用）
import { dirname, join, resolve } from "node:path";       // ← dirname 取目录部分；join 拼路径；resolve 转绝对路径
import {
  CLI_HELP,
  CliUsageError,
  parseCliArgs,
  type CliCommand,
  type ConfigCommand,
  type PreflightCommand,
  type WorkflowBuildCommand,
  type WorkflowListCommand,
} from "../src/cli/args.js";
import { detectCProject } from "../src/runtime/project-detector.js";   // ← 探测"这是什么 C 项目"
import { probeHost } from "../src/runtime/host-preflight.js";          // ← 探测"这台机器有什么工具"
import { resolveBuildWorkflow } from "../src/workflow/build-workflow.js";
import {
  discoverBuildWorkflows,
  saveBuildWorkflow,
  type BuildWorkflowCandidate,
} from "../src/workflow/registry.js";
import { readJsonInput, runWorkflow } from "../src/workflow/runner.js";
import type { WorkflowRunResult } from "../src/workflow/types.js";

// ── 顶层执行块：CLI 的"main 函数"────────────────────────────────────
// 【语法】下面这段代码不在任何函数里——Bun 支持"顶层 await/顶层语句"，
//         脚本一启动就从上往下执行，不需要 C/Java 那种 main() 入口。
// 【关系】整个文件唯一的副作用入口。parseCliArgs 抛 CliUsageError = 用户用错了
//         （退出码 2，并打印完整帮助）；其他异常 = 程序/环境真出问题了（退出码 1）。
try {
  // Bun.argv = 本次命令行的完整参数数组；[0] 是 bun 自身、[1] 是本脚本路径，
  // 所以 slice(2) 之后才是用户真正输入的参数（和 Node 的 process.argv.slice(2) 一样）。
  const command = parseCliArgs(Bun.argv.slice(2));
  const exitCode = await execute(command);
  if (exitCode !== 0) process.exitCode = exitCode;   // ← process.exitCode = "脚本跑完后以这个码退出"
} catch (cause) {                                     //    （比 process.exit() 温和：能让剩余清理跑完）
  // ← 用错命令（未知子命令/缺参数/选项值非法）→ 打印 error + 完整帮助，退出码 2
  if (cause instanceof CliUsageError) {
    console.error(`error: ${cause.message}\n\n${CLI_HELP}`);
    process.exitCode = 2;
  } else {
    // ← 真异常：优先打印 stack（带调用栈），没有 stack 就打印 message，再不行 String 化
    console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
    process.exitCode = 1;
  }
}

// ── execute：按命令类型分发（本文件的"路由表"）──────────────────────
// 【参数】command: CliCommand —— args.ts 用可辨识联合（discriminated union）定义：
//         每种命令都有个 kind 字段，if (command.kind === …) 就能安全收窄类型。
// 【返回】Promise<number> —— 退出码：0 成功，非 0 失败。
// 【语法】async/await：executeWorkflowBuild / runWorkflow 是异步的（要 spawn 子进程），
//         所以这里 await 等它们跑完再继续。
// 【关系】help/preflight/workflow-*/config 直接在这里处理；默认分支是 workflow run。
async function execute(command: CliCommand): Promise<number> {
  if (command.kind === "help") {
    console.log(CLI_HELP);
    return 0;
  }
  if (command.kind === "preflight") return executePreflight(command);
  if (command.kind === "workflow-build") return executeWorkflowBuild(command);
  if (command.kind === "workflow-list") return executeWorkflowList(command);
  if (command.kind === "config") return executeConfig(command);

  // ── 走到这里说明是 workflow run ─────────────────────────────────
  // 【语法】三层嵌套三元表达式 + null 合并写法，翻译成人话：
  //   没给 --input-file ？
  //     没给 --input-json → input = null（workflow 自己决定要不要输入）
  //     给了 --input-json → 把 JSON 字符串解析成对象
  //   给了 --input-file  → 用 readJsonInput 把文件内容读出来再解析
  // （args.ts 已保证两者互斥，同时给会直接报错。）
  const input = command.inputFile === null
    ? command.inputJson === null
      ? null
      : JSON.parse(command.inputJson)
    : readJsonInput(command.inputFile);
  // ← runWorkflow：把 workflow 源码先过一遍"沙箱检查"（source-policy：禁 node:/bun:/shell 等），
  //   再 spawn 一个 bun 子进程 + 能力代理（Broker）去执行它。workflow 想读文件/跑命令
  //   都得通过 JSONL 协议向主进程申请，越权直接被拒。
  const result = await runWorkflow({
    entry: command.entry,
    cwd: command.cwd,
    input,
    timeoutMs: command.timeoutMs,
  });
  if (command.format === "json") console.log(JSON.stringify(result, null, 2));
  else printWorkflowResult(result);
  // ← 只有 status === "pass" 才算成功；failed/timeout/rejected 一律退出码 1（方便脚本判断）
  return result.status === "pass" ? 0 : 1;
}

// ── executePreflight：探测主机 + 探测项目（CLI 的"体检"命令）────────
// 【作用】把 src/runtime 两个探测函数跑一遍，回答"这台机器 + 这个目录能不能构建 C 项目"。
// 【参数】command.repo —— 目标目录，默认 "."（当前目录）。
// 【返回】退出码：project.status === "ready" → 0，否则 1（方便在 shell 里 && 串接）。
// 【关系】probeHost / detectCProject 也是每条 AI 流水线的第一步（🔗 见
//         scripts/e2e-libuv-generate.ts 的 "1. preflight" 阶段），这里只是把结果打印出来。
// 【注意】函数没有 async —— 它调用的两个探测都是同步函数，所以直接 return。
function executePreflight(command: PreflightCommand): number {
  const repo = resolve(command.repo);          // ← 相对路径 → 绝对路径，打印出来更清楚
  const host = probeHost(repo);
  const project = detectCProject(repo, host);
  const value = { repo, host, project };
  if (command.format === "json") console.log(JSON.stringify(value, null, 2));
  else {
    // ── 人读格式：逐行打印关键字段 ─────────────────────────────
    console.log(`repo: ${repo}`);
    console.log(`platform: ${host.platform}/${host.arch}`);   // ← 例如 win32/x64
    // ← ?? 是"空值合并"：左边是 null/undefined 才取右边。项目没有构建系统时显示 none
    console.log(`primary build system: ${project.primary_build_system ?? "none"}`);
    console.log(`adapter: ${project.adapter}`);
    console.log(`status: ${project.status}`);
    console.log(`reason: ${project.reason}`);   // ← status 不是 ready 时，这里给出阻塞原因
  }
  return project.status === "ready" ? 0 : 1;
}

// ── executeWorkflowBuild：解析 BuildWorkflow（可顺手入库）───────────
// 【作用】对一个 workflow 源文件做"解析期"处理：源码沙箱检查 → 算 source hash →
//         声明式则真的执行一次拿到静态产物清单；可选写入 .refactorsa/ 注册表、
//         可选把 manifest 落成 json 文件。
// 【参数】entry：workflow 源文件；workflowId / revision：用来与 workflow 返回值"对账"
//         （不一致直接抛错，防止跑错版本）；timeoutMs：声明式解析执行的超时（毫秒，默认 60_000）。
// 【返回】永远退出码 0（解析失败会直接抛异常，走顶层 catch）。
// 【要不要 Claude】不需要。AI 生成的入口在 resolveWorkflows（resolve-workflows.ts），
//         本命令只吃"已经写好的" workflow 源文件。
async function executeWorkflowBuild(command: WorkflowBuildCommand): Promise<number> {
  const cwd = resolve(command.cwd);
  const host = probeHost(cwd);
  const project = detectCProject(cwd, host);
  // ← 解析：声明式 workflow 会在沙箱里执行一次函数，返回值过 BuildWorkflowOutput.parse()
  const resolution = await resolveBuildWorkflow({
    entry: command.entry,
    workflowId: command.workflowId,
    revision: command.revision,
    cwd,
    host,
    project,
    timeoutMs: command.timeoutMs,
  });

  // ← ReturnType<typeof saveBuildWorkflow>：TS 的类型运算符——"那个函数返回值是什么类型就用什么类型"，
  //   免得为了写个类型再 import 一次 StoredBuildWorkflow
  let saved: ReturnType<typeof saveBuildWorkflow> | null = null;
  if (command.save) saved = saveBuildWorkflow(cwd, resolution);   // ← --save：写入 .refactorsa/build-workflows/
  if (command.manifestOut !== null) {
    const manifestPath = resolve(cwd, command.manifestOut);
    mkdirSync(dirname(manifestPath), { recursive: true });        // ← 先保证父目录存在（recursive 不会因已存在而报错）
    writeFileSync(manifestPath, JSON.stringify(resolution.manifest, null, 2) + "\n");
  }

  // ── 组装要打印的对象（JSON 模式用）───────────────────────────
  const value = {
    manifest: resolution.manifest,
    // ← ?. 可选链：output 为 null 时不算错误、直接得到 undefined，再用 ?? 兜成 null。
    //   workflow-driven（自驱动）workflow 的 output 就是 null——产物要到 execute 才知道。
    artifact: resolution.output?.artifact ?? null,
    environment: resolution.output?.environment ?? null,
    source_hash: resolution.sourceHash,          // ← 源码 sha256，注册表靠它做防篡改校验
    saved: saved === null
      ? null
      : {
          entry: saved.entry,
          manifest: saved.manifestPath,
          output: saved.outputPath,
        },
  };
  if (command.format === "json") console.log(JSON.stringify(value, null, 2));
  else {
    console.log(`workflow: ${resolution.manifest.id}@${String(resolution.manifest.revision)}`);
    console.log(`source hash: ${resolution.sourceHash}`);
    // ← String(resolution.manifest.revision)：revision 在 schema 里是 number，
    //   模板字符串里也能直接用，这里显式转字符串只是写法习惯
    if (resolution.output === null) {
      console.log("build kind: workflow-driven (no static plan; output produced at execute)");
    } else {
      console.log(`artifact kind: ${resolution.output.artifact.kind}`);
      // ← Object.entries：把 {a: 1, b: 2} 变成 [["a",1],["b",2]]，逐个打印产物清单
      for (const [name, path] of Object.entries(resolution.output.artifact.paths)) {
        console.log(`artifact ${name}: ${path}`);
      }
    }
    if (command.manifestOut !== null) console.log(`manifest: ${resolve(cwd, command.manifestOut)}`);
    if (saved !== null) console.log(`saved: ${saved.manifestPath}`);
  }
  return 0;
}

/** Install the tool's workflow-spec skill into project or user skills dir. */
// ↑ 原文件自带的英文注释，一字未动：把本工具的 workflow-spec skill 装到项目级或用户级目录。
// ── executeConfig：安装 workflow-spec skill ─────────────────────────
// 【作用】把仓库里 .claude/plugins/workflow-spec/skills/workflow-spec/ 整个目录
//         复制成 Claude Code 能发现的 skill 目录（项目级 .claude/skills/ 或用户级 ~/.claude/skills/）。
// 【为什么需要】这个 skill 写明了 BuildWorkflow/TestWorkflow 的 API 与 Schema，是
//         AI 生成 workflow 时的"教科书"。它由宿主在生成会话里**强制注入**
//         （driver.ts 的 skills 选项，全仓只有 workflow-generator.ts 一处），
//         所以即使不装也能工作——这个命令是给人类阅读/本地调试用的。
// 【返回】0 成功；找不到源 skill 目录 → 1。
function executeConfig(command: ConfigCommand): number {
  // ← import.meta.dir：Bun 特有，等于"当前这个 .ts 文件所在的目录"（Node 里是 __dirname）
  const toolSkill = resolve(import.meta.dir, "..", ".claude", "plugins", "workflow-spec", "skills", "workflow-spec");
  if (!existsSync(join(toolSkill, "SKILL.md"))) {
    console.error(`tool skill not found: ${toolSkill}`);
    return 1;
  }
  const target = command.scope === "user"
    ? join(homedir(), ".claude", "skills", "workflow-spec")
    : join(process.cwd(), ".claude", "skills", "workflow-spec");
  // Replace any existing copy atomically-ish: remove then copy.
  // ↑ 原注释：先删后拷，"原子性≈有"——极端情况下中断会留下不完整副本。
  rmSync(target, { recursive: true, force: true });   // ← force: 目标不存在也不报错
  mkdirSync(dirname(target), { recursive: true });
  cpSync(toolSkill, target, { recursive: true });
  const files = readdirSync(target).filter((f) => f !== "SKILL.md");   // ← 只列出参考文档名
  console.log(`installed workflow-spec skill → ${target}`);
  console.log(`  SKILL.md (frontmatter: user-invocable=false, disable-model-invocation=true)`);
  for (const file of files) console.log(`  ${file}`);
  console.log("The skill is force-injected by the host during workflow generation;");
  console.log("neither you nor the model can trigger it manually.");
  return 0;
}

// ── executeWorkflowList：列出注册表里可复用的 BuildWorkflow ─────────
// 【作用】扫 .refactorsa/build-workflows/ 下的候选，并给出状态（valid/draft/
//         incompatible/stale/invalid）与理由。这是"selected 快速路径"的入口：
//         复用现成 workflow 就不用再跑生成会话。
// 【关系】discoverBuildWorkflows 在加载时会重算 source hash 与 manifest 对账，
//         对不上就标 stale/invalid（fail-closed：不许复用被改过的源码）。
function executeWorkflowList(command: WorkflowListCommand): number {
  const repo = resolve(command.cwd);
  const host = probeHost(repo);
  const project = detectCProject(repo, host);
  const candidates = discoverBuildWorkflows(repo, host, project);
  if (command.format === "json") {
    console.log(JSON.stringify({ repo, candidates }, null, 2));
  } else {
    printWorkflowCandidates(candidates);
  }
  return 0;
}

// ── printWorkflowCandidates：把候选列表打成人读的多行文本 ───────────
// 【参数】candidates: BuildWorkflowCandidate[] —— registry.ts 的结构：
//         { manifestPath, entry, manifest(可空), status, reasons[] }
function printWorkflowCandidates(candidates: BuildWorkflowCandidate[]): void {
  if (candidates.length === 0) {
    console.log("no build workflows found");
    return;
  }
  for (const candidate of candidates) {
    const identity = candidate.manifest === null
      ? "unknown"
      : `${candidate.manifest.id}@${String(candidate.manifest.revision)}`;
    console.log(`${identity} [${candidate.status}] ${candidate.manifestPath}`);
    for (const reason of candidate.reasons) console.log(`  reason: ${reason}`);   // ← 为什么是这个状态
  }
}

// ── printWorkflowResult：把 runWorkflow 的结果打成人读文本 ──────────
// 【参数】result: WorkflowRunResult —— 关键字段：
//         status: "pass" | "failed" | "timeout" | "rejected"（rejected = 源码没过沙箱检查）
//         exitCode / result / failure / stderr …
function printWorkflowResult(result: WorkflowRunResult): void {
  console.log(`status: ${result.status}`);
  console.log(`exit code: ${String(result.exitCode)}`);
  if (result.result !== null) console.log(`result: ${JSON.stringify(result.result)}`);
  if (result.failure !== null) console.log(`failure: ${result.failure}`);
  if (result.stderr.length > 0) console.log(`stderr:\n${result.stderr}`);
}
