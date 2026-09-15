/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/curator.ts —— "策展人"：把本次运行现写的 build 收进永久库
 *
 * 【这个文件是干什么的】
 *   声明制流程里，build-writer 这次现写的 build workflow 叫 **run-local**：源文件躺在
 *   runs/<sessionId>/workflows/build/<id>.ts，id 也带着会话尾巴（如 trim-build-sess-abc123）。
 *   它能用，但只属于这一次运行。等整次运行**验证通过（状态机 ACCEPTED）**之后，宿主会调
 *   本文件把这样的 build "转正"：复制进 .refactorsa/build-workflows/<稳定id>/r1/ 这个永久库，
 *   同时往 alias 表里记一条 "run-local id → 库 id"。下次别的会话再想用，直接按库 id 复用即可。
 *   为什么放在 ACCEPTED 之后？因为那时 build 已经被真实执行验证过了，转正才安全——
 *   策展人只收"被证明能用"的东西。
 *   两条铁律：① 稳定 id 由 curator 决定（去掉会话尾巴）；② 绝不改写 run-local 源文件
 *   （库里那份才是以后复用的权威副本）。
 *
 * 【在整个项目里的位置】
 *   上游：src/runtime/workflow-agent-pipeline.ts 的 promoteRunLocalBuilds()——run 结束且
 *         ACCEPTED 后，遍历声明集里 run_local 的 build，跳过已转正的，逐个调 curateBuildWorkflow。
 *   下游：src/workflow/build-workflow.ts 的 resolveBuildWorkflow（重新解析一遍、生成 manifest）、
 *         src/workflow/registry.ts 的 saveBuildWorkflow（真正把源文件+manifest 写进库）。
 *   产出：库条目 + alias 表（.refactorsa/build-workflow-aliases.json）。
 *   读取方：aliasLibraryId / loadAliases 被 pipeline 与查询逻辑用来"拿旧 id 找到库条目"。
 *
 * 【先修知识】
 *   · src/workflow/registry.ts —— 库的目录结构（<id>/r<revision>/workflow.ts + manifest.json）；
 *   · src/agents/dep-registry.ts —— run-local id 怎么生成（<slug>-<会话短 id>）；
 *   · Node 的 fs 同步 API（existsSync/readFileSync/writeFileSync/mkdirSync）。
 *
 * 【本文件是教程注释版】
 *   原文件：src/workflow/curator.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← Node 文件系统同步 API：existsSync 判存在、mkdirSync 建目录、readFileSync 读、writeFileSync 覆盖写
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// ← join 拼路径（自动处理分隔符）；resolve 把相对路径变成绝对路径
import { join, resolve } from "node:path";
// ← 只导入类型：宿主环境探测 / 项目识别结果，仅用于填 manifest 的 applies_to
import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";
// ← 解析 build workflow 源文件（校验 + 生成 manifest），是"入库前的最后一道检查"
import { resolveBuildWorkflow } from "./build-workflow.js";
// ← 真正写库的函数：把源文件和 manifest 落到 .refactorsa/build-workflows/<id>/r<rev>/
import { saveBuildWorkflow } from "./registry.js";

/**
 * curator — promotes run-local build workflows to the persisted library after
 * a successful run, recording an alias from the run-local id to the stable
 * library id so future sessions can resolve either.
 *
 * Runs AFTER the host verified (ACCEPTED): the build workflow demonstrably
 * worked, so promoting it is safe. The curator decides stable ids; it never
 * rewrites the run-local source (the library copy is authoritative for reuse).
 */

