/** Live table while the suite runs, plus the final report. */
import { Term, fmtDuration } from "./util.js";
import type { CaseEvaluation } from "./evaluate.js";

export type RowStatus = "queued" | "running" | "settled";

export interface Row {
  readonly id: string;
  readonly subject: string;
  status: RowStatus;
  phase: string;
  detail: string;
  startedAt: number;
  elapsedMs: number;
  evaluation: CaseEvaluation | null;
  error: string | null;
}

const COLUMNS = [
  { title: "CASE", width: 30 },
  { title: "SUBJECT", width: 9 },
  { title: "STATUS", width: 8 },
  { title: "ELAPSED", width: 9 },
];

function rowStatusText(row: Row, term: Term): string {
  if (row.status === "queued") return term.paint("queued", "gray");
  if (row.status === "running") return term.paint("running", "cyan");
  if (row.error !== null) return term.paint("error", "red");
  if (row.evaluation?.status === "passed") return term.paint("pass", "green");
  if (row.evaluation?.status === "pending-rubric") return term.paint("pass*", "yellow");
  return term.paint("fail", "red");
}

function rowDetail(row: Row): string {
  if (row.error !== null) return row.error.replace(/\s+/g, " ").slice(0, 160);
  if (row.status === "running") return `${row.phase} ${row.detail}`.trim().slice(0, 120);
  if (row.evaluation === null) return "";
  const firstBad = row.evaluation.checks.find((c) => !c.ok);
  if (firstBad !== undefined) return `${firstBad.name}: ${firstBad.detail}`.slice(0, 160);
  const rubric = row.evaluation.rubric;
  if (rubric !== null && rubric.status === "pending") return "rubric: pending (prompt written)";
  const observed = row.evaluation.observed;
  const state = typeof observed["state"] === "string" ? observed["state"] : "";
  const count = typeof observed["mismatchCount"] === "number" ? observed["mismatchCount"] : null;
  if (state !== "") {
    const builds = `${String(observed["baselineBuild"])}/${String(observed["candidateBuild"])}`;
    return `${state} mismatches=${count === null ? "?" : String(count)} builds=${builds}`;
  }
  const cases = observed["counts"];
  if (cases !== undefined && cases !== null) {
    return Object.entries(cases as Record<string, number>).map(([k, v]) => `${k}=${String(v)}`).join(" ");
  }
  return "";
}

export class LiveDisplay {
  private drawnLines = 0;
  private readonly streaming: boolean;

  constructor(private readonly term: Term, private readonly tty: boolean) {
    this.streaming = !tty;
  }

  private render(rows: readonly Row[]): string[] {
    const header = COLUMNS.map((c) => Term.fit(c.title, c.width)).join("  ") + "  DETAIL";
    const lines = [this.term.paint(header, "dim")];
    for (const row of rows) {
      const cells = [
        Term.fit(row.id, COLUMNS[0]!.width),
        Term.fit(row.subject, COLUMNS[1]!.width),
        Term.fit(rowStatusText(row, this.term), COLUMNS[2]!.width + 12),
        Term.fit(fmtDuration(row.elapsedMs), COLUMNS[3]!.width),
      ];
      lines.push(cells.join("  ") + "  " + rowDetail(row));
    }
    return lines;
  }

  update(rows: readonly Row[]): void {
    if (this.streaming) return;
    const lines = this.render(rows);
    if (this.drawnLines > 0) process.stdout.write(`\u001b[${String(this.drawnLines)}A`);
    process.stdout.write("\u001b[0J" + lines.join("\n") + "\n");
    this.drawnLines = lines.length;
  }

  log(message: string): void {
    if (this.streaming) {
      process.stdout.write(message + "\n");
      return;
    }
    if (this.drawnLines > 0) process.stdout.write(`\u001b[${String(this.drawnLines)}A\u001b[0J`);
    this.drawnLines = 0;
    process.stdout.write(message + "\n");
  }

  finish(rows: readonly Row[], outDir: string): void {
    if (this.drawnLines > 0) {
      process.stdout.write(`\u001b[${String(this.drawnLines)}A\u001b[0J`);
      this.drawnLines = 0;
    }
    const lines: string[] = [];
    lines.push("");
    const bySubject = new Map<string, { pass: number; fail: number; pending: number }>();
    for (const row of rows) {
      const bucket = bySubject.get(row.subject) ?? { pass: 0, fail: 0, pending: 0 };
      if (row.error !== null || row.evaluation?.status === "failed") bucket.fail++;
      else if (row.evaluation?.status === "pending-rubric") bucket.pending++;
      else if (row.evaluation?.status === "passed") bucket.pass++;
      else bucket.fail++;
      bySubject.set(row.subject, bucket);
    }
    lines.push(this.term.paint("summary", "bold"));
    for (const [subject, bucket] of bySubject) {
      const verdict = bucket.fail === 0 ? this.term.paint("ok", "green") : this.term.paint("fail", "red");
      lines.push(`  ${Term.fit(subject, 10)} pass=${String(bucket.pass)} fail=${String(bucket.fail)} pending-rubric=${String(bucket.pending)}  ${verdict}`);
    }
    lines.push("");
    for (const row of rows) {
      const status = rowStatusText(row, this.term);
      const pad = " ".repeat(Math.max(0, 30 - row.id.length));
      lines.push(`  ${row.id}${pad} ${status}  ${fmtDuration(row.elapsedMs)}  ${rowDetail(row)}`);
      for (const c of row.evaluation?.checks ?? []) {
        if (c.ok) continue;
        lines.push(`    ${this.term.paint("×", "red")} ${c.name}: ${c.detail}`);
      }
      if (row.evaluation?.rubric?.status === "scored") {
        const rubric = row.evaluation.rubric;
        lines.push(`    ${this.term.paint("rubric", "magenta")}: ${rubric.detail}`);
      }
    }
    lines.push("");
    lines.push(this.term.paint(`results: ${outDir}`, "dim"));
    process.stdout.write(lines.join("\n") + "\n");
  }
}
