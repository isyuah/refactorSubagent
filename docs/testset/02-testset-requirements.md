# libuv v1.52.1 重构测试集 —— 需求说明

> 消费方：`E:/Proj/refactorSubagent` 的声明制流程（`runAgentWorkflowVerification` → `runDeclaredWorkflowVerification` → 自驱 TestWorkflow + `ctx.expect` 逐位置比较）。
> 所有数字与行为都是本机实测（Windows 11 x64 / GCC 15.2 / CMake 4.3.1 / Ninja 1.13.2 / Debug）。

## 1. 目标与分层

测试集分两层，缺一不可：

| 层 | 内容 | 它保证什么 |
|---|---|---|
| **A. 自带用例层** | libuv 自带 `uv_run_tests_a.exe <case>` 的 14 个纯函数用例 | 改动没有破坏上游已覆盖的行为；这一层同时是"回归"（防止候选把已有用例改坏） |
| **B. oracle 层** | `refactor-task/oracle/oracle_*.c`（6 个程序、174 项检查、链接 `build/libuv.a`） | 覆盖自带用例层**没有**覆盖的行为（见 §9 的反例证据：两次"自带用例全绿、oracle 抓红"的实验） |

oracle 之所以必要：自带用例套件在若干处是**结构性失明**的——`strtok` 的空 token 语义、`uv_inet_ntop(AF_INET6)` 整条渲染路径、`uv_err_name/uv_strerror` 家族（唯一断言点是死代码）、6 个 getter/setter、`uv_version*`。详见 `01-refactor-targets.md`。

## 2. 依赖事实（必须由构建工作流复现）

### 2.1 构建

```
cmake -S <worktree> -B <worktree>/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=ON \
      -DCMAKE_C_FLAGS="-Wno-error=incompatible-pointer-types -Wno-error=discarded-qualifiers"
cmake --build <worktree>/build --target uv_run_tests_a -j 8
```

- **`-Wno-error=incompatible-pointer-types` 是必需的**：GCC 15 默认把该警告当错误，`src/win/util.c:630`（`uv__convert_utf16_to_utf8` 期望 `char**`，实参 `const char**`）会让整次构建失败；配套 `-Wno-error=discarded-qualifiers` 处理 `src/win/util.c:644`。不加这两项，baseline 构建在 `uv_a` 阶段就挂，整轮 ABORT。
- `LIBUV_BUILD_TESTS` 依赖 `LIBUV_BUILD_SHARED=ON`（`CMakeLists.txt:30-32`），不要试图只建静态库。
- 单配置 Ninja：产物平铺在 `build/`，实测整轮构建 32 s（8 并发）。
- **声明产物**：`build/uv_run_tests_a.exe`、`build/libuv.a`。两者都必须存在，缺失即 fail-closed。
- 选静态 runner（`uv_run_tests_a`）：它链接 `uv_a`，不依赖 `uv.dll`；`uv_run_tests.exe` 需要同目录 DLL，跨目录调用容易踩坑。

### 2.2 runner 协议

| 事项 | 实测结论 |
|---|---|
| 单个用例 | `uv_run_tests_a.exe <case>`（argv[1] 选择，无过滤/通配；一个进程一个用例） |
| 列出用例 | `uv_run_tests_a.exe --list`（唯一存在的开关） |
| 输出 | TAP：通过 `ok 1 - <case>`，跳过 `ok 1 - <case> # SKIP <原因>`，失败 `not ok 1 - <case>` + `# ` 前缀细节 |
| 退出码 | `0` 通过；`3` ASSERT 失败；**`7` 是 SKIP（非零但不是失败）**；`255` 用例名不存在/超时；整轮运行时为失败个数 |
| 固定开销 | 每次调用固定 250 ms 睡眠（`test/runner-win.c:82-86`）+ 进程创建，实测 0.44–0.52 s/用例 |
| cwd | 本测试集只用纯函数用例，不读 `test/fixtures`，cwd 不影响结果 |

## 3. 测试侧需求（自驱 TestWorkflow）

