# Scout 首轮真实模型评测（2026-10-19）

六个场景均已尝试调用真实模型。最终取得 **5 份有效调查报告、5 份真实模型评分**；
这五份均达到当前 0.8 门槛，平均分 0.9587。文件资源场景两次均被模型服务以额度不足拒绝，
未产生报告，不能记为能力得分 0，也不能将本批描述为六例全部通过。

人工复核确认了范围选择、依赖追踪和保留判断的价值，也发现模型裁判存在漏判、误扣和将源码知识
补进报告的情况。**自动通过是本批评分器的结果，不代表人工接受或完整流程验收。**

## 环境、模型身份和输入

| 项目 | 实际情况 |
|---|---|
| 宿主 | Windows / win32 / x64 |
| 分支 | `codex/verification-strategies`，含未提交实现 |
| HEAD | `49506943ae2741b078b6d973648ab0868862ae59`；仅 HEAD 不能重现未提交实现，应结合快照 |
| Bun / Claude Code CLI | `1.3.14` / `2.1.259` |
| scout 请求别名 | `sonnet` |
| judge 请求别名 | `opus` |
| 两者成功响应的 `message.model` | **`deepseek/deepseek-v4.1-flash`** |
| scout 预算 | 24 轮、300 秒期限、90 秒无消息期限 |
| judge 预算 | 2 轮、240 秒期限、90 秒无消息期限，无工具 |
| scout skill SHA-256 | `457d124fbe8f532a1dbc1e9a4cc210bcbfdba0a3103f60bd22805ee603e21aab` |

本机 Sonnet/Opus 配置映射不能证明实际后端身份；上述身份来自响应字段，而不是配置名。
本次不是 Sonnet 对 Opus 的比较，也不是异构模型交叉评审。独立会话隔离了上下文，不能消除同模型偏差。
被额度拒绝的会话只产生 `<synthetic>` 错误消息，没有可确认的后端模型响应。

scout 独立入口使用生产角色定义、相同 skill 和真实 MCP 提交工具；未启动 test-writer、build-writer 或 refactor。
每例的任务、完整源码、实际 prompt/skill、Preflight 和预算均保存于 `scout-input.json`。
重试沿用原材料、提示词和评分参考，没有根据结果调整标准。

## 执行与原始证据

第一例单跑确认链路，随后其余五例以并发 2 执行。首次 allocator 和 file-resource 被服务拒绝，
各串行重试一次；allocator 成功，file-resource 再次失败。没有继续循环重试。

| 阶段 | 请求数量 | 结果 |
|---|---:|---|
| scout 首次运行 | 6 | 4 份报告；2 次额度拒绝 |
| scout 重试 | 2 | allocator 提交；file-resource 再次被拒绝 |
| 五份真实报告的裁判会话 | 6 | 5 次评分成功；allocator 首次被拒绝、重试成功 |
| 人工错误报告的负控裁判 | 1 | 成功评分并识别预设关键错误，不计入 scout 样本 |

这里的数量是会话启动次数，不是 HTTP 请求数；单个 scout 会话会进行多轮模型请求。
服务错误为 `API Error: 400 You have insufficient credits to make this request`。
同一批中另有成功请求，只能确认这些会话被拒绝，不能据此确定账户余额或网关路由的根因。

两个 runner 输出目录保持原样，没有用后来的成功结果覆盖最初失败：

- [首次运行及六例无模型复评](../../runs/scout-real-20261019-a/summary.reevaluated.json)：4 pass / 2 fail，两个 fail 均为服务拒绝。
- [重试批次的中等档无模型复评](../../runs/scout-real-20261019-retry/summary.reevaluated.json)：1 pass / 1 fail。
- [合并查看各次尝试的汇总](../../runs/scout-real-20261019-a/trial-summary.json)：明确选取 allocator 重试结果，保留所有原始尝试路径、模型身份、评分绑定和工具统计。
- allocator 首次裁判错误另存于 `scout-real-20261019-retry/scout-allocator-chain/judge-attempt-1/`；成功裁判的会话与评分继续保存在该 case 目录。

`runs/` 被 Git 忽略。此文保存结论，完整本机记录位于上述目录。

