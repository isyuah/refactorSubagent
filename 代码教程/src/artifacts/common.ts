/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/artifacts/common.ts —— 数据字典里的"公共零件"
 *
 * 【这个文件是干什么的】
 *   只定义 3 个最基础的 Schema（校验规则），供 src/artifacts/ 里其他
 *   18 个文件复用：
 *     RelPath   —— "仓库内相对路径"字符串
 *     B64       —— base64 编码后的文本（大块内容的统一存放格式）
 *     Sha256Hex —— 64 个小写十六进制字符，即 SHA-256 指纹
 *
 *   先交代一下这个目录是什么：src/artifacts/ 是**全项目的数据字典**。
 *   这个项目里，"AI 说过的话"和"程序测到的事实"都必须变成一个 JSON
 *   工件（artifact）才能被使用，而每个 JSON 在落盘、进状态机之前都要
 *   先过一遍 Zod 校验。Zod 是一个第三方库，你可以把它想象成海关安检：
 *   数据想进程序，必须一件件过机器，形状不对当场拦下——本项目管这叫
 *   fail-closed（证明不了就拒绝）。
 *
 * 【在整个项目里的位置】
 *   上游：没有（这是字典的第一页，没有比它更基础的东西）。
 *   下游：behavior-contract / scope-manifest / test-spec / ctest-suite /
 *         build-workflow / refactor-task …… 本目录几乎每个文件都 import
 *         这里的 Schema 当字段类型。它们最终由 src/artifacts/index.ts 汇总成
 *         一个 Artifact 联合，交给 src/orchestrator/orchestrator.ts 的状态机。
 *
 * 【先修知识】
 *   不需要。如果读过《零基础看懂教程.md》§1.5 的 "Artifact" 词条更好。
 *
 * 【本文件是教程注释版】
 *   原文件：src/artifacts/common.ts（代码与本文件一致，仅多注释）
 *   阅读顺序建议：本文件 → behavior-contract → scope-manifest → …
 * ═══════════════════════════════════════════════════════════════════ */
// ← 第一行代码：从第三方包 zod 里导入一个叫 z 的工具集。
// 【语法】import { 名字 } from "包名"; 是 ES Module 的导入写法。
//   zod 这个包对外只暴露一个主要对象，社区习惯把它命名为 z（纯约定，
//   你叫它别的也行，但全世界的 zod 代码都写 z）。
//   记住一句话：z.xxx() 都是在"描述规则"，真正动手检查要等 .parse()。
import { z } from "zod";

// ── RelPath：仓库内相对路径 ─────────────────────────────────────────
// 【作用】规定 artifact 里出现的所有路径都必须是**相对路径**。
//   为什么这么严？本项目会把同一个仓库复制到两个目录（baseline 和
//   candidate 两个 git worktree，🔗 见 src/runtime/worktree.ts）分别构建，
//   绝对路径一换目录就全部失效；用相对路径，同一份 artifact 两边都能用。
// 【语法】z.string().min(1) 链式写法：z.string() 造出"必须是字符串"的
//   校验器，.min(1) 追加"长度至少 1（即不能是空串）"这条规则。链式调用
//   每一环都返回一个新的校验器，所以可以一路点下去。
// 【语法】.refine(函数, { message }) 是"自定义规则"：Zod 自带的规则
//   （是字符串吗？够长吗？）不够用时，你自己给一个返回 true/false 的函数。
//   返回 false 就校验失败，错误信息用 message 里那句。
// 【参数】这里的函数写成了箭头函数 (p) => ...：p 是被检查的那个字符串。
//   !p.startsWith("/")      —— 不能以 / 开头（排除 Unix 绝对路径）
//   !/^[A-Za-z]:/.test(p)   —— 不能以 C: 这种盘符开头（排除 Windows 绝对路径）
//   【语法】/^[A-Za-z]:/ 是正则表达式字面量：^ 开头、[A-Za-z] 一个字母、
//   然后一个冒号；.test(p) 返回"匹不匹配"。
// 【关系】被 scope-manifest、test-spec、observation-trace、ctest-suite、
//   build-workflow、refactor-task 等文件当成字段类型使用。它只做"形状
//   校验"，不会去磁盘上确认文件真的存在（真实存在性检查见
//   refactor-task.ts 的 assertCandidateTestsExist）。
/** Relative POSIX-style path inside the target repo. */
export const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p), {
    message: "paths must be repo-relative",
  });

// ── B64：base64 文本 ────────────────────────────────────────────────
// 【作用】承接"可能很大的任意内容"：程序运行 C 程序时抓到的 stdout/stderr、
//   测试要喂进去的 stdin、fixture 文件内容，都先 base64 编码再塞进 JSON。
// 【为什么】JSON 是纯文本格式，直接放二进制会把文件弄坏（还有换行、
//   引号、控制字符的坑）；base64 把任何字节串变成只含 A-Z a-z 0-9 + / 的
//   安全文本，读出来时用 Buffer.from(s, "base64") 解码即可。
// 【语法】这里没有加任何限制——只要是字符串就过。对比上面 RelPath 的
//   严格，可以看出规律：字段内容越自由，Schema 越宽松。
// 【关系】test-spec.ts 的 stdin/fixtures、observation-trace.ts 的
//   stdout_b64/stderr_b64、ctest-suite.ts 的 stdout_b64 都用它。
/** base64-encoded payload (stdin bytes, fixture contents, captured output). */
export const B64 = z.string();

// ── Sha256Hex：SHA-256 指纹 ─────────────────────────────────────────
// 【作用】识别"一段内容是不是原封不动"。SHA-256 把任意内容压成 256 位
//   指纹，改动一个字节，指纹就完全不同。
// 【语法】.regex(/…/) 是第三种追加规则的方式：必须匹配这个正则。
//   ^[0-9a-f]{64}$ = 从头到尾正好 64 个字符，且都是 0-9 或小写 a-f
//   （十六进制）。SHA-256 的输出恰好是 64 个这种字符，所以这条规则
//   等价于"必须长得像一个 sha256"。
// 【关系】最重要的消费方是 workflow 注册表（🔗 src/workflow/registry.ts、
//   test-registry.ts）：生成的 workflow 源码入库时算一个 hash 存进
//   manifest，下次复用时重算对比，防止有人偷偷改过源码。
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
