/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/trim-app/variants/safe/util.c —— "行为保持版"的重构答案
 *
 * 【这个文件是干什么的】
 *   它是 trim() 的一次【合法重构】：把原来一整段 trim() 拆成两个 static 辅助
 *   函数（skip_leading 跳过开头空白、cut_trailing 截掉结尾空白），
 *   可观察行为与 base/src/util.c 完全一致。
 *   在差分演练（bun run scripts/e2e-differential.ts --variant safe）里，
 *   它被覆盖到 candidate 分支上，最终必须被判 【ACCEPTED】 ——
 *   这是"证明流水线不冤枉好人"的那一半证据。
 *
 * 【为什么它"安全"（逐条对照行为契约）】
 *   ① 首部空白：skip_leading 的循环与原版逐字符相同；
 *   ② 尾部空白：cut_trailing 里"走到末尾 → 往回退 → 写 '\0'"三步与原版相同；
 *   ③ 返回值：trim 返回 cut_trailing(skip_leading(s))，而两个辅助函数都 return s，
 *      所以返回值依旧是"跳过开头空白之后的那个指针" == 原 base 版的返回值；
 *   ④ 改写的内存范围也一致（只在原串上写一个 '\0'）；
 *   ⑤ 签名没变：char *trim(char *)，头文件 util.h 一字未动。
 *   加上 static 让辅助函数只在本文件可见 —— 这是"安全重命名/拆分"的典型手法：
 *   对外接口（.h）纹丝不动，内部结构随便整理。
 *
 * 【怎么和原版对比的（数据流）】
 *   base commit（base/ 整个目录）→ candidate 分支（本文件覆盖 src/util.c）
 *   → 两侧各编一个 app（同样的 gcc 参数 + 同样的 determinism shim）
 *   → 跑同样的 4 个用例（r1: "hello"；d-normal: "  padded  "；
 *      d-blank: ""、"   "、"\t"；d-mixed: "ünïcødé\t"、"a b c "）
 *   → 逐通道对比 exit_code / stdout（stderr 忽略、文件系统按语义对比）
 *   → 全部一致 ⇒ consistent ⇒ 状态机推进到 ACCEPTED。
 *
 * 【在整个项目里的位置】
 *   与 variants/broken/util.c 互为一对对照组：safe 应 ACCEPTED、broken 应 REJECTED。
 *   两个都通过，才能说明"差分裁决"既不放过坏改动，也不误杀好改动。
 * 【先修知识】先读 base/src/util.c 注释版里的 trim() 三步算法。
 * 【本文件是教程注释版】
 *   原文件：examples/trim-app/variants/safe/util.c（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

#include <ctype.h>
#include "util.h"

/* SAFE REFACTOR: extract helpers; observable behavior identical. */
// ↑ ↑ 原文件自带的英文注释，一字未动：这是一次"提取函数"式重构，可观察行为不变。
// ── skip_leading：第①步独立成函数（跳过开头的空白）──────────────────
// 【语法】static 修饰函数 = 内部链接：这个名字只在当前 .c 文件里可见，
//   不会污染全局命名空间，也绝不会和其他文件的同名函数冲突。
//   这是重构时"引入中间函数"最安全的写法（对外完全无感）。
// 【与原版逐字符一致的循环】*s 为 '\0' 即停；(unsigned char) 强转满足
//   isspace 的入参要求（char 可能是负数，直接传是未定义行为）。
static char *skip_leading(char *s) {
    while (*s && isspace((unsigned char)*s)) s++;
    // ↑ 返回"第一个非空白字符"的位置 —— 与 base 版第①步结束时的 s 完全相同。
    return s;
}

// ── cut_trailing：第②③步独立成函数（从末尾回退并截断）───────────────
// 【注意】它收到的 s 已经是"跳过开头空白"之后的指针（见下面 trim 的组合方式），
//   所以 end 的起点、end > s 的比较基准都与 base 版一致，行为自然一致。
static char *cut_trailing(char *s) {
    char *end = s;
    while (*end) end++;                                            // 走到 '\0'
    while (end > s && isspace((unsigned char)end[-1])) end--;      // 回退过尾部空白
    *end = '\0';                                                   // 截断
    return s;                                                      // 返回起点（与 base 版相同）
}

// ── trim：对外签名不变，内部只是把两个辅助函数串起来 ──────────────────
// 【等价性】cut_trailing(skip_leading(s)) 的求值顺序：先算 skip_leading(s)
//   （跳过头），再把它的返回值交给 cut_trailing（裁尾）。与 base 版
//   "先跳头、再裁尾"的顺序一致；返回值都是裁完的起点。
// 【这就是"行为保持型重构"的样子】结构变了（1 个函数 → 3 个函数），
//   可观察行为（exit code / stdout / 文件系统副作用）一个字节都没变 ——
//   所以差分对比全绿，程序盖下 ACCEPTED 的章。
char *trim(char *s) {
    return cut_trailing(skip_leading(s));
}
