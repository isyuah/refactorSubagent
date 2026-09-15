/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/build-workflow-agent.test.ts —— 工作流写作规范的关键句"钉子测试"
 *
 * 【这个文件锁定了哪些行为】
 *   纯字符串断言：锁定 BUILD_WORKFLOW_SYSTEM / TEST_WORKFLOW_SYSTEM 两个
 *   系统提示词里的关键句必须存在——
 *   ① "交付物是默认导出函数的 TS 源码模块"（防止提示词改着改着忘了交代产物形态）；
 *   ② workflowKind 声明、validator.assertFile、返回 void、不返回 BuildWorkflowOutput、
 *      ctx.expect、按 ORDER 配对、plan 声明、幂等（idempotent）——
 *      这些句子是 fail-closed 与两侧配对机制的"提示词侧支柱"，删了任何一句，
 *      AI 产出质量就会退化，测试立刻红。
 *
 * 【为什么用字符串断言】提示词是"给模型的契约"，没有类型可查；把关键句钉进
 *   测试 = 给契约上锁。改提示词时这里红 = 你动到了关键承诺，要三思。
 *
 * 【怎么跑】bun test tests/build-workflow-agent.test.ts（纯逻辑，不需要 gcc）
 *
 * 【本文件是教程注释版】原文件 tests/build-workflow-agent.test.ts（B 方案后精简版），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from "bun:test";
import {
  BUILD_WORKFLOW_SYSTEM,
  TEST_WORKFLOW_SYSTEM,
} from "../src/agents/prompts.js";
describe("Workflow Agent guidance", () => {
  // 锁定"交付物形态"与两条铁律句：默认导出函数 / 禁 shell / fail-closed。
  test("requires TypeScript source modules and keeps fail-closed rules explicit", () => {
    expect(BUILD_WORKFLOW_SYSTEM).toContain("source must default-export a function");
    expect(TEST_WORKFLOW_SYSTEM).toContain("source must default-export a function");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("Never\nemit shell commands");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("Be fail-closed");
  });
  // 锁定两侧工作机制的关键句：workflowKind 声明 / 产物断言 / void 返回 /
  // 不返回旧式 Output / ctx.expect / 按位置（ORDER）配对。
  test("pins host artifact discriminators and identity fields", () => {
    expect(BUILD_WORKFLOW_SYSTEM).toContain('export const workflowKind = "workflow-driven"');
    expect(BUILD_WORKFLOW_SYSTEM).toContain("context.validator.assertFile");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("return nothing (void)");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("Do NOT return a BuildWorkflowOutput object");
    expect(TEST_WORKFLOW_SYSTEM).toContain('export const workflowKind = "test-workflow-driven"');
        expect(TEST_WORKFLOW_SYSTEM).toContain("ctx.expect");
    expect(TEST_WORKFLOW_SYSTEM).toContain("pairs declarations by ORDER");
  });

  // 锁定可观测性与幂等：plan 步骤声明（阶段级）、函数必须幂等。
  test("documents workflow-driven builds and plan declarations in guidance", () => {
    expect(BUILD_WORKFLOW_SYSTEM).toContain("workflow-driven");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("context.plan.declare");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("stage-level only");
    expect(BUILD_WORKFLOW_SYSTEM).toContain("idempotent");
    expect(TEST_WORKFLOW_SYSTEM).toContain("context.plan");
    expect(TEST_WORKFLOW_SYSTEM).toContain("plan.declare");
  });

});
