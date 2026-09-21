# libuv v1.52.1 重构候选点（可重构的地方 + 必须保持的行为）

> 对象：`libuv/`（tag `v1.52.1`，commit `1cfa32f`，`--depth 1` 克隆）。
> 主机事实：Windows 11 x64 / GCC 15.2 (MinGW) / CMake 4.3.1 / Ninja 1.13.2 / Debug。
> 所有"必须保持"的条目都来自本次实测（见 `02-testset-requirements.md` 的复现命令），不是从注释推断。

## 0. 结论先行

| | 目标 | 行数 | 风险 | 自带用例信号 | oracle 信号 | 建议顺序 |
|---|---|---|---|---|---|---|
| T1 | `src/strtok.c` | 52 | 低 | 弱（无空 token 覆盖；Windows 上库内副本零生产调用者） | 强（21 项检查） | 1 |
| T2 | `src/strscpy.c` | 38 | 低 | 中（未测 n==1/别名/尾部字节） | 强（23 项） | 2 |
| T3 | `src/inet.c` | 298 | 低-中 | 弱（完全未覆盖 v6 ntop） | 强（48 项） | 3 |
| T4 | `src/uv-common.c:198-250`（错误字符串岛） | ~52 | 低 | 无（唯一断言点是死代码） | 强（24 项） | 4 |
| T5 | `src/uv-data-getter-setters.c` | 119 | 低 | 中（6 个访问器未覆盖） | 强（52 项） | 5 |
| T6 | `src/version.c` | 45 | 低 | 无 | 强但平凡（6 项）—— 适合当控制任务 | 6 |
| T7 | `src/idna.c` | 560 | 中 | 强（~50 条 RFC3492/TR46 向量） | 暂不写（缺口见 §7） | 7 |

不建议作为重构对象：`src/random.c`（输出不可确定 + threadpool）、`src/queue.h` / `src/uv-common.h`（宏语义被 29+ 个 TU 复制，改动面过大）、`src/heap-inl.h`（无任何直接测试，只有 timer 行为间接覆盖）。

---

## T1 `src/strtok.c` — 52 行，单符号

**调用面**：`uv__strtok` 仅被 `src/unix/core.c:2004,2023` 调用（POSIX 路径）。**Windows 构建里库内副本没有任何调用者**，而自带用例 `test/test-strtok.c:27` 是 `#include "../src/strtok.c"` —— 它测的是测试 TU 里的副本，不是 `libuv.a` 里的那份。另一个后果：**不能把函数搬出 `src/strtok.c`**（测试直接 include 该文件），也不能改成 `static`。

**可做的行为保持型重构**：把 `str == NULL` / `str != NULL` 两支合并（`strtok.c:31-35`）；把 `tmp == NULL` 的早退提到最前；把内层分隔符扫描抽成 `static` 辅助函数；把 `while (*tmp != '\0')` 循环体改成提前 `return` 的平坦结构。

**必须保持不变（已实测钉死）**：

| 语义 | 观测值 |
|---|---|
| 相邻分隔符产生**空 token** | `"a..b"` + `"."` → `a`, ``, `b` |
| 尾随分隔符产生一个**尾部空 token** | `"abc."` + `"."` → `abc`, `` |
| 前导分隔符产生**前导空 token** | `".abc"` → ``, `abc` |
| 全分隔符串逐个产出空 token | `"..."` → ``, ``, ``, `` |
| 空输入产出一个空 token（非 NULL） | `""` → `` 一次，然后 NULL |
| `sep == ""` 时整串为一个 token | `"abc"` + `""` → `abc`，随后 NULL |
| 原地破坏 + 迭代器推进 | 命中处写 NUL；`*itr = 命中位置+1`；扫描到串尾时 `*itr = NULL` |
| 迭代器已为 NULL 后继续调用 | 恒返回 NULL |

**已知覆盖缺口**：自带用例的四个向量都不含相邻/首尾分隔符。

**必须复现的 refactor 陷阱**：任何"跳过连续分隔符"的清理（向 `strtok_r` 语义靠拢）都会让空 token 消失——自带用例全绿。用 `oracle_strtok` 兜住。

