/* ═══════════════════════════════════════════════════════════════════
 * 【文件总览】src/runtime/fs-snapshot.ts —— 目录快照 + 副作用 diff（全文件只有 48 行）
 *
 * 【这个文件是干什么的】
 *   回答一个很具体的问题："程序跑了一下那个 C 程序，它到底动了硬盘上的哪些文件？"
 *   做法分两步：
 *     ① snapshotDir(root)：把某个目录"拍个照"——递归读出里面所有文件，
 *        每个文件算一个 SHA-256 内容哈希。结果是"相对路径 → 哈希值"这样一张表。
 *     ② diffSnapshots(before, after)：拿运行前、运行后两张表对一对，
 *        得出三种副作用：create（新建）/ modify（内容变了）/ delete（没了）。
 *   注意它比的是"内容哈希"，不是"修改时间"——只要文件内容一个字节没变，就不算 modify。
 *
 * 【在整个项目里的位置】
 *   这个小工具是全仓库少数**新旧两条路径都在用**的模块：
 *   · 旧差分路径：src/runtime/runner.ts 的 captureTrace() 在每个用例运行前后各拍一张，
 *     把 diff 塞进 ObservationTrace 的 filesystem 字段（见 src/artifacts/observation-trace.ts 的 FsEffect）。
 *   · 新 workflow 路径：src/workflow/capabilities.ts 里能力代理的 fs.snapshot()/fs.diff()
 *     也 import 了这里的 diffSnapshots，给自驱动 workflow 提供"目录前后对比"能力。
 *   对比出来的结果最终会被 comparator.ts / expectation-compare.ts 拿去判 match 还是 mismatch。
 *
 * 【先修知识】
 *   · TypeScript 的 Map<string, string>（键值对容器）、泛型写法 Map<K, V>；
 *   · 递归函数（walk 自己调自己）；
 *   · 箭头函数与三元表达式 a ? b : c；
 *   · node:crypto 的 createHash（哈希 ≠ 加密，它只是给内容算一个"指纹"）。
 * 【本文件是教程注释版】
 *   原文件：src/runtime/fs-snapshot.ts（代码与本文件一致，仅多注释）
 * ═══════════════════════════════════════════════════════════════════ */
// ← node:crypto 是 Node 的哈希/加密模块；createHash("sha256") 造一个 SHA-256 哈希器
import { createHash } from "node:crypto";
// ← readdirSync 列目录、statSync 看文件属性、readFileSync 读内容，都是同步版本（不用 await）
import { readdirSync, statSync, readFileSync } from "node:fs";
// ← join 拼路径、relative 算"相对路径"、sep 是本系统的路径分隔符（Windows 是 \，Linux 是 /）
import { join, relative, sep } from "node:path";

/** Recursive snapshot of a directory: rel-path → sha256 (empty for dirs). */
// ← 类型别名：Snapshot 就是"相对路径 → SHA-256 十六进制串"的 Map。
//   泛型 Map<string, string> 里尖括号是类型参数，读作"键是 string、值也是 string 的表"。
export type Snapshot = Map<string, string>;

// ── snapshotDir：给一个目录拍"内容快照" ──────────────────────────────
// 【作用】递归走完 root 下所有子目录，返回一张"相对路径 → 文件内容哈希"的表。
// 【参数】root：要拍照的目录绝对路径（runner.ts 里是一个一次性临时目录，capabilities.ts 里是可读目录）。
// 【返回】Snapshot：Map。空目录会返回空 Map。
// 【语法】函数返回值类型写在参数列表后面（: Snapshot），这是 TS 的写法，JS 没有。
// 【关系】被旧路径 runner.ts（每个用例运行前后各调一次）和新路径 capabilities.ts（fs 能力）使用。
export function snapshotDir(root: string): Snapshot {
  // ← new Map() 造一张空表；这里冒号后的 Snapshot 只是给变量标注类型，运行时不存在
  const map: Snapshot = new Map();
  // ← 真正的遍历在下面那个私有函数 walk 里，这里只是起个头
  walk(root, root, map);
  return map;
}

