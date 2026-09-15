/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/registry.ts —— BuildWorkflow 的持久化注册表
 *
 * 【这个文件是干什么的】
 *   把解析好的 BuildWorkflow（源码 + 登记信息 + 构建计划）存到磁盘上，
 *   下次再遇到同一个项目时直接取回来复用，**不用再让 Claude 现场生成一遍**。
 *   它只做三件事：save（存）、load（取，带防篡改校验）、discover（把磁盘上
 *   有的全部列出来，并逐个判断"现在这台机器能不能用"）。
 *
 * 【磁盘布局】（背下来这张图，本文件的每个函数都在操作它）
 *   <repoRoot>/.refactorsa/build-workflows/<workflow-id>/r<revision>/
 *       ├── workflow.ts                    ← 源码原件（后缀随原文件）
 *       ├── manifest.json                  ← 登记信息（含 source_hash、applies_to）
 *       └── build-workflow-output.json     ← 构建计划（⚠️ 自驱动没有这个文件）
 *   🔗 test-registry.ts 是它的"测试侧镜像"，布局是
 *      .refactorsa/test-workflows/<id>/r<N>/{workflow.ts, manifest.json, test-workflow.json}。
 *      两个文件结构高度相似（save/load/discover/classify 一一对应），本文件把
 *      公共概念讲透，读 test-registry.ts 时只需注意三处差异（见那个文件的头注释）。
 *
 * 【在整个项目里的位置】
 *   上游（谁调用它）：只有 src/workflow/resolve-workflows.ts ——
 *     · saveBuildWorkflow(:205)：生成/选定之后立刻入库（幂等）；
 *     · discoverBuildWorkflows(:231)：列出所有候选给 Chooser 挑；
 *     · loadBuildWorkflow(:309)：选中之后取出持久化数据（复用路径不重跑模型）。
 *   下游（它调用谁）：checkWorkflowSource（source-policy.ts，重验源码）；
 *     产出的候选列表供 chooser.ts 决策。
 *   与 build-workflow.ts 的关系：本文件消费它的返回值 BuildWorkflowResolution，
 *     自己**不执行**任何 workflow（只读源码、算指纹、不 spawn 子进程）。
 *
 * 【先修知识】
 *   · src/artifacts/build-workflow.ts 的 BuildWorkflowManifest / BuildWorkflowOutput；
 *   · build-workflow.ts（resolution 是从哪来的）；
 *   · 《零基础看懂教程.md》§1.5 "注册表（.refactorsa/）"。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/registry.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 【语法】node:crypto 的 createHash —— 算 sha256 指纹（详见 build-workflow.ts）。
