export const workflowKind = "workflow-driven";
export default async ctx => {
  await ctx.plan.declare([{ id: "compile", title: "编译真实复制函数与边界检查程序" }]);
  await ctx.plan.begin("compile");
  let compiler;
  for (const name of ["gcc", "clang", "cc"]) {
    if (await ctx.tools.available(name)) { compiler = name; break; }
  }
  if (!compiler) throw new Error("体验示例需要 PATH 中的 gcc、clang 或 cc");
  const executable = "build/verification/text_copy_harness" + ctx.facts.host.executable_suffix;
  const result = await ctx.process.run({ program: compiler, args: ["-std=c99", "-Wall", "-Wextra", "-pedantic", "-Iinclude", "src/text_copy.c", "build/verification/harness.c", "-o", executable] });
  if (result.status !== "exited" || result.exitCode !== 0) throw new Error("辅助程序编译失败：" + result.stderr);
  await ctx.validator.assertFile(executable, "当前实现的边界检查程序");
  await ctx.plan.complete("compile");
};
