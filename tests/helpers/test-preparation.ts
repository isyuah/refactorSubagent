import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { WorkflowSessionAgentOptions } from "../../src/agents/workflow-session.js";
import type { DriverOptions, DriverRun } from "../../src/agents/driver.js";
import { AgentProgress } from "../../src/agents/progress.js";
import { mcpText, withMcpClient } from "./mcp-client.js";
import { analysisReport } from "./verification-analysis.js";

export const snapshotBuild = `export const workflowKind = "workflow-driven";
export default async ctx => {
  await ctx.fs.mkdir("build");
  const source = await ctx.fs.readFile("main.c", "utf8");
  await ctx.fs.writeFile("build/source.txt", source);
  await ctx.validator.assertFile("build/source.txt", "implementation snapshot");
};`;
export const auxiliaryBuild = `export const workflowKind = "workflow-driven";
export default async ctx => {
  const mock = await ctx.fs.readFile("build/verification/fake-clock.c", "utf8");
  await ctx.fs.writeFile("build/auxiliary.txt", mock);
  await ctx.validator.assertFile("build/auxiliary.txt", "test double source");
};`;
export const testSource = `export const workflowKind = "test-workflow-driven";
export default async ctx => {
  const source = await ctx.fs.readFile("build/source.txt", "utf8");
  const auxiliary = await ctx.fs.readFile("build/auxiliary.txt", "utf8");
  ctx.expect("函数返回值", source.match(/return (\\d+)/)[1]);
  ctx.expect("模拟时钟", auxiliary);
};`;
export const scenarios = { version: 1, scenarios: [{ id: "return", title: "检查真实实现返回值", purpose: "为独立函数重构保留可观察行为",
  inputs: ["读取当前工作目录 main.c 的构建快照"], observations: ["函数返回值", "模拟时钟"], sourceReferences: ["main.c:1"] }] };

/** Replay real registration tools, source delivery, events and transcript persistence. */
export function preparationReplay(options: { brokenBuild?: number; missingDocument?: boolean; constantTest?: boolean; emptyTest?: boolean; hangingBuild?: boolean; brokenTest?: boolean; singleBuild?: boolean; omitMaterialAfterFirst?: boolean } = {}) {
  const calls: WorkflowSessionAgentOptions[] = [];
  let generation = 0;
  const author = async (o: WorkflowSessionAgentOptions): Promise<DriverRun> => {
    calls.push(o); generation++;
    const id = o.resumeSessionId ?? "preparation-dialogue";
    if (o.resumeSessionId && !(await o.sessionStore?.load({ sessionId: id, projectKey: "offline" }))?.length) throw new Error("original transcript missing");
    await o.sessionStore?.append({ sessionId: id, projectKey: "offline" }, [{ uuid: `reply-${generation}`, type: "assistant" }]);
    const progress = new AgentProgress(o.logger, "test-writer", "offline-model");
    progress.accept({ type: "assistant", message: { id: `reply-${generation}`, content: [{ type: "text", text: "已交付两个构建和两个实际检查项。" }] } });
    await withMcpClient(o.mcpServers["dep-registry"] as McpSdkServerConfigWithInstance, async client => {
      const report = await client.callTool({ name: "submitVerificationAnalysis", arguments: analysisReport() });
      if (report.isError) throw new Error(mcpText(report));
      const ids: string[] = [];
      for (const [index, source] of (options.singleBuild ? [snapshotBuild] : [snapshotBuild, auxiliaryBuild]).entries()) {
        const response = await client.callTool({ name: "generateBuildWorkflow", arguments: {
          name: `build-${index + 1}`, description: index === 0 ? "build/source.txt: current implementation snapshot" : "build/auxiliary.txt: fake clock source",
          content: options.hangingBuild && index === 0 ? `export const workflowKind = "workflow-driven"; export default async ctx => { await ctx.plan.declare([{id:"hold",title:"等待取消"}]); await ctx.plan.begin("hold"); await new Promise(() => {}); };` : options.brokenBuild === index ? `export const workflowKind = "workflow-driven"; export default async () => { throw new Error("broken build ${index}"); };` : source,
          ...(index === 1 && !(options.omitMaterialAfterFirst && generation > 1) ? { materials: [{ path: "build/verification/fake-clock.c", content: "int fake_clock(void) { return 7; }\n" }] } : {}),
        } });
        const id = /workflow_id:\s*(\S+)/.exec(mcpText(response))?.[1];
        if (response.isError || !id) throw new Error(mcpText(response)); ids.push(id);
      }
      const declared = await client.callTool({ name: "declareDependency", arguments: { buildWorkflowIds: ids } });
      if (declared.isError) throw new Error(mcpText(declared));
    });
    const root = join(o.cwd, ".refactor", "review-input");
    mkdirSync(root, { recursive: true });
    const testEntry = /完整 TestWorkflow 写到原路径：([^\r\n]+)/.exec(o.prompt)?.[1]?.trim() ?? /module written to exactly:\s*([^\r\n]+)/.exec(o.prompt)?.[1]?.trim() ?? join(root, "test.ts");
    mkdirSync(join(testEntry, ".."), { recursive: true });
    writeFileSync(testEntry, options.brokenTest ? `export const workflowKind = "test-workflow-driven"; export default async ctx => { await ctx.fs.read("main.c"); };` : options.emptyTest ? `export const workflowKind = "test-workflow-driven"; export default async ctx => { await ctx.fs.readFile("main.c", "utf8"); };` : options.constantTest ? `export const workflowKind = "test-workflow-driven"; export default async ctx => { ctx.expect("fabricated", 1); };` : options.singleBuild ? `export const workflowKind = "test-workflow-driven";
export default async ctx => { const source = await ctx.fs.readFile("build/source.txt", "utf8"); ctx.expect("函数返回值", source.match(/return (\\d+)/)[1]); };` : testSource);
    const reviewEntry = /scenario documentation as JSON at ([^\r\n]+):/.exec(o.prompt)?.[1];
    if (!options.missingDocument && reviewEntry) writeFileSync(reviewEntry, JSON.stringify(scenarios));
    return { result: "offline source delivered", isError: false, timedOut: false, sessionId: id };
  };
  const build = async (o: DriverOptions): Promise<DriverRun> => {
    await withMcpClient(o.mcpServers!["dep-registry"] as McpSdkServerConfigWithInstance, async client => {
      const response = await client.callTool({ name: "generateBuildWorkflow", arguments: {
        name: "repaired", description: "build/source.txt: current implementation snapshot", content: snapshotBuild,
      } });
      if (response.isError) throw new Error(mcpText(response));
    });
    return { result: "repaired", isError: false, timedOut: false, sessionId: "build-dialogue" };
  };
  return { author, build, calls };
}