import { createHash } from "node:crypto";
// 【语法】node:fs 的同步文件 API，本文件全程用同步版本（函数都是普通函数，
//   不是 async）：existsSync 判存在 / mkdirSync 建目录（recursive: true 表示
//   一层层建）/ readdirSync 列目录 / readFileSync 读文件 / renameSync 改名 /
//   writeFileSync 写文件。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
// 【语法】node:path：dirname 取目录部分，extname 取扩展名（含点），join 拼路径。
//   其余（isAbsolute/normalize/relative/resolve/sep）见 build-workflow.ts。
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
// 【语法】又是"同一个名字引入两次"的写法：不带 type 的是 Zod Schema（拿来
//   .parse），带 type as 的是它的 TS 类型（拿来标注变量）。详见 build-workflow.ts
//   顶部的详细解释。
import {
  BuildWorkflowManifest,
  BuildWorkflowOutput,
  type BuildWorkflowManifest as BuildWorkflowManifestValue,
  type BuildWorkflowOutput as BuildWorkflowOutputValue,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import { checkWorkflowSource } from "./source-policy.js";
import type { BuildWorkflowResolution } from "./build-workflow.js";

// 目录常量：注册表根目录名、BuildWorkflow 子目录名。
// ⚠️ 容易混的两个目录：`.refactorsa/`（这里，跨会话复用的 workflow 注册表）
//    和 `.refactor/sessions/`（一次会话的状态机产物）是两套东西。
const REGISTRY_DIR = ".refactorsa";
const BUILD_WORKFLOWS_DIR = "build-workflows";
// workflow 源码的 API 版本号。manifest 里存了一份，加载时比对，
//   版本对不上 = 这份 workflow 是老格式写的 = 判 incompatible。
const CURRENT_WORKFLOW_API_VERSION = 1;

// ── BuildWorkflowCandidateStatus：候选的五态状态机 ─────────────────────
// 【作用】discover 出来的每一条候选都会被打上一个状态标签，Chooser 只挑
//   合用的。五种状态的判定顺序（见 classifyCandidate）：
//     invalid      —— 那个 revision 目录里连 manifest.json 都没有（结构性残缺）；
//     stale        —— 有 manifest 但读不过来：源码被沙箱检查拒了、指纹对不上
//                     （被改过）、Schema 不合法、身份对不上……任何 throw 都算；
//     incompatible —— 能读，但 applies_to 和当前主机/项目对不上（平台、架构、
//                     缺工具、构建系统不同、marker 缺失）；
//     draft        —— 都匹配，但 status 还是 "draft"（⚠️ 目前所有入库的都是
//                     draft，本项目还没有晋级成 verified 的机制）；
//     valid        —— 都匹配且 status === "verified"。
// 【语法】type X = "a" | "b" | ... —— 字符串字面量联合类型，比裸 string 安全。
export type BuildWorkflowCandidateStatus =
  | "valid"
  | "draft"
  | "incompatible"
  | "stale"
  | "invalid";

// ── StoredBuildWorkflow：从磁盘读回来的完整一份 ────────────────────────
export interface StoredBuildWorkflow {
  // manifest.json 的绝对路径。
  manifestPath: string;
  // build-workflow-output.json 的绝对路径；⚠️ 自驱动 workflow 没有这个文件，
  //   所以是 null（这时想拿计划必须重新执行 workflow）。
  outputPath: string | null;
  // 源码的绝对路径。
  entry: string;
  // 已过 Zod 校验的 manifest。
  manifest: BuildWorkflowManifestValue;
  // 已过 Zod 校验的构建计划；自驱动 = null。
  output: BuildWorkflowOutputValue | null;
}

// ── BuildWorkflowCandidate：discover 列表里的一项 ──────────────────────
// 【细节】manifest / entry 允许是 null —— 因为一条候选可能残缺到连 manifest
//   都读不出来（invalid），这时只能报告路径和原因。
export interface BuildWorkflowCandidate {
  manifestPath: string;
  entry: string | null;
  manifest: BuildWorkflowManifestValue | null;
  status: BuildWorkflowCandidateStatus;
  // 人读的原因列表（incompatible / stale / invalid 时非空，valid/draft 为空）。
  reasons: string[];
}

/** 存一份 BuildWorkflow 进注册表（幂等）。 */
// ── saveBuildWorkflow：入库（幂等）────────────────────────────────────
// 【作用】把 resolution 里的源码、manifest、构建计划写到上面的磁盘布局里。
// 【幂等】同一个 id@revision 再存一次：
//     · 源码指纹相同 → 认为是同一份，直接返回已存的那份（不报错）；
//     · 源码指纹不同 → **抛错**。这是刻意的：同一个版本号对应两种源码是
//       不可接受的（复用时到底跑哪份？），宁可让人手动升 revision。
// 【参数】repoRoot：注册表挂在哪（通常是 workspace 根）；resolution：
//   build-workflow.ts 的 resolveBuildWorkflow 返回值。
// 【语法】函数没有 async、没有 return 类型注解 —— TS 会自动推断出
//   StoredBuildWorkflow（因为有明确的 return 语句）。
export function saveBuildWorkflow(
  repoRoot: string,
  resolution: BuildWorkflowResolution,
  description = "",   // ★ B 方案新增：入库时可带人读描述（来自 generateBuildWorkflow 的 name/description）
): StoredBuildWorkflow {
  const root = resolve(repoRoot);
  // 第 1 步：重新读一遍源码。⚠️ 不直接用 resolution.sourceHash —— 因为要
  //   防的是"resolution 生成之后源码又被改了"这种窗口，所以此刻重新读文件
  //   重新算指纹，才是当前真实状态。
  // 【细节】`relative(root, resolution.entry)` 先把路径变成相对 root 的形式，
  //   再交给 resolveInside 确认没逃出 root（如果在别的盘/根目录之外，
  //   relative 会给出 .. 开头的路径，resolveInside 直接抛错）。
  const sourceEntry = resolveInside(root, relative(root, resolution.entry), "workflow source");
  const source = readFileSync(sourceEntry, "utf8");
  // 第 2 步：源码文件后缀（默认 .ts，详见 workflowExtension）。
  const extension = workflowExtension(sourceEntry);
  // 第 3 步：拼出目标目录 <root>/.refactorsa/build-workflows/<id>/r<rev>/。
  //   【语法】模板字符串 + String(number) 把数字版本号拼进 "r1" 这种目录名。
  const workflowDir = join(
    root,
    REGISTRY_DIR,
    BUILD_WORKFLOWS_DIR,
    resolution.manifest.id,
    `r${String(resolution.manifest.revision)}`,
  );
  const entry = join(workflowDir, `workflow${extension}`);
  const manifestPath = join(workflowDir, "manifest.json");
  const outputPath = join(workflowDir, "build-workflow-output.json");
  // 第 4 步：幂等判断 —— 目录已经存在说明这个 revision 存过了。
  if (existsSync(workflowDir)) {
    // 残缺目录（有目录没 manifest）直接报错，不静默覆盖。
    if (!existsSync(manifestPath)) {
      throw new Error(`workflow revision directory is incomplete: ${workflowDir}`);
    }
    // 读出已存的那份，比对源码指纹。
    const existing = loadBuildWorkflow(manifestPath, root);
    if (existing.manifest.source_hash !== sha256(source)) {
      // 同版本号、不同源码 → 拒绝（fail-closed）。
      throw new Error(
        `workflow revision already exists with different source: ${resolution.manifest.id}@${String(resolution.manifest.revision)}`,
      );
    }
    // 完全一样 → 幂等返回，什么都不写。
    return existing;
  }

  // 第 5 步：真正写入。顺序是 源码 → manifest → output，全部用原子写。
  mkdirSync(workflowDir, { recursive: true });
  atomicWrite(entry, source);
  // 【语法】`...resolution.manifest` 是对象展开：把原 manifest 的所有字段抄一份，
  //   然后覆盖 entry（改成注册表内的相对路径）和 source_hash（按刚读到的源码算）。
  //   重新 .parse 一遍既校验了结果，也把缺失字段补上默认值。
  const storedManifest = BuildWorkflowManifest.parse({
    ...resolution.manifest,
    entry: relative(root, entry).split(sep).join("/"),
    source_hash: sha256(source),
    description: description.length > 0 ? description : resolution.manifest.description,   // ★ B 方案新增：描述优先取显式入参，否则沿用 manifest 里已存的
  });
  // 【细节】JSON.stringify(x, null, 2) 带 2 空格缩进（人能 diff）+ 末尾换行
  //   （符合 POSIX 文本文件习惯）。
  atomicWrite(manifestPath, JSON.stringify(storedManifest, null, 2) + "\n");
  if (resolution.output === null) {
    // workflow-driven workflows have no static plan; nothing to persist.
    // ← 自驱动没有静态计划，自然也没有 output 文件可存。
    //   ⚠️ 这意味着复用自驱动 workflow 时拿不到计划，resolve-workflows.ts
    //   只能重新 resolve 一遍源码（重验身份），产物仍要等执行才知道。
    return { manifestPath, outputPath: null, entry, manifest: storedManifest, output: null };
  }
  // 声明式：把构建计划也存一份。入库前再 .parse 一遍（防御性校验）。
  const output = BuildWorkflowOutput.parse(resolution.output);
  atomicWrite(outputPath, JSON.stringify(output, null, 2) + "\n");
  return { manifestPath, outputPath, entry, manifest: storedManifest, output };
}

/** Load and verify one persisted workflow manifest and its source hash. */
// ── loadBuildWorkflow：取一份（带防篡改校验）──────────────────────────
// 【作用】读 manifest → 找到源码 → 沙箱检查 → 重算 sha256 与登记值比对 →
//   读（如果有的话）构建计划 → 交叉校验身份 → 返回完整一份。
// 【为什么必须重验指纹】manifest.json 是磁盘上的普通文件，谁都能改；源码也是。
//   只比对"manifest 里写的 hash"毫无意义（攻击者把两个都改了即可）。这里的
//   校验保证的是：**manifest 与源码当前内容一致** —— 中途被人改过源码的话，
//   加载就会失败，绝不带着未知代码往下走（fail-closed）。
// 【关系】saveBuildWorkflow（幂等检查）和 classifyCandidate（遍历注册表）都调它；
//   resolve-workflows.ts 的复用路径也直接调它。
export function loadBuildWorkflow(
  manifestPath: string,
  repoRoot: string,
): StoredBuildWorkflow {
  const root = resolve(repoRoot);
  const absoluteManifest = resolve(manifestPath);
  // 读 + 校验 manifest 结构。
  const manifest = BuildWorkflowManifest.parse(
    JSON.parse(readFileSync(absoluteManifest, "utf8")),
  );
  // manifest.entry 是相对 repoRoot 的路径，确认它没逃出去。
  const entry = resolveInside(root, manifest.entry, "workflow entry");
  // 沙箱源码检查：即使源码入库时是干净的，也要防止它后来被改成会 import
  //   node:fs 的版本——这一步在执行前再拦一次。
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) throw new Error(checked.reason ?? `workflow source rejected: ${entry}`);
  const actualHash = sha256(checked.source);
  if (actualHash !== manifest.source_hash) {
    throw new Error(
      `workflow source hash mismatch: expected ${manifest.source_hash}, got ${actualHash}`,
    );
  }

  // 构建计划和 manifest 同目录；不存在（自驱动）就是 null。
  const outputPath = join(dirname(absoluteManifest), "build-workflow-output.json");
  // 【语法】三元表达式：文件存在就 parse，否则 null。
  const output = existsSync(outputPath)
    ? BuildWorkflowOutput.parse(JSON.parse(readFileSync(outputPath, "utf8")))
    : null;
  // 交叉校验：计划里申报的身份必须和 manifest 一致（防止文件之间错配）。
  if (output !== null && (
    output.workflow_id !== manifest.id || output.workflow_revision !== manifest.revision
  )) {
    throw new Error("persisted BuildWorkflow output does not match its manifest");
  }
  return {
    manifestPath: absoluteManifest,
    outputPath: output === null ? null : outputPath,
    entry,
    manifest,
    output,
  };
}

