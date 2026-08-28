import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface E2EDashboardOptions {
  readonly root: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly staticFile?: string;
  readonly pollIntervalMs?: number;
}

export interface RunSummary {
  readonly run_id: string;
  readonly status: string;
  readonly phase: string;
  readonly updated_at: string;
  readonly elapsed_ms: number;
  readonly last_event: string;
}

export type JsonObject = Record<string, unknown>;

export interface DashboardEvent extends JsonObject {
  readonly seq: number;
}

export interface ArtifactSummary {
  readonly name: string;
  readonly size: number;
  readonly modified_at: string;
  readonly mtime_ms: number;
}

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_POLL_INTERVAL_MS = 800;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const encoder = new TextEncoder();

class DashboardHttpError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.name = "DashboardHttpError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function rejectInvalidName(name: string, kind: "run" | "artifact" | "log"): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\") ||
    isAbsolute(name) ||
    !SAFE_NAME.test(name)
  ) {
    throw new DashboardHttpError(400, `非法${kind}名称`);
  }
}

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new DashboardHttpError(400, "非法 URL 路径");
  }
}

function readJsonObject(path: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("JSON root is not an object");
  return parsed;
}

function readTextIfPresent(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function parseEvents(text: string, startSeq = 0): DashboardEvent[] {
  const lines = text.split("\n");
  const events: DashboardEvent[] = [];
  let seq = startSeq;
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      seq += 1;
      events.push({ ...parsed, seq });
    } catch {
      // A writer can leave a partial line while the dashboard is polling.
      // The incremental cursor retains that line and retries it next tick.
    }
  }
  return events;
}

function readSuffix(path: string, offset: number): { readonly text: string; readonly bytes: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.min(Math.max(offset, 0), size);
    const length = size - start;
    if (length <= 0) return { text: "", bytes: 0 };
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, start);
    return { text: buffer.subarray(0, bytes).toString("utf8"), bytes };
  } finally {
    closeSync(fd);
  }
}