---

## T2 `src/strscpy.c` — 38 行，单符号

**调用面**：33 处引用 / 12 个文件，其中 Windows 上编译的有 16 处：`src/inet.c:57,141`、`src/uv-common.c:210`、`src/win/util.c:1659-1714`、`src/win/thread.c:360`。即改动会经 `uv_err_name_r`、`uv_os_uname`、`uv_ip4_name` 等公开 API 外溢——**这些外溢路径有独立的行为信号**（见 `02` 的双层设计）。测试 `test/test-strscpy.c:28` 同样直接 include 该 `.c`：函数必须留在 `src/strscpy.c` 且保持外部链接。

**可做的重构**：`i == 0` 早退（`strscpy.c:32-33`）与截断路径合并；`SSIZE_MAX` 检查搬位；截断分支命名；去掉冗余 cast。

**必须保持不变（已实测钉死）**：

| 输入 | 返回值 | 缓冲区 |
|---|---|---|
| `n == 0` | `0`（**不是** UV_E2BIG） | 一个字节都不写 |
| `"x", n == 1` | `UV_E2BIG` (-4093) | `d[0] == 0`，`d[1]` 未被触碰 |
| `"xyz", n == 4` | `3` | `"xyz\0"` |
| `"abcdefghij", n == 4` | `UV_E2BIG` | 恰好写 3 个源字节 + `d[3] == 0` |
| 写出区域之外 | — | 从不被触碰 |
| `d == s`（别名） | 正常 | 不被破坏 |

**`SSIZE_MAX` 分支**（`strscpy.c:30`）在 Win64 上 `SSIZE_MAX == INTPTR_MAX`，实际不可达；可以保留原样或证明等价后移除，但**不要顺手改成别的错误码**。

**已知覆盖缺口**：n==1、写出区域之外的字节、别名、超过 4 字节的"恰好装下"边界。

---

## T3 `src/inet.c` — 298 行

**调用面**：`uv_inet_ntop/uv_inet_pton`（`uv.h:1787-1788`）被 `uv-common.c:261,296,301,306,313-316`、`src/win/udp.c:572,682` 等调用，并通过 `uv_ip4_name`/`uv_ip6_name`/`uv_ip_name` 面对用户。

**可做的重构**：4 个 `static` 内部函数（`inet_ntop4/6`、`inet_pton4/6`，`inet.c:29-32`）里抽出字节对拼装辅助；`words[i]` 填充循环（`inet.c:80-82`）提炼；`inet_pton4` 的 `saw_digit/octets` 状态机（`inet.c:172-206`）拉平；两处 `uv__strscpy(dst,tmp,size); return 0;` 尾巴（`inet.c:57-58,141-142`）合并。

**必须保持不变（已实测钉死）**：

| 语义 | 观测值 |
|---|---|
| 单个零组不压缩 | `2001:db8:0:1:1:1:1:1` |
| 两个及以上零组压缩 | `2001:db8::1`、`::`、`::1` |
| v4-mapped 用点分十进制 | `::ffff:1.2.3.4` |
| 缓冲区规则 | `size >= strlen(渲染)+1` 才成功；否则 `UV_ENOSPC` (-4055)，**目标缓冲区完全不被写入**（实测首字节仍是哨兵） |
| AF_INET 同规则 | `"1.2.3.4"` 需 `size >= 8` |
| pton 拒绝集 | 尾随点、位数不足、>255、空元素、双重压缩、超长组 → `UV_EINVAL` (-4071) |
| 未知 family | `UV_EAFNOSUPPORT` (-4089) |
| zone 后缀 | 解析前剥离，内容不校验（`fe80::1%7` 成功） |

**已知覆盖缺口**：自带用例的 `ip4_addr`/`ip6_pton`/`ip6_sin6_len`/`ip_name` 不经过 AF_INET6 的 ntop 路径——v6 渲染 + 短缓冲区规则全靠 oracle。

