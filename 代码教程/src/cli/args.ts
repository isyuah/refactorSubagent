/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/cli/args.ts —— 命令行参数解析（把 argv 变成结构化命令）
 *
 * 【这个文件是干什么的】
 *   用户在终端敲 `bun run scripts/cli.ts workflow run xxx.ts --timeout-ms 5000`，
 *   Bun 把参数以字符串数组的形式交给程序。本文件的唯一职责：
 *   把这堆字符串"翻译"成一个类型安全的命令对象（CliCommand 联合类型），
 *   供 scripts/cli.ts 按种类分发执行。只解析、不执行——职责单一。
 *
 * 【在整个项目里的位置】
 *   上游：scripts/cli.ts（读 process.argv 后调用 parseCliArgs）；
 *   下游：解析出的 WorkflowRunCommand/WorkflowBuildCommand 会去调
 *         src/workflow/ 的 runner / registry。
 *   ⚠️ 注意：这是"workflow 工具"的 CLI，不是完整的重构流程 CLI
 *   （refactor-subagent analyze/run/resume 那套还只是 PROJECT_STATUS 里的规划）。
 *
 * 【先修知识】可辨识联合（带 kind 标签的联合类型）、数组遍历、错误类继承。
 *
 * 【本文件是教程注释版】原文件 src/cli/args.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

// 类型别名 + 字面量联合：CliFormat 只有两个合法值。
export type CliFormat = "human" | "json";

// —— 下面是 5 种命令各自的"形状"（interface）。注意每种都有 kind 字段：——
// 它是"可辨识联合"的标签，后面的代码靠 switch/if (cmd.kind === …) 区分分支，
// TypeScript 会据此自动收窄类型（is 收窄），这是 TS 处理"多种之一"的标准手法。

export interface PreflightCommand {        // 预检：只探测主机环境，不动别的
  kind: "preflight";
  repo: string;                            // 仓库路径
  format: CliFormat;                       // 输出格式
}

export interface WorkflowRunCommand {      // 直接运行一个 workflow 源码文件
  kind: "workflow-run";
  entry: string;                           // workflow 的 .ts 入口
  cwd: string;                             // 工作目录
  inputJson: string | null;                // 内联 JSON 输入（与 input-file 二选一）
  inputFile: string | null;                // 从文件读 JSON 输入
  timeoutMs: number;                       // 超时（毫秒！默认 60_000）
  format: CliFormat;
}

export interface WorkflowBuildCommand {    // 运行构建 workflow 并产出 manifest（可入库）
  kind: "workflow-build";
  entry: string;
  workflowId: string;                      // 稳定 id（入库用）
  revision: number;                        // 版本号（正整数）
  cwd: string;
  manifestOut: string | null;              // 把 manifest 另存到哪
  save: boolean;                           // 是否入库到 .refactorsa 注册表
  timeoutMs: number;
  format: CliFormat;
}

export interface WorkflowListCommand {     // 列出注册表里已有的 workflow
  kind: "workflow-list";
  cwd: string;
  format: CliFormat;
}

export interface ConfigCommand {           // 安装 workflow-spec skill
  kind: "config";
  /** Where to install the tool skill: project .claude/skills or user ~/.claude/skills. */
  scope: "project" | "user";               // 装到项目级还是用户级
}

// 总联合：一个命令对象 = 这六种之一。{kind:"help"} 是内联写的（只有一种形状，不必单独 interface）。
export type CliCommand =
  | { kind: "help" }
  | PreflightCommand
  | WorkflowRunCommand
  | WorkflowBuildCommand
  | WorkflowListCommand
  | ConfigCommand;

// 自定义错误类：继承内置 Error。区分"用户用法错了"（CliUsageError，友好提示）
// 和真正的程序 bug（其他 Error）——调用方可以 instanceof 判断后打印帮助而不打印堆栈。
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);            // 调用父类构造函数（TS 继承语法要求必须先 super()）
    this.name = "CliUsageError";
  }
}

// ── parseCliArgs：入口解析器 ────────────────────────────────────────────
// 【参数】argv：命令行参数数组（不含程序名），readonly 表示函数承诺不修改它。
// 【返回】CliCommand —— 解析成功后的结构化命令。
// 【关系】scripts/cli.ts 调用；捕获 CliUsageError 后打印 CLI_HELP。
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const args = [...argv];            // [...x] 展开复制：得到一份可修改的副本（保护入参）
  const command = args.shift();      // shift()：弹出并返回第一个元素（子命令名）
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help" };
  }
  if (command === "preflight") return parsePreflight(args);
  if (command === "workflow") return parseWorkflow(args);
  if (command === "config") return parseConfig(args);
  throw new CliUsageError(`unknown command '${command}'`);   // 模板字符串拼错误消息
}