`test.workflow === null`（自驱）时宿主在两侧各执行一次同一份源码；期望按位置配对比较。需求如下，**顺序固定**：

1. `ctx.validator.assertFile("build/uv_run_tests_a.exe")`、`assertFile("build/libuv.a")` —— 产物缺失直接 throw（fail-closed，不进入声明）。
2. **判据完整性检查**（两个 pin，缺一不可）：
   - **oracle 源码**：`const snap = await ctx.fs.snapshot("refactor-task/oracle")`，把结果规范化为 `name=sha256` 排序拼接的字符串，与 `refactor-task/PINS.json` 的 `files` 逐项比对：
     `ctx.expect("oracle.sources.digest", "both-matches", canonical, "^oracle_common\\.h=248fd657…;…")`，另加 `ctx.expect("oracle.sources.snapshot", canonical)`（equal，抓两侧漂移）。
   - **自带用例的判据本体**：对 `PINS.json` 的 `upstream_judgement_files`（`test/task.h`、`test/runner.c`、`test/runner-win.c`、`test/run-tests.c`、`test/test-list.h` + 14 个用例源码）逐个文件同样声明 `both-matches` + `equal`。
   理由：改 **oracle** 会改变判据逻辑；改 **`test/**`** 会弱化判据本身（例如把 `ASSERT_EQ` 换成空语句、删掉几条断言）——两者都不会让 TAP 行或退出码变化，只有摘要能发现。
   `refactor-task/.gitattributes` 已设 `* -text`，全新 checkout 的字节与 PINS 摘要逐字一致（已用 scratch worktree 实测验证）。
3. 逐个编译 oracle（两侧同一命令，输出落在 `build/**` 以符合 `executableGlobs`）：

```
gcc -O0 -g -I . -I include -I src -I refactor-task/oracle \
    refactor-task/oracle/oracle_<name>.c build/libuv.a \
    -o build/oracle_<name>.exe \
    -lpsapi -luser32 -ladvapi32 -liphlpapi -luserenv -lws2_32 -ldbghelp -lole32 -lshell32
```

   `-I src` 是必需的：oracle 要用 `strtok.h` / `strscpy.h` 里的内部原型。
4. 依次运行 14 个自带用例与 6 个 oracle（`ctx.process.run({ program: "build/uv_run_tests_a.exe", args: [case] })`）。
5. 对每个用例/oracle **声明期望**（声明数量与顺序在两侧必须完全一致；任何 throw 都必须在声明之前发生）。
6. 返回一个结构性摘要对象（可选），宿主只记录不判定。

> 编译期依赖：`gcc` 必须是 measured tool（`ctx.tools.available("gcc")`）；`ctx.process.run` 的 `program` 用工作区相对路径 `build/...`，受 `executableGlobs: ["build/**"]` 保护。

## 4. 用例清单与期望

### 4.1 自带用例（14 个，全部确定性，实测 0.44–0.52 s）

| 用例 | 目标模块 | 断言（`both-matches` 模式） |
|---|---|---|
| `strscpy` | `src/strscpy.c` | exit `^0`；stdout `^ok 1 - strscpy` |
| `strtok` | `src/strtok.c` | exit `^0`；stdout `^ok 1 - strtok` |
| `utf8_decode1` | `src/idna.c` | exit `^0`；stdout `^ok 1 - utf8_decode1` |
| `utf8_decode1_overrun` | `src/idna.c` | exit `^0`；stdout `^ok 1 - utf8_decode1_overrun` |
| `wtf8` | `src/idna.c` | exit `^0`；stdout `^ok 1 - wtf8` |
| `idna_toascii` | `src/idna.c` | exit `^0`；stdout `^ok 1 - idna_toascii` |
| `ip4_addr` | `src/inet.c` | exit `^0`；stdout `^ok 1 - ip4_addr` |
| `ip6_pton` | `src/inet.c` | exit `^0`；stdout `^ok 1 - ip6_pton` |
| `ip6_sin6_len` | `src/inet.c` | exit `^0`；stdout `^ok 1 - ip6_sin6_len` |
| `ip_name` | `src/inet.c` | exit `^0`；stdout `^ok 1 - ip_name` |
| `uname` | `src/win/util.c` | exit `^0`；stdout `^ok 1 - uname` |
| `gethostname` | `src/win/util.c` | exit `^0`；stdout `^ok 1 - gethostname` |
| `getters_setters` | `src/uv-data-getter-setters.c` | exit `^0`；stdout `^ok 1 - getters_setters` |
| `queue_foreach_delete` | `src/queue.h` | exit `^0`；stdout `^ok 1 - queue_foreach_delete` |

