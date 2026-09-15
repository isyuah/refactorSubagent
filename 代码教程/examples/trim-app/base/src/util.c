/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/trim-app/base/src/util.c —— trim() 的"原始版本"（重构前的样子）
 *
 * 【这个文件是干什么的】
 *   实现 trim()：把字符串【首尾】的空白字符删掉（原地去掉，不是拷贝新串），返回 s。
 *   这个文件就是重构 Agent 的"手术对象" —— ScopeManifest 里唯一的 editable 文件：
 *     editable_files: [{ file: "src/util.c", symbols: ["trim"] }]
 *     readable_globs: ["src/**"]
 *   （见 scripts/e2e-differential.ts 的 scope 段。main.c 不许改，改了会被
 *    PreToolUse hook 当场拦下。）
 *
 * 【逐行读懂 trim()（这个算法本身值得学会）】
 *   三步走：
 *     ① 跳过开头所有空白（s 前移）；
 *     ② end 走到字符串末尾；
 *     ③ end 从末尾往回退，跳过结尾的空白，最后在那儿写 '\0' 把字符串截断。
 *   返回 s（= 第①步之后的位置），所以"返回值"和"原串"都被裁过了。
 *
 * 【在整个项目里的位置】
 *   上游：main.c 每打印一个参数就调一次 trim(argv[i])。
 *   下游：variants/safe/util.c（行为保持的重构版）与 variants/broken/util.c
 *        （故意改坏版）都以本文件为基准。e2e-differential 脚本把 base 拷成
 *        base commit，再用 variant 的 util.c 覆盖出 candidate 分支，最后
 *        双版本各编一个 app、跑同样的 4 个用例、逐通道对比 → ACCEPTED/REJECTED。
 * 【先修知识】指针运算、C 字符串以 '\0' 结尾、ctype.h 的 isspace。
 * 【本文件是教程注释版】
 *   原文件：examples/trim-app/base/src/util.c（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// isspace 需要的头（判断空白：空格、\t、\n、\v、\f、\r）。
#include <ctype.h>
#include "util.h"

// ── trim：原地去掉字符串首尾空白 ────────────────────────────────────
// 【签名】char *trim(char *s)：入参和返回值是同一个指针（"原址修改"风格，
//         和 strcpy/strtok 一脉相承）。调用方拿返回值或直接看原串都行。
// 【契约】① 首尾空白全去掉；② 中间空白一个不动；③ 空串/全空白串 → 变成空串；
//         ④ 返回值 == s。safe 版四条全保，broken 版破了第①条（见 broken/util.c）。
char *trim(char *s) {
    // ↑ 第①步：跳过开头空白。
    //   *s 为 '\0' 时循环自然停（防止越界读到字符串末尾之后）；
    //   (unsigned char) 强转是 ctype.h 的标准写法：isspace 的入参必须是
    //   unsigned char 值或 EOF，传"可能是负数的 char"是未定义行为。
    while (*s && isspace((unsigned char)*s)) s++;
    // ↑ 第②步准备：end 从头部起点出发，准备扫到末尾。
    char *end = s;
    // ↑ end 一路前移到字符串结尾的 '\0' 上（注意：end 此刻指向的是那个 '\0'）。
    while (*end) end++;
    // ↑ 第③步：从末尾往回退。
    //   条件 end > s 保证不会退过开头（也避免对空串乱写）；
    //   end[-1] 是"end 前面那个字符"（等价 *(end-1)），即当前最后一个有效字符。
    while (end > s && isspace((unsigned char)end[-1])) end--;
    // ↑ 关键一击：在"最后一个非空白字符的后面"写入 '\0'，把尾巴截掉。
    //   ⚠️ 这一步把原串改写了 —— 所以 trim 不能用在字符串字面量上（那是未定义行为）。
    *end = '\0';
    // ↑ 返回裁剪后的起点（跳过开头空白之后的位置）。
    return s;
}