// ── parseConfig：config 子命令 ─────────────────────────────────────────
function parseConfig(args: string[]): ConfigCommand {
  // ConfigCommand["scope"]：索引访问类型——直接"借"接口里 scope 字段的类型，
  // 避免重复写 "project" | "user"。
  let scope: ConfigCommand["scope"] = "project";
  for (const arg of args) {          // for...of：遍历数组元素值（区别于 for...in 遍历键）
    if (arg === "--user") {
      if (scope !== "project") throw new CliUsageError("config accepts only one of --project/--user");
      scope = "user";
      continue;                      // 跳过本次循环体剩余部分，进入下一个元素
    }
    if (arg === "--project") {
      if (scope !== "project") throw new CliUsageError("config accepts only one of --project/--user");
      continue;
    }
    if (arg.startsWith("--")) throw new CliUsageError(`unknown config option '${arg}'`);
    throw new CliUsageError(`config accepts no positional arguments, got '${arg}'`);
  }
  return { kind: "config", scope };
}

// ── parsePreflight：preflight 子命令 ───────────────────────────────────
function parsePreflight(args: string[]): PreflightCommand {
  let repo = ".";                    // 默认当前目录
  let format: CliFormat = "human";
  let sawRepo = false;               // 标记是否已给过位置参数（repo）
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    // ↑ args[index]!：非空断言。因为 tsconfig 开了 noUncheckedIndexedAccess（索引访问
    //   默认加 undefined），但此处 index 一定在长度内，用 ! 明确"我知道它存在"。
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      // ++index：先自增再使用——跳过选项的"值"，让 for 循环别把它当选项再解析一遍。
      continue;
    }
    if (arg.startsWith("--")) throw new CliUsageError(`unknown preflight option '${arg}'`);
    if (sawRepo) throw new CliUsageError("preflight accepts at most one repository path");
    repo = arg;
    sawRepo = true;
  }
  return { kind: "preflight", repo, format };
}

// ── parseWorkflow：workflow 子命令的二级分发 ───────────────────────────
function parseWorkflow(args: string[]): WorkflowRunCommand | WorkflowBuildCommand | WorkflowListCommand {
  const subcommand = args.shift();
  if (subcommand === "run") return parseWorkflowRun(args);
  if (subcommand === "build") return parseWorkflowBuild(args);
  if (subcommand === "list") return parseWorkflowList(args);
  throw new CliUsageError("workflow requires the 'run', 'build', or 'list' subcommand");
}

// ── parseWorkflowRun：workflow run ────────────────────────────────────
// 【对应文档】CLI_HELP 里 "Workflow run options" 段。
// 【关系】产出会交给 scripts/cli.ts → runner.runWorkflow。
function parseWorkflowRun(args: string[]): WorkflowRunCommand {
  const entry = requiredEntry(args);        // 第一个参数必须是入口 .ts
  let cwd = process.cwd();                  // 默认当前工作目录
  let inputJson: string | null = null;      // string | null：可空类型，用 null 表示"没提供"
  let inputFile: string | null = null;
  let timeoutMs = 60_000;                   // ⚠️ 数字字面量下划线分隔：60_000 = 60000，纯为可读
  let format: CliFormat = "human";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--cwd") {
      cwd = nextValue(args, ++index, "--cwd");
      continue;
    }
    if (arg === "--input-json") {
      // 两个输入来源互斥：先检查另一个是否已提供。
      if (inputFile !== null) throw new CliUsageError("--input-json and --input-file are mutually exclusive");
      inputJson = nextValue(args, ++index, "--input-json");
      continue;
    }
    if (arg === "--input-file") {
      if (inputJson !== null) throw new CliUsageError("--input-json and --input-file are mutually exclusive");
      inputFile = nextValue(args, ++index, "--input-file");
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(nextValue(args, ++index, "--timeout-ms"), "--timeout-ms");
      continue;
    }
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    throw new CliUsageError(`unknown workflow run option '${arg}'`);
  }
  return { kind: "workflow-run", entry, cwd, inputJson, inputFile, timeoutMs, format };
}