/** Find persisted workflows and classify deterministic reuse conditions. */
// ── discoverBuildWorkflows：遍历注册表，逐条分类 ───────────────────────
// 【作用】把 <root>/.refactorsa/build-workflows/ 下所有 id 目录、所有 r<N> 目录
//   都列出来，每一条给出状态和原因。Chooser 拿这份列表去挑可复用的。
// 【参数】host / project 都可选：不传就不做环境匹配（只判结构性/完整性问题）。
// 【返回】按 manifestPath 字典序排好（localeCompare），保证两次调用的顺序
//   稳定——决策逻辑依赖确定性，这一点很重要。
export function discoverBuildWorkflows(
  repoRoot: string,
  host?: HostPreflight,
  project?: ProjectDetection,
): BuildWorkflowCandidate[] {
  const root = resolve(repoRoot);
  const workflowsRoot = join(root, REGISTRY_DIR, BUILD_WORKFLOWS_DIR);
  // 目录不存在 = 注册表还是空的 = 没有任何候选（不报错）。
  if (!existsSync(workflowsRoot)) return [];

  const candidates: BuildWorkflowCandidate[] = [];
  // 两层循环：外层 <id> 目录，内层 r<N> 目录。
  // 【语法】readdirSync(path, { withFileTypes: true }) 返回 Dirent 数组，
  //   Dirent 自带 isDirectory()，省得再 stat 一次。
  for (const workflowId of readdirSync(workflowsRoot, { withFileTypes: true })) {
    if (!workflowId.isDirectory()) continue;
    const idRoot = join(workflowsRoot, workflowId.name);
    for (const revision of readdirSync(idRoot, { withFileTypes: true })) {
      if (!revision.isDirectory()) continue;
      const manifestPath = join(idRoot, revision.name, "manifest.json");
      // 结构性残缺：目录在、manifest 不在 → invalid（连读都没法读）。
      if (!existsSync(manifestPath)) {
        candidates.push({
          manifestPath,
          entry: null,
          manifest: null,
          status: "invalid",
          reasons: ["workflow revision has no manifest.json"],
        });
        continue;
      }
      // 正常情况交给分类器（内部 try/catch，不会把整个遍历炸掉）。
      candidates.push(classifyCandidate(manifestPath, root, host, project));
    }
  }
  return candidates.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
}