// ── CuratorOptions：curateBuildWorkflow 的入参 ───────────────────────
// 【字段】repoRoot    仓库根（.refactorsa 库就在它下面）
//         entry       run-local 源文件的绝对路径（本次运行现写的那份）
//         runLocalId  本次运行中声明的 id（带会话尾巴，如 ghost-s1）
//         libraryId   可选：调用方可以直接指定库 id；不给就从源文件推导（见 stableIdFromSource）
//         description 这个 build 产出什么（会写进库 manifest，AI 之后 inspectWorkflow 能看到）
// 【语法】readonly + 可选字段（?）——老规矩：字段只读、可缺省
export interface CuratorOptions {
  /** Repo root (contains .refactorsa library). */
  readonly repoRoot: string;
  /** Run-local workflow source entry (absolute). */
  readonly entry: string;
  /** Run-local id (as declared during the run). */
  readonly runLocalId: string;
  /** Optional stable library id; derived from the source when omitted. */
  readonly libraryId?: string;
  /** Description of what this build produces; persisted in the library manifest. */
  readonly description?: string;
  readonly host?: HostPreflight;
  readonly project?: ProjectDetection;
}

// ── CurateResult：一次"转正"的结果报告 ──────────────────────────────
// 【字段】libraryId 最终用的库 id（即使失败也会返回推导出来的那个）
//         revision 入库后的版本号；失败时是 0
//         aliasFile alias 表的（相对）路径，方便调用方打印/展示
//         promoted true = 真的入库了；false = 没入库（reason 里说明为什么）
//         reason   人话结论，直接进 e2e 报告
export interface CurateResult {
  readonly libraryId: string;
  readonly revision: number;
  readonly aliasFile: string;
  readonly promoted: boolean;
  readonly reason: string;
}

/** Alias file lives at the repo root, next to the registry dir. */
// ← alias 表路径：.refactorsa/build-workflow-aliases.json（和库目录 .refactorsa/ 并排放）
//   join 只拼出相对路径，调用方用时要自己接上 repoRoot
const ALIAS_FILE = join(".refactorsa", "build-workflow-aliases.json");

// ── AliasMap：alias 表文件的 JSON 形状 ──────────────────────────────
// 【作用】就一个字段 aliases：key 是 run-local id，value 是库 id
interface AliasMap {
  /** run-local id → stable library id */
  readonly aliases: Record<string, string>;
}

// ── loadAliases：读 alias 表（读不到就当空表）────────────────────────
// 【参数】repoRoot 仓库根
// 【返回】AliasMap；文件不存在/损坏时返回 { aliases: {} }——读侧 fail-open 是安全的，
//         因为"没有别名"顶多意味着找不到旧 id，不会导致错误数据
// 【语法】JSON.parse(...) as Partial<AliasMap> —— as 是"类型断言"：告诉编译器"按这个形状用"；
//         Partial 表示字段可缺省；?? 是空值合并：左边是 null/undefined 才取右边；
//         try {…} catch {…} 不写 catch 参数 = 把错误直接扔掉（这里就是要这个效果）
export function loadAliases(repoRoot: string): AliasMap {
  const path = join(resolve(repoRoot), ALIAS_FILE);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AliasMap>;
    return { aliases: parsed.aliases ?? {} };
  } catch {
    return { aliases: {} };
  }
}

// ── aliasLibraryId：拿 run-local id 查库 id ─────────────────────────
// 【返回】库 id；查不到返回 null（调用方据此判断"还没转正过"）
// 【关系】workflow-agent-pipeline.promoteRunLocalBuilds 用它跳过已转正的 build
export function aliasLibraryId(repoRoot: string, runLocalId: string): string | null {
  return loadAliases(repoRoot).aliases[runLocalId] ?? null;
}

// ── saveAlias：往 alias 表里加一条 ──────────────────────────────────
// 【作用】读旧表 → 加一条 → 整体重写。⚠️ 这是"读-改-写"三步，不是原子操作；
//         但本项目的写入口只有 run 结束后的单线程 curator，所以实际不会打架
// 【细节】mkdirSync(recursive: true) 保证 .refactorsa 目录存在（第一次转正时它可能还没有）；
//         JSON.stringify(map, null, 2) 缩进 2 空格，人能直接读；末尾再补一个换行符
export function saveAlias(repoRoot: string, runLocalId: string, libraryId: string): void {
  const root = resolve(repoRoot);
  const map = loadAliases(root);
  map.aliases[runLocalId] = libraryId;
  const dir = join(root, ".refactorsa");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, ALIAS_FILE),
    JSON.stringify({ aliases: map.aliases }, null, 2) + "\n",
    "utf8",
  );
}