## 六个场景的结果

耗时取 `scout-result.elapsedMs`：包含源码快照、Preflight、模型调查和提交，**不包含材料准备与裁判**。
Read 数量按工具调用 ID 去重；不能用会话 JSONL 行数代替模型轮数或工具次数。

| 场景 | 难度 | 报告建议 | scout 耗时 | Read | 模型分数 | 本轮状态 |
|---|---|---|---:|---:|---:|---|
| local-function | 基础 | `source-harness` | 64.2s | 5 | 1.000 | 已评分，达到门槛 |
| existing-tests | 基础 | `source-harness`，复用测试为备选 | 39.6s | 6 | 0.909 | 已评分，达到门槛；人工发现推荐依据有误 |
| allocator-chain | 中等 | `source-harness` | 39.5s | 7 | 1.000 | 重试后已评分；人工发现替身建议不完整 |
| file-resource | 中等 | 无报告 | 两次均在调查前被拒绝 | 0 | — | 服务阻断，未评估 |
| shared-library | 进阶 | `library-consumer` | 37.7s | 4 | 0.885 | 已评分，达到门槛；人工发现生命周期遗漏 |
| missing-provider | 进阶 | `undetermined` | 39.1s | 5 | 1.000 | 已评分，达到门槛；人工发现事实错误 |

五个成功场景均由真实 MCP 一次接受报告；宿主检查源码前后内容一致，无超时。
会话记录只出现 Read / Glob / Grep、查询配方和报告提交，未观察到读隐藏 reference、写源码或调用 shell。
这是本批会话的观察，不是 OS 沙箱保证。裁判会话未调用工具。

以下是模型原始逐项分数，未按人工复核改写：

| 场景 | 事实顺序及权重 | 原始分数 |
|---|---|---|
| local-function | 返回/截断(3)、缓冲区边界(3)、范围/依赖(3)、可行性诚实性(1) | 1 / 1 / 1 / 1 |
| existing-tests | 已有相关覆盖(4)、归一化语义(3)、错误/输出契约(2)、基于证据复用(2) | 1 / 1 / 1 / 0.5 |
| allocator-chain | 真实依赖链(4)、内存接缝(3)、错误/所有权/释放(3)、协议观察(2) | 1 / 1 / 1 / 1 |
| shared-library | 真实公开边界(4)、ABI 协商(3)、所有权/生命周期(3)、状态/失败更新(3) | 1 / 1 / 1 / 0.5 |
| missing-provider | 缺失配置(4)、未知 provider 契约(3)、源码优于旧文档(3)、可推进的不确定性(2) | 1 / 1 / 1 / 1 |

### 1. 局部函数：范围选择正确，交接措辞有错

scout 正确识别 `text_copy` 只需真实头文件和实现，Vulkan 属于应用调用方。
报告准确说明返回完整源长度、截断、容量 0/1、终止符、精确容量与写入范围，并明确没有编译或运行。
这是当前最清楚的正例：无需为了小函数引入整个图形应用。

人工发现两个报告问题：

- openQuestions 要求独立的 “harness entry point that does not define main”。目标实现没有 main，新增可执行 harness 通常应提供 main；这句会误导后续 writer。
- 将无符号 `capacity - 1` 的回绕描述为不具有良好定义不准确。无符号回绕本身有定义；危险是后续错误的长度选择、读取或越界写入。

报告还为简单函数提出了若干不影响当前范围判断的开放问题，交接可以更精简。
[原报告](../../runs/scout-real-20261019-a/scout-local-function/scout-analysis.json) ·
[原始评分](../../runs/scout-real-20261019-a/scout-local-function/rubric.json)。

### 2. 已有测试：发现覆盖，但低估复用价值

scout 读到了 `key_test`、真实 `key_core` 和 CMake 关系，正确排除了不调用目标的 `version_smoke`。
归一化、返回码、容量和错误时缓冲区不变的解释整体正确。

但其选择新增 harness 的主要论据有问题：

