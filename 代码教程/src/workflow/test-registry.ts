/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/workflow/test-registry.ts —— TestWorkflow 的持久化注册表
 *
 * 🔗🔗 这个文件是 registry.ts 的"测试侧镜像"，磁盘布局、幂等策略、防篡改
 *    校验、五态候选状态机全部同构。公共概念（sha256 防篡改、原子写、五态
 *    判定顺序、空列表 = 不设限）都在 registry.ts 里讲透了，本文件不重复，
 *    只讲**三处真实差异**（见下）。建议先读 registry.ts 再读这里。
 *
 * 【磁盘布局】（对比 registry.ts 只换了目录名和第三个文件名）
 *   <repoRoot>/.refactorsa/test-workflows/<workflow-id>/r<revision>/
 *       ├── workflow.ts            ← 源码原件
 *       ├── manifest.json          ← 登记信息（含 source_hash、applies_to）
 *       └── test-workflow.json     ← 声明式 TestWorkflow 对象
 *                                  （⚠️ 自驱动没有这个文件，见差异②）
 *
 * 【与 registry.ts 的三处差异】
 *   ① 多了 unlinkSync：一份 workflow 若从声明式改成自驱动再存一次，
 *      旧的 test-workflow.json 会被删掉，避免"目录里躺着一份过时的声明"；
 *   ② 第三个文件叫 test-workflow.json（而非 build-workflow-output.json），
 *      且当 resolution.workflow === null（自驱动）时**不写**这个文件；
 *   ③ compatibilityReasons 的 marker 检查被包进了
 *      `manifest.applies_to.build_systems.length > 0` 里 —— 也就是说：
 *      manifest 若没声明 build_systems，marker 也不检查了。
 *      registry.ts 那边是"给了 project 就检查 marker"。⚠️ 两边语义不一致，
 *      属于同构文件漂移的典型例子（读代码时要留意）。
 *
 * 【在整个项目里的位置】
 *   上游（谁调用它）：只有 src/workflow/resolve-workflows.ts ——
 *     · saveTestWorkflow(:464)：生成/选定后入库；
 *     · discoverTestWorkflows(:492)：列出候选；
 *     · loadTestWorkflow(:502)：选中后取出（还会顺带校验它绑定的 BuildWorkflow）。
 *   下游（它调用谁）：checkWorkflowSource（source-policy.ts）。
 *   与 test-workflow.ts 的关系：本文件消费它的 TestWorkflowResolution，
 *     自己不执行任何 workflow。
 *
 * 【先修知识】registry.ts（同构文件，必读）、test-workflow.ts（resolution 来源）。
 * 【本文件是教程注释版】
 *   原文件：src/workflow/test-registry.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 【语法】node:crypto 的 createHash —— sha256 指纹（详见 registry.ts / build-workflow.ts）。
