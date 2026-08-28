# libuv 行为保持型重构 E2E 测试报告

## 1. 这次测试到底要回答什么问题

本次运行不是只检查“代码能不能编译”，而是要回答：

> Claude 修改 `src/strscpy.c` 之后，候选版本是否可以在与原始版本相同的构建和测试流程下，表现出相同的可观察结果？

测试对象是 libuv `v1.52.1` 中的：

- 文件：`src/strscpy.c`
- 函数：`uv__strscpy`
- 重构目标：只调整函数内部结构，不改变公开 API、返回值、内存写入语义和字符串截断语义。

系统把代码分成两个版本进行验证：

```text
baseline：重构前的原始代码
candidate：Claude 修改后的候选代码
```

之后分别对两个版本执行相同的构建和 CTest 测试，并比较结果。

---

## 2. 最终结论先看这里

本次候选 patch **没有被接受**，最终状态是：

```text
REJECTED
```

这不是因为编译失败，也不是因为明确发现 `uv__strscpy` 的测试失败，而是因为：

1. baseline 和 candidate 都成功完成了 CMake 配置和 Debug 构建；
2. baseline 和 candidate 都完整执行了 shared/static 两套 libuv CTest；
3. 两边都遇到了当前 Windows 主机上的环境敏感失败；
4. 其中一个 TCP 测试的失败归属在两个版本之间发生了漂移：
   - baseline：`uv_test:tcp_close_while_connecting`
   - candidate：`uv_test_a:tcp_close_while_connecting`
5. 比较器采用 fail-closed 策略，不允许自动解释或忽略这个漂移，因此判定为 `inconsistent` 并拒绝 patch。

换句话说：

> 这次运行证明了“从 Claude 分析到程序化验证和拒绝”的闭环能完整运行，但没有证明这个 patch 可以安全合入。

---

## 3. 测试流程总览

完整流程可以理解成下面九步：

```text
1. 探测主机环境
       ↓
2. 探测项目类型和构建系统
       ↓
3. Claude 分析行为契约、修改范围、依赖和测试方案
       ↓
4. 确定 BuildWorkflow 和 TestWorkflow
       ↓
5. 创建 baseline / candidate 两个隔离 worktree
       ↓
6. Claude 只在 candidate 中执行受限重构
       ↓
7. 分别构建 baseline 和 candidate
       ↓
8. 分别运行完整 CTest
       ↓
9. 比较两边结果，程序决定 ACCEPTED 或 REJECTED
```

需要特别区分两类结果：

- **Claude 的分析结果**：说明它认为应该如何理解和修改代码；
- **程序的执行结果**：真正构建、运行、比较，并决定是否接受。

Claude 不能自行把 patch 标记为安全，最终裁决由程序完成。

---

## 4. 第一步：主机环境探测

对应 Artifact：

```text
host-preflight.json
```

### 4.1 探测到的环境

| 项目 | 结果 | 说明 |
|---|---|---|
| 操作系统 | Windows | `platform = win32` |
| CPU 架构 | x64 | `arch = x64` |
| 默认 Shell | `cmd.exe` | 不是 POSIX Shell |
| 可执行文件后缀 | `.exe` | Windows 构建产物需要考虑后缀 |
| GCC | 可用 | 路径记录为 `E:\Scoop\apps\gcc\current\bin\gcc.EXE` |
| CMake | 可用 | 用于配置和构建项目 |
| CTest | 可用 | 用于执行测试套件 |
| Ninja | 可用 | 主机具备，但本次实际 Workflow 没有使用它 |
| WSL | 可用 | 本次没有切换到 WSL 执行 |
| Clang | 未探测到 | 不影响本次 CMake 流程 |
| Make | 未探测到 | 不影响本次 CMake 流程 |
| Sanitizer | 本次没有启用 | `sanitizers = []` |

### 4.2 一个容易混淆的地方

HostPreflight 没有把 `cl.exe` 作为直接可用工具报告出来，但实际 CMake 配置输出显示：

```text
-- Building for: Visual Studio 18 2026
-- The C compiler identification is MSVC 19.51.36248.0
```

原因是：本次 BuildWorkflow 使用了 CMake 默认生成器，CMake 自己找到了 Visual Studio/MSVC。也就是说：