**易踩的边界**：`inet.c:105` 的 `best.len < 2`（单零组不压缩）与 `inet.c:139` 的 `(size_t)(tp - tmp) > size`（该比较含结尾 NUL，因此等价于 `size >= len+1`）。两处都已被 mutation 验证过：改动其一会让自带用例仍全绿而 oracle 失败。

---

## T4 `src/uv-common.c:198-250` —— 错误字符串岛

**可做的重构**：`UV_ERR_NAME_GEN_R` / `UV_STRERROR_GEN_R` 两个近似重复的宏展开合并为一个查找辅助 + 一个 `snprintf` 兜底，供 `uv_err_name_r`/`uv_strerror_r` 共用；`uv__unknown_err_code` 保持为唯一未知码路径。

**必须保持不变（已实测钉死）**：

| 语义 | 观测值 |
|---|---|
| `uv_err_name(UV_EINVAL)` / `uv_strerror(UV_EINVAL)` | `"EINVAL"` / `"invalid argument"` |
| `uv_err_name(UV_ENOENT)` / `uv_strerror(UV_ENOENT)` | `"ENOENT"` / `"no such file or directory"` |
| 未知码（含 0、负数、1337） | `"Unknown system error <n>"`，且是 **heap 拷贝**（调用者负责释放——不要"顺手修掉"这个看似泄漏的契约） |
| `_r` 变体返回值 | 恒等于传入的 `buf` |
| `_r` 截断 | 恰好 `n-1` 字节 + NUL：`(EINVAL,4) -> "inv"`、`(EINVAL,2) -> "E"`、`n==1 -> ""` |
| 表内/表外两条路径的截断机制不同 | 表内走 `uv__strscpy`，表外走 `snprintf`——两者语义不可互换 |

**覆盖缺口（本清单里最大的一处）**：`test/test-error.c:49-58` 是唯一断言点，其守卫 `strcmp(uv_strerror(0), "Success")` 永远为假（实际是 `"Unknown system error 0"`），函数打印 "i18n error messages detected, skipping test." 后返回 0，**下面的断言从未执行**，其中 `strcmp(uv_strerror(1337), "Unknown error")` 早已过期。

**不能动的地方**：四个函数的原型在 `uv.h:425-429`，字符串表的唯一来源是 `include/uv/errno.h` 的 `UV_ERRNO_MAP`。

---

## T5 `src/uv-data-getter-setters.c` — 119 行

**可做的重构**：把两个宏驱动的名字表改成表驱动查找；合并重复的字段访问器；删掉 `:56-62` 的 `default: break;`（无副作用）。

**必须保持不变**：24 个函数全部是 `UV_EXTERN`（ABI），名字/签名/导出不可改；`uv_handle_type_name` 对 `UV_UNKNOWN_HANDLE`/`UV_HANDLE_TYPE_MAX` 返回 NULL、对 `UV_FILE` 返回 `"file"`；`uv_req_type_name` 对 Windows 私有的 11..18 与 `UV_UNKNOWN_REQ`/`UV_REQ_TYPE_MAX` 返回 NULL。

**已实测的全表断言**：handle 0..18、req 0..19（Windows 上 `UV_REQ_TYPE_MAX == 19`，因为 `include/uv/win.h:356-365` 追加了 8 个私有请求类型；POSIX 上 `include/uv/unix.h:250` 为空）。

**覆盖缺口**：自带用例从不调用 `uv_udp_get_send_queue_size/count`、`uv_process_get_pid`、`uv_req_get_type/get_data/set_data`——两个 UDP 队列访问器互换了字段名（`send_queue_size` ↔ `send_queue_count`）整套自带用例照样全绿。

---

## T6 `src/version.c` — 45 行（控制任务）

**必须保持不变**：`uv_version() == UV_VERSION_HEX == 0x00013401`；`uv_version_string() == "1.52.1"`（且必须与 `UV_VERSION_MAJOR/MINOR/PATCH` 三元组一致）。

**覆盖**：全仓没有任何用例调用它们。这个目标适合当"控制任务"：重构几乎不可能出错，用来验证闭环本身（构建→跑用例→跑 oracle→期望对比→ACCEPTED）而不是验证被测代码。

---

