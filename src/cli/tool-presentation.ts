export interface ToolPresentation {
  readonly label: string;
  readonly completionOnly: boolean;
}

const TOOLS: Readonly<Record<string, ToolPresentation>> = {
  Read: { label: "读取文件", completionOnly: true },
  Write: { label: "写入文件", completionOnly: true },
  Edit: { label: "修改文件", completionOnly: true },
  Glob: { label: "查找文件", completionOnly: true },
  Grep: { label: "搜索内容", completionOnly: true },
  Task: { label: "子任务", completionOnly: false },
  Agent: { label: "子任务", completionOnly: false },
  Bash: { label: "执行命令", completionOnly: false },
  "mcp__dep-registry__inspectWorkflow": { label: "查询构建方案", completionOnly: true },
  "mcp__dep-registry__declareDependency": { label: "登记构建依赖", completionOnly: true },
  "mcp__dep-registry__generateBuildWorkflow": { label: "保存构建方案", completionOnly: true },
  "mcp__dep-registry__submitVerificationAnalysis": { label: "提交验证方案", completionOnly: true },
};

export function toolPresentation(name: string): ToolPresentation {
  const known = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (known) return known;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return { label: mcp ? `${mcp[1]}/${mcp[2]}` : name, completionOnly: false };
}