- HostPreflight 是程序提前探测到的主机事实；
- CMake configure 是实际执行时的构建系统探测；
- 两者的工具发现路径不完全相同。

最终实际构建使用的是 CMake + Visual Studio 多配置构建，而不是 HostPreflight 中列出的 GCC 直接编译命令。

---

## 5. 第二步：项目探测

对应 Artifact：

```text
project-detection.json
```

### 5.1 探测结果

| 项目 | 结果 |
|---|---|
| 语言 | C |
| 发现的构建系统 | CMake |
| 主构建系统 | CMake |
| 构建适配器 | `cmake` |
| 状态 | `ready` |
| 识别标记 | `CMakeLists.txt` |
| 源文件数量 | 323 |

程序给出的原因是：

```text
cmake project detected and cmake adapter is available
```

### 5.2 这一步的含义

这一步没有修改代码，只是在回答：

> 这个项目是什么语言？应该由哪个构建适配器负责？当前主机是否具备执行条件？

因为识别到了 `CMakeLists.txt`，而且 CMake 可用，所以流程可以继续。

---

## 6. 第三步：Claude 生成行为契约

对应 Artifact：

```text
analysis-behavior-contract.json
```

行为契约规定了什么算“行为保持”。本次契约要求下面这些通道都精确保持：

| 可观察通道 | 比较方式 |
|---|---|
| 进程退出码 | exact |
| 信号/异常终止 | exact |
| stdout | exact |
| stderr | exact |
| 文件系统效果 | exact |

允许改变的内容只有：

- 内部代码结构；
- 执行时间。

### 6.1 针对 `uv__strscpy` 的具体约束

Claude 分析结果中列出了这些具体语义：

1. `n == 0` 时，不能读取源缓冲区，也不能写入目标缓冲区，并返回 `0`；
2. `n > 0` 时继续逐字节向前复制；
3. 遇到源字符串的 NUL 时，返回已复制长度；
4. 发生截断时，只保留 `n - 1` 个字节，并写入结尾 NUL；
5. 截断时返回 `UV_E2BIG`；
6. 保持 `d == s` 的原地复制行为；
7. 不额外承诺或引入部分重叠缓冲区语义。

这比一句“保持行为不变”更具体。后续测试、比较和拒绝规则都以这些约束为依据。

---

## 7. 第四步：修改范围结果

对应 Artifact：

```text
analysis-scope-manifest.json
```

### 7.1 允许修改的范围

```text
文件：src/strscpy.c
符号：uv__strscpy
```

### 7.2 允许读取的范围

```text
src/**
CMakeLists.txt
```

### 7.3 Claude 被禁止读取的范围

```text
test/**
baseline/**
```

这里要区分：

- Claude 的分析/修改权限受到这个 ScopeManifest 限制；
- 程序自己的 CTest Runner 仍然需要执行测试；
- “Claude 不能直接读或改测试”不等于“程序不能运行测试”。

### 7.4 范围执行结果

Refactor Agent 实际运行后：

```text
scope_denials = []
changed_files = ["src/strscpy.c"]
```

这表示：

- 没有发现越界写入调用；
- 候选 patch 的变更文件只有声明的目标文件；
- 没有修改测试、构建文件或其他源文件。

---

## 8. 第五步：依赖分析结果

对应 Artifact：

```text
analysis-dependency-manifest.json
```

Claude 将目标函数的主要依赖归类为：

```text
C11 integer and pointer semantics
kind: pure
strategy: real_isolated
```

分析认为目标函数依赖：

- 调用者提供的缓冲区；
- `ssize_t`；
- `SSIZE_MAX`；
- 整数和指针语义。

同时没有把目标函数声明为依赖：

- 时间；
- 随机数；
- 文件系统；
- 环境变量；
- 网络；
- 外部状态；
- 并发。

这说明从“目标函数本身”的角度看，它适合做局部、确定性的重构。

但是，整个 libuv 官方测试套件本身会触及网络、DNS、文件监听和线程等系统能力。因此：

> 依赖 Manifest 描述的是重构目标的依赖，不代表整个官方 CTest 套件没有环境依赖。

这正是本次大型 CTest 出现环境敏感失败的原因之一。

---

## 9. 第六步：测试规格结果

