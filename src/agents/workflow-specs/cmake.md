# CMake CLI 用法（按需读取）

> 生成 BuildWorkflow 时如果项目是 CMake，先读本文件。
> 这里是最常用的命令与**关键陷阱**。

## 常用命令

### Configure（生成构建系统）

```bash
cmake -S <source_dir> -B <build_dir> [-G <generator>] [flags...]
```

- `-S`：含 CMakeLists.txt 的源码目录
- `-B`：构建目录（自动创建）
- `-G`：生成器（如 `"Visual Studio 17 2022"`、`Ninja`）；省略 = CMake 默认
- flags 常见：`-DBUILD_TESTING=ON`、`-DCMAKE_BUILD_TYPE=Debug`

### Build（编译）

```bash
cmake --build <build_dir> [--config <Config>] [--target <target>] [flags...]
```

- `--config`：多配置生成器（VS/Ninja Multi-Config）指定配置：`Debug`/`Release`/`RelWithDebInfo`/`MinSizeRel`
- `--target`：**只接受一个目标名**（见陷阱 1）

## 关键陷阱

### 陷阱 1：`--target` 只能一个目标 ⚠️

```bash
# 错误——CMake 会报错
cmake --build build --target uv_run_tests uv_run_tests_a

# 正确——分别构建
cmake --build build --target uv_run_tests
cmake --build build --target uv_run_tests_a
```

在 workflow 里：

```ts
// 正确：循环分别跑
for (const target of ["uv_run_tests", "uv_run_tests_a"]) {
  await ctx.process.run({
    program: "cmake",
    args: ["--build", "build", "--config", "Debug", "--target", target],
    timeoutMs: 600000,
  });
}
```

### 陷阱 2：多配置生成器的产物在配置子目录

Visual Studio / Ninja Multi-Config 生成器输出到 `<build_dir>/<Config>/<target>.exe`：

```text
build/Debug/uv_run_tests.exe      # Debug 配置
build/Release/uv_run_tests.exe    # Release 配置
```

**不是** `build/uv_run_tests.exe`。探测产物时查配置子目录。

### 陷阱 3：MSVC Debug 可执行文件带 `d` 后缀

MSVC 的 Debug 配置下，可执行文件可能带 `d` 后缀：

```text
uv_run_tests.exe    → Debug 下可能是 uv_run_testsd.exe
uv_run_tests_a.exe  → Debug 下可能是 uv_run_tests_ad.exe
```

探测产物时两种都检查：

```ts
const candidates = ["build/Debug/uv_run_tests.exe", "build/Debug/uv_run_testsd.exe"];
const found = candidates.find(async (p) => await ctx.fs.exists(p));
```

### 陷阱 4：测试目标通常需要显式开启

大型项目（如 libuv）的测试目标受 option 控制：

```cmake
cmake_dependent_option(LIBUV_BUILD_TESTS "..." ON "BUILD_TESTING;..." OFF)
```

configure 时显式传：
```bash
cmake -S . -B build -DBUILD_TESTING=ON -DLIBUV_BUILD_TESTS=ON -DLIBUV_BUILD_BENCH=OFF
```

不开启则测试可执行文件根本不构建。

### 陷阱 5：`add_test` 注册的测试名

`add_test(NAME <name> COMMAND ...)` 的 `<name>` 是 CTest 看到的顶层测试名：

```cmake
add_test(NAME uv_test COMMAND uv_run_tests ...)
```

`ctest -N` 会列出这些名字。`required_top_level_tests` 应该填这些观察到的名字。

## 检查 configure 是否成功

退出码 0 = 成功。configure 失败时看 stderr 定位（缺工具、缺依赖、语法错）。
