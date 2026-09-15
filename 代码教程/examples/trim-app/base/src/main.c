/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/trim-app/base/src/main.c —— 最小示例工程的"程序入口"
 *
 * 【这个文件是干什么的】
 *   一个只有十几行的命令行小工具：对每个命令行参数去掉首尾空白，
 *   然后按 "[时间戳] #编号 去白空格后的文本" 的格式打印一行。
 *   例：`app "  hi  "` → 输出 `[1700000000] #77 hi`
 *
 *   它是整个项目的"实验小白鼠"：重构 Agent 的每次完整流程（分析 → 受限重构 →
 *   双版本构建 → 跑测试 → 对比 → 裁决）都先在这个小工程上演练。
 *   工程一共 4 个文件：
 *     base/src/main.c   本文件（入口，不许改 —— 不在 editable 白名单里）
 *     base/src/util.c   trim() 的实现（重构 Agent 唯一允许改的文件）
 *     base/src/util.h   trim() 的声明
 *     base/shim/determinism.h  确定性 shim（把 time()/rand() 钉死）
 *   variants/safe/util.c 和 variants/broken/util.c 是两份"标准答案"：
 *   行为保持版（应被判 ACCEPTED）和故意改坏版（应被判 REJECTED）。
 *
 * 【这个程序为什么"故意不可复现"】
 *   它同时用了 time()（每次运行都不一样）和 rand()（不播种时每次进程都一样，
 *   一旦播种就随种子变）。真实项目里到处是这种东西 —— 本例用最小代价复刻了
 *   这个麻烦，好让 shim/determinism.h 有用武之地：把这两个源头冻结，
 *   baseline 和 candidate 两次运行才能产出逐字节相同的 stdout，差分对比才有意义。
 *   🔗 见 shim/determinism.h 注释版；scripts/e2e-differential.ts 里
 *      dependency-manifest 把 time()/rand() 声明成 freeze/seed 两种隔离策略。
 *
 * 【在整个项目里的位置】
 *   上游：scripts/demo-e2e.ts / scripts/e2e-differential.ts 把 examples/trim-app/base
 *         拷进临时仓库做 base commit；构建命令由 environment.spec 的
 *         direct-compiler 给出：gcc -O2 -Wall -include shim/determinism.h
 *         src/main.c src/util.c -o app
 *   下游：编译出的 app 被 test-spec 的 4 个用例（r1 / d-normal / d-blank / d-mixed）
 *         反复运行，stdout/exit code 逐通道对比。
 * 【先修知识】基本 C（argc/argv、printf 格式化、指针数组）。
 * 【本文件是教程注释版】
 *   原文件：examples/trim-app/base/src/main.c（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

// 标准库头：printf / rand、srand / time。
// ⚠️ 注意：由于构建时加了 `-include shim/determinism.h`，这个头文件会被
//    "提前塞进"每个编译单元（在本文件自己的 #include 之前），
//    所以这里的 <time.h> / <stdlib.h> 因为 include guard 已被包含过而变成空操作，
//    真正生效的是 shim 里的宏 —— 详见 shim/determinism.h 注释版。
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
// 双引号包含 = 项目自己的头（到源文件所在目录找），声明了 trim()。
#include "util.h"

/*
 * Prints "[<timestamp>] #<ticket> <trimmed>" for each argument.
 * timestamp and ticket come from time()/rand() — nondeterministic sources
 * that the verification environment pins via shim/determinism.h.
 */
// ↑ ↑ 原文件自带的英文注释，一字未动。它自己就点明了本程序的关键：
//    时间戳和编号来自 time()/rand() 这两个不确定源，验证环境会用
//    shim/determinism.h 把它们钉死。
// ── main：把每个参数去空白后带前缀打印 ───────────────────────────────
// 【行为契约】（差分对比就是按这条契约来的）
//   - 对每个 argv[1..argc-1] 输出一行；
//   - 三个通道都被锁定：exit_code（这里恒 0）、stdout（逐字节一致）、stderr（忽略）；
//   - 时间戳与编号在一次进程内是常量，所以同一输入必然得到同一行输出 ——
//     前提是 time()/rand() 被冻结（见 shim）。
int main(int argc, char **argv) {
    // ↑ time(NULL) 取当前日历时间（秒）。(long) 强转是为了匹配 %ld 的格式要求。
    //   在 shim 作用下它恒等于 1700000000（2023-11-14 22:13:20 UTC）。
    long now = (long)time(NULL);
    // ↑ rand() 取一个伪随机数，% 100 压到 0..99。
    //   在 shim 作用下恒等于 77。%02d 会把它打印成两位、不足补零（77 不变，
    //   若换成 5 会打成 "05"）。
    int ticket = rand() % 100;
    // ↑ 从 1 开始循环：argv[0] 是程序名自己，不是用户输入。
    for (int i = 1; i < argc; i++) {
        // ↑ %ld = long 时间戳；%02d = 两位编号；%s = trim() 的返回值。
        //   trim() 是"原地去空白"：直接改写 argv[i] 指向的那段内存并返回同一个指针，
        //   所以这里打印的已经是掐头去尾后的字符串。
        printf("[%ld] #%02d %s\n", now, ticket, trim(argv[i]));
    }
    // ↑ 退出码 0 = 成功。这也是行为契约里被锁定为 "exact" 的通道之一：
    //   重构版本若改了退出码，差分会立刻 REJECTED。
    return 0;
}