// ── walk：递归遍历目录，把每个文件的哈希写进 out ─────────────────────
// 【作用】标准库 readdirSync 只列出一层，所以这里自己递归下钻子目录。
// 【参数】root 用来算相对路径（保持不变）；dir 是当前正在看的目录；out 是累积结果的表。
// 【返回】void —— 没有返回值，结果是靠"往 out 里塞东西"带出去的（引用传递）。
// 【语法】for...of 逐个取出数组元素；if/else 里没有大括号的单语句写法也是合法的。
function walk(root: string, dir: string, out: Snapshot): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // ← statSync 拿到"这是文件还是目录、多大"这类元信息
    const st = statSync(full);
    if (st.isDirectory()) {
      // ← 是目录：往下钻一层（root 不变，dir 换成子目录）
      walk(root, full, out);
    } else {
      // ← 是文件：先把绝对路径转成相对路径。
      //   relative() 在 Windows 上返回带反斜杠的路径，所以这里统一 split(sep).join("/")
      //   换成正斜杠，保证 Windows 和 Linux 上算出来的 key 长得一模一样（可比较、可复现）。
      const rel = relative(root, full).split(sep).join("/");
      // ← 读出文件全部字节 → 喂给哈希器 → digest("hex") 输出 64 位十六进制字符串（就是"内容指纹"）
      out.set(rel, createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  }
}

// ← 联合类型（union type）：FsEffectOp 只能是这三个字符串之一。
//   用类型把"取值范围"钉死，写错一个字编译期就报错。
export type FsEffectOp = "create" | "modify" | "delete";

// ← interface 描述一个"对象的形状"：一条副作用 = 哪个文件 + 干了什么 + 现在的内容是什么。
//   sha256 允许是 null（删除的文件已经没有"现在的内容"了）。
export interface FsDiff {
  path: string;
  op: FsEffectOp;
  sha256: string | null;
}

/** before → after diff, sorted by path for deterministic output. */
// ── diffSnapshots：两张快照对比出 create/modify/delete 三种副作用 ────
// 【作用】本文件对外提供的第二个核心函数：把"运行前"和"运行后"两张表比出差异。
// 【参数】before / after：两张快照（一般 before = snapshotDir(同一目录) 在运行前的样子）。
// 【返回】FsDiff[]：副作用数组，按路径排序——排序是为了"确定性"（deterministic），
//        同样的输入永远产出同样顺序的结果，这样两次运行的 diff 才能逐项对比。
// 【关系】runner.ts 用它填 ObservationTrace.observations[].filesystem；
//        capabilities.ts 用它实现 workflow 的 fs.diff 能力；comparator.ts 再拿这些结果判 match。
export function diffSnapshots(before: Snapshot, after: Snapshot): FsDiff[] {
  const effects: FsDiff[] = [];
  // ← 第一遍：以后一张表为基准，找出"新建"和"修改"。
  //   for (const [path, sha] of after) 是"解构 + 迭代"写法：Map 迭代出来是 [键, 值] 对，
  //   方括号一次性把两个值拆进两个变量里。
  for (const [path, sha] of after) {
    const prev = before.get(path);
    // ← 前一张表里根本没有这个路径 → 新建
    if (prev === undefined) effects.push({ path, op: "create", sha256: sha });
    // ← 路径有，但内容哈希不一样 → 修改（所以只改了文件名或时间戳不会算进来）
    else if (prev !== sha) effects.push({ path, op: "modify", sha256: sha });
  }
  // ← 第二遍：以前一张表为基准，找出"删除"（后一张表里已经没有了）
  for (const [path, sha] of before) {
    if (!after.has(path)) effects.push({ path, op: "delete", sha256: sha });
  }
  // ← 排序：字符串比较（小于/大于），返回 -1/1/0 表示"谁排前面"。
  //   嵌套三元读法：a.path < b.path ? -1 : (a.path > b.path ? 1 : 0)
  effects.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return effects;
}
