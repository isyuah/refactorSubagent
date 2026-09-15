/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/trim-app/base/src/util.h —— trim() 的对外契约（头文件）
 *
 * 【这个文件是干什么的】
 *   只有 7 行，干两件事：防止被重复包含（include guard）、声明 trim() 的签名。
 *   它是 main.c 和 util.c 之间"约定一致"的那张纸 —— main.c 只认这个签名，
 *   所以 util.c 怎么重写（哪怕拆成 safe 版的两个 static 辅助函数），
 *   只要签名和可观察行为不变，main.c 一行都不用动。这正是"行为保持型重构"
 *   能成立的前提：接口（.h）冻结，实现（.c）随便换。
 *
 * 【在整个项目里的位置】
 *   readable_globs 是 "src/**"，所以它能被读；但它不在 editable_files 里，
 *   重构 Agent 不许改它 —— 改头文件 = 改对外契约 = 直接越界（hook 拦截）。
 * 【先修知识】C 的 #ifndef include guard 惯用法。
 * 【本文件是教程注释版】
 *   原文件：examples/trim-app/base/src/util.h（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// ── include guard：防止同一个头被 #include 两次 ─────────────────────
// 【作用】第一次包含时 UTIL_H 未定义 → 定义它、声明 trim()；
//         第二次包含时 UTIL_H 已定义 → 预处理器直接跳到 #endif，什么都不做。
// 【为什么必须有】shim/determinism.h 也是靠这一招做到"无害的二次包含"的：
//   它先真正包含 <time.h>/<stdlib.h>，之后源文件再包含它们时就是空操作，
//   于是不会出现"同一个函数声明两次、签名还冲突"的编译错误。
// 🔗 见 shim/determinism.h 注释版（那里把这招用成了确定性技巧的核心）。
#ifndef UTIL_H
#define UTIL_H

/* Trim leading and trailing whitespace in place; returns s. */
// ↑ ↑ 原文件自带的英文注释，一字未动：一句话说清契约 ——
//    "原地去掉首尾空白，返回 s"。注意它同时承诺了两件事：
//    ① in place（会改写原串，所以不能传字符串字面量）；② 返回值就是 s。
//    这就是行为契约的最小形态：差分测试验证的就是这句话有没有被守住。
// 【签名】入参 char *（不是 const char *）：因为它要改写这块内存。
//         若有人把它改成 const char *，调用方 main.c 里 argv[i] 虽然能编过，
//         但语义（可写性承诺）变了 —— 这类"签名级"改动属于 API 变更，
//         本项目提示词里明确列为 Forbidden（不许改 API）。
char *trim(char *s);

#endif
