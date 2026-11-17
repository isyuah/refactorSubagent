export const workflowKind = "test-workflow-driven";
export default async ctx => {
  const executable = "build/verification/text_copy_harness" + ctx.facts.host.executable_suffix;
  await ctx.validator.assertFile(executable, "当前实现的边界检查程序");
  const result = await ctx.process.run({ program: executable, args: [] });
  if (result.status !== "exited" || result.exitCode !== 0) throw new Error("辅助程序执行失败：" + result.stderr);
  const names = { normal: "正常复制", "exact-fit": "恰好容纳", truncated: "截断复制", "capacity-one": "容量为一", empty: "空字符串", "capacity-zero": "零容量查询", "empty-zero": "空串零容量", "null-source": "空源指针", "null-destination": "空目标指针", "long-truncated": "长字符串截断" };
  const rows = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (rows.length !== Object.keys(names).length || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("辅助程序未交付完整的十项观测");
  for (const row of rows) {
    if (!Object.hasOwn(names, row.id)) throw new Error("未知观测：" + row.id);
    const { id, ...observation } = row;
    ctx.expect(names[id], observation);
  }
};
