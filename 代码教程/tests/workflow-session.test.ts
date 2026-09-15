/* ═══════════════════════════════════════════════════════════════════════
 * 【文件总览】tests/workflow-session.test.ts —— test-writer 会话编排的合同测试
 *
 * 【这个文件锁定了哪些行为】（用注入的假 runner，不开真 Claude 会话）
 *   ① 会话配置注入正确：agents 里有 build-writer、mcpServers 里有 dep-registry、
 *      extraAllowedTools 放行全部三个 MCP 工具、skills 带 workflow-spec；
 *   ② test 源文件没产出 → 会话失败（"did not produce"）；
 *   ③ ★ 会话提示词同时要求两个交付物：declareDependency（含"空数组也要显式声明"）
 *      + 不许重建（MUST NOT rebuild）+ 提到 inspectWorkflow 与 build-writer；
 *   ④ 会话报错且无输出 → 失败（"failed without output"）；
 *   ⑤ 超时 → 如实报告（"timed out"）；
 *   ⑥ ★ 文件即使产出了，只要从没显式调用过 declareDependency → 仍然失败
 *      （"空声明也必须显式说出来"这条纪律被状态机式地锁死）。
 *
 * 【测试技巧值得学】makeSessionHarness 捕获传给 runner 的选项（capturedOptions），
 *   让我们能在不开真会话的前提下断言"会话是怎么被配置的"。
 *
 * 【怎么跑】bun test tests/workflow-session.test.ts（纯逻辑 + 临时目录）
 *
 * 【本文件是教程注释版】原文件 tests/workflow-session.test.ts（a9de1cf），
 *   代码与本文件逐字一致，只是多了注释。
 * ═══════════════════════════════════════════════════════════════════════ */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostPreflight, ProjectDetection } from "../src/artifacts/index.js";
import {
  runWorkflowSession,
  type WorkflowSessionAgentOptions,
  type WorkflowSessionResult,
} from "../src/agents/workflow-session.js";

// 临时仓库：一个 src/main.c 就够（会话不会真读它——runner 是假的）。
function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-wfsess-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.c"), "int main(void){return 0;}\n");
  return root;
}

// 最小 HostPreflight 夹具：as unknown as 双重断言（形状不完整，测试够用即可）。
function minimalHost(): HostPreflight {
  return {
    kind: "host-preflight",
    version: 1,
    platform: process.platform,
    arch: process.arch,
    tools: {},
    paths: {},
  } as unknown as HostPreflight;
}

// 最小 ProjectDetection 夹具。
function minimalProject(root: string): ProjectDetection {
  return {
    kind: "project-detection",
    version: 1,
    repo_root: root,
    language: "c",
    build_systems: [],
    primary_build_system: null,
    markers: [],
    source_files: ["src/main.c"],
    adapter: "none",
    status: "ready",
    reason: null,
  } as unknown as ProjectDetection;
}

// runner 的行为开关：让每个测试自定义"假会话"的表现。
interface RunnerBehavior {
  /** Pre-write the test file before the runner returns. */
  writeTestEntry?: boolean;    // runner 返回前把 test 源文件写出来（模拟 AI 交付）
  /** Whether to simulate the agent having called declareDependency. */
  declared?: boolean;
  /** Whether to register a run-local build so declaration is valid. */
  generateBefore?: boolean;
  /** Simulate session error / timeout. */
  isError?: boolean;
  timedOut?: boolean;
  result?: string;
}

// 测试台架：搭目录、造假 runner 并捕获它收到的选项。
function makeSessionHarness(behavior: RunnerBehavior) {
  const repoDir = tempRepo();
  const sessionRoot = mkdtempSync(join(tmpdir(), "rfr-wfsess-run-"));
  const sessionId = "sess-123";
  // test 源文件的目标位置：runs/{session}/workflows/test/my-test.ts（B 方案固定布局）。
  const testEntry = join(
    sessionRoot,
    ".refactor",
    "runs",
    sessionId,
    "workflows",
    "test",
    "my-test.ts",
  );
  mkdirSync(join(testEntry, ".."), { recursive: true });
  // ↑ join(x, "..") 的妙用：拿到父目录路径再 recursive 创建。



  let capturedOptions: WorkflowSessionAgentOptions | null = null;
  const runner = async (o: WorkflowSessionAgentOptions): Promise<{
    result: string;
    isError: boolean;
    timedOut: boolean;
    denials: string[];
  }> => {
    capturedOptions = o;   // ★ 捕获：测试稍后检查"会话被怎么配置"
    if (behavior.writeTestEntry) {
      mkdirSync(join(testEntry, ".."), { recursive: true });
      writeFileSync(testEntry, "export const workflowKind = \"test-workflow-driven\";\n", "utf8");
    }
    return {
      result: behavior.result ?? "session done",
      isError: behavior.isError ?? false,
      timedOut: behavior.timedOut ?? false,
      denials: [],
    };
  };

  return {
    repoDir,
    sessionRoot,
    testEntry,
    run: (): Promise<WorkflowSessionResult> =>
      runWorkflowSession({
        repoDir,
        sessionRoot,
        sessionId,
        task: "verify trim behavior",
        testEntry,
        host: minimalHost(),
        project: minimalProject(repoDir),
        runAgentFn: runner,      // ★ 注入假 runner（不开真 Claude）
      }),
    captured: () => capturedOptions,
  };
}

describe("runWorkflowSession", () => {
  // ① 配置注入：子代理/MCP server/MCP 工具放行/skill 全部到位。
  test("passes agents, mcpServers and MCP allowed tools to the runner", async () => {
    const h = makeSessionHarness({ writeTestEntry: true });
    await h.run();
    const o = h.captured();
    expect(o).not.toBeNull();
    expect(o!.agents["build-writer"]).toBeDefined();
    expect(o!.mcpServers["dep-registry"]).toBeDefined();
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__inspectWorkflow");
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__declareDependency");
    expect(o!.extraAllowedTools).toContain("mcp__dep-registry__generateBuildWorkflow");
    expect(o!.skills).toContain("workflow-spec:workflow-spec");
  });

  // ② test 源文件没写出来 → 会话失败。
  test("fails when the test workflow file is not produced", async () => {
    const h = makeSessionHarness({ writeTestEntry: false });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("did not produce");
    expect(result.testEntryExists).toBe(false);
  });

  // ③ 提示词必须同时要求两个交付物 + 关键纪律（显式声明/禁止重建/查库/派子代理）。
  test("session prompt demands both deliverables (declaration + file)", async () => {
    const h = makeSessionHarness({ writeTestEntry: true });
    await h.run();
    const o = h.captured();
    expect(o!.prompt).toContain("declareDependency");
    expect(o!.prompt).toContain("empty array []");
    expect(o!.prompt).toContain("MUST NOT rebuild");
    expect(o!.prompt).toContain("inspectWorkflow");
    expect(o!.prompt).toContain("build-writer");
  });

  // ④ 会话出错且没有任何输出 → 失败。
  test("fails when the session errors without output", async () => {
    const h = makeSessionHarness({ isError: true, result: "" });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("failed without output");
  });

  // ⑤ 超时 → 如实报告。
  test("reports timeout", async () => {
    const h = makeSessionHarness({ timedOut: true, writeTestEntry: true });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("timed out");
  });

  // ⑥ ★ 文件在、但没显式 declareDependency → 仍失败（新鲜 registry 里没有声明记录）。
  test("fails when declaration was never called even if file exists", async () => {
    const h = makeSessionHarness({ writeTestEntry: true });
    const result = await h.run();
    // Fresh registry → declare never called → not explicit → failure.
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("declareDependency");
  });
});
