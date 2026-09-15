/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】examples/trim-app/base/shim/determinism.h —— 确定性 shim（行为可复现的关键）
 *
 * 【这个文件是干什么的】
 *   用 3 个宏把 C 里最常见的不确定源"钉死"：
 *     time()   → 永远返回 1700000000（= 2023-11-14 22:13:20 UTC）
 *     rand()   → 永远返回 77
 *     srand(x) → 什么都不干（把种子吞掉，防止程序自己把 rand() 弄"活"）
 *   效果：无论程序跑多少遍、在 baseline 还是 candidate 侧跑，
 *   输出都一模一样。这就是"行为可复现"的全部机关。
 *
 * 【它是怎么被"塞进"代码里的（关键机制：-include 强制包含）】
 *   编译命令不是普通的 gcc …，而是带了 -include shim/determinism.h：
 *     gcc -O2 -Wall -include shim/determinism.h src/main.c src/util.c -o app
 *   `-include <文件>`（GCC 的旗标）= 在编译【每一个】翻译单元（每个 .c）之前，
 *   预处理器先把这个文件整个读进来 —— 相当于它被放在了 main.c / util.c 的第一行。
 *   所以哪怕 util.c 根本不包含 <time.h>，它的 time/rand 也照样被换掉。
 *   【谁加的这个旗标】宿主程序，不是人：EnvironmentSpec 里声明了
 *     determinism: { frozen_time_epoch_ms: 1_700_000_000_000,   // ← 毫秒！= 1700000000 秒
 *                    random_seed: 42,
 *                    intercept_headers: ["shim/determinism.h"] }
 *   （scripts/e2e-differential.ts / tests/fixtures.ts 都是这么写的），
 *   构建适配器看到 intercept_headers 非空，就给编译命令追加 -include
 *   （src/runtime/build-adapter.ts:56、src/runtime/builder.ts:82）。
 *
 * 【为什么这样能让行为可复现（呼应 main.c）】
 *   main.c 打印 `[<time()>] #<rand()%100> …`。不冻结时，两次运行的时间戳不同，
 *   stdout 逐字节对比（contract 里 stdout: { mode: "exact" }）必然失败，
 *   重构做得再干净也会被误判 REJECTED。冻结之后，baseline 与 candidate
 *   唯一可能的不同就是"重构本身改坏了行为" —— 对比才有意义。
 *   ⚠️ 顺带说清一个细节：shim 把 rand() 钉成常量 77，而不是真的播种 42。
 *      manifest 里的 random_seed: 42 是"我承诺随机性已被隔离"的声明字段；
 *      真正怎么隔离由这份头文件实现。声明与实现要保持一致（本例一致）。
 *
 * 【这个技巧的边界（诚实声明）】
 *   它是【预处理器层面的替换】，不是 libc 级拦截：只有"源代码文本里写了
 *   time(...)/rand()/srand(...)"的地方会被换掉。库内部（比如 libc 自己）调用的
 *   时间函数不受影响；想拦更深的就得换链接期拦截/系统调用拦截了。
 *   对这个只有两文件的小工程来说，3 个宏刚刚好 —— 这也是示例工程的价值：
 *   用最小的东西把"确定性隔离"这个概念讲清楚。
 *
 * 【在整个项目里的位置】
 *   只被 examples/trim-app 使用；它的路径出现在 environment.spec 的
 *   determinism.intercept_headers 里，随构建命令生效。
 * 【先修知识】C 预处理器宏（#define 的函数式宏）、include guard、-include 旗标。
 * 【本文件是教程注释版】
 *   原文件：examples/trim-app/base/shim/determinism.h（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */

/*
 * Determinism shim — force-fed into EVERY translation unit via
 * `gcc -include determinism.h`, i.e. BEFORE the source's own includes.
 *
 * It deliberately includes the real system headers FIRST (so genuine
 * declarations are seen), then replaces the nondeterministic entry points
 * with macros. Any later #include of <time.h>/<stdlib.h> is a no-op due to
 * include guards, so no conflicting redeclaration can occur.
 */
// ↑ ↑ 以上是原文件自带的英文注释，一字未动。它讲的正是本文件最精妙的一点：
//    【顺序】—— 先包含真头文件，再定义宏。下面逐行展开说。
//
// ── include guard ─────────────────────────────────────────────────
// 防止本文件被意外包含两次（两次 #define 同名宏虽然无害，但 guard 是标准习惯）。
#ifndef DETERMINISM_SHIM_H
#define DETERMINISM_SHIM_H

// ── 第 1 步：先把【真的】系统头包含进来 ─────────────────────────────
// 【为什么顺序必须是"先真后假"】
//   ① <time.h> 里有 typedef time_t 等类型定义 —— 下面第 2 步的宏展开要用到
//      time_t，所以必须先让它存在；
//   ② <time.h> 里还有 `time` 函数的原型声明 —— 必须在定义宏【之前】完成。
//      因为一旦 #define time(t) 生效，后面文本里出现的每一个 `time(` 都会被
//      替换成 `((time_t)1700000000)`；如果之后再包含一个没被 guard 挡住的
//      <time.h>，那句 `time_t time(time_t *);` 会被搅成
//      `time_t ((time_t)1700000000)(time_t *);` → 直接编译错误。
//      这正是英文注释里那句 "no conflicting redeclaration can occur" 的含义：
//      靠 include guard 让后续包含变成空操作，宏才不会污染到声明本身。
#include <time.h>
#include <stdlib.h>

// ── 第 2 步：用函数式宏替换不确定入口 ───────────────────────────────
// 【语法】`#define 名字(参数) 替换体` 是【函数式宏】：只在这种"名字+左括号"
//   的写法出现时展开，纯文本替换，发生在编译之前（所以连函数调用都省了）。
// 【这条的效果】源码里任何 `time(NULL)` / `time(0)` 都变成 `((time_t)1700000000)`。
//   - (time_t) 强转：保证类型与 <time.h> 里 time 的返回类型一致，
//     配合 main.c 里的 (long) 转换和 %ld 打印，行为与真实现完全同形；
//   - 1700000000 秒 = 2023-11-14 22:13:20 UTC，与 manifest 里的
//     frozen_time_epoch_ms: 1_700_000_000_000（毫秒）是同一个时刻；
//   - 参数 t 写了但没用 —— 宏参数允许不用（这样 time(任意参数) 都能替换）。
//   ⚠️ 副作用：替换体没有副作用，所以连"调用函数"这个事实都消失了，
//      程序里 time() 不再消耗任何真实时间。
#define time(t) ((time_t)1700000000)
// ↑ 任何 rand() 都展开成 (77)。main.c 里 `rand() % 100` 于是恒等于 77，
//   打出来就是 "#77"。既然值是常量，自然也不需要播种。
#define rand() (77)
// ↑ 把 srand 吞掉：`srand(42)` 展开成 `((void)(42))`。
//   【为什么要做这一条】如果不吞，程序里一句 srand(time(NULL)) 会先把 time
//   换成常量（无害），但更普遍的情形是程序用任意值播种 —— 播种本身不会
//   改变本 shim 的 rand()（它已经是常量宏了），但保留 srand 的"空实现"
//   能保证语义上"随机性已被接管"，同时 ((void)(seed)) 这个 void 强转
//   避免"无效果语句"类的编译警告。
#define srand(seed) ((void)(seed))

#endif
// ↑ include guard 收尾。此后任何再次包含本文件 / <time.h> / <stdlib.h> 的
//   代码都是空操作 —— 这就是整个 shim 能"无害地全局生效"的原因。
