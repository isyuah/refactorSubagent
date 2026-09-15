/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/curator.test.ts —— 策展人（run-local build 转正 + alias 表）测试
 *
 * 【锁定了哪些行为】
 *   1. alias 表能写入/读回/查到（saveAlias → loadAliases → aliasLibraryId 闭环）；
 *   2. curateBuildWorkflow 把 run-local build 写进 .refactorsa 永久库，库 id 是
 *      run-local id 去掉会话尾巴，并把别名记录下来；
 *   3. 转正是幂等的（同一份源文件转正两次，库里只有一条）；
 *   4. 源文件缺失 → promoted=false，不抛错；
 *   5. description 会写进库 manifest，之后能被 dep-registry 的 inspectWorkflow 查到；
 *   6. 可以显式指定 libraryId 覆盖默认推导。
 *   测试对象：src/workflow/curator.ts（配合 registry.ts 与 dep-registry.ts）。
 *
 * 【本文件是教程注释版】
 *   原文件：tests/curator.test.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from "bun:test";
// ← 文件系统工具：mkdtempSync 建一次性临时目录（每个测试独占，互不污染）
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
// ← tmpdir 系统临时目录
import { tmpdir } from "node:os";
import { join } from "node:path";
// ← 被测对象：alias 表 + 转正函数
import {
  aliasLibraryId,
  curateBuildWorkflow,
  loadAliases,
  saveAlias,
} from "../src/workflow/curator.js";
// ← 用来验证"库条目真的出现了"
import { discoverBuildWorkflows } from "../src/workflow/registry.js";
// ← 用来验证"库条目能被 AI 的 inspectWorkflow 看到"
import { LocalDependencyRegistry } from "../src/agents/dep-registry.js";

// ← 一份最小的合法 workflow-driven build 源码（模板字符串跨多行）
//   ⚠️ 注意是模板字符串（反引号），里面的换行是内容的一部分
const VALID_BUILD = `export const workflowKind = "workflow-driven";
export default async () => { return; };
`;

// ── tempRepo：给每个测试一个干净的"假仓库" ──────────────────────────
// 【作用】建临时根目录 + 预建 run-local 目录（.refactor/runs/s1/workflows/build），
//         让测试可以往里面写"本次运行现写的 build"
function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rfr-curator-"));
  mkdirSync(join(root, ".refactor", "runs", "s1", "workflows", "build"), { recursive: true });
  return root;
}

describe("curator alias", () => {
  // 【测什么】别名表写入 → 查询 → 直接读表，三件事都成立。
  // 【为什么重要】alias 是声明制流程的"老 id 兼容层"：run 结束后拿 run-local id
  //   还能找到库条目。查不到时必须返回 null（而不是抛错），调用方靠它判断"还没转正"。
  test("alias round-trips through the alias file", () => {
    const root = tempRepo();
    expect(aliasLibraryId(root, "my-build-s1")).toBeNull();
    saveAlias(root, "my-build-s1", "my-build");
    expect(aliasLibraryId(root, "my-build-s1")).toBe("my-build");
    expect(loadAliases(root).aliases["my-build-s1"]).toBe("my-build");
  });
});