对应 Artifact：

```text
analysis-test-spec.json
```

Claude 分析阶段提出了 3 个针对 `strscpy` 的测试用例：

| 用例 ID | 类型 | 实际意图 |
|---|---|---|
| `strscpy-regression-normal-and-empty` | regression | 普通输入和空字符串行为 |
| `strscpy-regression-boundary-and-truncation` | regression | 边界值和截断行为 |
| `strscpy-differential-before-after` | differential | baseline 与 candidate 的行为差分 |

这三个用例都计划调用：

```text
uv_run_tests_a strscpy
```

并期望退出码为 `0`。

### 9.1 本次实际执行和这个 Artifact 的关系

本次最终验收没有只运行这 3 个小用例，而是执行了用户强制指定的完整 CTest Workflow。

因此：

- 这 3 个用例是 Claude 分析阶段的测试设计结果；
- 最终实际执行的是完整 libuv CTest 套件；
- 完整套件中包含 `strscpy` 测试；
- CTest 失败列表中没有 `strscpy`；
- shared runner 的日志明确记录了 `strscpy` 为 `ok`。

这说明目标测试没有成为本次拒绝的直接原因，但完整套件的环境漂移仍然足以触发拒绝。

---

## 10. 第七步：两个 Workflow 是什么

本次运行使用了两个由程序加载并校验的 Workflow：

```text
BuildWorkflow：负责把源码编译成可执行测试程序
TestWorkflow：负责调用这些测试程序并收集结果
```

这两个 Workflow 都是用户在 E2E 脚本中强制指定的，所以解析结果中的模式是：

```text
mode = forced
```

不是 Claude 临时自由生成，也不是程序在多个候选中自动猜选。

### 10.1 BuildWorkflow

Workflow ID：

```text
libuv-v1.52.1-cmake-debug@1
```

入口：

```text
examples/workflows/libuv-build.ts
```

实际构建内容：

```text
构建系统：CMake
配置：Debug
构建目录：build
```

CMake 配置参数：

```text
-DBUILD_TESTING=ON
-DLIBUV_BUILD_TESTS=ON
-DLIBUV_BUILD_BENCH=OFF
```

含义：

- 打开测试构建；
- 构建 libuv 官方测试；
- 关闭 benchmark，避免把基准程序混入本次测试目标。

构建参数：

```text
--config Debug
```

BuildWorkflow 声明的逻辑产物：

```text
build/uv_run_tests
build/uv_run_tests_a
```

在 Windows 上实际对应：

```text
build/Debug/uv_run_tests.exe
build/Debug/uv_run_tests_a.exe
```

其中：

- `uv_run_tests.exe`：shared library 测试程序；
- `uv_run_tests_a.exe`：static library 测试程序。

### 10.2 TestWorkflow

Workflow ID：

```text
libuv-v1.52.1-ctest-debug@1
```

入口：

```text
examples/workflows/libuv-test.ts
```

定义内容：

```text
runner: ctest
build_workflow_id: libuv-v1.52.1-cmake-debug
build_workflow_revision: 1
build_dir: build
configuration: Debug
extra_args: []
required_top_level_tests:
  - uv_test
  - uv_test_a
```

含义是：

1. 先使用上面的 BuildWorkflow 生成测试程序；
2. 再在 `build` 目录对应的 CTest 工程中执行 Debug 测试；
3. 必须在 CTest 输出中观察到 `uv_test` 和 `uv_test_a` 两个顶层目标；
4. 如果某个顶层目标没有出现，程序会将其视为环境/执行错误，而不是静默忽略。

### 10.3 为什么 Claude 的 EnvironmentSpec 看起来不一样

Claude 分析 Artifact 中提出过一个 EnvironmentSpec：

```text
CMake + Ninja
target: uv_run_tests_a
```

但最终执行使用的是 E2E 脚本中强制提供的 BuildWorkflow：

```text
CMake + Visual Studio 默认生成器
同时构建 shared/static 两个测试目标
```

所以应当这样理解：

```text
Claude EnvironmentSpec：分析阶段的建议
用户强制 Workflow：本次真正执行的构建和测试协议
```

最终执行以强制 Workflow 为准。

---

## 11. 第八步：隔离 baseline 和 candidate