**注意 `exit code 7`**：`ASSERT_OK(exit)` 的写法会把 SKIP 当失败。这里应写成 `exit === 0` 的 both-matches（`^0`），而 TAP 行 `^ok 1 - <case>` 同时覆盖 SKIP 情形——两者都由程序断言，不做主观解释。

### 4.2 oracle（6 个，实测 < 0.1 s/个，共 174 项检查）

| oracle | 目标 | 检查数 | 期望 |
|---|---|---|---|
| `oracle_strtok` | `src/strtok.c` | 21 | exit `^0`；汇总 `total_failures=0` |
| `oracle_strscpy` | `src/strscpy.c` | 23 | 同上 |
| `oracle_inet` | `src/inet.c` | 48 | 同上 |
| `oracle_errstr` | `src/uv-common.c:198-250` | 24 | 同上 |
| `oracle_getters` | `src/uv-data-getter-setters.c` | 52 | 同上 |
| `oracle_version` | `src/version.c` | 6 | 同上 |

每个 oracle 的逐条语义（"必须保持不变"的完整清单）见 `01-refactor-targets.md`；机器可读版本见 `testset/libuv-testset.json` 的 `oracles[].pins`。

## 5. 期望声明模型（写给 TestWorkflow 作者）

宿主语义：`ctx.expect(name, relation, value, pattern?)`，两侧各跑一次、**按位置配对**。baseline 的值只与 candidate 的值比较。

| 目的 | 写法 |
|---|---|
| 绝对断言（"必须是 0 / 必须是这段文本"） | `ctx.expect(name, "both-matches", String(observed), "pattern")` —— 两侧各自匹配正则；**value 必须是字符串** |
| 跨侧稳定（差分，抓候选漂移） | `ctx.expect(name, String(observed))`（默认 `equal`） |
| 完整输出对照 | `ctx.expect(name + ".transcript", stdout.trim())` |

三条硬性要求：

1. **两侧声明数量与顺序必须一致**：所有可能失败的步骤（文件缺失、编译失败、进程非零退出可选）都必须先 throw；不要在循环里按环境分支提前 `return`。
2. **正则不要以 `$` 收尾**：JS 正则的 `$` 不匹配结尾换行，先对 stdout 做 `trim()`；`\n` 用 `\n` 或 `;`/`|` 连接后再匹配。
3. **不要用 `baseline-greater`/`baseline-less` 做"至少/至多"**：本测试集所有断言都是等值或正则，数值比较语义留给性能类需求。

## 6. 判定规则（fail-closed）

| 情况 | 结论 |
|---|---|
| 构建失败 / 声明产物缺失 | ABORT（不进验证） |
| 任一侧自带用例 exit ≠ 0 或 TAP 行不是 `ok 1 - <case>` | REJECTED |
| 任一侧 oracle exit ≠ 0 或 `total_failures != 0` | REJECTED |
| 两侧逐行输出不一致（`equal` 声明不成立） | REJECTED（判定为行为漂移） |
| 任一侧 oracle 源码摘要 ≠ PINS 摘要 | REJECTED（判据被改动） |
| 用例被跳过（TAP `# SKIP`） | 按 REJECTED 处理：本清单里的用例在正确环境与正确参数下都不应跳过 |
| 全部通过且无漂移 | ACCEPTED |

