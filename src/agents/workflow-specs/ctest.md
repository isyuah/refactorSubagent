# CTest 用法（按需读取）

> 生成 TestWorkflow（runner: "ctest"）时读本文件。

## 运行

```bash
ctest --test-dir <build_dir> [-C <Config>] [--output-on-failure] [args...]
```

- `--test-dir`：构建目录（含 CTestTestfile.cmake）
- `-C`：配置（多配置生成器必填，如 `Debug`）
- `--output-on-failure`：失败时输出详情

## 输出解析要点

顶层测试格式：

```text
1/2 Test #1: uv_test ..........................***Failed  213.38 sec
2/2 Test #2: uv_test_a ........................***Failed  213.31 sec

0% tests passed, 2 tests failed out of 2
```

- 每行 `Test #N: <name>` 是一个顶层测试
- `***Failed` / `Passed` 是状态
- 底部 `X% tests passed, N tests failed out of M` 是总结
- 大型测试（如 libuv 的 uv_test 跑 477 个内部用例）用 TAP 输出（`ok 1 - ...` / `not ok ...`），**内部用例失败 ≠ 顶层测试失败**——顶层测试的状态看 Test #N 行

## workflow 里如何用

TestWorkflow 的 `runner: "ctest"` 由宿主执行，workflow 本身**不跑 ctest**。workflow 只声明：

```ts
{
  runner: "ctest",
  build_dir: "build",
  configuration: "Debug",
  required_top_level_tests: ["uv_test", "uv_test_a"],  // 观察自 CMakeLists add_test
  extra_args: [],
}
```

宿主管超时、并行、进程隔离、最终裁决。

## 观察测试名

在 CMakeLists.txt 找：

```cmake
add_test(NAME uv_test COMMAND uv_run_tests ...)
add_test(NAME uv_test_a COMMAND uv_run_tests_a ...)
```

`NAME` 后的名字就是要填进 `required_top_level_tests` 的。

## 环境敏感失败

某些测试在特定环境失败（IPv6/UDP/DNS/超时）——这是**宿主分类**的职责，workflow 不需要处理。workflow 只声明测试集合，宿主判断成败。