## T7 `src/idna.c` — 560 行（暂缓）

**为什么暂缓**：算法复杂（punycode/TR46/UTF 转换），且模块的行为依赖 `assert`（`idna.c:202,233,252,395,451`）——`Release` 下这些不变量消失，同一个 patch 在 Debug/Release 下行为不同；此外 `test/test-idna.c:22-29` 把 `UV_EXTERN` 清空、把 `uv__malloc` 重定义成 `malloc` 后直接 include 该 `.c`，任何新引入的 `uv__*` 依赖都会破坏测试 TU。

**已识别的覆盖缺口**（若将来要做）：目标缓冲区截断路径（`if (*d < de)` 守卫，`idna.c:160-190,322-360`）与 `UV_E2BIG` 溢出路径（`idna.c:240-246,258-259`）无用例；`uv_utf16_to_wtf8` / `uv_utf16_length_as_wtf8` 在测试里完全没有调用者（只有 `src/win/fs.c`、`src/win/tty.c` 间接走到）。

---

## 通用约束（对上面每个目标都成立）

1. **公开头文件不可改**：`include/uv.h`、`include/uv/errno.h`、`include/uv/win.h` 的任何改动都是 ABI 改动，超出"行为保持"的定义范围。
2. **测试源码不可改**：`test/**` 是被测代码的判据（oracle 的另一半）。候选 patch 若触碰 `test/`，本次验证的判据即失效——`02` 里的 TestWorkflow 会用 `ctx.expect` 钉住测试源码的 hash。
3. **`.c` 被测试 include 的模块不可拆分文件**：`strscpy.c`、`strtok.c`、`idna.c` 三者都属于这一类；函数必须留在原文件且保持外部链接。
4. **不要为了"修 bug"而改行为**：本次实测出的所有怪行为（空 token、`uv_strerror(0)` 的措辞、单零组不压缩、`size >= len+1`）都是**判据的一部分**；修正它们等于改变可观测行为，应当被 REJECTED。

---

# 加难档（H1–H8，2026-09-21 新增）

T1–T6 是**单文件、38–298 行、任务简报写明"必须保持"清单**的 L1 目标，6/6 实测 ACCEPTED、0 失配——这一档已经饱和（详见 `03-suite-and-runner.md` §11）。H 档按四条轴加难：**改动面**（跨 TU / 跨文件 / 改构建）、**不变量隐蔽度**（自带用例看不见）、**信息量**（简报不再给清单）、**可判性**（需要新 oracle）。

判据统一放在 `testset/resources/workflows/judgement-hard/`（每目标一个 oracle，注入到 `refactor-task/oracle-hard/<target>/`），上游用例只用 `parts/{loop,thread,util}.json` 里已校准 stable-ok 的条目。

| # | 目标 | 规模 | 自带用例看得见吗 | 新 oracle | 难度 |
|---|---|---|---|---|---|
| H1 | `src/win/error.c:66-190` 系统错误码映射表 + 写路径分流 | 190 | `error_message` 部分可见 | `oracle_error.c`（320 检查） | ★★★ |
| H2 | `src/win/fs-fd-hash-inl.h` fd→filemap 哈希 | 195 | 几乎不可见（`fs_fd_hash` 的 stdout 含计时，未进判据） | `oracle_fd_hash.c`（166 检查） | ★★★★ |
| H3 | `src/timer.c` 堆/队列双路径与到期快照 | 199 | 只看得到边缘 | `oracle_timer.c`（187 检查） | ★★★ |
| H4 | `src/uv-common.c` 的 `uv_walk` / `uv_loop_close` | 1064 | `walk_handles`/`loop_close` 部分可见 | `oracle_walk.c`（73 检查） | ★★★★ |
| H5 | `src/win/util.c` 环境变量族 + UTF-16 转换 | 1760 | `env_vars` 只覆盖第一段 | `oracle_env.c`（102 检查） | ★★★★ |
| H6 | `src/win/core.c` 事件循环（pending 环形队列 / backend timeout / uv_run 模式） | 879 | `loop_*` 部分可见 | `oracle_loop.c` | ★★★★★ |
| H7 | `src/threadpool.c` 工作项生命周期与取消协议 | 429 | 未校准（cancel 类含竞态） | `oracle_threadpool.c` | ★★★★★ |
| H8 | **结构性重构**：把 `uv-common.c` 的一块实现拆到新 TU + 改 CMakeLists | — | 间接（链接可见） | 复用既有 6 个 oracle | ★★★★ |