**不要**把"自带用例全绿"当作充分条件：§9 的两次实验证明它在两个目标上是盲的。

## 7. 排除项（不要放进测试集）

| 用例 | 排除原因 |
|---|---|
| `getaddrinfo_fail` / `_fail_sync` | 解析 `example.invalid.` 并断言失败；通配 DNS/captive portal 会让它成功 → 硬失败（超时上限 10 s） |
| `getaddrinfo_basic` / `_basic_sync` / `_concurrent` | 依赖 `localhost` 解析；并发版走 threadpool，负载下会晃 |
| `getnameinfo_basic_ip4` / `_ip4_sync` / `_ip6` | `flags=0` 走真实 PTR 反查；`_ip6` 还要求主机启用 IPv6 |
| `ip6_addr_link_local` | 枚举真实网卡；VPN/Hyper-V/WSL 适配器变化会改变枚举结果（无 `fe80::` 时该用例空转通过） |
| 整个 `uv_run_tests_a.exe`（无参数） | 全量套件含上述环境敏感用例，历史上在本机保持非绿色；只在需要"完整套件证据"时单独跑，不进入判定 |

## 8. 复现命令（本机实测）

```bash
# 1. 配置 + 构建（out-of-source，源码保持干净）
cd E:/Proj/refactorSubagent
cmake -S libuv -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=ON \
      "-DCMAKE_C_FLAGS=-Wno-error=incompatible-pointer-types -Wno-error=discarded-qualifiers"
cmake --build build --target uv_run_tests_a -j 8     # 实测 32 s

# 2. 单个自带用例（cwd 无关）
build/uv_run_tests_a.exe strtok        # -> "ok 1 - strtok"，exit 0（实测 0.51 s）

# 3. 全部 oracle（源码在仓库内，编译产物落在 build/**）
LIBS="-lpsapi -luser32 -ladvapi32 -liphlpapi -luserenv -lws2_32 -ldbghelp -lole32 -lshell32"
for src in libuv/refactor-task/oracle/oracle_*.c; do
  n=$(basename "$src" .c)
  gcc -O0 -g -I libuv/include -I libuv/src -I libuv/refactor-task/oracle \
      "$src" build/libuv.a -o "build/$n.exe" $LIBS
  ./build/$n.exe                     # 期望最终一行 total_failures=0
done
```

> 本机备注：审查用的 shell 不能执行工作区之外的 exe（`error: command not found`），所以上面的命令从项目根运行；harness 没有这个限制——`ctx.process.run` 解析的是**工作区相对路径**，worktree 内 `build/...` 正常执行（已实测）。

## 9. 反例证据：自带用例层失明，oracle 层抓住

> 该结论已在测试套件里批量复现：5 个行为变异体实测 4 个上游全绿、只有 oracle 抓到，见 `03-suite-and-runner.md` §10。

两次 mutation 都在本机实跑（改动后 rebuild + 跑自带用例 + 跑 oracle，最后 `git checkout --` 还原并复验）。

**M1 — `src/strtok.c` 丢弃尾部/空 token**（把 `return start;` 改成 `return (start && *start == '\0') ? NULL : start;`）

```
自带用例:  ok 1 - strtok                         (exit 0 —— 完全没察觉)
oracle: 4 项失败 —— trailing-separator / all-separators / empty-input / runs-and-edges
```

**M2 — `src/inet.c:105` 把 `best.len < 2` 改成 `best.len < 1`**（单个零组也被压缩）

```
自带用例:  ip4_addr ok / ip6_pton ok / ip6_sin6_len ok / ip_name ok   (全绿)
oracle: 4 项失败 —— ntop6-plain 渲染变化 + ntop6-plain-short 边界随之改变
```

两个 mutation 都是"看起来像清理"的改动，且都能骗过上游套件。这是本测试集必须带 oracle 层的直接理由。

## 10. 环境风险与已观测事故

