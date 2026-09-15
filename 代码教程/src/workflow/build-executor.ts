/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/build-executor.ts —— 真正"把项目编译出来"的执行器
 *
 * 【这个文件是干什么的】
 *   resolve 阶段（resolve-workflows.ts）只回答"怎么构建"；本文件负责"真的去构建"。
 *   输入一个【已校验】的 BuildWorkflow，按形态分两种做法：
 *
 *   · 声明式（options.output 非 null）：resolve 阶段已经执行过一次函数、拿到一份
 *     结构化计划（CMake 的 source/build 目录与参数、Ninja 参数、编译器命令行）。
 *     这里按计划【重放】进程调用：先 configure、再 build（或一条 ninja / 一条编译器命令）。
 *
 *   · 自驱动 / workflow-driven（options.output 为 null）：重新执行 workflow 函数本身，
 *     把 fs / process / tools / adapters / validator 这些"能力"注入给它，由它自己驱动
 *     整个构建，并用 ctx.validator.assertFile(path, 描述) 断言产物真的存在——
 *     断言失败会 throw，worker 非零退出 → 本函数拿到 status !== "pass" → 失败。
 *
 *   最后统一再做一次"产物是否真的在盘上"的检查。任何一步失败都返回 status:"failed"
 *   加一个【占位 artifact】，绝不假装成功——这就是 fail-closed。
 *
 * 【在整个项目里的位置】
 *   上游：src/runtime/workflow-pipeline.ts 的 executeBuild()——baseline 和 candidate
 *        两个 worktree 【各调用一次】；另外 scripts/e2e-cmake.ts、scripts/demo-libuv.ts、
 *        scripts/e2e-libuv-generate.ts 和 tests/ 也直接调用它。
 *   下游：LocalCapabilityBroker（能力代理——真正的进程/文件操作都在它那边，受 policy 约束）、
 *        runner.ts 的 runWorkflow（spawn 一个 bun 子进程跑 workflow 源码）。
 *   产出：BuildWorkflowExecution。pipeline 检查它的 status：失败 → orch.abort(...) 会话中止；
 *        成功 → 继续跑测试，并用 logger.artifact 落成 baseline-build.json / candidate-build.json。
 *
 * 【最重要的一个心智模型：同一个 workflow 函数会被执行多次】
 *   · 声明式：resolve 阶段执行一次函数拿计划（build-workflow.ts）→ execute 阶段在
 *     baseline、candidate 两个 worktree 里各重放一遍进程调用；
 *   · 自驱动：resolve 阶段【不】执行函数（所以 output 是 null）→ execute 在 baseline
 *     worktree 跑一次、candidate worktree 再跑一次（两次之间还隔着一次"重构"）；
 *   · 自驱动 TestWorkflow 同理：同一份源码在两侧各跑一次（test-executor.ts 的 runTestSide）。
 *   所以 workflow 函数必须【幂等】：重复 mkdir 已存在的目录、对已有 build 目录再 configure
 *   一次、重复写同一个文件，都不得报错；也不能依赖"上一次运行留下的状态"——每一次执行
 *   都必须能从零独立完成整个构建。这也是为什么 CMake 路径每次都无条件重新 configure。
 *
 * 【先修知识】
 *   ① 《零基础看懂教程.md》§1.5 的 Capability Broker 与"自驱动 TestWorkflow 的两侧运行"；
 *   ② src/workflow/capabilities.ts（policy 各字段、默认超时 60_000、输出上限）；
 *   ③ src/workflow/runner.ts（worker 子进程 + JSONL 能力协议）；
 *   ④ src/workflow/types.ts（WorkflowCapabilityPolicy / ProcessResult / WorkflowEvent）。
 *
 * 【语法】本文件用到的（都在第一次出现处细讲）：`??` 空值合并、`"kind" in build` 的
 *   类型收窄、模板字符串、Object.entries + 解构参数、Set + 展开成数组、数组 .some、
 *   类型谓词 `value is ProcessResult`、Buffer 的 base64 解码、try/finally。
 *   （本文件没有用可选链 `?.`，判空全部是显式比较。）
 *
 * 【本文件是教程注释版】
 *   原文件：src/workflow/build-executor.ts（代码与本文件逐字一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { existsSync } from "node:fs";   // ← 只用来回答一个问题："产物文件在不在盘上？"