## H1 `src/win/error.c` — 系统错误码映射表

**为什么难**：~110 条 `case` 的映射是平台语义的唯一真源，而**两条路径语义分歧**（`uv_translate_sys_error` vs `uv_translate_write_sys_error`）看起来像可去重的重复代码；`<= 0` 的 passthrough 规则看着多余，删掉会让全库的 success 判定崩。

**oracle**：`oracle_error.c` 逐行冻结 98 个输入 ×（通用路径、写路径）→ 期望值，并单独断言两条路径的分歧集合恰好是两个码（`ERROR_BROKEN_PIPE`→`UV_EPIPE`、`ERROR_NO_DATA`→`UV_EPIPE`）。自包含：自己声明 `int uv_translate_write_sys_error(int);`（`src/win/internal.h:333`），不依赖内部头。

**已实测的 mutant**：把写路径变体合并回通用表 → oracle 5 条失败（`write:no-data-232` 实际 `EAGAIN`、期望 `EPIPE` 等）。

## H2 `src/win/fs-fd-hash-inl.h` — fd→filemap 哈希

**为什么难**：`static` 函数 + 宏展开的碰撞链；组内回填（把组内最后一个元素搬到被删槽位）与"`size % 16 == 0` 才释放整组"两条规则看起来都可以简化；被 `test/test-fs-fd-hash.c:27` 直接 include（不能改名/搬家/static 化）。

**oracle**：166 条检查覆盖空表、跨桶/组边界、满组、跨组回填、清空后再填、16 桶扫描、40 项乱序 churn 到 32 项边界。

**已实测的 mutant**：删掉 `FIND_IN_BUCKET_PTR` 里的首组大小提升（`if (size != 0 && first_group_size == 0) first_group_size = GROUP_SIZE`）→ oracle 19 条失败（满组成员全部查不到）。

## H3 `src/timer.c` — 定时器堆与到期快照

**为什么难**：`uv_timer_stop` 走 heap 还是 queue 取决于句柄是否 active（union 复用）；`uv__run_timers` 的两阶段（先摘到期项、再 `uv_timer_again`、最后回调）保证了"回调里启停不影响本轮名单"；`timer_less_than` 的 `(timeout, start_id)` 双重排序决定同刻定时器的顺序。

**oracle**：187 条检查，全部是触发顺序 / 返回值 / `is_active` / 相对 `loop->time` 的差值，**不含任何墙钟断言**。含 `uv__next_timeout` 的 `-1`/`0`/精确 ms/`INT_MAX` 钳制。

**已实测的 mutant**：把两阶段合成单阶段（上游 1.45 之前的形状）→ oracle 失败；**自带 timer 用例几乎看不见**（只有 `timer_zero_timeout` 会响）。

## H4 `src/uv-common.c` — `uv_walk` / `uv_loop_close`

**为什么难**：`uv_walk` 的"快照 + 旋转"是公开文档化的"遍历中可安全关闭句柄"语义，改成 `uv__queue_foreach` 直遍历在多数场景下也"能用"；`uv_loop_close` 的 `#ifndef NDEBUG` `saved_data` 保存/恢复在 Release 下是死代码，删掉看不出来——但本机 recipe 是 Debug。

**oracle**：73 条检查（关闭中遍历可见性、INTERNAL 句柄过滤、`uv_loop_close` 的 EBUSY 判据、Debug 下 `loop.data` 契约）。

**已实测的 mutant**：三处独立改动（直遍历 / 删 `saved_data` / 放宽 close 判据）→ 6 条失败。

## H5 `src/win/util.c` — 环境变量族与 UTF-16 转换