// ── parseWorkflowBuild：workflow build ────────────────────────────────
// 与 run 的区别：多 --id/--revision（产物要入库必须能定位）、--save、--manifest-out。
function parseWorkflowBuild(args: string[]): WorkflowBuildCommand {
  const entry = requiredEntry(args);
  let workflowId: string | null = null;
  let revision: number | null = null;
  let cwd = process.cwd();
  let manifestOut: string | null = null;
  let save = false;                         // 布尔开关选项：出现即 true
  let timeoutMs = 60_000;
  let format: CliFormat = "human";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--id") {
      workflowId = nextValue(args, ++index, "--id");
      continue;
    }
    if (arg === "--revision") {
      revision = parsePositiveInteger(nextValue(args, ++index, "--revision"), "--revision");
      continue;
    }
    if (arg === "--cwd") {
      cwd = nextValue(args, ++index, "--cwd");
      continue;
    }
    if (arg === "--manifest-out") {
      manifestOut = nextValue(args, ++index, "--manifest-out");
      continue;
    }
    if (arg === "--save") {
      save = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(nextValue(args, ++index, "--timeout-ms"), "--timeout-ms");
      continue;
    }
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    throw new CliUsageError(`unknown workflow build option '${arg}'`);
  }
  // 必填项收尾检查：--id/--revision 必须给（入库需要身份）。
  if (workflowId === null) throw new CliUsageError("workflow build requires --id");
  if (revision === null) throw new CliUsageError("workflow build requires --revision");
  // 注意收窄：到这里 TS 知道 workflowId/revision 不是 null（上面抛错挡住了），
  // 所以能直接赋给非空的 workflowId/revision 字段。
  return { kind: "workflow-build", entry, workflowId, revision, cwd, manifestOut, save, timeoutMs, format };
}

// ── parseWorkflowList：workflow list ──────────────────────────────────
function parseWorkflowList(args: string[]): WorkflowListCommand {
  let cwd = process.cwd();
  let format: CliFormat = "human";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--cwd") {
      cwd = nextValue(args, ++index, "--cwd");
      continue;
    }
    if (arg === "--format") {
      format = parseFormat(nextValue(args, ++index, "--format"));
      continue;
    }
    throw new CliUsageError(`unknown workflow list option '${arg}'`);
  }
  return { kind: "workflow-list", cwd, format };
}

// ── 小工具函数们 ──────────────────────────────────────────────────────

// 必填的入口文件参数：不允许缺失、也不允许以 - 开头（那说明用户把选项当成了位置参数）。
function requiredEntry(args: string[]): string {
  const entry = args.shift();
  if (entry === undefined || entry.startsWith("-")) {
    throw new CliUsageError("workflow command requires an entry .ts file");
  }
  return entry;
}

// 取选项的值：args[index] 必须存在且不能是另一个选项（以 -- 开头）。
function nextValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new CliUsageError(`${option} requires a value`);
  return value;
}

// 解析正整数：Number() 转换 + isSafeInteger（安全整数范围内，防溢出）+ 必须 > 0。
function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CliUsageError(`${option} must be a positive integer`);
  return parsed;
}

// 只接受两个白名单值——枚举类参数用"白名单 + 报错"而不是正则，最直白可靠。
function parseFormat(value: string): CliFormat {
  if (value === "human" || value === "json") return value;
  throw new CliUsageError(`format must be 'human' or 'json', got '${value}'`);
}

// ── CLI_HELP：帮助文本（模板字符串跨行）────────────────────────────────
// scripts/cli.ts 捕获 CliUsageError 或用户敲 help 时打印它。
// 注意最后一段是"分期实现"的自白：当时 capability 级 fs/process 访问还在下一阶段
// （现在已经实现了，帮助文本略有滞后——读文档要以代码为准）。
export const CLI_HELP = `Usage:
  refactor-subagent preflight [repo] [--format human|json]
  refactor-subagent workflow run <entry.ts> [options]
  refactor-subagent workflow build <entry.ts> --id <id> --revision <n> [options]
  refactor-subagent workflow list [--cwd <dir>] [--format human|json]
  refactor-subagent config [--project | --user]

Config options:
  --project                   Install workflow-spec skill into ./claude/skills (default)
  --user                      Install workflow-spec skill into ~/.claude/skills

The config command installs the tool's workflow-spec skill (exact API/schema
for workflow generation). The skill is force-injected by the host; it cannot
be triggered manually or by the model.

Workflow run options:
  --cwd <dir>                 Working directory for the workflow process
  --input-json <json>         JSON input passed to the workflow
  --input-file <file>         Read JSON input from a file
  --timeout-ms <n>            Maximum workflow duration (default: 60000)
  --format human|json         Output format (default: human)

Workflow build options:
  --id <id>                   Stable workflow identifier
  --revision <n>              Positive workflow revision
  --cwd <dir>                 Project working directory
  --manifest-out <path>       Save the generated manifest as JSON
  --save                      Persist source, output, and manifest under .refactorsa
  --timeout-ms <n>            Maximum workflow duration (default: 60000)
  --format human|json         Output format (default: human)

The workflow host currently provides process-level execution and source-policy
checks. Capability-based filesystem/process access is added in the next phase.`;