1. **构建产物可能被外部删除**：首轮构建后 `build/uv_run_tests_a.exe` 在 1 分钟内消失，`ninja` 重新链接（<1 s）即恢复。缓解：每次运行前重跑 `cmake --build build --target uv_run_tests_a`（幂等，已链接时几乎零成本）。若把该目录加入杀软排除项会更稳。
2. **行尾**：`refactor-task/.gitattributes` 必须是 `* -text`，否则 `core.autocrlf=true` 的 checkout 会把 oracle 源码写成 CRLF，摘要 pin 全部失配（已用 scratch worktree 验证过 `* -text` 下的字节一致）。
3. **超时预算**：14 个自带用例 + 6 个 oracle ≈ 8 s 纯执行；给 `stages.testWorkflowMs` 留 ≥ 60 s 余量（含 6 次 gcc 编译，实测每次 ~1 s）。

## 11. 尚未覆盖 / 后续

> 本节的"后续"里，语料扩容与批量执行已经落地：见 `03-suite-and-runner.md`（25 用例矩阵、5 类被测对象、并行执行器）与 `04-rubric.md`（writer 档裁判标准）。上游 437 个用例中已挑出 loop 19 / thread 22 / util 10 作为候选语料（`testset/parts/`，当前以 calibrate 方式分类，尚未升进判据）。

- `src/idna.c` 的截断与溢出路径（`UV_E2BIG`/`UV_ENOBUFS`）、`uv_utf16_to_wtf8` / `uv_utf16_length_as_wtf8` 无任何测试调用者；要做该目标需新增 oracle，并注意 `assert` 在 Release 下消失导致的不变量差异。
- `src/random.c`（输出不可确定 + threadpool）与 `src/queue.h` / `src/uv-common.h`（宏语义被 29+ TU 复制）不适合作为行为保持型目标，已在 `01` 标注为不建议。
- 共享库 runner（`uv_run_tests.exe` + `uv.dll`）目前未纳入；若将来要验证 ABI/导出面，需要额外声明 `uv.dll` 与 `import lib` 产物并处理 PATH。

## 12. 验收演练：判据自测 → AI 重构（M1a / M1b / T3）

判据 workflow 落地后（`libuv/refactor-task/workflows/{build,test}-workflow.ts`，随基线提交），用 harness 的**预置阶段**跑了一次端到端判据自测：`--pipeline-file` 注入两份 workflow + 候选补丁，`workflows`/`refactor` 两个槽被替换，`verify` 仍是宿主实现——真构建、真跑 14 个自带用例与 6 个 oracle、98 条声明逐位置比较，全程零模型调用。

### 12.1 M1a：不调模型的判据自测

```bash
cd E:/Proj/refactorSubagent
bun run scripts/cli.ts run E:/Proj/refactorSubagent/libuv --task "<task>" \
  --pipeline-file E:/Proj/refactorSubagent/testset/pipeline/m1a-accept.json \
  --session m1a-accept-s2 --session-root E:/Proj/refactorSubagent/runs/m1a-accept
```

| 运行 | 候选 | 状态 | 比较结果 |
|---|---|---|---|
| `m1a-accept-s2` | `patches/m1a-accept.patch`（`src/strtok.c` 加一行注释） | **ACCEPTED**（exit 0） | 98/98 一致 |
| `m1a-reject-s2` | `patches/m1a-reject.patch`（§9 的 M1：丢弃空/尾 token） | **REJECTED**（exit 1） | 95/98：`oracle_strtok.exit`、`.summary`、`.stdout` 失配 |

reject 运行里候选侧的 oracle 逐条输出（7 项）：

```text
strtok-oracle: empty-token-between FAIL expected="[a]|[]|[b]|END" got="[a]|END"
strtok-oracle: trailing-separator  FAIL expected="[abc]|[]|END" got="[abc]|END"
strtok-oracle: leading-separator   FAIL expected="[]|[abc]|END" got="END"
strtok-oracle: all-separators      FAIL expected="[]|[]|[]|[]|END" got="END"
strtok-oracle: empty-input         FAIL expected="[]|END" got="END"
strtok-oracle: runs-and-edges      FAIL expected="[]|[]|[x]|[]|[y]|[]|END" got="END"
strtok-oracle: mutate-second-token FAIL expected="" got="(null)"
```

