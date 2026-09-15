/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/state-machine.test.ts —— fail-closed 规则 R1~R7 的"法律条文"
 *
 * 【这个文件是干什么的】
 *   整个项目的灵魂是状态机 + fail-closed。本文件就是它的"最权威说明书"：
 *   每一个 test() 锁定一条规则的行为——不光测"合法路径能走通"，更测
 *   "每一种作弊手法都会被拒"。锁定的内容：
 *     R1  只能按顺序提交（跳步拒绝）
 *     R2  artifact 必须过 Zod Schema（缺字段拒绝）
 *     R3  baseline 上解释不了的失败必须分类（unknown 拒，preexisting_behavior 过）
 *     R4  patch 只能改 editable_files 里的文件
 *     R5  candidate 的用例集合必须覆盖 baseline 的全部用例
 *     R6  对比结果 inconsistent → 落到 REJECTED
 *     R7  终态（ACCEPTED/REJECTED/ABORTED）不可变
 *   外加一条工程能力：会话从磁盘重新打开（reopen）后能接着推进。
 *
 * 【在整个项目里的位置】
 *   被测对象是 src/orchestrator/orchestrator.ts（状态机）+ store.ts（落盘）。
 *   夹具来自 ./fixtures.ts（旧版差分路径的合法序列）。
 *   🔗 新版自驱动 TestWorkflow 的对应测试在 expectation-state-machine.test.ts。
 *
 * 【先修知识】src/orchestrator/orchestrator.ts 的 submit()/abort()、
 *   src/orchestrator/store.ts 的 create()/open()、fixtures.ts。
 *
 * 【bun test 语法】（第一次出现，后面文件不再重复讲）
 *   · import { describe, test, expect } from "bun:test" —— Bun 内置测试框架，
 *     不用装 jest/vitest。describe 给一组测试起名；test 定义一个用例；
 *     expect(实际值) 返回一堆断言方法。
 *   · beforeEach(fn) —— 每个 test 开始前都跑一遍 fn，用来造干净环境。
 *   · 常用断言：toBe（严格相等 ===）/ toEqual（深度相等，比对象内容）/
 *     toBeTrue / toBeFalse / toContain（子串或成员）/ toHaveLength。
 *   · test(name, fn, 超时毫秒) —— 第三个参数可给单个用例放宽超时（默认 5 秒）。
 *
 * 【需要真实 gcc/cmake 吗】不需要。全程只用临时目录 + 内存里的状态机，
 *   属于纯逻辑单测，跑得飞快。
 *
 * 【本文件是教程注释版】原文件 tests/state-machine.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";        // ← mkdtempSync：在系统临时目录里建一个"名字唯一"的新目录
import { tmpdir } from "node:os";             // ← 系统临时目录路径（Windows 上一般是 %TEMP%）
import { join } from "node:path";             // ← 跨平台路径拼接
import { Orchestrator } from "../src/orchestrator/orchestrator.js";   // ← 被测对象：状态机
import { SessionStore } from "../src/orchestrator/store.js";          // ← 被测对象：会话落盘
import {
  happyPath,
  trace,
  patch,
  comparison,
} from "./fixtures.js";

// 这两个变量声明在 describe 外面、beforeEach 里赋值，让同组所有 test 都能用。
let orch: Orchestrator;
let store: SessionStore;

// ── beforeEach：每个用例都从"全新会话"开始 ─────────────────────────────
// 用随机 id 建一个全新的 SessionStore + Orchestrator。这样测试之间零耦合：
// 上一个用例推进到 ACCEPTED 也不会影响下一个用例（它拿到的是空状态机）。
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "rfr-"));
  const id = "s-" + Math.random().toString(36).slice(2, 8);   // ← 随机 6 位会话 id
  store = SessionStore.create(root, id);      // ← create：目录必须不存在（已存在会抛错）
  orch = new Orchestrator(store);
});

/** Submit artifacts[0..n) of the happy path. */

// ── advance(n)：测试辅助函数 —— 把合法序列推进到第 n 步 ────────────────
// 【作用】把 happyPath() 的前 n 个 artifact 依次提交。任何一步失败都直接
//        抛异常（测试标记为失败），因为这是"搭台子"，台子没搭好后面的
//        断言就没有意义。
// 【语法】slice(0, n)：取数组前 n 个元素。`r.ok` 是 SubmitResult 的判别字段，
//        TypeScript 靠它收窄出 r.reason 的类型。
function advance(n: number) {
  for (const a of happyPath().slice(0, n)) {
    const r = orch.submit(a);
    if (!r.ok) throw new Error(`setup failed: ${r.reason}`);
  }
}