- 将 `needs-adapter` 当作 CMake 不可靠/不可用，虽然同一 Preflight 明确写着 `configure_probe/build_probe = not-run`，原因是主动跳过。
- 声称已有测试缺少“容量大于 length+1”和“数字、连字符保持不变”的断言。实际第一条就用 `out[12]` 处理 `"Ab_09-Z"` 并比较 `"ab-09-z"`，已经覆盖这两点。
- 连续下划线与写入哨兵等确实可补充，但并不足以自动推出应该重写整套 harness；应比较补充已有测试的成本。

裁判对复用论证扣了半分，方向合理；但也沿用了部分错误的“已有缺口”描述。
**选 source-harness 本身不是错误，错误是支撑选择的事实不准确。**
[原报告](../../runs/scout-real-20261019-a/scout-existing-tests/scout-analysis.json) ·
[原始评分](../../runs/scout-real-20261019-a/scout-existing-tests/rubric.json)。

这里也暴露了宿主事实的问题：[独立入口](../../testset/runner/scout-session.ts) 主动跳过 CMake probe，
而 [project-detector](../../src/runtime/project-detector.ts) 的 `adapterAvailable` 要求两个 probe 都为 pass，
否则输出 `needs-adapter`，reason 写“adapter or host tool is unavailable”。
因此，本次相同输入会把“未验证”表现得像“不可用”，容易诱导模型选择。
探测器并未检查 DeviceSDK，missing-provider 报告将该状态归因为 DeviceSDK 缺失也没有宿主测量依据。

### 3. 分配器依赖链：分析扎实，确定失败方案未交付

scout 跟到了 `frame_parse → wire_checksum` 和 `hex_decode → nibble`，要求编译三个真实实现，
没有用固定成功替代 checksum/解码。它准确解释了校验顺序、错误不写 out、坏 hex 的释放、成功后的
所有权转移，以及 `frame_release` 清空后不再释放。

问题是报告把 FrameMemory 回调分类为 `real`，把 counting allocator 归为临时资源，
强调传入 malloc/free，却没有明确提出“在既有 ctx/alloc/release 接缝中按指定调用返回 NULL”
这样的确定失败方案，也没有说明这一方案不能验证真实 allocator 的集成语义。
知道返回 -4 的代码条件，尚不等于向 writer 交付了可执行的故障模拟建议。

裁判的满分理由声称报告已规划 “alloc-failure (-4, NULL allocator/counting)”；提交报告没有明确的
失败注入方案。裁判还声称报告明确给出了大小写十六进制及空 payload 观察，实际上它主要来自裁判
自己看到的源码和公式。按“不得替报告补全未声明知识”的规则，这些满分理由过宽。

下一步应补充接入点、模拟的成功/失败/计数行为、保留真实逻辑，以及覆盖损失；不要求 scout 写 mock 代码。
[重试后原报告](../../runs/scout-real-20261019-retry/scout-allocator-chain/scout-analysis.json) ·
[原始评分](../../runs/scout-real-20261019-retry/scout-allocator-chain/rubric.json)。

### 4. 文件资源：本轮没有能力证据

两次会话均在调用 Read 前被额度错误终止，没有提交报告，跳过模型评分。
因此无法判断 scout 是否会保留真实临时文件、正确区分打开/读取/格式错误，或错误地假设跨平台
读失败注入方式。前次可信探针证明材料可以编译运行，不代表 scout 已通过这一场景。
[首次结果](../../runs/scout-real-20261019-a/scout-file-resource/scout-result.json) ·
[重试结果](../../runs/scout-real-20261019-retry/scout-file-resource/scout-result.json)。

### 5. 共享库：抓住公开 ABI，生命周期仍需补齐

scout 推荐每侧构建自己的真实共享库，经 `counter_get_api` 获取表，保留真实公开头和不透明 Counter。
版本/size 必须精确匹配、错误返回 NULL、库内分配与 close、范围错误不改状态/out 等方向正确。

仍有以下遗漏或论证错误：