同时 14 个自带用例（42 条声明）全绿，`strtok` 仍是 `ok 1 - strtok`、exit 0——§9 的"上游失明、oracle 抓住"这次是在真实管线复现的，而不是手工实验。

### 12.2 M1b：判据冻结，只让 AI 重构（首个真实 ACCEPT）

同一套预置判据（`workflows.mode=preset`），只把 `refactor` 槽换回 AI 会话：任务文本 = `TASK.md` 的 T1（重构 `src/strtok.c`，不改可观测行为），限制 `sessions.refactor.deadlineMs=1800000`、`maxTurns=60`。

```bash
bun run scripts/cli.ts run E:/Proj/refactorSubagent/libuv --task "<T1 简报>" \
  --pipeline-file E:/Proj/refactorSubagent/testset/pipeline/m1b-strtok-ai.json \
  --session m1b-strtok-s1 --session-root E:/Proj/refactorSubagent/runs/m1b-strtok \
  --limit sessions.refactor.deadlineMs=1800000 --limit sessions.refactor.maxTurns=60
```

结果：**ACCEPTED**，98/98 声明一致，两侧 build pass，`changed_files=["src/strtok.c"]`。墙钟 249 s（PREFLIGHT→准备 6.9 s；**refactor 会话 56.7 s**；两侧构建 56.6 s / 90.0 s；两侧测试 16.0 s / 21.1 s）。

候选实际做了什么（`git diff 9ddbf62 refactor/agent-m1b-strtok-s1`，18 增 15 删，只动 `src/strtok.c`）：

```diff
+/* Reports whether `c` occurs in the NUL-terminated separator set `sep`. */
+static int uv__strtok_is_sep(char c, const char* sep) {
+  while (*sep != '\0') {
+    if (c == *sep)
+      return 1;
+    sep++;
+  }
+  return 0;
+}
+
 char* uv__strtok(char* str, const char* sep, char** itr) {
-  const char* sep_itr;
-  char* tmp;
   char* start;
+  char* tmp;
 
-  if (str == NULL)
-    start = tmp = *itr;
-  else
-    start = tmp = str;
-
+  tmp = str != NULL ? str : *itr;
   if (tmp == NULL)
     return NULL;
 
+  start = tmp;
   while (*tmp != '\0') {
-    sep_itr = sep;
-    while (*sep_itr != '\0') {
-      if (*tmp == *sep_itr) {
-        *itr = tmp + 1;
-        *tmp = '\0';
-        return start;
-      }
-      sep_itr++;
+    if (uv__strtok_is_sep(*tmp, sep)) {
+      *itr = tmp + 1;
+      *tmp = '\0';
+      return start;
     }
     tmp++;
   }
+
   *itr = NULL;
   return start;
 }
```

三处形态都命中 `TASK.md` 的允许清单（抽 `static` 谓词、平坦化循环体、合并赋值分支），判据（含 21 项 `uv__strtok` oracle 检查，覆盖空 token / 尾随 / 前导 / 全分隔符 / 空输入 / `sep==""` / 原地破坏 / `*itr` 推进 / 返回值恒为 token 起点）全部一致。**这是"AI 重构 + 冻结判据"第一次在 libuv 上拿到 ACCEPT。**

对比 §9 的 M1：同一个 `src/strtok.c`，一个"看起来像清理"的改动被 oracle 抓住判 REJECT，一个真正的行为保持重构拿到 ACCEPT——判据在两个方向上都工作。

### 12.3 M1a 首轮演练抓到的两个判据缺陷（已修）

