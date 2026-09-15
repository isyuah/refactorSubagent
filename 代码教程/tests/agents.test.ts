/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】tests/agents.test.ts —— AI 会话层的边界：JSON 提取、范围拦截、输入归一化
 *
 * 【这个文件是干什么的】
 *   锁定 src/agents/driver.ts 里三个"纯函数"的行为（它们是所有 AI 会话的
 *   安全底座）：
 *     ① extractJson          —— 从 Claude 的自由文本回答里抠出 JSON
 *     ② checkToolScope       —— 每次工具调用（Read/Glob/Grep/Write…）前
 *                               检查路径是否越界（fail-closed）
 *     ③ normalizeToolInput   —— 把相对路径换算成"以 Agent 工作目录为根"的绝对路径
 *   另外锁定 ScopeManifest Schema 的一条自洽性规则：
 *     readable_globs 和 forbidden_globs 不允许重叠（否则规则自相矛盾）。
 *
 * 【在整个项目里的位置】
 *   checkToolScope 被 driver.ts 的 PreToolUse Hook 调用——也就是真正"拦下
 *   AI 越界"的那段代码。教程 §1.5 提到 r11 实测拦下 2 次越界，靠的就是它。
 *
 * 【先修知识】glob 通配（** 任意层级）、Zod Schema 的 refine（自定义校验）。
 *
 * 【需要真实 gcc/cmake 吗】不需要。这里会写临时文件，但不编译任何东西，
 *   不调用任何模型——纯逻辑单测。
 *
 * 【本文件是教程注释版】原文件 tests/agents.test.ts，代码逐字一致。
 * ═══════════════════════════════════════════════════════════════════ */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkToolScope,              // ← 工具调用范围检查（本文件的主角）
  DEFAULT_AGENT_FORBIDDEN_GLOBS,  // ← 内置的"永远禁止"清单（.git、.refactor 等）
  extractJson,                 // ← 从自由文本里抽 JSON
  normalizeToolInput,          // ← 相对路径 → 绝对路径
} from "../src/agents/driver.js";
import { ScopeManifest } from "../src/artifacts/scope-manifest.js";

describe("extractJson", () => {
  // 【测什么】最常见的形态：模型把 JSON 包在 ```json ...``` 代码围栏里，
  //   前后还带着说明文字。必须能把中间那段干净地解析出来。
  // 【语法】'...' 单引号字符串里用 \n 表示换行；toEqual 做深度比较。
  test("parses fenced json block", () => {
    const out = extractJson('intro\n```json\n{"a": 1}\n```\ntrailer');
    expect(out).toEqual({ a: 1 });
  });

  // 【测什么】模型没加围栏、直接吐一个 JSON 对象，也得能解析。
  test("parses bare json object", () => {
    expect(extractJson('{"b": [1,2]}')).toEqual({ b: [1, 2] });
  });

  // 【测什么】完全没 JSON 时要抛错——不能悄悄返回 undefined 让下游拿着
  //   空值继续跑。抛错才会触发上游的"重试一次"逻辑（analyze.ts）。
  // 【语法】expect(() => f()).toThrow()：断言"调用时会抛异常"，
  //   所以这里传的是一个函数而不是调用结果。
  test("throws when nothing parses", () => {
    expect(() => extractJson("no json here")).toThrow();
  });

  // 【测什么】歧义裁决：文本里既有裸 JSON 又有围栏块时，必须优先信围栏。
  //   这防止"模型先在正文里举例说明，再给出真正答案"的情况解析错对象。
  test("prefers fenced block over surrounding text", () => {
    const out = extractJson('{"wrong": true}\n```json\n{"right": false}\n```');
    expect(out).toEqual({ right: false });
  });
});