程序在执行修改和测试前创建了两个独立 worktree：

```text
baseline：基于原始提交
candidate：基于同一个原始提交，再应用 Claude 的修改
```

本次记录的基线提交是：

```text
1cfa32ff59c076ffb6ed735bbc8c18361558661f
```

candidate 使用的分支名称是：

```text
refactor/agent-libuv-agent-live-001
```

这样做的目的，是保证：

- baseline 和 candidate 不共享构建目录；
- 一个版本的生成文件不会污染另一个版本；
- 两个版本从相同源码基线出发；
- 程序可以准确知道候选 patch 改了哪些文件。

---

## 12. 第九步：Claude 执行受限重构

对应 Artifact：

```text
refactor-summary.json
patch-candidate.json
```

Claude 给出的重构摘要是：

- 对 `uv__strscpy` 提前处理 `n == 0`；
- 简化循环体；
- 将截断终止位置直接写成 `d[n - 1]`；
- 移除循环后的冗余索引分支；
- 保持逐字节复制、返回值、字符串终止和原地复制语义。

候选 patch 记录显示：

```text
changed_files = ["src/strscpy.c"]
scope_denials = []
```

Claude 在自己的回话中提到，尝试直接编译时需要额外授权，因此它没有完成自己的编译检查。但这不等于整个流程没有编译验证：

> 后续由主程序通过受控 BuildWorkflow 重新配置并构建 candidate，实际构建成功。

这是职责分离：

- Claude 可以提出修改；
- 主程序负责真正执行构建并判断结果。

---

## 13. 第十步：baseline 构建结果

对应 Artifact：

```text
baseline-build.json
```

baseline 执行了两个构建阶段：

### 13.1 CMake configure

结果：

```text
status: exited
exitCode: 0
duration: 21,984 ms
```

说明 CMake 配置成功，并成功识别 Visual Studio/MSVC 工具链。

### 13.2 CMake build

结果：

```text
status: exited
exitCode: 0
duration: 85,000 ms
```

说明 baseline 编译成功，并且逻辑上声明的两个测试产物都存在。

baseline 构建总结果：

```text
PASS
```

---

## 14. 第十一步：candidate 构建结果

对应 Artifact：

```text
candidate-build.json
```

candidate 也执行了完全相同的构建流程。

### 14.1 CMake configure

```text
status: exited
exitCode: 0
duration: 22,560 ms
```

### 14.2 CMake build

```text
status: exited
exitCode: 0
duration: 85,338 ms
```

candidate 构建总结果：

```text
PASS
```

因此可以明确排除：

- 语法错误；
- 编译错误；
- 基本链接错误；
- 构建产物缺失。

本次拒绝发生在构建之后的测试结果比较阶段。

---

## 15. 第十二步：CTest 到底测试了什么

实际运行的命令等价于：

```text
ctest --test-dir build -C Debug --output-on-failure -j 1
```

参数含义：

| 参数 | 含义 |
|---|---|
| `--test-dir build` | 使用 `build` 目录中的 CTest 工程 |
| `-C Debug` | 运行 Debug 配置 |
| `--output-on-failure` | 失败时输出详细诊断 |
| `-j 1` | 串行执行，避免多个网络/文件测试互相干扰 |

程序还设置了套件级超时，并在 Windows 上使用进程树清理，避免测试进程或子进程永久挂起。

### 15.1 CTest 的两个层级

本次输出有两个层级，容易混淆：

```text
CTest 顶层目标：2 个
  1. uv_test
  2. uv_test_a

每个顶层目标内部的 TAP 测试：约 474/477 个
```

因此 Artifact 中的：

```json
"total": 2,
"passed": 0,
"failed": 2
```

表示的是 **2 个顶层 CTest 目标**，不是表示只有两个内部测试，更不是表示 474/477 个测试全部失败。

---

## 16. baseline CTest 结果

对应 Artifact：

```text
baseline-ctest-result.json
ctest-baseline.json
```

### 16.1 顶层结果

```text
status: fail
exit_code: 8
duration: 368,435 ms，约 6 分 8 秒
top_level_tests:
  - uv_test
  - uv_test_a
```

两个顶层目标都被 CTest 判为失败，所以 CTest 总结为：

