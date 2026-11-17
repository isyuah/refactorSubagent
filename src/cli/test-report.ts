import type { PreparationView } from "../testing/types.js";
import { styled, statusTone, type TextLine } from "./terminal.js";

const pretty = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "未提供";
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const field = (name: string, value: string): TextLine => [styled(`${name}：`, "accent"), value];
export function preparationPages(view: PreparationView): { title: string; lines: TextLine[] }[] {
  const { metadata, builds } = view.content;
  const trial = metadata.trial;
  const analysis = metadata.analysis;
  const status = trial.status === "pass" ? "原版试跑通过" : trial.status === "failed" ? "原版试跑失败" : "等待试跑";
  const overview: TextLine[] = [[styled(status, trial.status === "pass" ? "success" : trial.status === "failed" ? "error" : "warning")],
    field("验证范围", metadata.scope), field("原版提交", metadata.base_sha), field("工作版本", String(view.revision)),
    field("保存位置", view.saved ?? "尚未保存"), field("交付状态", metadata.delivery === "complete" ? "完整" : "草稿"),
    field("试跑主机", `${metadata.host.platform} / ${metadata.host.arch}`),
    field("测试模型（当前配置）", view.limits.sessions.testWriter.model ?? "SDK 默认值"),
    field("会话限制（当前配置）", `轮数 ${view.limits.sessions.testWriter.maxTurns ?? "不限制"} / 总时间 ${view.limits.sessions.testWriter.deadlineMs === null ? "不限制" : seconds(view.limits.sessions.testWriter.deadlineMs)}`), [""], [styled("AI 的验证方案", "heading")]];
  if (analysis) {
    overview.push(field("验证方式", analysis.recommendation.strategy), field("选择理由", analysis.recommendation.rationale));
    for (const b of analysis.behaviors) overview.push(field("覆盖行为", b));
    for (const d of analysis.dependencies) overview.push(field(`${d.name} / ${d.treatment}`, d.rationale),
      ...(d.treatment === "test-double" ? [field("替代位置", d.seam), field("模拟行为", d.simulate.join("；")), field("保留真实实现", d.retainReal), field("失去的覆盖", d.lostCoverage.join("；"))] : []));
    for (const gap of [...analysis.limitations, ...analysis.openQuestions]) overview.push([styled("覆盖缺口：", "warning"), gap]);
  } else overview.push(["尚未交付验证方案。"]);
  overview.push([""], [styled("构建产物与使用方式", "heading")], ...builds.map(b => field(b.id, b.description || "描述未提供")));
  const scenarios: TextLine[] = [[styled("AI 交付的测试场景", "heading")]];
  for (const s of metadata.review?.scenarios ?? []) scenarios.push([""], field(`${s.id} / ${s.title}`, s.purpose),
    field("输入和条件", s.inputs.join("；")), field("观察点", s.observations.join("、")), field("源码依据", s.sourceReferences.join("、")));
  if (!metadata.review) scenarios.push(["场景说明尚未交付；可输入修改意见要求补全。"]);
  const names = new Set(metadata.review?.scenarios.flatMap(s => s.observations) ?? []);
  const actualNames = [...trial.observations.map(o => o.name), ...(trial.ctest?.top_level_tests ?? [])];
  const unmatched = actualNames.filter(name => !names.has(name));
  if (unmatched.length) scenarios.push([""], field("未关联到场景的实际检查项", unmatched.join("、")));
  const results: TextLine[] = [[styled("宿主实际执行结果", "heading")], field("状态", status), field("耗时", seconds(trial.duration_ms)),
    field("检查项数量", String(trial.observations.length)), field("场景数量", String(metadata.review?.scenarios.length ?? 0)),
    field("完整证据", trial.evidence_dir ?? "尚未执行")];
  if (view.trialOrigin === "saved") results.push([styled("当前为保存时的试跑记录；重新试跑将使用当前项目提交。", "warning")]);
  if (trial.failure) results.push([styled("失败原因：", "error"), trial.failure.reason]);
  for (const b of trial.builds) results.push([styled(`构建 ${b.id}：`, "accent"), styled(b.status === "not-run" ? "未执行" : b.status === "pass" ? "通过" : "失败", statusTone(b.status)),
    ` / ${seconds(b.duration_ms)}${b.failure ? ` / ${b.failure}` : ""}`]);
  for (const o of trial.observations) results.push([""], field(o.name, `${o.relation} / ${pretty(o.value).slice(0, 1024)}`));
  if (trial.ctest) {
    results.push(field("CTest", `${trial.ctest.status} / ${trial.ctest.summary.total} 项测试`), field("实际执行的 CTest 名称", trial.ctest.top_level_tests.join("、")));
    for (const failed of trial.ctest.failed_tests) results.push(field(`失败 ${failed.name}`, failed.output.slice(0, 1024)));
  }
  if (view.history.length) results.push([""], [styled("历史试跑", "heading")], ...view.history.map(t => field(t.status, `${seconds(t.duration_ms)} / ${t.evidence_dir ?? "无证据"}`)));
  const files: TextLine[] = [[styled("本轮交付文件", "heading")]];
  for (const f of view.files) {
    files.push([""], [styled(f.path, "accent")]);
    if (f.content === null) { files.push([styled("已删除", "warning")], [f.previous!]); continue; }
    if (f.previous !== null && f.previous !== f.content) files.push([styled("修改前", "warning")], [f.previous], [styled("修改后", "success")]);
    else files.push([styled(f.previous === null ? "新文件" : "内容相同", "muted")]);
    files.push([f.content]);
  }
  return [{ title: "方案概览", lines: overview }, { title: "测试场景", lines: scenarios }, { title: "试跑结果", lines: results }, { title: "文件与修改", lines: files }];
}