// ── classifyCandidate：单条候选的状态判定（不会 throw）────────────────
// 【作用】把上面说的五态判定收敛在一个函数里：
//     能读 → 再看环境匹不匹配 → 匹配则看 status 是 draft 还是 valid；
//     读不了（任何异常）→ stale，并把异常信息作为原因记下来。
// 【为什么用 try/catch】遍历注册表时遇到一个坏目录不该让整次发现失败——
//   把它标成 stale、附上原因，让上层能看见又能继续。
function classifyCandidate(
  manifestPath: string,
  repoRoot: string,
  host?: HostPreflight,
  project?: ProjectDetection,
): BuildWorkflowCandidate {
  try {
    const stored = loadBuildWorkflow(manifestPath, repoRoot);
    const reasons = compatibilityReasons(stored.manifest, host, project);
    // 有任何环境不匹配项 → incompatible。
    if (reasons.length > 0) {
      return {
        manifestPath,
        entry: stored.entry,
        manifest: stored.manifest,
        status: "incompatible",
        reasons,
      };
    }
    return {
      manifestPath,
      entry: stored.entry,
      manifest: stored.manifest,
      // 【语法】`条件 ? "draft" : "valid"`：manifest.status 是 "draft" | "verified"，
      //   映射成候选状态。
      status: stored.manifest.status === "draft" ? "draft" : "valid",
      reasons: [],
    };
  } catch (error) {
    return {
      manifestPath,
      entry: null,
      manifest: null,
      status: "stale",
      reasons: [errorMessage(error)],
    };
  }
}