```text
0% tests passed, 2 tests failed out of 2
```

这里的“0%”是顶层 CTest 目标比例，不是内部 474/477 个 TAP 用例的通过比例。

### 16.2 baseline shared 测试

`uv_test` 内部报告：

```text
1..474
```

失败的内部测试有 5 个：

```text
fs_event_watch_dir_short_path
getaddrinfo_fail
getaddrinfo_fail_sync
tcp_close_while_connecting
tcp_connect_timeout
```

其余已输出的测试大部分为 `ok`，部分测试按官方逻辑被 `SKIP`。

### 16.3 baseline static 测试

`uv_test_a` 内部报告：

```text
1..477
```

失败的内部测试有 4 个：

```text
fs_event_watch_dir_short_path
getaddrinfo_fail
getaddrinfo_fail_sync
tcp_connect_timeout
```

注意：baseline 的 `tcp_close_while_connecting` 失败出现在 shared 顶层目标中，没有出现在 static 顶层目标中。

### 16.4 为什么 Artifact 有 11 条 failure name

baseline 的结构化失败列表包含：

- 5 条 `uv_test:<inner-test>`；
- 4 条 `uv_test_a:<inner-test>`；
- 2 条顶层套件名：`uv_test`、`uv_test_a`。

最后两个不是额外的内部测试，而是 CTest 顶层失败的汇总记录。真正的内部失败是前面的 9 条。

---

## 17. candidate CTest 结果

对应 Artifact：

```text
candidate-ctest-result.json
ctest-candidate.json
```

### 17.1 顶层结果

```text
status: fail
exit_code: 8
duration: 368,835 ms，约 6 分 9 秒
top_level_tests:
  - uv_test
  - uv_test_a
```

candidate 与 baseline 一样，两个顶层 CTest 目标都执行到了，且都被判为失败。

### 17.2 candidate shared 测试

`uv_test` 内部报告：

```text
1..474
```

失败的内部测试有 4 个：

```text
fs_event_watch_dir_short_path
getaddrinfo_fail
getaddrinfo_fail_sync
tcp_connect_timeout
```

### 17.3 candidate static 测试

`uv_test_a` 内部报告：

```text
1..477
```

失败的内部测试有 5 个：

```text
fs_event_watch_dir_short_path
getaddrinfo_fail
getaddrinfo_fail_sync
tcp_close_while_connecting
tcp_connect_timeout
```

所以 candidate 不是“多出了一个完全新的失败测试”，而是 `tcp_close_while_connecting` 的失败从 shared 目标移动到了 static 目标。

---

## 18. 每个失败测试具体在测什么

这些失败都没有直接指向 `src/strscpy.c`。它们测试的是 Windows 文件系统、DNS 和 TCP 网络行为。

### 18.1 `fs_event_watch_dir_short_path`

测试内容：

- 创建目录和文件；
- 启动文件系统事件监听；
- 使用 Windows 短路径相关行为观察事件回调；
- 检查回调返回的路径是否符合预期。

实际失败证据是 `test/test-fs-event.c` 中的路径断言失败，涉及 `_wcsncmp(filename, dir, dirlen)`。

更直观地说：

> 测试期待 Windows 文件监听回调返回的路径前缀与测试目录一致，但当前主机返回的路径形式没有满足这个断言。

这属于 Windows 文件监听/路径环境差异，不是字符串复制函数的测试。

出现位置：

- baseline shared；
- baseline static；
- candidate shared；
- candidate static。

因此这是两边共有的环境问题。

### 18.2 `getaddrinfo_fail`

测试内容：

```text
解析 example.invalid.
```

`example.invalid.` 被用作一个预期不存在的域名。测试期望：

```text
status < 0
res == NULL
```

实际结果：

```text
status = 0
```

也就是当前机器上的 DNS/解析链路返回了成功，而测试预期解析失败。

出现位置：

- baseline shared；
- baseline static；
- candidate shared；
- candidate static。

### 18.3 `getaddrinfo_fail_sync`

这是上一个 DNS 测试的同步版本。

测试期望：

```text
uv_getaddrinfo(...) < 0
```

实际结果：

```text
uv_getaddrinfo(...) == 0
```

这说明同一类 DNS 负向解析假设在同步调用中也不成立。

出现位置：