import { createHash } from "node:crypto";
// 【语法】node:fs 同步 API。🔗 比 registry.ts 多 import 了 unlinkSync（删文件），
//   对应"差异①"。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
// 【语法】node:path。与 registry.ts 引入的是同一批工具（这里只是分行写）。
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
// 【语法】"Schema 值 + 类型别名"双引入的套路（详见 build-workflow.ts 顶部）：
//   TestWorkflow / TestWorkflowManifest 是 Zod Schema（拿来 .parse），
//   type TestWorkflow as TestWorkflowValue / type TestWorkflowManifest as
//   TestWorkflowManifestValue 是它们的 TS 类型（拿来标注字段）。
import {
  TestWorkflow,
  TestWorkflowManifest,
  type TestWorkflow as TestWorkflowValue,
  type TestWorkflowManifest as TestWorkflowManifestValue,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import { checkWorkflowSource } from "./source-policy.js";
import type { TestWorkflowResolution } from "./test-workflow.js";

// 目录常量。🔗 与 registry.ts 的差别只有子目录名：test-workflows。
const REGISTRY_DIR = ".refactorsa";
const TEST_WORKFLOWS_DIR = "test-workflows";
// API 版本号，与 registry.ts 各存一份（当前都是 1）。
const CURRENT_WORKFLOW_API_VERSION = 1;

// ── TestWorkflowCandidateStatus：五态候选状态机 ────────────────────────
// 🔗 与 registry.ts 的 BuildWorkflowCandidateStatus 一字不差。
//   判定顺序见 classifyCandidate：invalid（没有 manifest）→ stale（读失败）→
//   incompatible（环境不匹配）→ draft → valid。
export type TestWorkflowCandidateStatus =
  | "valid"
  | "draft"
  | "incompatible"
  | "stale"
  | "invalid";

// ── StoredTestWorkflow：从磁盘读回来的完整一份 ─────────────────────────
// ⚠️ 与 registry.ts 的 StoredBuildWorkflow 有个风格差异：这里的字段全部带
//   readonly（那边没有）。语义一样——都是"读回来的快照，别改"。
export interface StoredTestWorkflow {
  readonly manifestPath: string;
  // test-workflow.json 的路径；自驱动 workflow 没有这个文件 → null。
  readonly workflowPath: string | null;
  // 源码绝对路径。
  readonly entry: string;
  readonly manifest: TestWorkflowManifestValue;
  // 声明式 TestWorkflow 对象；自驱动 = null。
  readonly workflow: TestWorkflowValue | null;
}

// ── TestWorkflowCandidate：discover 列表里的一项 ───────────────────────
// 🔗 与 registry.ts 的 BuildWorkflowCandidate 同构（只是多了 readonly）。
export interface TestWorkflowCandidate {
  readonly manifestPath: string;
  readonly entry: string | null;
  readonly manifest: TestWorkflowManifestValue | null;
  readonly status: TestWorkflowCandidateStatus;
  readonly reasons: string[];
}

/** 存一份 TestWorkflow 进注册表（幂等）。 */
// ── saveTestWorkflow：入库（幂等）────────────────────────────────────
// 🔗 与 registry.ts 的 saveBuildWorkflow 同一套流程：
//   重读源码 → 算指纹 → 目录已存在则比对指纹（同源幂等返回、异源抛错）→
//   原子写 源码 / manifest / 声明对象。下面只标注本文件特有的点。
export function saveTestWorkflow(
  repoRoot: string,
  resolution: TestWorkflowResolution,
): StoredTestWorkflow {
  const root = resolve(repoRoot);
  // 重读源码并确认没逃出 repoRoot（防"resolution 之后源码又被改了"）。
  const sourceEntry = resolveInside(
    root,
    relative(root, resolution.entry),
    "test workflow source",
  );
  const source = readFileSync(sourceEntry, "utf8");
  const extension = workflowExtension(sourceEntry);
  // 目标目录 <root>/.refactorsa/test-workflows/<id>/r<rev>/。
  const workflowDir = join(
    root,
    REGISTRY_DIR,
    TEST_WORKFLOWS_DIR,
    resolution.manifest.id,
    `r${String(resolution.manifest.revision)}`,
  );
  const entry = join(workflowDir, `workflow${extension}`);
  const manifestPath = join(workflowDir, "manifest.json");
  // 差异②：第三个文件叫 test-workflow.json。
  const workflowPath = join(workflowDir, "test-workflow.json");

  // 幂等：目录已存在 → 必须有 manifest → 指纹一致才返回已有份，否则抛错。
  if (existsSync(workflowDir)) {
    if (!existsSync(manifestPath)) {
      throw new Error(`test workflow revision directory is incomplete: ${workflowDir}`);
    }
    const existing = loadTestWorkflow(manifestPath, root);
    if (existing.manifest.source_hash !== sha256(source)) {
      throw new Error(
        `test workflow revision already exists with different source: ` +
          `${resolution.manifest.id}@${String(resolution.manifest.revision)}`,
      );
    }
    return existing;
  }

  mkdirSync(workflowDir, { recursive: true });
  atomicWrite(entry, source);
  // 抄一份 manifest，改 entry 为注册表内的相对路径 + 重算指纹，再 parse 校验。
  const storedManifest = TestWorkflowManifest.parse({
    ...resolution.manifest,
    entry: relative(root, entry).split(sep).join("/"),
    source_hash: sha256(source),
  });
  // Self-driven test workflows have no declarative object (resolution.workflow
  // is null); only the source + manifest are stored.
  // 差异②：自驱动没有声明对象可存，只落 源码 + manifest。
  if (resolution.workflow === null) {
    // 差异①：把可能残留的旧 test-workflow.json 删掉。什么时候会有残留？
    // 同一个 id@revision 先以声明式存过、后来源码改成自驱动再存——不过那
    // 种情况上面指纹比对已经抛错了；这条 unlinkSync 主要防的是手工清理过
    // 目录、或历史遗留的脏文件。总之保证"没有声明对象"这个事实在磁盘上
    // 也是干净的。
    if (existsSync(workflowPath)) unlinkSync(workflowPath);
    // 【语法】模板字符串包 JSON.stringify，末尾补一个换行。
    atomicWrite(manifestPath, `${JSON.stringify(storedManifest, null, 2)}\n`);
    return {
      manifestPath,
      workflowPath: null,
      entry,
      manifest: storedManifest,
      workflow: null,
    };
  }
  // 声明式：入库前再 parse 一遍（防御性），先 manifest 后声明对象，全部原子写。
  const workflow = TestWorkflow.parse(resolution.workflow);
  atomicWrite(manifestPath, `${JSON.stringify(storedManifest, null, 2)}\n`);
  atomicWrite(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  return {
    manifestPath,
    workflowPath,
    entry,
    manifest: storedManifest,
    workflow,
  };
}

// ── loadTestWorkflow：取一份（带防篡改校验）──────────────────────────
// 🔗 与 registry.ts 的 loadBuildWorkflow 同一套：读 manifest → 沙箱检查源码 →
//   重算 sha256 与登记值比对 → 读声明对象 → 交叉校验身份。
// 【差异】这里最后比对的是 workflow.workflow_id / workflow_revision 与 manifest。
export function loadTestWorkflow(
  manifestPath: string,
  repoRoot: string,
): StoredTestWorkflow {
  const root = resolve(repoRoot);
  const absoluteManifest = resolve(manifestPath);
  const manifest = TestWorkflowManifest.parse(
    JSON.parse(readFileSync(absoluteManifest, "utf8")),
  );
  // manifest.entry 必须落在 repoRoot 之内。
  const entry = resolveInside(root, manifest.entry, "test workflow entry");
  // 沙箱检查：防止入库后源码被人改成会 import node:fs 的版本。
  const checked = checkWorkflowSource(entry);
  if (!checked.ok) {
    throw new Error(checked.reason ?? `test workflow source rejected: ${entry}`);
  }
  // 防篡改的核心：重算指纹，与 manifest 里登记的值比对。
  const actualHash = sha256(checked.source);
  if (actualHash !== manifest.source_hash) {
    throw new Error(
      `test workflow source hash mismatch: expected ${manifest.source_hash}, got ${actualHash}`,
    );
  }
  // 声明对象和 manifest 同目录；自驱动没有这个文件 → null。
  const workflowPath = join(dirname(absoluteManifest), "test-workflow.json");
  const workflow = existsSync(workflowPath)
    ? TestWorkflow.parse(JSON.parse(readFileSync(workflowPath, "utf8")))
    : null;
  // 交叉校验：声明对象自称的身份必须与 manifest 一致。
  if (
    workflow !== null &&
    (workflow.workflow_id !== manifest.id || workflow.workflow_revision !== manifest.revision)
  ) {
    throw new Error("persisted TestWorkflow identity does not match its manifest");
  }
  return {
    manifestPath: absoluteManifest,
    workflowPath,
    entry,
    manifest,
    workflow,
  };
}

// ── discoverTestWorkflows：遍历注册表，逐条分类 ────────────────────────
// 🔗 与 registry.ts 的 discoverBuildWorkflows 一模一样（目录名不同而已）：
//   两层循环遍历 <id>/r<N>，没有 manifest 的记 invalid，其余交给
//   classifyCandidate，最后按路径字典序排序保证结果稳定。
export function discoverTestWorkflows(
  repoRoot: string,
  host?: HostPreflight,
  project?: ProjectDetection,
): TestWorkflowCandidate[] {
  const root = resolve(repoRoot);
  const workflowsRoot = join(root, REGISTRY_DIR, TEST_WORKFLOWS_DIR);
  if (!existsSync(workflowsRoot)) return [];

  const candidates: TestWorkflowCandidate[] = [];
  for (const workflowId of readdirSync(workflowsRoot, { withFileTypes: true })) {
    if (!workflowId.isDirectory()) continue;
    const idRoot = join(workflowsRoot, workflowId.name);
    for (const revision of readdirSync(idRoot, { withFileTypes: true })) {
      if (!revision.isDirectory()) continue;
      const manifestPath = join(idRoot, revision.name, "manifest.json");
      if (!existsSync(manifestPath)) {
        candidates.push({
          manifestPath,
          entry: null,
          manifest: null,
          status: "invalid",
          reasons: ["test workflow revision has no manifest.json"],
        });
        continue;
      }
      candidates.push(classifyCandidate(manifestPath, root, host, project));
    }
  }
  return candidates.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
}

// ── classifyCandidate：单条候选的状态判定（不会 throw）────────────────
// 🔗 判定语义与 registry.ts 完全一致，只是**写法**不同，值得对比着看：
//   registry.ts 先判 reasons 再各写一个 return；这里把状态收进一个嵌套三元
//   表达式、只写一个 return。可读性见仁见智，行为等价。
//   【语法】嵌套三元：`A ? x : (B ? y : z)` —— 从外往里读，
//     reasons 非空 → "incompatible"
//     否则 manifest.status === "draft" → "draft"
//     否则 → "valid"。
function classifyCandidate(
  manifestPath: string,
  repoRoot: string,
  host?: HostPreflight,
  project?: ProjectDetection,
): TestWorkflowCandidate {
  try {
    const stored = loadTestWorkflow(manifestPath, repoRoot);
    const reasons = compatibilityReasons(stored.manifest, host, project);
    return {
      manifestPath,
      entry: stored.entry,
      manifest: stored.manifest,
      status:
        reasons.length > 0
          ? "incompatible"
          : stored.manifest.status === "draft"
            ? "draft"
            : "valid",
      reasons,
    };
  } catch (error) {
    // 读失败（源码被拒 / 指纹不符 / Schema 坏了 / 身份错配）→ stale。
    return {
      manifestPath,
      entry: null,
      manifest: null,
      status: "stale",
      reasons: [errorMessage(error)],
    };
  }
}

// ── compatibilityReasons：环境匹配检查 ────────────────────────────────
// 🔗 前半段（API 版本 / 平台 / 架构 / 必需工具）与 registry.ts 逐字等价，
//   不再重复解释。规则同样是"空列表 = 不设限"。
// ⚠️ 差异③在第 ④ 段：这里的 marker 检查被包进了 build_systems.length > 0，
//   与 registry.ts 不一致（详见文件头"三处差异"）。
function compatibilityReasons(
  manifest: TestWorkflowManifestValue,
  host?: HostPreflight,
  project?: ProjectDetection,
): string[] {
  const reasons: string[] = [];
  if (manifest.workflow_api_version !== CURRENT_WORKFLOW_API_VERSION) {
    reasons.push(`workflow API ${String(manifest.workflow_api_version)} is unsupported`);
  }
  if (host !== undefined) {
    if (
      manifest.applies_to.platforms.length > 0 &&
      !manifest.applies_to.platforms.includes(host.platform)
    ) {
      reasons.push(`platform ${host.platform} is not listed`);
    }
    if (
      manifest.applies_to.architectures.length > 0 &&
      !manifest.applies_to.architectures.includes(host.arch)
    ) {
      reasons.push(`architecture ${host.arch} is not listed`);
    }
    // `?.` 可选链：host.tools[tool] 不存在时整条是 undefined，!== true → 不可用。
    for (const tool of manifest.applies_to.required_tools) {
      if (host.tools[tool]?.available !== true) {
        reasons.push(`required tool is unavailable: ${tool}`);
      }
    }
  }
  // 差异③：外层多了一个 `manifest.applies_to.build_systems.length > 0`。
  //   后果：如果这份 TestWorkflow 没声明 build_systems，marker 检查会被整体
  //   跳过（registry.ts 里 marker 是独立检查的）。哪个是对的？按"空 = 不设限"
  //   的约定，registry.ts 的写法更自洽；这里更像顺手写歪了。
  if (project !== undefined && manifest.applies_to.build_systems.length > 0) {
    if (
      project.primary_build_system !== null &&
      !manifest.applies_to.build_systems.includes(project.primary_build_system)
    ) {
      reasons.push(`build system ${project.primary_build_system} is not listed`);
    }
    for (const marker of manifest.applies_to.markers) {
      if (!project.markers.includes(marker)) reasons.push(`project marker is missing: ${marker}`);
    }
  }
  return reasons;
}

// ── resolveInside：路径必须落在 root 之内 🔗 同 registry.ts ────────────
function resolveInside(root: string, path: string, label: string): string {
  const absolute = isAbsolute(path) ? normalize(path) : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes repository root: ${path}`);
  }
  return absolute;
}

// ── workflowExtension：保留源码后缀 🔗 同 registry.ts ──────────────────
function workflowExtension(entry: string): string {
  const extension = extname(entry).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx"].includes(extension) ? extension : ".ts";
}

// ── sha256：源码指纹 🔗 同 registry.ts ────────────────────────────────
function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

// ── atomicWrite：原子写 🔗 同 registry.ts（临时文件 + rename）──────────
function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

// ── errorMessage：unknown 异常转字符串 🔗 同 registry.ts ──────────────
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
