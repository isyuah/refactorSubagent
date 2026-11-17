/** Prepare a real C project and a tested review bundle. This command never calls a model. */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createTwoFilesPatch } from "diff";
import { probeHost } from "../src/runtime/host-preflight.js";
import { resolveHead } from "../src/runtime/worktree.js";
import { saveTestPlan } from "../src/testing/bundle.js";
import { TestPreparation } from "../src/testing/preparation.js";
import { emptyTrial, type PlanContent } from "../src/testing/types.js";
import { freezeVerificationMaterials, serializeVerificationMaterials } from "../src/workflow/verification-materials.js";
import { RunDisplay } from "../src/cli/display.js";

const args = Bun.argv.slice(2);
const usage = "Usage: bun scripts/setup-test-preparation-demo.ts [--out <new directory>]";
if (args.length === 1 && args[0] === "--help") { console.log(usage); process.exit(0); }
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out")) throw new Error(usage);
const destination = resolve(args[1] ?? "runs/test-preparation-playground");
if (existsSync(destination)) throw new Error(`体验目录已存在，保留现有内容。请用 --out 指定新目录：${destination}`);
const template = fileURLToPath(new URL("../examples/test-preparation/", import.meta.url));
const repo = join(destination, "repo");
mkdirSync(destination, { recursive: true });
cpSync(join(template, "repo"), repo, { recursive: true });
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
git(["init", "-q", "--initial-branch=main"]);
git(["config", "core.autocrlf", "false"]);
git(["config", "user.name", "Test preparation demo"]);
git(["config", "user.email", "demo@example.invalid"]);
git(["add", "."]);
git(["-c", "user.name=Test preparation demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "Initial text_copy library"]);
const host = probeHost(repo);
if (!["gcc", "clang", "cc"].some(name => host.tools[name]?.available)) throw new Error(`体验示例需要 gcc、clang 或 cc。添加到 PATH 后，请用 --out 指定一个新目录。项目已保留：${repo}`);
const scope = "保护 text_copy 的正常复制、恰好容纳、截断、容量为 0/1、空字符串和 NULL 参数；观察返回状态、copied、required、终止符、无效输入不写入和缓冲区外字节。输入遵守头文件中的 NUL 结尾与不重叠前提。";
const task = "合并 text_copy 中完整复制与截断复制的重复循环，保持公开接口、状态、长度、终止符、无效输入不写入和缓冲区外字节完全不变。";
const revisionRequest = "补充容量为 2 的截断场景，以及无效源指针时目标缓冲区所有字节保持不变的独立检查，并同步更新场景说明。";
const cases = [
  { name: "正常复制", input: "hello，容量 16", status: 0, copied: 5, required: 5, text: "hello", terminated: true, untouched: false },
  { name: "恰好容纳", input: "hello，容量 6", status: 0, copied: 5, required: 5, text: "hello", terminated: true, untouched: false },
  { name: "截断复制", input: "hello，容量 4", status: 1, copied: 3, required: 5, text: "hel", terminated: true, untouched: false },
  { name: "容量为一", input: "hello，容量 1", status: 1, copied: 0, required: 5, text: "", terminated: true, untouched: false },
  { name: "空字符串", input: "空字符串，容量 4", status: 0, copied: 0, required: 0, text: "", terminated: true, untouched: false },
  { name: "零容量查询", input: "hello，NULL 目标，容量 0", status: 1, copied: 0, required: 5, text: "", terminated: false, untouched: true },
  { name: "空串零容量", input: "空字符串，NULL 目标，容量 0", status: 1, copied: 0, required: 0, text: "", terminated: false, untouched: true },
  { name: "空源指针", input: "NULL 源，目标预填 #，容量 8", status: 2, copied: 0, required: 0, text: "########", terminated: false, untouched: true },
  { name: "空目标指针", input: "hello，NULL 目标，容量 4", status: 2, copied: 0, required: 0, text: "", terminated: false, untouched: true },
  { name: "长字符串截断", input: "320 个 x，容量 8", status: 1, copied: 7, required: 320, text: "xxxxxxx", terminated: true, untouched: false },
];
const source = (name: string) => readFileSync(join(template, "verification", name), "utf8");
const content: PlanContent = {
  metadata: { scope, delivery: "complete", base_sha: resolveHead(repo), host, trial: emptyTrial(),
    analysis: {
      subject: "src/text_copy.c: text_copy",
      recommendation: { strategy: "source-harness", rationale: "项目只构建静态库，没有可直接执行的程序或测试。函数不依赖文件、网络或外部服务，可用小型 C 辅助程序直接调用真实实现。此预置方案由体验脚本提供，未调用 AI。", alternatives: ["先构建静态库再链接辅助程序也可行，但本例直接编译两个 C 文件即可。"] },
      behaviors: ["正常复制与恰好容纳", "截断及 0/1 容量边界", "空字符串与 NULL 参数", "状态、复制长度、原长度、终止符和缓冲区边界"],
      dependencies: [{ name: "C 标准库 strlen", kind: "compile", treatment: "real", rationale: "使用本机 C 工具链和真实标准库，无需模拟依赖。" }],
      evidence: [{ basis: "source", reference: "include/text_copy.h: text_copy", finding: "头文件明确了容量、NULL、终止符和不重叠前提。" }, { basis: "source", reference: "CMakeLists.txt: add_library", finding: "只定义静态库，没有可执行程序与现成测试。" }],
      limitations: ["未枚举所有字符串和容量组合。", "没有测试超出接口前提的非 NUL 结尾或重叠缓冲区。", "守卫字节检查只覆盖辅助程序分配的缓冲区。"], openQuestions: [],
    },
    review: { version: 1, scenarios: cases.map(c => ({ id: c.name, title: c.name, purpose: `观察${c.name}时的返回信息、写入结果及缓冲区边界`, inputs: [c.input], observations: [c.name], sourceReferences: ["include/text_copy.h: text_copy", "src/text_copy.c: text_copy"] })) },
  },
  test: { source: source("test.ts"), workflowId: "text-copy-demo-test", revision: 1 },
  builds: [{ id: "text-copy-harness", workflowId: "text-copy-demo-build", revision: 1,
    description: "编译 src/text_copy.c 与固定辅助 C 代码，生成 build/verification/text_copy_harness（Windows 加 .exe）；无参数运行，stdout 每行输出一项 JSON 观测。",
    source: source("build.ts"), materials: serializeVerificationMaterials(freezeVerificationMaterials([{ path: "build/verification/harness.c", content: source("harness.c") }])) }],
};
const localStateDir = join(repo, ".refactor", "test-plan-dialogues");
const seed = saveTestPlan({ parent: join(destination, "seed"), id: "text-copy-demo", content, history: [], evidenceDirs: [], dialogue: null, localStateDir });
const display = new RunDisplay({ verbosity: "summary", progress: "plain", format: "human", color: true });
const preparation = new TestPreparation({ repo, sessionRoot: join(destination, "sessions"), session: "preview-trial", from: seed.directory, onProgress: display.receive });
const cancelled = () => preparation.cancel();
process.on("SIGINT", cancelled); process.on("SIGTERM", cancelled);
try {
  console.error("正在编译并试跑预置方案，不调用模型……");
  await preparation.trial();
  const trial = preparation.view().content.metadata.trial;
  if (trial.status !== "pass") throw new Error(`示例试跑失败：${trial.failure?.reason}；证据：${trial.evidence_dir}`);
  for (const c of cases) {
    const expected = { status: c.status, copied: c.copied, required: c.required, text: c.text, terminated: c.terminated, guards: true, untouched: c.untouched };
    if (!isDeepStrictEqual(trial.observations.find(o => o.name === c.name)?.value, expected)) throw new Error(`示例观测不符合源码契约：${c.name}；证据：${trial.evidence_dir}`);
  }
  const saved = preparation.save(join(destination, "plans"));
  const original = readFileSync(join(repo, "src", "text_copy.c"), "utf8").replaceAll("\r\n", "\n");
  const refactored = original.slice(0, original.indexOf("    if (length < capacity) {")) + `    size_t limit = length < capacity ? length : capacity - 1;
    for (i = 0; i < limit; ++i) {
        dst[i] = src[i];
    }
    dst[i] = '\\0';
    result.copied = i;
    result.status = length < capacity ? TEXT_COPY_OK : TEXT_COPY_TRUNCATED;
    return result;
}
`;
  const patch = join(destination, "refactor.patch");
  writeFileSync(patch, createTwoFilesPatch("a/src/text_copy.c", "b/src/text_copy.c", original, refactored));
  const offlinePipeline = join(destination, "offline-pipeline.json");
  writeFileSync(offlinePipeline, JSON.stringify({ version: 1, stages: {
    workflows: { mode: "test-plan", directory: saved.directory },
    refactor: { mode: "patch", patchFile: patch },
  } }, null, 2) + "\n");
  const quote = (value: string): string => process.platform === "win32" ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const commands = {
    review: `bun ${quote(cli)} tests review ${quote(repo)} --from ${quote(saved.directory)}`,
    prepare: `bun ${quote(cli)} tests prepare ${quote(repo)} --scope ${quote(scope)}`,
    runOffline: `bun ${quote(cli)} run ${quote(repo)} --task ${quote(task)} --pipeline-file ${quote(offlinePipeline)} --auto-retry 0 --session-root ${quote(join(destination, "sessions"))}` ,
    run: `bun ${quote(cli)} run ${quote(repo)} --tests ${quote(saved.directory)} --task ${quote(task)}`,
  };
  const result = { repo, offlinePipeline, patch, plan: saved.directory, trial: { status: trial.status, duration_ms: trial.duration_ms, builds: trial.builds.length, observations: trial.observations.length }, scope, task, revisionRequest, commands };
  writeFileSync(join(destination, "experience.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  process.off("SIGINT", cancelled); process.off("SIGTERM", cancelled);
  display.stop(); preparation.close();
}
