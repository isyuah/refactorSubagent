/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/build-workflow.test.ts —— BuildWorkflow 的解析、校验与注册表生命周期
 *
 * 【这个文件是干什么的】
 *   锁定 src/workflow/build-workflow.ts（resolveBuildWorkflow）+ registry.ts
 *   的一整套门槛行为：
 *     ① CLI 参数能解析出 workflow build 子命令（含默认值）；
 *     ② 一段合法的 BuildWorkflow 源码 → 执行 → 过 Zod 校验 → 生成带
 *        64 位 source_hash 的 manifest；
 *     ③ 产物路径越出工作区（"../outside"）→ 直接拒绝（escapes workspace）；
 *     ④ 存进注册表后能被原样读回（源码一字不差、hash 一致、产物一致、能被发现）；
 *     ⑤ ⚠️ 关键的"防篡改"行为：存进去之后有人改了源码（哪怕只加一行注释），
 *        hash 对不上 → 加载直接抛 "source hash mismatch"，发现时把它标成 stale。
 *
 * 【在整个项目里的位置】
 *   这是教程 §1.5"注册表（.refactorsa/）"的核心：selected 快速路径能安全复用，
 *   靠的就是这份 hash 校验——复用一段被偷偷改过的 workflow 等于绕过整个
 *   审查体系。
 *
 * 【先修知识】模板字符串 + .replace()（用来给合法源码"注入"一个坏路径）、
 *   expect(...).rejects.toThrow(...)（断言 Promise 会 reject）。
 *
 * 【需要真实 gcc/cmake 吗】不需要真的编译。声明式 workflow 在 resolve 阶段
 *   只是把函数跑一遍拿到结构化对象，不调用编译器。但 probeHost/detectCProject
 *   会探测工具，所以用例超时放到 30~60 秒。
 *
 * 【本文件是教程注释版】原文件 tests/build-workflow.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCliArgs } from "../src/cli/args.js";
import { probeHost } from "../src/runtime/host-preflight.js";
import { detectCProject } from "../src/runtime/project-detector.js";
import { resolveBuildWorkflow } from "../src/workflow/build-workflow.js";
import {
  discoverBuildWorkflows,
  loadBuildWorkflow,
  saveBuildWorkflow,
} from "../src/workflow/registry.js";

// 造一个"带 workflow 源码的临时项目"：main.c + workflow.ts。
function tempBuildProject(workflow: string): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-build-workflow-"));
  writeFileSync(join(root, "main.c"), "int main(void){return 0;}\n");
  writeFileSync(join(root, "workflow.ts"), workflow);
  return root;
}

// 一段合法的【声明式】BuildWorkflow：默认导出函数，拿到 facts 后直接返回
// BuildWorkflowOutput（环境规格 direct-compiler + 产物路径 build/app）。
const validWorkflow = `
export default ({ facts }) => ({
  kind: "build-workflow-output",
  version: 1,
  workflow_id: "direct-smoke",
  workflow_revision: 3,
  environment: {
    kind: "environment-spec",
    version: 1,
    build: {
      kind: "direct-compiler",
      compiler: "gcc",
      flags: [],
      defines: {},
      sources: ["main.c"],
      output: "build/app"
    },
    sanitizers: [],
    determinism: { frozen_time_epoch_ms: null, random_seed: null, intercept_headers: [] },
    sandbox: { run_cwd_strategy: "fresh_temp_dir" }
  },
  artifact: {
    kind: "executable",
    version: 1,
    workflow_id: "direct-smoke",
    workflow_revision: 3,
    paths: { app: "build/app" },
    metadata: { detected: facts.project?.primary_build_system ?? null }
  }
});
`;

