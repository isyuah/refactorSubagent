import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const Text = z.string().trim().min(1).max(4000);
const Dependency = {
  name: Text,
  kind: z.enum(["compile", "internal", "resource", "external"]),
  rationale: Text,
};

/** The MCP input shape; semantic checks also run in the host store below. */
export const VerificationAnalysisInput = z.object({
  subject: Text,
  recommendation: z.object({
    strategy: z.enum(["reuse-existing", "library-consumer", "source-harness", "undetermined"]),
    rationale: Text,
    alternatives: z.array(Text).max(8),
  }).strict(),
  behaviors: z.array(Text).min(1).max(32),
  dependencies: z.array(z.discriminatedUnion("treatment", [
    z.object({ ...Dependency, treatment: z.literal("real") }).strict(),
    z.object({ ...Dependency, treatment: z.literal("temporary-resource") }).strict(),
    z.object({ ...Dependency, treatment: z.literal("unresolved") }).strict(),
    z.object({
      ...Dependency,
      treatment: z.literal("test-double"),
      seam: Text,
      simulate: z.array(Text).min(1).max(16),
      retainReal: Text,
      lostCoverage: z.array(Text).min(1).max(16),
    }).strict(),
  ])).max(32),
  evidence: z.array(z.object({
    basis: z.enum(["source", "preflight", "inference"]),
    reference: Text,
    finding: Text,
  }).strict()).min(1).max(48),
  limitations: z.array(Text).max(16),
  openQuestions: z.array(Text).max(16),
}).strict();

const VerificationAnalysisSchema = VerificationAnalysisInput.superRefine((report, ctx) => {
  if (report.recommendation.strategy !== "undetermined" &&
      !report.evidence.some(({ basis }) => basis === "source")) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "A recommendation needs source evidence" });
  }
  if ((report.recommendation.strategy === "undetermined" ||
       report.dependencies.some(({ treatment }) => treatment === "unresolved")) &&
      report.openQuestions.length === 0) {
    ctx.addIssue({ code: "custom", path: ["openQuestions"], message: "Explain what remains unresolved" });
  }
});

export type VerificationAnalysis = z.infer<typeof VerificationAnalysisInput>;

/**
 * One run's advisory report. It is neither an executable workflow nor shared
 * verification material. Only successful submissions in this session count;
 * a file left by an earlier attempt is not evidence of a new investigation.
 */
export class VerificationAnalysisStore {
  private submitted = false;
  private closed = false;

  constructor(readonly path: string, private readonly task: string) {}

  submit(input: unknown): { path: string; report: VerificationAnalysis } {
    if (this.closed) throw new Error("Verification analysis submission is closed for this session");
    const report = VerificationAnalysisSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(report, null, 2), "utf8") > 64 * 1024) {
      throw new Error("Verification analysis exceeds 64 KiB; return conclusions instead of exploration logs");
    }
    const content = JSON.stringify({ version: 1, task: this.task, report }, null, 2) + "\n";

    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    this.submitted = true;
    return { path: this.path, report };
  }

  hasSubmission(): boolean {
    return this.submitted;
  }

  /** Close after the writer exits, including timeout/error paths. */
  close(): void {
    this.closed = true;
  }
}