- baseline shared；
- baseline static；
- candidate shared；
- candidate static。

### 18.4 `tcp_connect_timeout`

测试内容：

- 连接一个预期不可达或不会及时建立连接的地址；
- 启动 50ms 定时器；
- 定时器触发时关闭连接；
- 验证连接回调收到 `UV_ECANCELED`。

测试期望：

```text
status == UV_ECANCELED
```

实际结果：

```text
status == 0
```

也就是连接在当前网络环境下返回了成功，或者至少没有按照测试预期进入取消状态。

这受到以下因素影响：

- 当前网络路由；
- 防火墙；
- 操作系统 TCP 栈；
- 目标地址的实际响应；
- 连接建立与定时器之间的时序。

出现位置：

- baseline shared；
- baseline static；
- candidate shared；
- candidate static。

### 18.5 `tcp_close_while_connecting`

测试内容：

- 连接一个任意的不可达地址；
- 连接尚未完成时关闭 TCP handle；
- 检查连接回调收到可接受的取消/不可达错误。

测试允许的结果是：

```text
UV_ECANCELED
或
UV_ENETUNREACH
```

baseline 的 shared 版本出现了断言失败；candidate 的 static 版本出现了断言失败。

这个测试特别依赖网络路径和时序，所以即便源代码没有变化，也可能在不同运行、不同测试目标或不同时间点产生不同错误归属。

但当前比较器没有把这种漂移自动视为“可以忽略”。它只看到：

```text
baseline 有：uv_test:tcp_close_while_connecting
candidate 有：uv_test_a:tcp_close_while_connecting
```

于是按照严格差分规则报告为失败集合变化。

---

## 19. 第十三步：baseline/candidate 差分比较

对应 Artifact：

```text
ctest-comparison-result.json
```

比较器检查了：

1. 顶层测试名称是否相同；
2. baseline/candidate 的顶层状态是否相同；
3. 失败测试名称集合是否相同。

### 19.1 相同的部分

```text
baseline top-level tests = [uv_test, uv_test_a]
candidate top-level tests = [uv_test, uv_test_a]
status match = true
```

所以：

- 测试目标没有丢失；
- candidate 没有因为修改而无法启动测试；
- 两边都执行了完整的 shared/static CTest 流程；
- 两边顶层状态都是 `fail`。

### 19.2 不同的部分

比较器发现：

```text
added_failures:
  uv_test_a:tcp_close_while_connecting

removed_failures:
  uv_test:tcp_close_while_connecting
```

因此结果为：

```text
overall: inconsistent
```

原因原文是：

```text
CTest drift: added=[uv_test_a:tcp_close_while_connecting]
removed=[uv_test:tcp_close_while_connecting]
```

### 19.3 为什么已分类为 environment，仍然拒绝

baseline 失败分类中，这些失败被程序标记为：

```text
category: environment
related_to_scope: false
```

这表示程序有证据认为它们是环境相关，并且不涉及 `src/strscpy.c`。

但这并不自动等于“可以放行”。当前 fail-closed 规则是：

```text
环境失败可以被记录和解释；
无法证明 baseline/candidate 结果集合一致时，不能自动接受 patch。
```

这是两个不同问题：

- **失败原因分类**：它更像环境问题还是代码问题？
- **差分是否一致**：新旧版本的观测结果是否完全相同？

本次第一个问题的答案偏向环境，第二个问题的答案是“不一致”。所以最终仍然拒绝。

---

## 20. 状态机最终走了哪些状态

状态转换记录如下：

```text
INIT
  → CONTRACT_READY
  → SCOPE_READY
  → DEPENDENCY_READY
  → TESTS_READY
  → BUILD_WORKFLOW_READY
  → TEST_WORKFLOW_READY
  → ENV_READY
  → BASELINE_READY
  → PATCH_CREATED
  → VERIFICATION_RUNNING
  → REJECTED
```

每个状态的直观含义：

