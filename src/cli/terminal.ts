import { stripVTControlCharacters } from "node:util";

export type Tone = "heading" | "agent" | "accent" | "success" | "warning" | "error" | "baseline" | "candidate" | "muted";
export type TextPart = string | { readonly text: string; readonly tone: Tone };
export type TextLine = readonly TextPart[];
export interface ColorOptions {
  readonly color?: boolean;
  readonly output?: { readonly isTTY?: boolean };
  readonly env?: Record<string, string | undefined>;
}

const CODES: Readonly<Record<Tone, string>> = {
  heading: "1;34", agent: "35", accent: "36", success: "32", warning: "33", error: "31",
  baseline: "34", candidate: "35", muted: "2",
};

export function cleanText(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function styled(text: string, tone: Tone): TextPart { return { text, tone }; }

/** Clean each untrusted fragment before applying our own, fixed ANSI styles. */
export class TerminalStyle {
  private readonly enabled: boolean;
  constructor(options: ColorOptions = {}) {
    const env = options.env ?? process.env;
    this.enabled = options.color === true && Boolean(options.output?.isTTY) && env.NO_COLOR === undefined && env.TERM !== "dumb";
  }

  render(parts: TextLine): string {
    return parts.map((part) => {
      const text = cleanText(typeof part === "string" ? part : part.text);
      return this.enabled && typeof part !== "string" && text ? `\u001b[${CODES[part.tone]}m${text}\u001b[0m` : text;
    }).join("");
  }
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "pass": case "completed": case "complete": case "ACCEPTED": case "consistent": return "success";
    case "failed": case "fail": case "error": case "REJECTED": case "inconsistent": return "error";
    case "ABORTED": case "not-run": case "cancelled": case "canceled": case "timeout": case "timed-out":
    case "aborted": case "interrupted": case "stopped": case "undetermined": return "warning";
    default: return "accent";
  }
}
