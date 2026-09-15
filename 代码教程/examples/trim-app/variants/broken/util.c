/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/trim-app/variants/broken/util.c —— "故意改坏版"的重构答案
 *
 * 【这个文件是干什么的】
 *   它是一份【故意引入行为变化】的"重构"，用来验证流水线的另一半能力：
 *   坏改动必须被抓住。在差分演练
 *   （bun run scripts/e2e-differential.ts --variant broken）里，它必须被判
 *   【REJECTED】—— 如果它也拿到了 ACCEPTED，说明对比器形同虚设。
 *
 * ⚠️【它到底改坏了哪一处】
 *   对比 base/src/util.c 的 trim()：base 版有【两】段循环 ——
 *     先 `while (*s && isspace(*s)) s++;` 跳过【开头】空白，
 *     再从末尾回退裁掉【结尾】空白。
 *   本文件把第一段循环【整个删掉了】，只保留了裁尾巴的部分。
 *   结果：trim() 变成了"只裁尾部空白"。
 *   【具体差异在哪】返回值不同！base 版返回"第一个非空白字符"的指针，
 *   本版返回的还是原来的 s —— 于是开头的空白被原样保留在结果里：
 *     输入 "  padded  " → base 版打印 "padded"
 *                      → 本版  打印 "  padded"   ←← 差别就在这两个空格
 *   （内存里的样子：把末尾的 '\0' 往前挪了两位，字符串整体"缩短"了，
 *    但起点没动，所以头部的空格还留在输出里。）
 *   对全空白输入（"   "、"\t"）和没有前导空白的输入（"hello"、"a b c "），
 *   本版输出恰好和 base 版一样 —— 所以 4 个测试用例里【只有 d-normal
 *   ("  padded  ")】能抓住它。这也解释了为什么差分用例要覆盖"带前导空格"这种
 *   边界情形：测试集的覆盖面直接决定"坏改动能不能被发现"。
 *   【其他通道】退出码仍是 0、stderr 仍为空、不碰文件系统 —— 唯一变化在
 *   stdout 通道，而行为契约里 stdout 是 mode: "exact"（逐字节必须一致），
 *   所以这一处不同就足以让对比结果变成 inconsistent → REJECTED。
 *
 * 【在整个项目里的位置】
 *   与 variants/safe/util.c 互为一对对照组（safe → ACCEPTED，broken → REJECTED）。
 *   e2e-differential 脚本会用本文件覆盖 candidate 分支的 src/util.c，
 *   与 base 各编一个 app、跑同样的用例、逐通道对比，
 *   最后断言 actual_state === "REJECTED"，不等则退出码置 1（测试失败）。
 * 【先修知识】base/src/util.c 注释版（trim 的三步算法）。
 * 【本文件是教程注释版】
 *   原文件：examples/trim-app/variants/broken/util.c（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

#include <ctype.h>
#include "util.h"

/* BROKEN REFACTOR: trims trailing whitespace only — behavior change that the
 * differential run must catch (e.g. input "  hi  "). */
// ↑ ↑ 原文件自带的英文注释，一字未动。它自己就招了：
//    "只裁尾部空白 —— 这是差分必须抓住的行为变化（例如输入 "  hi  "）"。
// ── trim：缺了"跳过开头空白"那一步的坏版本 ──────────────────────────
// 【对照 base 版逐行看】
//   base 版第一行 `while (*s && isspace((unsigned char)*s)) s++;` 在这里【没有】，
//   所以下面 end 的起点是原始 s（可能指向空白），而不是"跳过空白后的 s"。
//   返回的 s 也就不是"第一个非空白字符"，而是原串开头。
char *trim(char *s) {
    char *end = s;                                             // ← 从原串开头出发（base 版此时已跳过头部空白）
    while (*end) end++;                                        // ← 走到末尾 '\0'
    while (end > s && isspace((unsigned char)end[-1])) end--;  // ← 往回跳过尾部空白
    *end = '\0';                                               // ← 在最后一个非空白后截断
    return s;                                                  // ← 返回原串开头 ⇒ 前导空白被保留 ⇒ 行为变了
}
// ↑【为什么差分能抓住它】两次运行（base 版 app / broken 版 app）用同样的
//   输入、同样的确定性 shim（时间戳恒 1700000000、编号恒 77），所以输出
//   "[1700000000] #77 …" 的前缀完全一致，唯一可能不同的就是 trim 的结果 ——
//   一旦不同，stdout 通道（exact 模式）立刻不一致，对比器判 inconsistent，
//   状态机停在 REJECTED（fail-closed：证不出等价就不放行）。
//   🔗 对照 variants/safe/util.c：那边同样的流程得到 consistent → ACCEPTED。