describe("BuildWorkflow planning and registry", () => {
  // 【测什么】CLI 解析面：`workflow build <file> --id ... --revision ...`
  //   这串命令行参数要被解析成一个结构化对象。重点看默认值：
  //   save: false（默认不入库）、timeoutMs: 60_000（默认 60 秒）、
  //   cwd: process.cwd()（默认当前目录）。
  test("parses the build workflow CLI command", () => {
    expect(parseCliArgs([
      "workflow",
      "build",
      "workflow.ts",
      "--id",
      "direct-smoke",
      "--revision",
      "3",
      "--manifest-out",
      ".refactorsa/build.json",
      "--format",
      "json",
    ])).toEqual({
      kind: "workflow-build",
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: process.cwd(),
      manifestOut: ".refactorsa/build.json",
      save: false,
      timeoutMs: 60_000,
      format: "json",
    });
  });

  // 【测什么】主流程：源码 → 执行 → 校验 → manifest。逐项核对：
  //   manifest 的 id/revision 与传入一致、source_hash 是 64 位、
  //   output 非 null、产物路径是 { app: "build/app" }、status 是 draft。
  // 【语法】`"kind" in result.output.environment.build` 用 in 判断字段存在，
  //   这是 TS 类型收窄的手段之一：收窄之后才能安全访问 .kind 的具体值。
  test("validates workflow output and generates a source-hashed manifest", async () => {
    const root = tempBuildProject(validWorkflow);
    const host = probeHost(root);
    const project = detectCProject(root, host);
    const result = await resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: root,
      host,
      project,
    });

    expect(result.manifest.id).toBe("direct-smoke");
    expect(result.manifest.revision).toBe(3);
    expect(result.manifest.source_hash).toHaveLength(64);   // ← sha256 十六进制长度
    expect(result.output).not.toBeNull();
    if (result.output === null) return;
    if (!("kind" in result.output.environment.build) || result.output.environment.build.kind !== "direct-compiler") {
      throw new Error("expected direct compiler environment");
    }
    expect(result.output.environment.build.kind).toBe("direct-compiler");
    expect(result.output.artifact.paths).toEqual({ app: "build/app" });
    expect(result.manifest.status).toBe("draft");
  }, 60_000);

  // 【测什么】路径逃逸防护：把产物路径从 "build/app" 换成 "../outside"，
  //   resolve 必须 reject，错误信息里要有 "escapes workspace"。
  //   👉 workflow 源码也是不可信代码，它声明要写到哪里必须被关在
  //      工作区之内——这是沙箱的"出墙检测"。
  // 【语法】validWorkflow.replace(a, b)：在源码字符串里做替换，构造坏输入；
  //   await expect(promise).rejects.toThrow(msg)：断言这个 Promise 会以
  //   含 msg 的错误 reject（注意要传 Promise 本身，不是 await 之后的结果）。
  test("rejects an artifact path that escapes the workflow workspace", async () => {
    const root = tempBuildProject(validWorkflow.replace('"build/app" },', '"../outside" },'));
    await expect(resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: root,
    })).rejects.toThrow("escapes workspace");
  }, 60_000);

  // 【测什么】注册表的完整闭环：save → load → discover。
  //   · 存进去的源码文件内容必须与原始字符串【一字不差】；
  //   · 读回来的 manifest hash 与解析时算的一致；
  //   · 读回的产物路径也对；
  //   · discover 能发现这 1 条候选，状态 draft。
  test("saves and discovers a workflow revision with a verified source hash", async () => {
    const root = tempBuildProject(validWorkflow);
    const host = probeHost(root, { skipCMakeProbe: true });   // ← 跳过 cmake 探测，省时间
    const project = detectCProject(root, host);
    const resolution = await resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: root,
      host,
      project,
    });
    const saved = saveBuildWorkflow(root, resolution);
    const loaded = loadBuildWorkflow(saved.manifestPath, root);
    const candidates = discoverBuildWorkflows(root, host, project);

    expect(readFileSync(saved.entry, "utf8")).toBe(validWorkflow);
    expect(loaded.manifest.source_hash).toBe(resolution.sourceHash);
    expect(loaded.output?.artifact.paths).toEqual({ app: "build/app" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe("draft");
  }, 30_000);

  // 【测什么】防篡改（本文件最重要的一条）：存好之后往源码文件里追加
  //   一行注释 `// drift`——对功能毫无影响的改动，但 hash 变了。
  //   结果：loadBuildWorkflow 直接抛 "source hash mismatch"，
  //   discoverBuildWorkflows 把它标成 status: "stale"。
  //   👉 注册表里的 workflow 一旦被改过，就不许再被复用——
  //      这是 fail-closed 在"复用"这件事上的体现。
  test("marks a persisted workflow stale after source drift", async () => {
    const root = tempBuildProject(validWorkflow);
    const resolution = await resolveBuildWorkflow({
      entry: "workflow.ts",
      workflowId: "direct-smoke",
      revision: 3,
      cwd: root,
    });
    const saved = saveBuildWorkflow(root, resolution);
    writeFileSync(saved.entry, `${validWorkflow}\n// drift\n`);

    expect(() => loadBuildWorkflow(saved.manifestPath, root)).toThrow("source hash mismatch");
    expect(discoverBuildWorkflows(root)).toEqual([
      expect.objectContaining({ status: "stale" }),
    ]);
  });
});