import { join } from "node:path";   // ← join(cwd, 相对路径) = 绝对路径，配合 existsSync 用。
import {
  BuildWorkflowOutput as BuildWorkflowOutputValue,   // ← 这里导入的是"值"（Zod schema 本体），但只用它的类型位置 —— 因为 options.output 的类型是 `BuildWorkflowOutputValue | null`。
  type BuildArtifact,   // ← 构建产物的描述：{kind, version, workflow_id, workflow_revision, paths, metadata}。paths 是"名字 → 相对路径"的表。
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import type {
  CapabilityRequest,   // ← worker → 主进程的能力请求（JSONL 协议消息）。
  CapabilityResponse,   // ← 主进程 → worker 的应答。
} from "./capability-protocol.js";
import { LocalCapabilityBroker } from "./capabilities.js";   // ← 能力代理：文件/进程操作只在这里发生，受 policy（可读/可写 glob、工具白名单、输出上限）约束。
import { runWorkflow } from "./runner.js";   // ← 自驱动路径用：spawn 一个 bun 子进程跑 workflow 源码，子进程想要能力也得走上面的 broker。
import type {
  ProcessResult,   // ← 一次进程运行的结果：status/exitCode/signal/base64 的 stdout/stderr/耗时/error。
  WorkflowCapabilityPolicy,   // ← 能力策略。
  WorkflowEvent,   // ← 一次能力调用的观测记录（capability/method/ok/耗时/error）。
} from "./types.js";
// ── ExecuteBuildWorkflowOptions：执行一次构建需要的全部输入 ───────────
// 【作用】executeBuildWorkflow 的唯一入参。
// 【参数】逐字段：
//   cwd —— 在哪个目录里构建。真实流水线里传的是 worktree 目录（baseline 或 candidate），
//          不是被重构工程的根目录；相对路径都相对它解析。
//   entry —— workflow 源码入口。自驱动构建【必填】；纯声明式可以不传。
//   output —— 声明式计划。自驱动为 null（产物要等函数跑起来才知道，见 build-workflow.ts 的注释）。
//   host / project —— 程序实测的事实，原样交给 broker：broker 用 host 解析"实测工具"
//          （policy.allowedTools 为空 = 所有实测工具都允许）。
//   policy —— 能力策略：可读/可写 glob、可执行 glob、工具白名单、最大进程数、
//          输出/文件字节上限。
//   timeoutMs —— 每个构建步骤的超时（毫秒！）。⚠️ configure 和 build 各拿一份【全额】
//          预算，所以最坏情况是 2×timeoutMs；pipeline 默认传 1_200_000（20 分钟）。
export interface ExecuteBuildWorkflowOptions {
  readonly cwd: string;
  /** Workflow source entry; required for workflow-driven builds. */
  readonly entry?: string;
  /** Declarative plan. May be null for workflow-driven builds (the function
   *  produces the output during execution). */
  readonly output: BuildWorkflowOutputValue | null;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
  readonly policy?: WorkflowCapabilityPolicy;
  readonly timeoutMs?: number;
}
// ── BuildWorkflowStepResult：一步构建的"体检单" ──────────────────────
// 【作用】记录一次进程调用的结果（configure 或 build），会原样进 artifact / 日志。
// 【字段】status —— 来自 ProcessResult 的五种状态（exited/timeout/output_limit/
//          spawn_error/stopped）之一，或宿主侧的 "error"（请求根本没成功）。
//          exitCode 为 null 表示进程没正常退出（超时/没 spawn 起来等）。
//          stdout/stderr —— 已经由 base64 解码成可读文本。
export interface BuildWorkflowStepResult {
  readonly name: "configure" | "build";
  readonly status: ProcessResult["status"] | "error";   // ← 语法点：`A["status"]` 是索引访问类型，取 ProcessResult 里 status 字段的类型（一个字符串联合）。
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error: string | null;
}

// ── BuildWorkflowExecution：一次构建执行的完整结论 ───────────────────
// 【作用】本文件的返回值。pipeline 只看两件事：status 是否 "pass"、failure 是什么。
// 【字段】artifact —— 成功时是计划里声明的产物描述；自驱动失败时是一个【占位】对象。
//   steps —— configure/build 的观测记录数组（declarative 最多 2 项；自驱动固定补 1 项）。
//   missingArtifacts —— 缺失产物清单，元素形如 "app: build/app.exe"。
//   events —— 本次执行产生的全部能力调用事件（观测/排错用）。
export interface BuildWorkflowExecution {
  readonly status: "pass" | "failed";
  readonly artifact: BuildArtifact;
  readonly steps: BuildWorkflowStepResult[];
  readonly missingArtifacts: string[];
  readonly events: WorkflowEvent[];
  readonly failure: string | null;
}

/** Execute a validated BuildWorkflow through the brokered process boundary. */
// ── executeBuildWorkflow：执行一次构建（本文件唯一导出的函数）─────────
// 【作用】按上面两种形态把项目真的编译出来，并验证产物存在。
// 【参数】options: ExecuteBuildWorkflowOptions（见上）。
// 【返回】Promise<BuildWorkflowExecution>。注意：它【从不抛错】——所有失败都编码在
//        返回值里（status/failure/missingArtifacts），让调用方决定要不要 abort。
// 【关系】runtime/workflow-pipeline.ts 在 baseline / candidate 两个 worktree 各调一次；
//        内部通过 broker（声明式）或 runWorkflow（自驱动）跨进程干活。
//
// 【路段】下面的 L… 都是【原文件】的行号（本注释版行数更多，对不上号）。
// 【路段①|L55-61 建 Broker + 准备两个收集容器】
// 【路段②|L63-69 决定 artifact 初值与 buildKind】
// 【路段③|L70-146 声明式分支：cmake / ninja / direct-compiler / workflow-driven 计划 / legacy 拒绝】
// 【路段④|L147-161 自驱动分支（output === null）：重新执行函数】
// 【路段⑤|L163-187 宿主侧产物存在性检查（missingArtifacts）】
// 【路段⑥|L188-190 finally：无论成败都关掉 Broker】
export async function executeBuildWorkflow(
  options: ExecuteBuildWorkflowOptions,
): Promise<BuildWorkflowExecution> {
  // 路段①：建一个能力代理。它自己不跑构建，只是"审批窗口"：后面每次进程调用都要
  // 过它的 policy（能跑什么工具、输出多大、多久超时）。workspaceRoot 用 cwd——
  // 也就是当前 worktree，所有相对路径与可写范围都以它为根。
  const broker = new LocalCapabilityBroker({
    workspaceRoot: options.cwd,
    host: options.host,
    policy: options.policy,
  });
  const steps: BuildWorkflowStepResult[] = [];   // ← 每一步的观测记录，最后原样带回。
  const events: WorkflowEvent[] = [];   // ← 每一次能力调用的事件（含耗时），是排错的主要线索。
  try {
    // workflow-driven: the function produces the output during execution.
    let artifact: BuildArtifact | null = null;   // ← 语法点：let = 可重新赋值；类型标注 `BuildArtifact | null` 表示"此刻还没有产物"。
    let buildKind = "custom";   // ← 记录构建形态，供最后 artifactCandidates() 判断要不要尝试 CMake 的多配置子目录。
    if (options.output !== null) {
      // 路段②③：声明式。计划里已经写好了"该怎么构建"，这里只是照着执行。
      artifact = options.output.artifact;   // ← 先假设产物就是计划声明的这份；如果后面失败，failed() 会用它。
      const build = options.output.environment.build;
      buildKind = "kind" in build ? build.kind : "custom";   // ← 语法点：`"kind" in build` 判断对象有没有 kind 字段（联合类型收窄），TS 由此知道 build.kind 可以安全访问。
      if ("kind" in build && build.kind === "cmake") {   // ← 分支 1：CMake。两步走：configure（生成构建系统）→ build（真正编译）。
        const configureArgs = ["-S", build.source_dir, "-B", build.build_dir];   // ← -S 源码目录、-B 构建目录（CMake ≥3.13 的写法）。
        if (build.generator !== null) configureArgs.push("-G", build.generator);   // ← 生成器（如 "Visual Studio 17 2022"）；null 就让 CMake 自己挑。
        configureArgs.push(...build.configure_flags);   // ← 展开运算符：把计划里的额外参数逐个追加。
        const configure = await runProcess(broker, "configure", {   // ← 走 broker 发起进程调用（即使宿主自己执行，也要过同一套 policy 与事件记录）。
          program: "cmake",
          args: configureArgs,
          cwd: ".",
          timeoutMs: options.timeoutMs,   // ← ⚠️ configure 拿【全额】timeoutMs。
        }, events);
        steps.push(configure.step);
        if (configure.result === null || !successful(configure.result)) {   // ← result 为 null = 请求本身失败（没拿到合法结果）；successful() 要求正常退出且退出码 0。
          return failed(options.output.artifact, steps, [], events, configure.step.error ?? "CMake configure failed");   // ← `??`：有具体错误就用，没有就用兜底文案。
        }

        const buildArgs = ["--build", build.build_dir, ...build.build_flags];   // ← 第二步：cmake --build <dir>（驱动已生成的构建系统）。
        if (build.target !== null) buildArgs.push("--target", build.target);   // ← 可选目标；注意 CMake 的 --target 一次只接受一个。
        const built = await runProcess(broker, "build", {
          program: "cmake",
          args: buildArgs,
          cwd: ".",
          timeoutMs: options.timeoutMs,   // ← ⚠️ build 又拿一份【全额】timeoutMs → 最坏 2×预算（任务清单 #8 点名的地方）。
        }, events);
        steps.push(built.step);
        if (built.result === null || !successful(built.result)) {
          return failed(options.output.artifact, steps, [], events, built.step.error ?? "CMake build failed");
        }
      } else if ("kind" in build && build.kind === "ninja") {   // ← 分支 2：Ninja，一条命令搞定。
        const args = ["-C", build.build_dir, ...build.build_flags];   // ← -C 切到构建目录。
        if (build.target !== null) args.push(build.target);
        const built = await runProcess(broker, "build", {
          program: "ninja",
          args,
          cwd: ".",
          timeoutMs: options.timeoutMs,
        }, events);
        steps.push(built.step);
        if (built.result === null || !successful(built.result)) {
          return failed(options.output.artifact, steps, [], events, built.step.error ?? "Ninja build failed");
        }
      } else if ("kind" in build && build.kind === "direct-compiler") {   // ← 分支 3：直接调编译器（无构建系统的最小工程）。
        const output = process.platform === "win32" && !build.output.toLowerCase().endsWith(".exe")   // ← Windows 上 gcc 不会自动补 .exe，这里替它补上。
          ? `${build.output}.exe`
          : build.output;
        const args = [
          ...build.flags,
          ...Object.entries(build.defines).map(([key, value]) => `-D${key}=${value}`),   // ← 语法点：Object.entries 把 {N:1} 变 [["N",1]]；解构参数 ([key, value]) 直接在箭头函数参数位置拆开。
          ...build.sources,
          "-o",
          output,
        ];
        const built = await runProcess(broker, "build", {
          program: build.compiler,   // ← 编译器名字来自实测 host（gcc/clang…），不是随便猜的。
          args,
          cwd: ".",
          timeoutMs: options.timeoutMs,
        }, events);
        steps.push(built.step);
        if (built.result === null || !successful(built.result)) {
          return failed(options.output.artifact, steps, [], events, built.step.error ?? "compiler build failed");
        }
      } else if ("kind" in build && build.kind === "workflow-driven") {   // ← 分支 4：计划声明自己是自驱动 → 重新执行函数（与 output===null 同一条路）。
        const driven = await runDrivenWorkflow(options, broker, steps, events);
        if ("error" in driven) {   // ← 语法点：`"error" in driven` 区分返回的两种形状（{artifact} 或 {error}）。
          return failed(
            { kind: "custom", version: 1, workflow_id: "", workflow_revision: 0, paths: {}, metadata: {} },   // ← ⚠️ 占位 artifact：自驱动没有可声明的产物表，这里塞一个"空壳"让返回类型成立。paths 为空，宿主侧的产物检查自然无事可做。
            steps,
            [],
            events,
            driven.error,
          );
        }
        artifact = driven.artifact;
        buildKind = "workflow-driven";
      } else {   // ← 分支 5：老式"shell 命令"形态已被淘汰，直接拒绝（fail-closed，不做隐式兼容）。
        return failed(options.output.artifact, steps, [], events, "legacy shell-command BuildWorkflow execution is not supported");
      }
    } else {
      // options.output === null: workflow-driven with no declarative plan.
      // 路段④：自驱动。resolve 阶段没有执行函数，这里才是它第一次（以及 baseline/candidate
      // 各一次）真正跑起来的地方。
      const driven = await runDrivenWorkflow(options, broker, steps, events);
      if ("error" in driven) {
        return failed(
          { kind: "custom", version: 1, workflow_id: "", workflow_revision: 0, paths: {}, metadata: {} },   // ← 同样的占位 artifact。注意 workflow_id 是空串——它其实过不了 BuildArtifact 的 z.string().min(1) 校验，这里没 parse 所以不炸，但别把它当成可入库的 artifact。
          steps,
          [],
          events,
          driven.error,
        );
      }
      artifact = driven.artifact;
      buildKind = "workflow-driven";
    }

    // 路段⑤：宿主侧的"产物到底在不在"检查。即使构建退出码是 0，也必须看到文件才算过。
    const output = artifact;
    const missingArtifacts: string[] = [];
    for (const [name, path] of Object.entries(output.paths)) {   // ← 遍历产物表：{app: "build/app.exe"} 这类。
      const candidates = artifactCandidates(path, buildKind);   // ← 同一个产物可能落在几个等价路径（.exe 后缀 / CMake 多配置子目录）。
      if (!candidates.some((candidate) => existsSync(join(options.cwd, candidate)))) {   // ← some：只要有一个候选路径存在就算在。全都不在 → 记为缺失。
        missingArtifacts.push(`${name}: ${path}`);
      }
    }
    if (missingArtifacts.length > 0) {   // ← fail-closed 的关键一步：编译"成功"但产物不在 = 失败。
      return failed(
        output,
        steps,
        missingArtifacts,
        events,
        `build completed but artifacts are missing: ${missingArtifacts.join(", ")}`,
      );
    }
    return {
      status: "pass",
      artifact: output,
      steps,
      missingArtifacts,
      events,
      failure: null,
    };
  } finally {
    await broker.close();   // ← 路段⑥：finally 保证失败/成功都会关掉 broker（清理它管理的子进程等资源）。
  }
}

/**
 * Re-run a workflow-driven workflow function: it drives the build through
 * injected capabilities (process/fs/validator) and returns void. Artifact
 * existence is asserted by the workflow itself via ctx.validator; no static
 * artifact manifest is needed (the old BuildWorkflowOutput return is gone).
 */
// ── runDrivenWorkflow：把 workflow 函数真正跑起来（自驱动路径）────────
// 【作用】spawn 一个 bun 子进程执行 workflow 源码；函数用注入的能力自己驱动构建，
//        返回 void。产物是否存在由函数内部的 ctx.validator.assertFile 断言，
//        宿主不再要求它返回一张静态产物表。
// 【参数】options（原样透传）、broker（本函数其实不直接用它——能力请求由 runner 里
//        的 broker 应答）、steps / events（两个收集容器，往里追加观测记录）。
// 【返回】Promise<{artifact} | {error}> —— 语法点：可辨识联合。调用方用
//        `"error" in driven` 区分。
// 【关系】executeBuildWorkflow 的两个分支调它；内部调 runner.ts 的 runWorkflow
//        （spawn worker）。⚠️ 超时默认 60_000（runWorkflow 的 timeoutMs 是必填，
//        调用方没传就取这个兜底）；整个函数【只拿一份】预算，配置/编译/断言都在里面。
async function runDrivenWorkflow(
  options: ExecuteBuildWorkflowOptions,
  broker: LocalCapabilityBroker,
  steps: BuildWorkflowStepResult[],
  events: WorkflowEvent[],
): Promise<{ readonly artifact: BuildArtifact } | { readonly error: string }> {
  if (options.entry === undefined) return { error: "workflow-driven build requires the workflow entry" };   // ← 没有源码就没法自驱动，直接失败。
  const driven = await runWorkflow({
    entry: options.entry,
    cwd: options.cwd,
    facts: { host: options.host, project: options.project },   // ← 实测事实注入给函数（context.facts.host / context.facts.project）。
    policy: options.policy,
    timeoutMs: options.timeoutMs ?? 60_000,   // ← `??` 兜底 60 秒：worker 侧单次能力调用的默认超时在 capabilities.ts 里，而整个 workflow 的墙钟上限在这里定。
  });
  events.push(...driven.events);   // ← 把 worker 里发生的全部能力事件搬回宿主的 events 数组。
  if (driven.status !== "pass") {   // ← 函数 throw（比如 assertFile 断言失败）、退出码非 0、超时，都会落到这里。
    return { error: driven.failure ?? "workflow-driven build failed" };
  }
  // workflow-driven: no BuildWorkflowOutput return is required anymore.
  // Artifact existence was asserted in-band by ctx.validator; a successful
  // run means the workflow's assertions (if any) passed.
  steps.push({   // ← 自驱动没有天然的"步骤"概念，这里补一条汇总记录，让 artifact 里的 steps 不为空、Dashboard 有东西可显示。
    name: "build",
    status: "exited",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
    error: null,
  });
  return { artifact: { kind: "custom", version: 1, workflow_id: "", workflow_revision: 0, paths: {}, metadata: {} } };   // ← ⚠️ 占位：paths 故意为空。因为 paths 为空，executeBuildWorkflow 路段⑤的 existsSync 循环什么也不会检查——产物校验完全由函数内部的 ctx.validator.assertFile 承担。
}

// ── runProcess：通过 broker 发起一次进程调用，并整理成"步骤记录"──────
// 【作用】把一次进程调用包装成 CapabilityRequest，交给 broker 执行；无论成败都
//        产出一条 BuildWorkflowStepResult。
// 【参数】name —— "configure" 或 "build"（只是个标签）；spec —— 程序名/参数/工作目录/超时；
//        events —— 事件数组（应答里带的事件会被 push 进去）。
// 【返回】{result, step}：result 为 null 表示没拿到合法结果（此时 step.status = "error"）。
// 【细节】请求 id 形如 build:configure:3 —— 用 events.length + 1 保证同一次执行内唯一，
//        方便在事件流里对上"哪条应答对应哪条请求"。
async function runProcess(
  broker: LocalCapabilityBroker,
  name: "configure" | "build",
  spec: { readonly program: string; readonly args: readonly string[]; readonly cwd: string; readonly timeoutMs?: number },
  events: WorkflowEvent[],
): Promise<{ readonly result: ProcessResult | null; readonly step: BuildWorkflowStepResult }> {
  const request: CapabilityRequest = {
    type: "capability-request",
    id: `build:${name}:${String(events.length + 1)}`,
    capability: "process",   // ← 要用的是"进程"能力。
    method: "run",   // ← 具体动作：同步跑完再回（区别于 start/wait/stop）。
    args: [spec],
  };
  const response: CapabilityResponse = await broker.handle(request);   // ← 真正执行点：policy 校验、spawn、输出截断、超时都发生在 broker 内部。
  events.push(response.event);   // ← 事件先记下来（无论成败）。
  if (!response.ok || !isProcessResult(response.value)) {   // ← isProcessResult 是手工写的"形状检查"（这里没走 Zod）。
    const error = response.error ?? `invalid process result for ${name}`;
    return {
      result: null,
      step: {
        name,
        status: "error",   // ← 宿主侧专属状态：不是进程的错，是"根本没拿到结果"。
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: response.event.durationMs,
        error,
      },
    };
  }
  const result = response.value;
  return {
    result,
    step: {
      name,
      status: result.status,
      exitCode: result.exitCode,
      stdout: decode(result.stdoutBase64),   // ← 协议里输出是 base64（避免 JSON 转义/二进制问题），展示前解码。
      stderr: decode(result.stderrBase64),
      durationMs: result.durationMs,
      error: result.error,
    },
  };
}

// ── successful：一步算不算成功 ──────────────────────────────────────
// 【作用】唯一标准：进程正常退出（status === "exited"）且退出码为 0。
//        超时、输出超限、spawn 失败、被停止，统统不算成功（fail-closed）。
function successful(result: ProcessResult): boolean {
  return result.status === "exited" && result.exitCode === 0;
}

// ── failed：把一次失败整理成统一形状 ─────────────────────────────────
// 【作用】所有失败路径都调它，保证返回值结构一致（status:"failed" + 原因）。
// 【参数】artifact —— 失败时也带回当前已知的产物描述（自驱动时是占位对象）。
function failed(
  artifact: BuildArtifact,
  steps: BuildWorkflowStepResult[],
  missingArtifacts: string[],
  events: WorkflowEvent[],
  failure: string,
): BuildWorkflowExecution {
  return {
    status: "failed",
    artifact,
    steps,
    missingArtifacts,
    events,
    failure,
  };
}

// ── artifactCandidates：同一个产物可能在哪几个路径上 ─────────────────
// 【作用】产物路径声明写的是"逻辑路径"，实际文件可能带 .exe 后缀、或落在 CMake
//        多配置生成器的子目录里。这里列出所有等价候选，逐个 existsSync。
// 【返回】string[]（去重后）。语法点：new Set([...]) 天然去重，[...set] 再转回数组。
// 【细节】buildKind === "cmake" 时追加 <配置>/<文件> 候选：Visual Studio 这类多配置
//        生成器会把产物放进 Debug/Release/RelWithDebInfo/MinSizeRel 子目录——
//        这正是 libuv 声明 build/uv_run_tests 而实际产物在 build/Debug/uv_run_tests.exe
//        也能通过检查的原因。
function artifactCandidates(path: string, buildKind: string): string[] {
  const candidates = new Set([path]);
  if (process.platform === "win32" && !path.toLowerCase().endsWith(".exe")) candidates.add(`${path}.exe`);   // ← Windows：可执行文件通常带 .exe。
  if (buildKind === "cmake") {
    const slash = path.lastIndexOf("/");   // ← 拆出"目录"和"文件名"两部分。
    const parent = slash < 0 ? "." : path.slice(0, slash);
    const file = slash < 0 ? path : path.slice(slash + 1);
    for (const configuration of ["Debug", "Release", "RelWithDebInfo", "MinSizeRel"]) {
      const candidate = parent === "." ? `${configuration}/${file}` : `${parent}/${configuration}/${file}`;
      candidates.add(candidate);
      if (process.platform === "win32") candidates.add(`${candidate}.exe`);
    }
  }
  return [...candidates];
}

// ── isProcessResult：手工的"类型谓词" ───────────────────────────────
// 【作用】broker 返回的 value 类型是 unknown（协议上来的 JSON，什么都可能是）。
//        这个函数逐字段确认形状；返回 true 时 TS 就把 value 当成 ProcessResult 用。
// 【语法】`value is ProcessResult` 叫类型谓词（type predicate）：返回 true 的分支里，
//        编译器自动把参数类型收窄成 ProcessResult。这是不引入 Zod 时的轻量校验写法。
function isProcessResult(value: unknown): value is ProcessResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;   // ← `as` 断言：告诉编译器"按这个形状看"，不做运行时检查（检查就在下面几行）。
  return (record.status === "exited" || record.status === "timeout" || record.status === "output_limit" || record.status === "spawn_error" || record.status === "stopped") &&
    (record.exitCode === null || typeof record.exitCode === "number") &&
    (record.signal === null || typeof record.signal === "string") &&
    typeof record.stdoutBase64 === "string" &&
    typeof record.stderrBase64 === "string" &&
    typeof record.durationMs === "number" &&
    (record.error === null || typeof record.error === "string");
}

// ── decode：base64 → UTF-8 文本 ─────────────────────────────────────
// 【作用】能力协议里进程输出统一用 base64 传输（JSON 安全、不会被转义/截断搞坏），
//        展示前还原成可读文本。
function decode(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}