/** Derive a stable library id from a workflow source's own manifest id. */

// ── stableIdFromSource：从 run-local id 推导稳定库 id ────────────────
// 【作用】去掉尾巴：trim-build-sess-abc123 → trim-build。这样"每次运行都生成一份"的同一个 build
//         会收敛到同一个库 id，转正才有幂等性（第二次直接命中已存在的库条目）
// 【语法】/-[A-Za-z0-9]+$/ 是正则：末尾一个"连字符 + 字母数字串"；replace 把它替换成空串
//         ⚠️ 它只是"按形状猜"，不校验那段尾巴是不是真的是会话 id——所以想自定义名字时，
//         应该显式传 CuratorOptions.libraryId
function stableIdFromSource(runLocalId: string): string {
  // Run-local ids look like "<slug>-<session>"; strip the session suffix.
  return runLocalId.replace(/-[A-Za-z0-9]+$/, "");
}

/**
 * Promote one run-local build workflow into the library. Idempotent: if the
 * derived library id already exists with identical source, only the alias is
 * added.
 */

// ── curateBuildWorkflow：把一个 run-local build 转正入库（本文件主函数）────
// 【作用】① 算出库 id；② run-local 源文件不存在就直接放弃（promoted: false）；
//         ③ 用库 id 重新解析一遍源文件（相当于做一次完整校验 + 生成"以库身份"的 manifest）；
//         ④ saveBuildWorkflow 写库；⑤ saveAlias 记别名。
// 【幂等】第二次转正同一个 build 时，saveBuildWorkflow 发现目标 revision 目录已存在且
//         source_hash 相同 → 直接返回已存条目，不重复写；alias 也是重复写同一个值。结果一致。
// 【参数】options —— 见 CuratorOptions
// 【返回】Promise<CurateResult>；async 是因为 resolveBuildWorkflow 内部可能要跑子进程
// 【关系】上游 workflow-agent-pipeline.promoteRunLocalBuilds（在 ACCEPTED 之后逐个调用，
//         调用方自己 catch 异常并记 warn——转正失败不会让整次运行失败）
export async function curateBuildWorkflow(
  options: CuratorOptions,
): Promise<CurateResult> {
  // ← 把仓库根规范化成绝对路径，后面所有拼路径都以它为基准
  const repoRoot = resolve(options.repoRoot);
  // ← ?? 空值合并：显式给了 libraryId 就用它，否则从 run-local id 里去掉会话尾巴
  const libraryId = options.libraryId ?? stableIdFromSource(options.runLocalId);

  // ← 源文件都不在了（被清理/归档掉了），没法入库：报告失败但不抛错，让调用方继续处理下一个
  if (!existsSync(options.entry)) {
    return { libraryId, revision: 0, aliasFile: ALIAS_FILE, promoted: false, reason: "run-local source missing" };
  }

  // ← 用"库 id"重新解析一遍：既校验了源码（source-policy），又拿到一份
  //   id/revision = <libraryId>/1 的 manifest——库里存的身份从此就是稳定 id
  const resolution = await resolveBuildWorkflow({
    entry: options.entry,
    workflowId: libraryId,
    revision: 1,
    cwd: repoRoot,
    entryRoot: repoRoot,
    workspaceRoot: repoRoot,
    host: options.host,
    project: options.project,
  });

  // ← 真正写库（源文件 + manifest.json）；已存在且内容相同 → 返回已存条目（幂等的关键）
  const stored = saveBuildWorkflow(repoRoot, resolution, options.description ?? "");
  // ← 最后记别名：以后拿 run-local id 也能查到这份库条目
  saveAlias(repoRoot, options.runLocalId, libraryId);
  return {
    libraryId,
    revision: stored.manifest.revision,
    aliasFile: ALIAS_FILE,
    promoted: true,
    reason: `run-local '${options.runLocalId}' promoted as '${libraryId}'`,
  };
}