describe("curateBuildWorkflow", () => {
  // 【测什么】一条完整转正链路：写 run-local 源文件 → curate → 库里出现 trim-build，
  //   状态是 draft，别名记录在案，description 也进了 manifest。
  // 【为什么重要】这是 B 方案"run 结束收口"的主路径：run-local id 去掉尾巴变库 id，
  //   下次别的会话 inspectWorkflow 就能直接复用，不必每次重新写 build。
  test("promotes a run-local build into the library and records the alias", async () => {
    const root = tempRepo();
    const runLocalEntry = join(root, ".refactor", "runs", "s1", "workflows", "build", "trim-build-s1.ts");
    writeFileSync(runLocalEntry, VALID_BUILD, "utf8");

    const result = await curateBuildWorkflow({
      repoRoot: root,
      entry: runLocalEntry,
      runLocalId: "trim-build-s1",
      description: "builds trim_app test runner",
    });
    expect(result.promoted).toBe(true);
    // ← "trim-build-s1" 去掉尾巴 "-s1" 得到 "trim-build"：稳定 id 的推导规则就锁定在这
    expect(result.libraryId).toBe("trim-build");
    expect(aliasLibraryId(root, "trim-build-s1")).toBe("trim-build");

    const discovered = discoverBuildWorkflows(root);
    const lib = discovered.find((c) => c.manifest?.id === "trim-build");
    expect(lib).toBeDefined();
    // ← 新入库的条目状态是 draft，要等真正被复用并验证后才可能变 verified
    expect(lib?.status).toBe("draft");
    expect(existsSync(lib!.entry!)).toBe(true);
    expect(lib?.manifest?.description).toBe("builds trim_app test runner");
  });

  // 【测什么】同一份源文件转正两次，库里只有一个 dup 条目。
  // 【为什么重要】run 可能被重试/恢复，转正会被重复调用；幂等性保证不会在库里
  //   堆出一堆重复条目（registry 的 saveBuildWorkflow 发现 hash 相同就直接复用已存条目）。
  test("idempotent: second promote does not duplicate", async () => {
    const root = tempRepo();
    const runLocalEntry = join(root, ".refactor", "runs", "s1", "workflows", "build", "dup-s1.ts");
    writeFileSync(runLocalEntry, VALID_BUILD, "utf8");

    await curateBuildWorkflow({ repoRoot: root, entry: runLocalEntry, runLocalId: "dup-s1" });
    const second = await curateBuildWorkflow({ repoRoot: root, entry: runLocalEntry, runLocalId: "dup-s1" });
    expect(second.promoted).toBe(true);
    expect(discoverBuildWorkflows(root).filter((c) => c.manifest?.id === "dup")).toHaveLength(1);
  });

  // 【测什么】源文件不存在 → promoted=false，reason 说明 missing。
  // 【为什么重要】runs/ 目录可能被清理或归档；这种情况应该"跳过并记录"，而不是
  //   让整个收尾流程崩掉（调用方逐个处理，一条失败不影响其余 build 转正）。
  test("missing source is not promoted", async () => {
    const root = tempRepo();
    const result = await curateBuildWorkflow({
      repoRoot: root,
      entry: join(root, ".refactor", "runs", "s1", "workflows", "build", "ghost-s1.ts"),
      runLocalId: "ghost-s1",
    });
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("missing");
  });

  // 【测什么】description 写进库之后，AI 侧的 inspectWorkflow 能看到它，状态显示
  //   为 library-draft。
  // 【为什么重要】这一步把"宿主收口"和"AI 的可用性"接起来了：test-writer 之所以敢
  //   复用一个库 build，靠的就是 inspect 返回的描述与状态。描述丢了 = 复用决策瞎猜。
  test("library description is visible to dep-registry inspect", async () => {
    const root = tempRepo();
    const runLocalEntry = join(root, ".refactor", "runs", "s1", "workflows", "build", "vis-s1.ts");
    writeFileSync(runLocalEntry, VALID_BUILD, "utf8");
    await curateBuildWorkflow({
      repoRoot: root,
      entry: runLocalEntry,
      runLocalId: "vis-s1",
      description: "visible after promotion",
    });
    // ← 造一个真实的注册表实例（读同一个仓库根），模拟 AI 会话里能看到什么
    const reg = new LocalDependencyRegistry({
      workspaceRoot: root,
      sessionRoot: root,
      sessionId: "s1",
    });
    const items = await reg.inspect({ kind: "build" });
    const lib = items.items.find((item) => item.id === "vis");
    expect(lib?.status).toBe("library-draft");
    expect(lib?.description).toBe("visible after promotion");
  });

  // 【测什么】显式传 libraryId 时，库 id 和别名都用它（不走自动推导）。
  // 【为什么重要】自动推导只是"去掉尾巴"的猜测；想让库里的名字更语义化时得有出口，
  //   而且别名必须跟着显式名字走，否则旧 id 查不到新条目。
  test("honors an explicit library id", async () => {
    const root = tempRepo();
    const runLocalEntry = join(root, ".refactor", "runs", "s1", "workflows", "build", "x-s1.ts");
    writeFileSync(runLocalEntry, VALID_BUILD, "utf8");
    const result = await curateBuildWorkflow({
      repoRoot: root,
      entry: runLocalEntry,
      runLocalId: "x-s1",
      libraryId: "custom-lib-name",
    });
    expect(result.libraryId).toBe("custom-lib-name");
    expect(aliasLibraryId(root, "x-s1")).toBe("custom-lib-name");
  });
});