- 没有明确要求 API 表和函数指针仅在库加载期间使用、所有对象在卸载前 close，或验证多个 Counter 之间状态独立。原评分参考明确要求这些内容，裁判却给生命周期满分。
- 没有明确提出连续 step、失败后再成功观察，以及极大 delta 的观察方案。
- 说 source-harness 会退化成复制/include 生产实现过于绝对；直接编译真实 .c 也可做局部 harness。这里需要真实 DLL 的理由应是公开导出/ABI 覆盖，而不是局部 harness 本身不可行。
- 裁判扣分理由称报告没有准确识别 `seed <= 100`，但 behaviors 已明确写了这条。seed 参数是 unsigned，“负 seed”也不能作为报告遗漏的独立有符号输入契约。

保留原始 0.885 分，不用错误理由自动改判；生命周期项和状态项应重新人工审核。
[原报告](../../runs/scout-real-20261019-a/scout-shared-library/scout-analysis.json) ·
[原始评分](../../runs/scout-real-20261019-a/scout-shared-library/rubric.json)。

### 6. 缺失配置/provider：正确保留判断，部分源码推断失真

scout 识别了缺 config 模板/生成头、`DEVICE_VALIDATE_REPLY` 值未知、provider 仅有声明和生命周期
文档缺失，并选择 `undetermined`，提出当前配置、provider 版本/链接形态和初始化/清理约束等问题。
它没有凭旧文档声称模块无状态，也没有虚构已编译或通过。

但报告和评分有两个实质问题：

- behaviors 说 NULL out “return -1 immediately”。源码先构造请求并执行 `++sequence`，再判断 NULL；因此 NULL 调用也会影响下一次有效调用的请求序列。报告识别了状态存在，却没有准确交接这个错误路径状态变化。裁判注意到措辞但仍给满分。
- inference 说“没有生成头时编译会把未定义宏当 0 并禁用校验”。源码是无条件 `#include "device_options.h"`，头不存在先导致编译失败；只有头文件已经提供且宏未定义等特定条件下，`#if` 才按 0 处理。裁判 summary 也复述了这个错误。

当前“暂不决定验证范围”的结论合理，但不应据满分忽略这些问题。
[原报告](../../runs/scout-real-20261019-a/scout-missing-provider/scout-analysis.json) ·
[原始评分](../../runs/scout-real-20261019-a/scout-missing-provider/rubric.json)。

## 裁判负控与评分可信度

以 local-function 的同一任务、源码、参考和规则，人工构造了一份保持合理范围建议、
但故意将返回语义改成“实际复制字节数”的报告。单独会话评分，不混入真实 scout 结果。

裁判把 `return-and-truncation` 判为 **0**，宿主因 critical 错误拒绝，原始总分 **0.400**。
因此它能够发现这一明显核心错误，宿主的 critical 拒绝路径也在真实输出上生效。

但该裁判还把 scope/dependencies 判为 0.5，理由称报告没有明确说明 Vulkan 无关/无需全工程构建；
负控实际明写 “Vulkan belongs only to application.c and is unnecessary for this function”。
buffer-boundaries 的扣分也部分重复了另一个事实的返回语义错误。
这进一步说明分项理由不能直接作为事实，且同模型有时会在看到一处错误后扩大扣分。

[人工负控](../../runs/scout-real-20261019-a/calibration-negative/negative-report.json) ·
[裁判与宿主结果](../../runs/scout-real-20261019-a/calibration-negative/calibration-result.json)。

本轮仅有一次人工负控，没有形成裁判准确率、稳定性或模型优劣的统计结论。
完整报告裁判没有重复采样，也没有以另一个后端模型交叉评分。

## 调用量与交接体量

以下是成功 scout 会话的响应 usage，按 `message.id` 去重后累加，避免 JSONL 对同一 assistant
回复的重复内容导致多计。输入与缓存读取分列，字段语义依赖兼容服务，不能换算成实际账单。
这张表不包含裁判；完整分会话统计见合并汇总。

| 场景 | input_tokens | cache_read_input_tokens | output_tokens | 提交报告字符数 |
|---|---:|---:|---:|---:|
| local-function | 63,162 | 8,192 | 4,170 | 9,357 |
| existing-tests | 57,179 | 19,712 | 4,388 | 6,047 |
| allocator-chain | 45,054 | 15,616 | 4,022 | 9,075 |
| shared-library | 56,175 | 15,104 | 4,070 | 5,123 |
| missing-provider | 73,342 | 15,360 | 4,348 | 8,148 |