**为什么难**：`uv_os_environ` 的 name/value 同一块内存、`strchr(buf + 1, '=')` 保住以 `=` 开头的 Windows 特殊变量、释放端在**另一个 TU**（`uv-common.c:941-949` 只 free name）；`uv_os_getenv` 的 `*size` 语义（成功 = 不含 NUL，`UV_ENOBUFS` = 含 NUL）与 `wchar_t fastvar[512]` 溢出后的重试。

**oracle**：102 条检查，含 64KB 值往返、`UV_ENOBUFS` 的 size 语义、特殊变量存在性、以及 UTF-16↔UTF-8 的代理对/嵌入 NUL/非法序列。

**已实测的 mutant**：三处（`strchr(buf, '=')`、释放器顺手 free(value)、utf16 零长拷贝语义）→ oracle 8 条失败；**自带 `env_vars` 只抓到第一处**就断言退出，其余两处只有 oracle 看得见。

## H6 / H7（同批新增，判据与实测见 `03-suite-and-runner.md` §11）

- **H6 `src/win/core.c`**（879 行）：Windows 侧 `uv_run` 正文。最核心的隐含不变量是 `uv__insert_pending_req` 的**环形** pending 队列（处理期间新到的请求必须留到下一轮），其次是 `uv_backend_timeout` 的 0/超时值取舍（空闲/endgame/stop_flag 时必须是 0）与 `uv_run(DEFAULT)` 进循环前先跑一轮 timers。
  - oracle `oracle_loop.c`（132 检查，只用公开 API）：`uv_loop_alive` 四态、三种 run 模式的返回值与迭代次数、prepare→check 顺序、DEFAULT 首轮回调顺序、backend_timeout 的六种守卫状态、pending 环形队列的投递/复用、fs 请求的 liveness、unref/ref、`uv_loop_close`。
  - 已实测的 mutant：`uv_backend_timeout` 守卫收成一行 + 删掉首轮 timers（两处"看起来重复"的删除）→ oracle 10 条失败 + 上游 `close_order`/`loop_backend_timeout` 也响。
  - **注意**：改坏 backend_timeout 会让上游自带用例**挂死**（libuv runner 在 Windows 上不杀超时子进程），所以判据里只声明快速失败的上游用例，循环语义由 oracle 覆盖。
- **H7 `src/threadpool.c`**（429 行）：`uv_cancel` 的三态返回（未开始成功 / 已开始 `UV_EBUSY` / 已结束 `UV_EINVAL`）依赖 `uv__work_cancel` 的双锁顺序与 `uv__queue_empty(&w->wq) && w->work != NULL` 判据；`uv__cancelled` 这个"只含 abort() 的 static 函数"是**哨兵**，`uv__queue_init(q)` 与 `w->work = NULL` 的**位置**就是协议本身。
  - oracle `oracle_threadpool.c`（208 检查，3 轮重复）：参数校验、提交→work→after_work 的顺序、三种取消状态、重复 cancel、非 work 请求类型；用信号量构造确定性状态，30 次连续运行 stdout 逐字节一致。
  - 已实测的 mutant：删掉 `uv__cancelled` 哨兵、改用 `NULL` 当"已取消"标记（"消除代码味道"的典型改法）→ oracle 18 条失败（每个正常完成的请求都被报成 `UV_ECANCELED`）。

## H8 结构性重构（没有单点 oracle）

**为什么难**：改的是**代码形状**而不是某个函数——把 `src/uv-common.c` 里自洽的一块（参考正解取错误名/错误串渲染族，54 行）移进新 TU，并把它注册进 `CMakeLists.txt` 的 `uv_sources`。漏注册 = 链接失败；函数留在原地 = 没做；动了公开符号名/签名 = ABI 变更。

**判据**：复用既有 6 个 oracle（`oracle_errstr` 直接覆盖被移动的族）+ `error_message`/`env_vars`/`loop_*`/`walk_handles` 等上游用例，见 `testset/resources/workflows/judgement-h8-structural/`。

**参考正解**：`testset/resources/patches/structural-split-uvcommon.patch`（离线用例 `judgement-accept-structural` 用它证明"判据接受一个多文件 patch"）。