| 状态 | 含义 |
|---|---|
| `CONTRACT_READY` | 行为契约已通过 Schema 校验 |
| `SCOPE_READY` | 可编辑文件和符号范围已确定 |
| `DEPENDENCY_READY` | 依赖和隔离策略已确定 |
| `TESTS_READY` | 测试规格已确定 |
| `BUILD_WORKFLOW_READY` | 构建 Workflow 已确定 |
| `TEST_WORKFLOW_READY` | 测试 Workflow 已确定 |
| `ENV_READY` | 构建环境 Artifact 已提交 |
| `BASELINE_READY` | 原始版本已完成基线测试 |
| `PATCH_CREATED` | candidate patch 已创建并记录 |
| `VERIFICATION_RUNNING` | candidate 正在执行验证 |
| `REJECTED` | 比较结果不满足自动接受条件 |

这里没有进入 `ABORTED`，因为流程没有崩溃，也没有遇到无法继续的结构化错误；它完成了验证，只是验证结果不允许接受。

---

## 21. 这次测试证明了什么

已证明：

- 可以识别一个真实 CMake/C 项目；
- 可以生成并校验结构化 Behavior Contract；
- 可以限制 Claude 的可编辑文件和符号；
- 可以把 baseline 和 candidate 放进隔离 worktree；
- 可以用固定 BuildWorkflow 执行 CMake configure/build；
- baseline 和 candidate 都能成功编译；
- 可以执行大型 CTest 套件；
- 可以实时保存 CTest 输出和结构化结果；
- 可以区分顶层 CTest 测试和内部 TAP 用例；
- 可以识别 Windows/DNS/TCP 环境失败；
- 当失败集合发生漂移时，程序会拒绝自动接受。

---

## 22. 这次测试没有证明什么

没有证明：

- candidate patch 已经安全；
- `uv__strscpy` 在所有可能输入下都与原实现等价；
- 当前 Windows 主机可以让 libuv 完整 CTest 全部通过；
- sanitizer 下没有未定义行为；本次没有启用 sanitizer；
- 网络和 DNS 失败可以安全忽略；
- 只要失败被标记为 environment，就应该放行 patch。

特别是：

> “目标测试 `strscpy` 没有出现在失败列表中”是正面证据，但不足以抵消完整测试结果中的失败集合漂移。

---

## 23. 运行证据索引

本次运行的 session ID：

```text
libuv-agent-live-001
```

关键证据：

| Artifact | 内容 |
|---|---|
| `host-preflight.json` | 主机、工具链和平台事实 |
| `project-detection.json` | C 项目和 CMake 探测结果 |
| `analysis-behavior-contract.json` | 行为保持规则 |
| `analysis-scope-manifest.json` | 可读、可改、禁止范围 |
| `analysis-dependency-manifest.json` | 依赖类别和隔离策略 |
| `analysis-test-spec.json` | Claude 设计的目标测试 |
| `analysis-environment-spec.json` | Claude 分析阶段提出的环境建议 |
| `workflow-resolution-build.json` | 实际采用的 BuildWorkflow 及其来源 |
| `workflow-resolution-test.json` | 实际采用的 TestWorkflow 及其来源 |
| `build-workflow-output.json` | 实际构建和测试产物定义 |
| `refactor-summary.json` | Claude 重构摘要和范围拒绝记录 |
| `patch-candidate.json` | candidate commit 和变更文件 |
| `baseline-build.json` | baseline configure/build 结果 |
| `candidate-build.json` | candidate configure/build 结果 |
| `baseline-ctest-result.json` | baseline 原始 CTest 结果 |
| `candidate-ctest-result.json` | candidate 原始 CTest 结果 |
| `ctest-baseline.json` | baseline 失败分类后的结果 |
| `ctest-candidate.json` | candidate 结构化结果 |
| `ctest-comparison-result.json` | 新旧结果比较和最终差分依据 |
| `run.jsonl` | 按时间顺序记录的全流程事件 |
| `state.json` | 最终状态和最后事件 |

---

## 24. 用一句话总结

这次测试不是“代码编译通过所以成功”，而是：

```text
Claude 只改了指定的 C 函数
→ 原版和候选版都编译成功
→ 两边都完整跑了 libuv shared/static 测试
→ 目标 strscpy 测试没有失败
→ 但 Windows 网络/文件系统环境失败在两边的归属发生漂移
→ 程序无法证明观测结果一致
→ 按 fail-closed 规则拒绝 patch
```

因此，这次的最终结果是：

```text
验证链路成功运行；候选重构未被自动接受。
```