function fieldString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function fieldNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function summaryFromState(runId: string, state: JsonObject): RunSummary {
  return {
    run_id: runId,
    status: fieldString(state.status, "unknown"),
    phase: fieldString(state.phase, ""),
    updated_at: fieldString(state.updated_at, ""),
    elapsed_ms: Math.max(0, fieldNumber(state.elapsed_ms)),
    last_event: fieldString(state.last_event, ""),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function textResponse(text: string, contentType: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function parseAfter(url: URL): number {
  const raw = url.searchParams.get("after");
  if (raw === null || raw === "") return 0;
  if (!/^\d+$/.test(raw)) throw new DashboardHttpError(400, "after 必须是非负整数");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new DashboardHttpError(400, "after 超出可用范围");
  return value;
}

function artifactContentType(name: string): string {
  return extname(name).toLowerCase() === ".json"
    ? "application/json; charset=utf-8"
    : "text/plain; charset=utf-8";
}

class EventCursor {
  private offset = 0;
  private pending = "";
  private seq = 0;

  constructor(private readonly eventPath: string) {}

  initial(after: number): DashboardEvent[] {
    if (!existsSync(this.eventPath)) return [];
    const text = readFileSync(this.eventPath, "utf8");
    const lastNewline = text.lastIndexOf("\n");
    let completeText = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
    const tail = lastNewline < 0 ? text : text.slice(lastNewline + 1);
    if (tail.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(tail);
        if (isRecord(parsed)) completeText = text;
      } catch {
        // Treat a final partial line as pending data for the next poll.
      }
    }
    const events = parseEvents(completeText);
    this.offset = Buffer.byteLength(completeText, "utf8");
    this.pending = "";
    this.seq = events.length;
    return events.filter((event) => event.seq > after);
  }

  readDelta(): DashboardEvent[] {
    if (!existsSync(this.eventPath)) return [];
    const size = statSync(this.eventPath).size;
    if (size < this.offset) {
      this.offset = 0;
      this.pending = "";
      this.seq = 0;
    }
    const suffix = readSuffix(this.eventPath, this.offset);
    this.offset += suffix.bytes;
    if (suffix.text.length === 0) return [];

    this.pending += suffix.text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    const parsed = parseEvents(lines.join("\n"), this.seq);
    this.seq += parsed.length;
    return parsed;
  }
}

class DashboardService {
  readonly root: string;
  readonly html: string;
  readonly pollIntervalMs: number;

  constructor(options: E2EDashboardOptions) {
    const root = resolve(options.root);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`E2E root is not a directory: ${root}`);
    }
    this.root = realpathSync(root);
    this.html = readFileSync(
      options.staticFile ?? join(import.meta.dir, "..", "..", "web", "e2e-dashboard.html"),
      "utf8",
    );
    this.pollIntervalMs = Math.max(200, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  }

  handle(request: Request): Response {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    try {
      const url = new URL(request.url);
      const path = decodePathname(url.pathname);
      if (path === "/") return textResponse(this.html, "text/html; charset=utf-8");
      if (!path.startsWith("/")) throw new DashboardHttpError(400, "非法 URL 路径");

      const segments = path.slice(1).split("/");
      if (segments.some((segment) => segment.length === 0)) {
        throw new DashboardHttpError(400, "非法 URL 路径");
      }
      if (segments.length === 2 && segments[0] === "api" && segments[1] === "runs") {
        return jsonResponse(this.listRuns());
      }
      if (segments[0] !== "api" || segments[1] !== "runs") {
        throw new DashboardHttpError(404, "资源不存在");
      }

      const runId = segments[2];
      if (runId === undefined) throw new DashboardHttpError(404, "资源不存在");
      rejectInvalidName(runId, "run");

      if (segments.length === 3) return jsonResponse(this.readRun(runId));
      const resource = segments[3];
      if (resource === "events" && segments.length === 4) {
        return jsonResponse(this.readEvents(runId, parseAfter(url)));
      }
      if (resource === "stream" && segments.length === 4) {
        return this.stream(request, runId, parseAfter(url));
      }
      if (resource === "artifacts" && segments.length === 4) {
        return jsonResponse(this.listArtifacts(runId));
      }
      if (resource === "artifacts" && segments.length === 5) {
        const name = segments[4];
        if (name === undefined) throw new DashboardHttpError(404, "资源不存在");
        rejectInvalidName(name, "artifact");
        return this.readArtifact(runId, name);
      }
      if (resource === "logs" && segments.length === 4) {
        return jsonResponse(this.listLogs(runId));
      }
      if (resource === "logs" && segments.length === 5) {
        const name = segments[4];
        if (name === undefined) throw new DashboardHttpError(404, "资源不存在");
        rejectInvalidName(name, "log");
        return this.readLog(runId, name);
      }
      throw new DashboardHttpError(404, "资源不存在");
    } catch (cause) {
      if (cause instanceof DashboardHttpError) {
        return jsonResponse({ error: cause.publicMessage }, cause.status);
      }
      console.error("E2E dashboard request failed", cause);
      return jsonResponse({ error: "读取观测数据失败" }, 500);
    }
  }

  private pathInsideRoot(parts: readonly string[], requireExisting = false): string {
    const candidate = resolve(this.root, ...parts);
    if (!isWithin(this.root, candidate)) {
      throw new DashboardHttpError(400, "拒绝访问 root 外路径");
    }
    if (!existsSync(candidate)) {
      if (requireExisting) throw new DashboardHttpError(404, "资源不存在");
      return candidate;
    }
    try {
      const real = realpathSync(candidate);
      if (!isWithin(this.root, real)) {
        throw new DashboardHttpError(400, "拒绝访问 root 外路径");
      }
    } catch (cause) {
      if (cause instanceof DashboardHttpError) throw cause;
      if (requireExisting) throw new DashboardHttpError(404, "资源不存在");
    }
    return candidate;
  }

  private runDirectory(runId: string): string {
    rejectInvalidName(runId, "run");
    const runDir = this.pathInsideRoot([runId], true);
    let info;
    try {
      info = lstatSync(runDir);
    } catch {
      throw new DashboardHttpError(404, "run 不存在");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new DashboardHttpError(404, "run 不存在");
    }
    const statePath = this.pathInsideRoot([runId, "state.json"], true);
    let stateInfo;
    try {
      stateInfo = lstatSync(statePath);
    } catch {
      throw new DashboardHttpError(404, "run 不存在");
    }
    if (!stateInfo.isFile() || stateInfo.isSymbolicLink()) {
      throw new DashboardHttpError(404, "run 不存在");
    }
    return runDir;
  }


  private readState(runId: string): JsonObject {
    try {
      this.runDirectory(runId);
      return readJsonObject(this.pathInsideRoot([runId, "state.json"], true));
    } catch (cause) {
      if (cause instanceof DashboardHttpError) throw cause;
      throw new DashboardHttpError(500, "state.json 无法读取");
    }
  }

  private readRun(runId: string): { readonly state: JsonObject; readonly events: DashboardEvent[] } {
    return { state: this.readState(runId), events: this.readAllEvents(runId) };
  }

  private eventPath(runId: string): string {
    this.runDirectory(runId);
    return this.pathInsideRoot([runId, "run.jsonl"]);
  }

  private readAllEvents(runId: string): DashboardEvent[] {
    const path = this.eventPath(runId);
    if (!existsSync(path)) return [];
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) return [];
      return parseEvents(readTextIfPresent(path));
    } catch {
      return [];
    }
  }

  private readEvents(runId: string, after: number): { readonly events: DashboardEvent[]; readonly next_seq: number } {
    const events = this.readAllEvents(runId);
    return { events: events.filter((event) => event.seq > after), next_seq: events.at(-1)?.seq ?? 0 };
  }

  private listRuns(): RunSummary[] {
    const summaries: RunSummary[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_NAME.test(entry.name)) continue;
      try {
        summaries.push(summaryFromState(entry.name, this.readState(entry.name)));
      } catch {
        // A directory without a readable state.json is not an observable run.
      }
    }
    summaries.sort((a, b) => {
      const byTime = b.updated_at.localeCompare(a.updated_at);
      return byTime !== 0 ? byTime : a.run_id.localeCompare(b.run_id);
    });
    return summaries;
  }

  private artifactDirectory(runId: string): string | null {
    this.runDirectory(runId);
    const path = this.pathInsideRoot([runId, "artifacts"]);
    if (!existsSync(path)) return null;
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
      return path;
    } catch {
      return null;
    }
  }

  private listDirectoryFiles(runId: string, directoryName: "artifacts" | "logs"): ArtifactSummary[] {
    this.runDirectory(runId);
    const directory = this.pathInsideRoot([runId, directoryName]);
    if (!existsSync(directory)) return [];
    let info;
    try {
      info = lstatSync(directory);
    } catch {
      return [];
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return [];

    const files: ArtifactSummary[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !SAFE_NAME.test(entry.name)) continue;
      try {
        const path = this.pathInsideRoot([runId, directoryName, entry.name], true);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        files.push({
          name: entry.name,
          size: stat.size,
          modified_at: stat.mtime.toISOString(),
          mtime_ms: stat.mtimeMs,
        });
      } catch {
        // Ignore files that disappear or fail the root containment check mid-list.
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
  }

  private listArtifacts(runId: string): ArtifactSummary[] {
    // Keep this explicit so an absent artifacts directory still validates runId.
    this.artifactDirectory(runId);
    return this.listDirectoryFiles(runId, "artifacts");
  }

  private listLogs(runId: string): ArtifactSummary[] {
    return this.listDirectoryFiles(runId, "logs");
  }

  private regularChild(runId: string, directoryName: "artifacts" | "logs", name: string): string {
    rejectInvalidName(name, directoryName === "artifacts" ? "artifact" : "log");
    this.runDirectory(runId);
    const path = this.pathInsideRoot([runId, directoryName, name], true);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      throw new DashboardHttpError(404, "文件不存在");
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new DashboardHttpError(404, "文件不存在");
    return path;
  }

  private readArtifact(runId: string, name: string): Response {
    const path = this.regularChild(runId, "artifacts", name);
    try {
      return textResponse(readFileSync(path, "utf8"), artifactContentType(name));
    } catch {
      throw new DashboardHttpError(404, "Artifact 不存在");
    }
  }

  private readLog(runId: string, name: string): Response {
    const path = this.regularChild(runId, "logs", name);
    try {
      return textResponse(readFileSync(path, "utf8"), "text/plain; charset=utf-8");
    } catch {
      throw new DashboardHttpError(404, "日志不存在");
    }
  }

  private stream(request: Request, runId: string, after: number): Response {
    this.runDirectory(runId);
    const eventPath = this.pathInsideRoot([runId, "run.jsonl"]);
    const cursor = new EventCursor(eventPath);
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastState = "";

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      pollTimer = null;
      heartbeatTimer = null;
      if (controller !== null) {
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      }
    };

    const send = (eventName: string, payload: unknown, id?: number): void => {
      if (closed || controller === null) return;
      const idLine = id === undefined ? "" : `id: ${id}\n`;
      const data = JSON.stringify(payload).replace(/\n/g, "\\n");
      try {
        controller.enqueue(encoder.encode(`event: ${eventName}\n${idLine}data: ${data}\n\n`));
      } catch {
        close();
      }
    };

    const tick = (): void => {
      if (closed) return;
      try {
        for (const event of cursor.readDelta()) send("event", event, event.seq);
        const state = this.readState(runId);
        const serialized = JSON.stringify(state);
        if (serialized !== lastState) {
          lastState = serialized;
          send("state", state);
        }
      } catch {
        // Keep the stream alive while state.json is being replaced by a writer.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
        try {
          const state = this.readState(runId);
          lastState = JSON.stringify(state);
          send("state", state);
          for (const event of cursor.initial(after)) send("event", event, event.seq);
          pollTimer = setInterval(tick, this.pollIntervalMs);
          heartbeatTimer = setInterval(() => {
            if (!closed) {
              try {
                controller?.enqueue(encoder.encode(": keep-alive\n\n"));
              } catch {
                close();
              }
            }
          }, 15_000);
        } catch {
          send("error", { message: "run 状态暂时不可用" });
          close();
        }
      },
      cancel: () => close(),
    });
    request.signal.addEventListener("abort", close, { once: true });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
}

export function createE2EDashboardHandler(options: E2EDashboardOptions): (request: Request) => Response {
  const service = new DashboardService(options);
  return (request: Request) => service.handle(request);
}

export function createE2EDashboardServer(options: E2EDashboardOptions) {
  const handler = createE2EDashboardHandler(options);
  return Bun.serve({
    hostname: options.hostname ?? DEFAULT_HOSTNAME,
    port: options.port ?? DEFAULT_PORT,
    fetch: handler,
  });
}