// ── compatibilityReasons：环境匹配检查（返回"不匹配的理由"列表）────────
// 【作用】拿 manifest.applies_to（存库时记录的"我适用于什么"）与当前实测的
//   host / project 逐项比对。⚠️ 关键规则：**空列表 = 不设限**——manifest 没写
//   平台，就表示"哪个平台都行"，不会因为列表里没有当前平台而拒绝。
// 【返回】理由字符串数组；空数组 = 完全兼容。
function compatibilityReasons(
  manifest: BuildWorkflowManifestValue,
  host?: HostPreflight,
  project?: ProjectDetection,
): string[] {
  const reasons: string[] = [];
  // ① API 版本：manifest 是老格式写的，直接判不兼容。
  if (manifest.workflow_api_version !== CURRENT_WORKFLOW_API_VERSION) {
    reasons.push(`workflow API ${String(manifest.workflow_api_version)} is unsupported`);
  }
  // ② 主机匹配（只在调用方真的给了 host 时才检查）。
  if (host !== undefined) {
    if (manifest.applies_to.platforms.length > 0 && !manifest.applies_to.platforms.includes(host.platform)) {
      reasons.push(`platform ${host.platform} is not listed`);
    }
    if (manifest.applies_to.architectures.length > 0 && !manifest.applies_to.architectures.includes(host.arch)) {
      reasons.push(`architecture ${host.arch} is not listed`);
    }
    // ③ 必需工具：manifest 说需要 cmake，就得确认这台机器的 cmake 可用。
    //   【语法】host.tools[tool]?.available —— `?.` 可选链：host.tools[tool]
    //   是 undefined 时整个表达式直接是 undefined 而不抛错，然后 !== true
    //   判定为"不可用"。
    for (const tool of manifest.applies_to.required_tools) {
      if (host.tools[tool]?.available !== true) reasons.push(`required tool is unavailable: ${tool}`);
    }
  }
  // ④ 项目匹配（只在调用方真的给了 project 时才检查）。
  if (project !== undefined) {
    if (manifest.applies_to.build_systems.length > 0 && project.primary_build_system !== null &&
        !manifest.applies_to.build_systems.includes(project.primary_build_system)) {
      reasons.push(`build system ${project.primary_build_system} is not listed`);
    }
    // ⑤ marker：manifest 声明"项目里必须有这些标志文件/目录"，缺一个就不算匹配。
    //   ⚠️ 注意这里**没有** build_systems.length > 0 的外层条件——只要给了
    //   project 就检查 marker。test-registry.ts 那份把 marker 检查包进了
    //   build_systems 判断里，行为有细微差别（见那边注释）。
    for (const marker of manifest.applies_to.markers) {
      if (!project.markers.includes(marker)) reasons.push(`project marker is missing: ${marker}`);
    }
  }
  return reasons;
}