describe("fail-closed state machine", () => {
  // 【测什么】最好的情况：9 个 artifact 按序合法提交，最终 ACCEPTED，
  //           且历史上留下恰好 9 条转移记录（一次不多一次不少）。
  test("R1+R2: full legal path reaches ACCEPTED", () => {
    advance(9);
    expect(store.state).toBe("ACCEPTED");
    expect(store.history).toHaveLength(9);
  });

  // 【测什么】R1 跳步：INIT 时直接交第 2 个 artifact（scope），必须被拒，
  //           而且状态必须原地不动（不能"半提交"）。失败原因里要写明是 R1。
  // 【语法】happyPath()[1]! —— 末尾的 ! 是"非空断言"：TS 认为数组下标可能越界
  //           （类型是 undefined 的联合），我们用 ! 告诉编译器"这里一定有值"。
  test("R1: skipping a stage is rejected", () => {
    const r = orch.submit(happyPath()[1]!); // scope at INIT, contract missing
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("R1");   // ← 先收窄类型再取 reason，TS 的判别联合写法
    expect(store.state).toBe("INIT");
  });

  // 【测什么】R2 Schema 关卡：artifact 形状不对（behavior-contract 缺了整个
  //           channels 字段）必须在进门时被 Zod 拦下，状态不变。
  //           这就是"模型说的话必须过安检才能算数"的那道闸。
  test("R2: schema-invalid artifact is rejected without state change", () => {
    const r = orch.submit({ kind: "behavior-contract", version: 1 }); // no channels
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("schema");
    expect(store.state).toBe("INIT");
  });

  // 【测什么】R3：baseline 上有失败时，必须给出可信分类。
  //           category = "unknown"（说不清原因）→ 拒绝；
  //           category = "preexisting_behavior"（旧代码也这么失败，与本次改动
  //           无关）→ 放行。注意好的那份是用 structuredClone 深拷贝改出来的，
  //           坏的那份保持原样，两次提交互不影响。
  // 【语法】structuredClone(x)：内置的深拷贝（嵌套对象也复制一份）。
  test("R3: unclassified baseline failure blocks; preexisting_behavior passes", () => {
    advance(5);
    const bad = trace("baseline", {
      observations: [
        {
          case_id: "d1",
          status: "error",
          exit_code: -1,
          signal: null,
          stdout_b64: "",
          stderr_b64: "",
          filesystem: [],
          duration_ms: 0,
        },
      ],
      failures: [
        {
          case_id: "d1",
          category: "unknown",
          related_to_scope: false,
          explanation: "segfault, cause unclear",
        },
      ],
    });
    expect(orch.submit(bad).ok).toBeFalse();

    const good = structuredClone(bad)!;
    good.failures[0]!.category = "preexisting_behavior";
    good.failures[0]!.explanation =
      "old code also fails this case identically";
    expect(orch.submit(good).ok).toBeTrue();
  });

  // 【测什么】R4 范围红线：patch 改了 src/other.c（不在 editable_files 里），
  //           必须拒绝。这是"AI 不许动白名单以外的文件"在状态机层的兜底
  //           （执行期还有 PreToolUse Hook 那一道）。
  test("R4: patch outside editable scope is rejected", () => {
    advance(6);
    const r = orch.submit(patch(["src/other.c"]));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("R4");
  });

  // 【测什么】R5 用例集合一致：candidate 的观测少了一条（把 d2 砍掉），
  //           必须拒绝。否则 AI 只要"少测一个会失败的用例"就能蒙混过关。
  test("R5: candidate trace missing baseline cases is rejected", () => {
    advance(7);
    const partial = trace("candidate");
    partial.observations = partial.observations.slice(0, 2); // drop d2
    const r = orch.submit(partial);
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain("R5");
  });

  // 【测什么】R6 对比结果决定裁决：d1 是 mismatch → 整体 inconsistent →
  //           状态机走到 REJECTED。注意 submit 返回 ok: true——
  //           "提交成功，裁决是拒绝"和"提交被拒"是两码事。
  test("R6: inconsistent comparison lands on REJECTED", () => {
    advance(8);
    const r = orch.submit(comparison(["match", "mismatch", "match"]));
    expect(r).toEqual({ ok: true, from: "VERIFICATION_RUNNING", to: "REJECTED" });
    expect(store.state).toBe("REJECTED");
  });

  // 【测什么】R7 终态不可变：已经 ACCEPTED 之后，连 abort() 都不能再改状态。
  //           这保证"裁决"一旦给出就无法被后续操作洗掉（可审计）。
  test("R7: terminal states are immutable", () => {
    advance(9);
    const r = orch.abort("try again");
    expect(r.ok).toBeFalse();
  });

  // 【测什么】workflow recovery：会话落盘后，用 SessionStore.open() 从磁盘
  //           重新打开，状态应该还在 DEPENDENCY_READY，而且能继续往下提交。
  //           这是"崩溃恢复"能力的地基。
  // ⚠️ 生产入口目前只调 create()，没有调用 open()（见教程任务 #7）——
  //    所以这里测的是"纸面上已经具备"的恢复能力，不是已经接通的能力。
  // 【语法】split(".refactor")[0]! —— 从会话目录路径反推出工作区根目录。
  test("workflow recovery: reopened session resumes at stored state", () => {
    advance(3);
    const root = store.sessionDir.split(".refactor")[0]!;
    const reopened = SessionStore.open(root, store.id);
    expect(reopened.state).toBe("DEPENDENCY_READY");
    expect(new Orchestrator(reopened).submit(happyPath()[3]!).ok).toBeTrue();
  });
});
