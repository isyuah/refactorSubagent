import { STAGES } from "../display.js";
import type { Item, Paragraph, Section } from "./workbench.js";

const COMMANDS = [
  { description: "全流程重构：准备或复用测试，修改候选代码并对比两侧行为。", args: 'run "../my-project" --task "提取重复的参数检查，保持行为不变"' },
  { description: "准备测试：编写测试并在原版试跑，审阅后可保存或继续重构。", args: 'tests prepare "../my-project" --scope "检查解析器空输入及非法输入的返回值"' },
  { description: "审阅测试：打开已保存的方案，查看场景、观测值和辅助源码，也可修改后重试。", args: 'tests review "../my-project" --from "../my-test-plan/r1"' },
  { description: "查看构建方案：列出指定项目保存的构建方案、版本和状态。省略 --cwd 时查当前目录。", args: 'workflow list --cwd "../my-project"' },
  { description: "检查环境与项目：探测工具并识别目标项目的构建方式。", args: 'preflight "../my-project"' },
] as const;

const PARAMETERS: readonly Paragraph[] = [
  { text: "仓库路径：run、tests prepare、tests review 后的位置参数。填写目标 Git 仓库目录，例如 ../my-project。相对路径以启动命令时所在的目录为准。" },
  { text: "--task <任务描述>（重构）：说明希望怎样改代码，例如「提取重复的参数检查，保持行为不变」。" },
  { text: "--scope <行为描述>（准备测试）：说明要保护的接口、输入、输出或边界情况，例如「检查解析器空输入及非法输入的返回值」。" },
  { text: "--from <方案目录>（审阅测试）：填写包含 plan.json 的具体版本目录，例如 ../my-test-plan/r1。" },
  { text: "--auto-retry <次数>：整个运行最多自动修复几次（含恢复前已用）。默认 3，填 0 关闭。" },
  { text: "--resume <会话编号>：从上次 ABORTED 的结果报告 artifacts/run-summary.json 读取 session。使用同一仓库和任务；若原运行使用了自定义 --session-root，恢复时也要传入同一个目录。程序会创建新会话、复用仍有效的检查点并重新验证。" },
];

const FLOW: readonly Paragraph[] = [
  { text: "执行顺序", tone: "heading" },
  { text: `${STAGES.preflight}：探测可用工具，并识别项目的构建方式。` },
  { text: `${STAGES.workflows}：由 AI 编写，或使用指定脚本和已保存的方案。` },
  { text: `${STAGES.prepare}：准备原版与候选版各自使用的工作目录。` },
  { text: `${STAGES.refactor}：由 AI 修改候选代码，也可应用现成补丁或使用已有候选改动。` },
  { text: `${STAGES.verify}：用同一方案验证两侧行为。通过显示 ACCEPTED，比较未通过显示 REJECTED，无法完成验证显示 ABORTED。` },
  { text: `${STAGES.cleanup}：保存结论与证据，清理临时工作目录。候选改动不会自动合并。` },
  { text: "失败后会修什么", tone: "heading" },
  { text: "行为不一致，或原版构建通过而候选版编译失败：回到原重构会话修候选代码。确认由候选程序导致的测试执行失败也走这条路。" },
  { text: "测试脚本自身出错：交给测试编写会话修脚本，有原会话时优先继续原会话。" },
  { text: "原版构建脚本出错：新开一个构建修复会话。缺少工具等环境问题，或无法判断原因时，停止并保留证据。" },
  { text: "修复后重新验证；通过、次数用完或没有修复进展时结束。" },
];

export function guideSection(): Section {
  const items: readonly Item[] = [
    {
      id: "guide-tasks",
      label: "任务指引",
      description: "功能与命令示例",
      detail: () => ({
        title: "任务指引 · 功能一览",
        paragraphs: [
          { text: "以下命令从工具仓库运行。请将示例路径换成目标仓库或测试方案。" },
          ...COMMANDS.flatMap(({ description, args }): Paragraph[] => [
            { text: description }, { text: `bun scripts/cli.ts ${args}`, tone: "accent" },
          ]),
        ],
      }),
    },
    { id: "guide-params", label: "参数指引", description: "填写内容与示例值", detail: () => ({ title: "参数指引", paragraphs: PARAMETERS }) },
    { id: "guide-flow", label: "流程说明", description: "执行顺序与失败修复", detail: () => ({ title: "流程说明", paragraphs: FLOW }) },
  ];
  return { id: "guide", title: "使用指引", items: () => items };
}