字符数为 `JSON.stringify(report).length`，不是 tokenizer 结果，也不能跨中英文直接比较质量。
五个工程只有 4–7 个文本文件、1.3–2.7 KiB 源码，报告仍为约 5–9 千字符，最终回复还重复了一遍。
隔离调查上下文已有作用，但“只交接决定性结论”的压缩还可以改善。

## 下一步建议及本轮边界

1. **先修正 Preflight 的不确定状态表达。** 主动跳过探测应该表达“尚未确认”，不要输出像已测失败的理由；scout 也应同时检查 probe 状态，不能用它无依据否定已有覆盖。
2. **定向强化调查交接。** 关注确定失败接缝、关键错误路径的状态变化、跨调用/多对象/卸载生命周期；核对“已有测试没覆盖”的断言，不扩大 scout 到构建手册或测试代码编写。
3. **收紧裁判的证据约束并加入少量有区分力的校准。** 理由应指向报告实际陈述，缺失内容不能从源码补全；用“缺确定失败计划”“漏卸载生命周期”等边界报告校准，而不只用全对/明显全错样本。条件允许时确认第二个后端的实际身份后交叉评分。
4. **补完 file-resource 后，再挑少量组合流程。** 先检查真实临时文件与读失败限制，再用局部 harness 和共享库场景验证 writer 能将建议变成两侧可运行验证。

本轮完成真实 scout/裁判调用、单例负控、程序性结果检查、源码/报告/评分的人工复核及无模型缓存复评。
没有为了获得更高分修改生产提示词、输入材料或评分参考，也没有将发现的问题顺手改入生产流程。
没有运行 Linux/macOS、writer 组合、baseline/candidate 构建执行或完整 `bun run check`；
此处的小型受控工程结果不能证明大型真实项目适配性或完整重构流程已经可接受。

## 本轮实际入口

```powershell
# 先试单例，再跑其余五例
bun testset/run.ts --only scout-local-function --scout-model sonnet --concurrency 1 --out runs/scout-real-20261019-a --no-color
bun testset/run.ts --subject scout --exclude scout-local-function --scout-model sonnet --concurrency 2 --out runs/scout-real-20261019-a --no-color

# 两个被拒绝场景分别重试一次；保留原目录
bun testset/run.ts --only scout-allocator-chain --scout-model sonnet --concurrency 1 --out runs/scout-real-20261019-retry --no-color
bun testset/run.ts --only scout-file-resource --scout-model sonnet --concurrency 1 --out runs/scout-real-20261019-retry --no-color

# 裁判分批调用；scout 不重跑。adapter 保存裁判会话并只向 stdout 输出评分 JSON
bun testset/run.ts --only scout-local-function --reevaluate runs/scout-real-20261019-a --rubric-cmd 'bun "E:/Proj/refactorSubagent/runs/scout-real-20261019-a/score-with-model.ts"' --no-color
bun testset/run.ts --subject scout --exclude scout-local-function --reevaluate runs/scout-real-20261019-a --rubric-cmd 'bun "E:/Proj/refactorSubagent/runs/scout-real-20261019-a/score-with-model.ts"' --no-color
bun testset/run.ts --only scout-allocator-chain --reevaluate runs/scout-real-20261019-retry --rubric-cmd 'bun "E:/Proj/refactorSubagent/runs/scout-real-20261019-a/score-with-model.ts"' --no-color

# 负控会调用裁判；汇总脚本和下列缓存复评不调用模型
bun runs/scout-real-20261019-a/calibrate-judge.ts
bun testset/run.ts --subject scout --reevaluate runs/scout-real-20261019-a --no-color
bun testset/run.ts --subject scout --tag intermediate --reevaluate runs/scout-real-20261019-retry --no-color
bun runs/scout-real-20261019-a/summarize-trial.ts
```

这些是已执行命令的记录。包含模型调用的命令会再次消耗服务额度；现有 scout 输出目录受覆盖保护，
负控脚本也要求新目录。原始 runner 两份汇总均有服务错误，所以缓存复评退出码仍为 1，错误未降级成通过。
