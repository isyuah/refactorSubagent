/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/agents/analyze-legacy.ts —— 旧版"模型分析"路径（被封存但保留）
 *
 * 【这个文件是干什么的】
 *   原来的分析阶段：开一个只读 Claude 会话，让它产出一整份 JSON 提案
 *   （行为契约/范围/依赖/测试/环境 5 个 artifact），宿主用 Zod 严格校验，
 *   校验失败把错误拼回提示词重试一次。
 *
 * 【为什么还被保留（文件头注释原话的翻译）】
 *   只是为了让已退役的 TestSpec 执行路径（agent-pipeline，即 e2e:agent）
 *   还能编译运行。声明制主流程用的是 analyze.ts（host 探针分析，零模型往返）。
 *   【不要扩展本文件】——它是被封存的参照物。
 *
 * 【教学价值】
 *   "双层校验"的教科书示例：SDK 原生 json_schema 约束形状（浅层）→
 *   宿主 Zod Proposal 校验语义（深层）→ 失败带错误重试。
 *
 * 【本文件是教程注释版】原文件 src/agents/analyze-legacy.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * analyze-legacy — the original model-backed analysis (5 schema artifacts).
 *
 * Kept only so the retired TestSpec-runner path (agent-pipeline) still
 * compiles and runs. The declared-mode workflow path uses analyze.ts
 * (host-side probing, no model round trip). Do not extend this file.
 */
import { z } from "zod";
import {
  BehaviorContract,
  DependencyManifest,
  EnvironmentSpec,
  ScopeManifest,
  TestSpec,
  type AnyArtifact,
  type HostPreflight,
  type ProjectDetection,
} from "../artifacts/index.js";
import {
  DEFAULT_AGENT_FORBIDDEN_GLOBS,
  DEFAULT_AGENT_READABLE_GLOBS,
  runAgent,
  extractJson,          // 兜底解析：从自由文本里抠 JSON（structuredOutput 缺失时用）
} from "./driver.js";
import { ANALYZE_SYSTEM, analyzePrompt } from "./prompts.js";

// 分析会话的额外可读范围：构建系统的关键文件（默认可读集之外显式加这些）。
// as const：锁定为只读字面量元组。
const ANALYZE_READABLE_GLOBS = [
  ...DEFAULT_AGENT_READABLE_GLOBS,
  "CMakeLists.txt",
  "cmake/**",
  "config/**",
] as const;

// ── analysisReadableGlobs：按项目源码清单推导可读范围 ────────────────────
// 对 project.source_files 的每个文件：取它所在的目录级 glob（dir/**）加进可读集；
// 但跳过测试/基线/生成物目录（test、tests、baseline、.refactor、node_modules）——
// 分析不该看测试（否则"照着测试写契约"会作弊），也不该看依赖和生成物。
// some() + includes：路径的任一段命中即跳过。
function analysisReadableGlobs(project?: ProjectDetection): string[] {
  const globs = new Set<string>(ANALYZE_READABLE_GLOBS);
  for (const file of project?.source_files ?? []) {
    const parts = file.split("/");
    if (parts.some((part) => ["test", "tests", "baseline", ".refactor", "node_modules"].includes(part))) continue;
    if (parts.length > 1) globs.add(`${parts.slice(0, -1).join("/")}/**`);
  }
  return [...globs];   // Set 展开回数组（自动去重）
}

// SDK 原生 json_schema：只约束"顶层 5 个键都是 object 且必填"（浅层形状）。
// 深层结构交给宿主 Zod（Proposal）——分工：SDK 防乱来，Zod 防走样。
const ANALYZE_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      contract: { type: "object" },
      scope: { type: "object" },
      deps: { type: "object" },
      tests: { type: "object" },
      env: { type: "object" },
    },
    required: ["contract", "scope", "deps", "tests", "env"],
    additionalProperties: false,   // 多一个键都不行
  },
};

/** Analyze proposals are data; the host validates them before state changes. */
// 宿主侧的深层校验：直接复用 artifacts/ 里的 5 个完整 Schema。
// （SDK json_schema 里那 5 个 object 到这里要过"真安检"。）
const Proposal = z.object({
  contract: BehaviorContract,
  scope: ScopeManifest,
  deps: DependencyManifest,
  tests: TestSpec,
  env: EnvironmentSpec,
});

// 分析结果的 TS 类型（与 Proposal 一一对应，方便调用方按字段取用）。
export interface AnalysisResult {
  contract: z.infer<typeof BehaviorContract>;
  scope: z.infer<typeof ScopeManifest>;
  deps: z.infer<typeof DependencyManifest>;
  tests: z.infer<typeof TestSpec>;
  env: z.infer<typeof EnvironmentSpec>;
}

// ── analyzeRepoLegacy：旧分析主函数（2 次尝试 + 错误回灌）──────────────────
// 【参数】repoDir 仓库路径；taskContext 任务描述；host/project 程序测量事实
// 【返回】AnalysisResult（5 个 artifact 的强类型对象）
// 【流程】拼提示词（含测量事实 JSON）→ 只读会话（maxTurns 24）→ 取 JSON
//        → safeParse 失败把 issue 拼进提示词再试一次 → 两次都失败抛错。
// 【语法】for (let attempt = 0; attempt < 2; attempt++) 是"最多试两次"的循环
//        （成功 return / continue 直接控制流转，不需要 break 标志位）。
export async function analyzeRepoLegacy(
  repoDir: string,
  taskContext?: string,
  host?: HostPreflight,
  project?: ProjectDetection,
): Promise<AnalysisResult> {
  let lastErrors = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      analyzePrompt(
        taskContext,
        host ? JSON.stringify(host, null, 2) : undefined,    // 测量事实原文注入
        project ? JSON.stringify(project, null, 2) : undefined,
      ) +
      (lastErrors
        ? `\n\nYour previous JSON was REJECTED by validation:\n${lastErrors}\nFix these problems and reply again.`
        : "");                                               // ★ 错误回灌：把上次的具体问题喂回去

    const run = await runAgent({
      cwd: repoDir,
      prompt,
      systemPrompt: ANALYZE_SYSTEM,
      allowedTools: ["Read", "Glob", "Grep"],   // 只读：分析不许改
      readableGlobs: analysisReadableGlobs(project),
      forbiddenGlobs: [...DEFAULT_AGENT_FORBIDDEN_GLOBS],
      outputFormat: ANALYZE_OUTPUT_FORMAT,      // SDK 层 json_schema（第一道）
      maxTurns: 24,
    });

    let raw: unknown;
    try {
      // structuredOutput：SDK json_schema 的产物；缺失时 extractJson 从文本里抠。
      raw = run.structuredOutput ?? extractJson(run.result);
    } catch {
      lastErrors = "response was not parsable as structured JSON";
      continue;   // 直接进入下一次尝试
    }

    const parsed = Proposal.safeParse(raw);   // 宿主 Zod（第二道）
    if (parsed.success) return parsed.data;

    // 把每个 Zod issue 拼成 "a.b.c: message" 的行，作为重试提示的一部分。
    lastErrors = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
  }

  throw new Error(`analysis failed schema validation after retry:\n${lastErrors}`);
}

// 把分析结果转成 artifact 数组（调用方逐个 submit 给状态机用）。
export function proposalArtifacts(a: AnalysisResult): AnyArtifact[] {
  return [a.contract, a.scope, a.deps, a.tests, a.env];
}
