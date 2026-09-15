/** Small shared helpers for the suite runner: paths, JSON, time, terminal. */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export function joinPath(...parts: string[]): string {
  return join(...parts);
}

export function abs(base: string, path: string): string {
  return resolve(base, path);
}

/** "1m 04s" / "12.3s" / "820ms" */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.floor(s - m * 60);
  return `${m}m ${String(rest).padStart(2, "0")}s`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
};

export type Color = keyof typeof ANSI;

export class Term {
  constructor(private readonly enabled: boolean) {}

  paint(text: string, ...colors: Color[]): string {
    if (!this.enabled) return text;
    return colors.map((c) => ANSI[c]).join("") + text + ANSI.reset;
  }

  /** Pad/truncate to a fixed display width (ASCII-safe: caller pads plain text). */
  static fit(text: string, width: number): string {
    if (text.length === width) return text;
    if (text.length < width) return text + " ".repeat(width - text.length);
    return text.slice(0, Math.max(0, width - 1)) + "…";
  }
}

export function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

export function tailFile(path: string, lines: number, limit = 4000): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  const parts = text.split(/\r?\n/);
  const slice = parts.slice(Math.max(0, parts.length - lines)).join("\n");
  return slice.length > limit ? slice.slice(slice.length - limit) : slice;
}