describe("Agent scope enforcement", () => {
  // 【测什么】范围检查的全景表 —— 一次测完 8 种情况，读这张表就懂了权限模型：
  //   读白名单内的文件            → 放行
  //   读 forbidden_globs 里的文件  → 拒，理由含 "forbidden"（禁止读，不只是不许改！）
  //   读 readable_globs 外的文件   → 拒，理由含 "Observation Scope"（可读范围）
  //   Glob 在可读目录             → 放行
  //   Grep 可能扫到 forbidden 区域 → 拒，理由含 "may include forbidden"（宁可错杀）
  //   写 editable 文件            → 放行
  //   写 editable 外的文件        → 拒，理由含 "Modification Scope"（可改范围）
  //   写 forbidden 目录里的新文件  → 拒（即便它在 editable 列表里，forbidden 优先）
  //   路径逃出工作区（../）        → 拒，理由含 "escapes"
  //   👉 最后一条尤其重要：forbidden > editable 的优先级，和"路径逃逸"的兜底。
  test("checks read, search, and write scopes fail-closed", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "rfr-agent-scope-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "src", "main.c"), "int main(void){return 0;}\n");
    writeFileSync(join(root, "tests", "secret.c"), "int secret(void){return 1;}\n");

    const readable = ["src/**"];
    const forbidden = ["tests/**", ...DEFAULT_AGENT_FORBIDDEN_GLOBS];   // ← ... 展开数组合并
    const editable = ["src/main.c"];
    expect(checkToolScope("Read", { file_path: "src/main.c" }, root, readable, forbidden, editable).allowed).toBeTrue();
    expect(checkToolScope("Read", { file_path: "tests/secret.c" }, root, ["**"], forbidden, editable).reason).toContain("forbidden");
    expect(checkToolScope("Read", { file_path: "README.md" }, root, readable, forbidden, editable).reason).toContain("Observation Scope");
    expect(checkToolScope("Glob", { path: "src", pattern: "*.c" }, root, readable, forbidden, editable).allowed).toBeTrue();
    expect(checkToolScope("Grep", { path: ".", glob: "**/*.c" }, root, ["**"], forbidden, editable).reason).toContain("may include forbidden");
    expect(checkToolScope("Write", { file_path: "src/main.c" }, root, readable, forbidden, editable).allowed).toBeTrue();
    expect(checkToolScope("Write", { file_path: "src/other.c" }, root, readable, forbidden, editable).reason).toContain("Modification Scope");
    // An editable entry is host authorization by construction: it wins over
    // broad forbidden globs (e.g. a run-local deliverable under .refactor/**).
    // ★ 新版语义反转：editable 白名单是宿主的显式授权，优先级高于宽泛的 forbidden——
    //   否则 test-writer 没法写它在 .refactor/** 下的交付物。
    expect(checkToolScope("Write", { file_path: "tests/generated.c" }, root, ["**"], forbidden, ["tests/generated.c"]).allowed).toBeTrue();
    // Without an editable entry, the same path stays forbidden.
    expect(checkToolScope("Write", { file_path: "tests/other.c" }, root, ["**"], forbidden, editable).reason).toContain("forbidden");
    expect(checkToolScope("Read", { file_path: "../outside.c" }, root, ["**"], [], editable).reason).toContain("escapes");
    // Claude Code sends Glob with an absolute repo-root path plus a pattern;
    // a pattern targeting a readable subtree must not be denied just because
    // the bare root is not itself listed as readable.
    // ★ 新增：Glob 常带"绝对根路径 + pattern"，判定看 pattern 指向的子树是否可读。
    expect(checkToolScope("Glob", { path: root, pattern: "src/**" }, root, readable, forbidden, editable).allowed).toBeTrue();
    expect(checkToolScope("Glob", { path: root, pattern: "tests/**" }, root, readable, forbidden, editable).reason).toContain("forbidden");
    expect(checkToolScope("Glob", { path: root, pattern: "**/*" }, root, readable, forbidden, editable).reason).not.toBeNull();
  });
});
describe("Agent tool input normalization", () => {
  // 【测什么】模型给的工具参数是相对路径（它看不到你的绝对路径），
  //   检查前必须先换算成以 Agent 工作目录为根的绝对路径，否则 glob 匹配
  //   会全部失灵。注意第三条：Grep 的 path 写 "." 会被归一化为 root，
  //   但 glob 模式本身保持原样。
  // 👉 最后一条很关键：`../outside.c` 归一化后返回 null——也就是"这参数
  //    根本不合法"，直接在归一化阶段就否掉，不给后面检查的机会。
  test("resolves relative file and search roots under the agent cwd", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "rfr-agent-normalize-"));
    expect(normalizeToolInput("Read", { file_path: "src/main.c" }, root)).toEqual({
      file_path: join(root, "src", "main.c"),
    });
    expect(normalizeToolInput("Glob", { path: "src", pattern: "*.c" }, root)).toEqual({
      path: join(root, "src"),
      pattern: "*.c",
    });
    expect(normalizeToolInput("Grep", { path: ".", glob: "src/**/*.c" }, root)).toEqual({
      path: join(root, "src"),
      glob: "src/**/*.c",
    });
    expect(normalizeToolInput("Read", { file_path: "../outside.c" }, root)).toBeNull();
  });
});

describe("ScopeManifest validation", () => {
  // 【测什么】Schema 自身的自洽性：可读范围和禁止范围不允许重叠。
  //   两段都断言抛出 "must not overlap"：
  //   第一段 —— readable "src/**" 与 forbidden "src/trim.h" 重叠（子路径也算）；
  //   第二段 —— readable "**"（全宇宙）与任何 forbidden 都必然重叠。
  //   👉 如果放任重叠，Hook 就得自己决定"哪条赢"，那等于把安全策略交给运气。
  // 【语法】ScopeManifest.parse(...)：Zod 的 parse 在校验失败时直接抛异常，
  //   所以配合 toThrow(部分匹配的文案) 用。
  test("rejects readable and forbidden globs that overlap", () => {
    expect(() => ScopeManifest.parse({
      kind: "scope-manifest",
      version: 1,
      editable_files: [{ file: "src/trim.c", symbols: ["trim_in_place"] }],
      readable_globs: ["src/**"],
      forbidden_globs: ["src/trim.h"],
    })).toThrow("must not overlap");

    expect(() => ScopeManifest.parse({
      kind: "scope-manifest",
      version: 1,
      editable_files: [{ file: "src/trim.c", symbols: ["trim_in_place"] }],
      readable_globs: ["**"],
      forbidden_globs: ["tests/**"],
    })).toThrow("must not overlap");
  });
});
