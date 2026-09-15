/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/workflow-resolution.ts —— workflow 决策的"会议纪要"
 *
 * 【这个文件是干什么的】
 *   定义 WorkflowResolution artifact：记录"本次用哪个 Build/TestWorkflow"的
 *   决策——id/revision、来源（mode）、源码哈希、候选清单、选择理由。
 *
 * 【B 方案（2026-09 改版）的重要变化】
 *   mode 枚举新增 **"declared"**：test-writer 会话用 declareDependency 声明
 *   依赖集，构建依赖不再写在 WorkflowResolution 里，而是集中记录在新的
 *   DeclaredBuildSet artifact 中（单凭证承载整个声明集）。所以：
 *   - declared 模式的 test 决策【豁免】"必须记录 build_workflow"的校验
 *     （依赖审计改由状态机查 declared-build-set 完成，见 orchestrator.ts）；
 *   - selected/generated 等旧模式语义不变，且它们的生成路径已被删除
 *     （chooser/模板策略/propose 全部下线）。
 *
 * 【superRefine 两条硬规则（状态机也会再查一遍）】
 *   - build 的决策不得依赖另一个 BuildWorkflow（它是起点）；
 *   - test 的决策必须记录绑定的 BuildWorkflow——**declared 模式除外**。
 *
 * 【本文件是教程注释版】原文件 src/artifacts/workflow-resolution.ts（B 方案改版后），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { z } from "zod";
import { RelPath } from "./common.js";

// 四种来源：
export const WorkflowResolutionMode = z.enum(["forced", "selected", "generated", "declared"]);
//   forced    用户明确指定了 workflow 源码文件，强制使用
//   selected  注册表里有现成的，直接复用（⚠️ 旧版的 Chooser 拍板机制已随 B 方案删除）
//   generated 现场生成（⚠️ 旧版的模板策略/AI 写源码路径已删除，枚举值暂保留兼容）
//   declared  ★ B 方案新增：test-writer 会话声明依赖集，构建依赖记在 DeclaredBuildSet 里
export type WorkflowResolutionMode = z.infer<typeof WorkflowResolutionMode>;

export const WorkflowResolution = z
  .object({
    kind: z.literal("workflow-resolution"),
    version: z.literal(1),
    workflow_kind: z.enum(["build", "test"]),   // 这份纪要记的是构建还是测试
    mode: WorkflowResolutionMode,
    workflow_id: z.string().min(1),             // 选中的 workflow
    workflow_revision: z.number().int().positive(),
    /** Build identity required by a TestWorkflow; null for BuildWorkflow. */
    // ↑ 绑定的 BuildWorkflow 身份：test 必填、build 必须为 null——
    //   ⚠️ declared 模式的 test 例外（依赖集合在 DeclaredBuildSet 里），见下面 superRefine。
    build_workflow: z
      .object({ id: z.string().min(1), revision: z.number().int().positive() })
      .nullable()
      .default(null),
    /** Logical root kind used for recovery; root_path records the measured path. */
    // ↑ entry_root：workflow 源码放在哪类根目录下——
    //   workspace=项目内 / external=外部路径 / session=本次会话目录
    //   （B 方案里 AI 生成的源码落点改为 runs/{sessionId}/workflows/，归 session）。
    entry_root: z.enum(["workspace", "external", "session"]),
    root_path: z.string().min(1),               // 实际测量的根路径
    entry: RelPath,                             // 源码入口（相对 root_path）
    source_hash: z.string().regex(/^[0-9a-f]{64}$/),  // 源码 sha256（审计与复用校验）
    candidate_entries: z.array(RelPath).default([]),  // 决策时"货架上"的全部候选
    reason: z.string().min(1),                  // 为什么选它（人读的理由）
  })
  .superRefine((value, context) => {
    if (value.workflow_kind === "build" && value.build_workflow !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["build_workflow"],
        message: "BuildWorkflow resolution cannot depend on another BuildWorkflow",
      });
    }
    if (value.workflow_kind === "test" && value.build_workflow === null) {
      // Declared-mode test workflows are self-driven: their build dependencies
      // live in the DeclaredBuildSet artifact, not in a single static reference.
      // ↑ declared 模式豁免：自驱动 test 的构建依赖在 DeclaredBuildSet 里集中声明，
      //   不需要在 resolution 里逐条写静态引用。
      if (value.mode !== "declared") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["build_workflow"],
          message: "TestWorkflow resolution must record its BuildWorkflow dependency",
        });
      }
    }
  });
export type WorkflowResolution = z.infer<typeof WorkflowResolution>;