// ── resolveInside：路径必须落在 root 之内（与 absoluteWithin 同款思路）──
// 🔗 与 build-workflow.ts 的 absoluteWithin / test-registry.ts 的同名函数一致。
//   区别在于报错文案写的是 "escapes repository root"。
function resolveInside(root: string, path: string, label: string): string {
  const absolute = isAbsolute(path) ? normalize(path) : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes repository root: ${path}`);
  }
  return absolute;
}

// ── workflowExtension：保留源码原后缀，认不出的回退成 .ts ─────────────
// 【作用】存档文件名叫 workflow.ts / workflow.js…… 跟着原文件走，
//   这样 worker 的动态 import 行为和原来一致。
// 【语法】Array.prototype.includes 判断数组里有没有某个值。
function workflowExtension(entry: string): string {
  const extension = extname(entry).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx"].includes(extension) ? extension : ".ts";
}

// ── sha256：源码指纹（与 build-workflow.ts 同款）──────────────────────
function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

// ── atomicWrite：原子写文件 ───────────────────────────────────────────
// 【为什么需要】直接 writeFileSync 目标文件，写到一半进程被杀/断电，磁盘上
//   就会留下半个文件——对"加载时要校验 JSON、要算 hash"的注册表来说是灾难。
//   原子写的套路是两步：先写到同目录下的临时文件（`${path}.tmp-${进程号}`，
//   加 pid 是为了两个进程同时写不至于互相覆盖），再用 renameSync 改名。
//   同一文件系统内的改名是**原子操作**：目标文件要么是旧的、要么是完整的新，
//   不存在中间态。
function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

// ── errorMessage：把 unknown 类型的异常转成字符串 ─────────────────────
// 【语法】TS 里 catch 到的东西类型是 unknown（它可能是任何值，不一定是 Error），
//   所以要先 instanceof Error 判断，再取 .message；不是 Error 就 String() 强转。
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
