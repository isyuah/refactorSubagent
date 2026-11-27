import { describe, expect, test } from "bun:test";
import { compareExpectations } from "../src/workflow/expectation-compare.js";
import type { ExpectationDeclaration } from "../src/workflow/types.js";

/**
 * 比较器的单侧语义：both-matches 下基线侧（未经改动的原版代码）是否匹配
 * 考卷自己声明的模式。基线自违说明考卷的期望值与事实矛盾，候选怎么改都
 * 消除不了——路由器据此判"考卷可疑"而不是把预算烧在修代码上。
 */

const decl = (
  name: string,
  relation: ExpectationDeclaration["relation"],
  value: unknown,
  pattern?: string,
): ExpectationDeclaration => ({ name, relation, value, ...(pattern !== undefined ? { pattern } : {}) });

describe("compareExpectations — baseline self-verification", () => {
  test("both-matches: 两侧都匹配 → matched", () => {
    const outcome = compareExpectations(
      [decl("digest", "both-matches", "file=aaa", "^file=aaa$")],
      [decl("digest", "both-matches", "file=aaa", "^file=aaa$")],
    );
    expect(outcome.overall).toBe("consistent");
    expect(outcome.mismatched).toHaveLength(0);
  });

  test("both-matches: 仅基线侧不匹配（候选侧匹配）→ 考卷自违，baselineMatched=false", () => {
    // 真正的单侧象限：候选值匹配考卷模式，基线值不匹配。这样把
    // baselineSelfMatch(b) 误写成 baselineSelfMatch(c) 时本断言会失败。
    const outcome = compareExpectations(
      [decl("test/test-strscpy.c.digest", "both-matches", "test/test-strscpy.c=e3710c8d", "^test/test-strscpy\\.c=43b0aeae$")],
      [decl("test/test-strscpy.c.digest", "both-matches", "test/test-strscpy.c=43b0aeae", "^test/test-strscpy\\.c=43b0aeae$")],
    );
    expect(outcome.overall).toBe("inconsistent");
    expect(outcome.mismatched).toHaveLength(1);
    expect(outcome.mismatched[0]!.baselineMatched).toBe(false);
    expect(outcome.mismatched[0]!.reason).toContain("baseline no");
    expect(outcome.mismatched[0]!.reason).toContain("candidate ok");
  });

  test("both-matches: 仅候选侧不匹配 → 真漂移，baselineMatched=true", () => {
    const outcome = compareExpectations(
      [decl("stdout", "both-matches", "hello", "^hello$")],
      [decl("stdout", "both-matches", "HELLO", "^hello$")],
    );
    expect(outcome.overall).toBe("inconsistent");
    expect(outcome.mismatched[0]!.baselineMatched).toBe(true);
  });

  test("both-matches: 两侧都不匹配 → 考卷自违，baselineMatched=false", () => {
    const outcome = compareExpectations(
      [decl("x", "both-matches", "a", "^b$")],
      [decl("x", "both-matches", "a", "^b$")],
    );
    expect(outcome.mismatched[0]!.baselineMatched).toBe(false);
  });

  test("跨侧关系（equal）不匹配 → 单侧无语义，baselineMatched=null", () => {
    const outcome = compareExpectations(
      [decl("value", "equal", 1)],
      [decl("value", "equal", 2)],
    );
    expect(outcome.overall).toBe("inconsistent");
    expect(outcome.mismatched[0]!.baselineMatched).toBeNull();
  });

  test("both-matches 缺模式 → 视为自违（false），不崩溃", () => {
    const outcome = compareExpectations(
      [decl("x", "both-matches", "a")],
      [decl("x", "both-matches", "a")],
    );
    expect(outcome.mismatched[0]!.baselineMatched).toBe(false);
  });
});
