/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】scripts/demo.ts —— 第 1 步演示：纯状态机（完全没有 AI）
 *
 * 【这个文件是干什么的】
 *   项目演进三部曲的第 1 步。它不碰任何 C 代码、不编译、不调用 Claude，
 *   只是把 tests/fixtures.ts 里**造好的假 artifact** 按顺序喂给状态机：
 *     ① 前 9 个 artifact 走"幸福路径"，一路推到 ACCEPTED；
 *     ② 再开一个全新会话，故意"犯规"，看状态机怎么 fail-closed 地拒绝。
 *   看完它你就明白了本项目最核心的一件事：**状态机只认"带 kind+version 的
 *   JSON 事实"，谁想跳步骤、谁想提交不合 Schema 的东西，都会被拒**。
 *
 * 【跑什么 / 要不要 Claude / 多久 / 期望输出】
 *   命令：bun run demo           （package.json → "demo": "bun run scripts/demo.ts"）
 *   要不要 Claude：不要（连 gcc/cmake 都不要）。
 *   耗时：毫秒级（只在系统临时目录建了两个会话文件夹）。
 *   期望输出：
 *     9 行 "✓ submit xxx → 下一状态"，最后一行 final state: ACCEPTED；
 *     然后 --- fail-closed checks --- 两段演示（跳步骤会被拒）。
 *     退出码恒为 0（本脚本从不设置 process.exitCode）。
 *
 * 【在整个项目里的位置】
 *   上游：package.json 的 "demo" 脚本。
 *   下游：src/orchestrator/orchestrator.ts（状态机）+ src/orchestrator/store.ts（会话存取）。
 *   演进的下一步：demo-e2e.ts（无 AI 的真实 C 差分）→ demo-agents.ts（真 Claude）。
 *
 * 【先修知识】
 *   ① 《零基础看懂教程.md》§1.3 的 10 步旅程与状态机图；
 *   ② tests/fixtures.ts（那些假 artifact 长什么样）；
 *   ③ structuredClone / 解构 / 可辨识联合这几个语法（下文遇到会讲）。
 * 【本文件是教程注释版】
 *   原文件：scripts/demo.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * End-to-end smoke: walk a fake C-refactoring session through every state,
 * then demonstrate fail-closed rejections.
 */
// ↑ 原文件自带的英文 doc 注释，一字未动：端到端冒烟——把一个假的 C 重构会话
//   走完所有状态，然后演示 fail-closed 拒绝。
import { mkdtempSync } from "node:fs";   // ← mkdtempSync：建一个"名字唯一"的临时目录（xxx-随机后缀）
import { tmpdir } from "node:os";        // ← tmpdir()：系统临时目录（Windows 上一般是 %TEMP%）
import { join } from "node:path";        // ← join：用平台正确的分隔符拼路径
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { SessionStore } from "../src/orchestrator/store.js";
import {
  happyPath,
  trace,
  patch,
  comparison,
} from "../tests/fixtures.js";
// ↑ 注意：trace / patch / comparison 在这里也被 import 进来——trace 和 patch 在
//   下面的"犯规演示"里用到了；comparison 其实没直接用到（happyPath() 内部已经含它）。

// ── 第 1 幕：幸福路径（一个全新会话从 INIT 走到 ACCEPTED）──────────
const root = mkdtempSync(join(tmpdir(), "refactor-demo-"));
const store = SessionStore.create(root, "demo-001");   // ← 会话目录：root/.refactor/sessions/demo-001
const orch = new Orchestrator(store);                  // ← 状态机持有一个 store，所有推进都写回磁盘

console.log(`session: ${store.id}  (${store.sessionDir})\n`);

// ← happyPath() 返回 9 个 artifact，顺序 = 状态机期望的提交顺序：
//   contract → scope → deps → tests → env → baseline trace → patch → candidate trace → comparison
for (const artifact of happyPath()) {
  // 【语法】structuredClone：深拷贝对象。为什么拷？因为 submit 成功后会把 artifact
  //   存进 store（存的是引用），不拷的话后面循环里复用的对象可能被改掉。
  const r = orch.submit(structuredClone(artifact));
  const tag = r.ok ? "✓" : "✗";
  console.log(
    `${tag} submit ${artifact.kind}` +
      (r.ok ? ` → ${r.to}` : ` — REJECTED: ${"reason" in r && r.reason}`),
  );
  // ↑【语法】"reason" in r：判断这个联合类型分支里有没有 reason 字段
  //   （失败分支才是 { ok: false, reason }）。r.ok 为真时这整个括号是 false，短路掉。
}

console.log(`\nfinal state: ${store.state}`);   // ← 应打印 ACCEPTED（最后一个 comparison 是 consistent）
console.log("history:");
for (const h of store.history) {
  // ← history 是完整的"状态迁移史"，每条记 from → to 和触发它的 artifact kind；
  //   abort 时 artifact_kind 为 null，所以打印成 "abort"
  console.log(`  ${h.from} → ${h.to}  [${h.artifact_kind ?? "abort"}]`);
}

// --- fail-closed demonstrations on a fresh session ---
// ↑ 原注释：在一个全新会话上演示 fail-closed。
console.log("\n--- fail-closed checks ---");
const store2 = SessionStore.create(root, "demo-002");
const orch2 = new Orchestrator(store2);

const skip = orch2.submit(patch());   // ← 犯规①：一上来就提交 patch（patch 要等 BASELINE_READY 才轮到）
console.log(`skip stage:        ${skip.ok ? "ACCEPTED?!" : skip.reason}`);
// ↑ 期望打印 R1 violation: INIT requires 'behavior-contract', got 'patch-record'
//   （如果真被接受了，打印 "ACCEPTED?!" —— 用感叹号提醒"这不该发生"）

// ← 先老老实实提交前两个 artifact（contract、scope），把状态推到 SCOPE_READY
orch2.submit(happyPath()[0]!);
orch2.submit(happyPath()[1]!);

// ← 犯规②：把第 3 个 artifact（依赖清单）换掉内容——只剩一个 system()，
//   kind: "concurrency"、strategy: "reject"（schema 里 reject 的注释是
//   "cannot verify safely → block refactoring touching this dep"：没法安全验证，
//   就禁止任何触碰这个依赖的重构）。
const outOfScope = orch2.submit({
  ...happyPath()[2]!,
  // 【语法】... 展开运算符：把原对象的字段抄一份，再用后面的字段覆盖同名者。
  //   这里就是"抄 deps() 然后只换 dependencies 数组"。
  dependencies: [
    { name: "system()", kind: "concurrency", strategy: "reject", evidence: [], notes: "" },
  ],
});
console.log(`dep manifest v2:   ${outOfScope.ok ? "ok → " + outOfScope.to : outOfScope.reason}`);
console.log(`state remains:     ${store2.state}`);
// ⚠️ 诚实说明：这一步在当前实现里【不会】被状态机拒绝——它过了 Zod Schema，
//    而状态机的语义检查（checkSemantic）目前只管 workflow-resolution、baseline、
//    patch 范围和对比结果，并不解释依赖策略。所以你会看到 "ok → DEPENDENCY_READY"。
//    这正是 demo 想让你看到的事实边界："reject" 只是一份**声明**，它约束的是
//    下游真正执行隔离策略的人；状态机在这一层只查"结构对不对、顺序对不对"。