1. **`test/**` 的 15 个摘要是在 CRLF 工作区上算的**：任何 LF checkout 都会让这 15 条 `both-matches` 两侧同时失配（首轮 accept 判成 REJECTED）。修法：仓库根 `.gitattributes` 加 `* -text`（不动上游那行 `test/fixtures/lorem_ipsum.txt text eol=lf`）、克隆内 `core.autocrlf=false`、摘要按 blob 字节重算。
2. **oracle 汇总行的名字取自源内宏**：`strtok-oracle`，不是文件名 `oracle_strtok`；按文件名写的 6 条 `summary` 声明两侧都不匹配。修法：workflow 内维护 `ORACLE_SUMMARY_NAMES` 映射。

结论：**判据本身必须先被验证**。这两条都不会让任何一条用例"变红"，只会在判定时表现为莫名其妙的 REJECT——所以 M1a 是使用本测试集之前的前置步骤。

### 12.4 加难：T3 `src/inet.c`（判据一字未改，ACCEPTED）

任务简报换成 T3（298 行、4 个 `static` 内部函数 + 2 个公开入口，48 项 `oracle_inet` 检查 + 4 个自带用例 `ip4_addr`/`ip6_pton`/`ip6_sin6_len`/`ip_name`），**判据仍是同一份 `test-workflow.ts`（同 98 条声明）**——加难度只加在任务侧，判据不动。

```bash
TASK=$(cat E:/Proj/refactorSubagent/testset/tasks/t3-inet.task.txt)
bun run scripts/cli.ts run E:/Proj/refactorSubagent/libuv --task "$TASK" \
  --pipeline-file E:/Proj/refactorSubagent/testset/pipeline/m1b2-inet-ai.json \
  --session m1b2-inet-s1 --session-root E:/Proj/refactorSubagent/runs/m1b2-inet \
  --limit sessions.refactor.deadlineMs=2400000 --limit sessions.refactor.maxTurns=80
```

结果：**ACCEPTED**，98/98 声明一致，两侧 build pass，`changed_files=["src/inet.c"]`，**124 增 / 56 删**（对比 T1 的 18/15）。墙钟 244 s：准备 6.2 s → **refactor 会话 134.5 s**（T1 为 56.7 s）→ 两侧构建 40.1 s / 39.2 s → 两侧测试 11.6 s / 11.8 s。

候选做出的是跨函数重构（不是改名级别的整理）：

| 新增 `static` | 作用 | 原状 |
|---|---|---|
| `inet_ntop_finish(tmp, dst, size, len)` | 统一两处 `uv__strscpy(dst,tmp,size); return 0;` 尾巴，`len` 含结尾 NUL，失败时 `return UV_ENOSPC` 且目标缓冲区一字节不写 | `inet_ntop4` 与 `inet_ntop6` 各写一遍 |
| `inet_words_from_bytes(src, words, n)` | 把 16 字节按大端拼成 16-bit 词 | `words[i/2] \|= src[i] << ((1-(i%2))<<3)` 位运算循环 |
| `inet_find_best_run(words, n)` → `struct inet_run {base,len}` | 最长零串扫描（含"串尾仍在进行的 run 也要参评"这一步） | 内联在 `inet_ntop6` 里，用匿名结构体 |
| `inet_pton6_emit(**tp, endp, val)` | 带边界检查的 16-bit 写入 | 展开在内层循环 |

同时把 `inet_pton4` 的 `saw_digit`/`octets` 状态机改写成 `continue` 平坦结构、把 v4-mapped 判定提成 `embedded_v4` 变量。两处已实测钉死的边界都保住了：单个零组不压缩（`best.len < 2` 保留并加注释）、`inet_ntop_finish` 的 `len > size` 等价于原来的 `(size_t)(tp - tmp) > size`（比较含结尾 NUL）。

判据对比（同一份 98 条，三轮运行的分布）：

| 运行 | 任务 | 候选来源 | 判定 | 声明通过 |
|---|---|---|---|---|
| `m1a-reject-s2` | T1 | 手工破坏补丁 | REJECTED | 95/98（仅 `oracle_strtok.*`） |
| `m1b-strtok-s1` | T1 | AI 会话（57 s） | ACCEPTED | 98/98 |
| `m1b2-inet-s1` | T3 | AI 会话（134 s） | ACCEPTED | 98/98 |
