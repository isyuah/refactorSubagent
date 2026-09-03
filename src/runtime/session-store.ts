import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

/**
 * Filesystem-backed SessionStore mirror.
 *
 * The Claude Agent SDK dual-writes transcripts to an external store when a
 * `sessionStore` adapter is provided (the subprocess still writes its local
 * copy). This adapter appends each mirrored transcript line under a run's
 * session directory:
 *
 *   <sessionRoot>/sessions/<sessionId>/main.jsonl
 *   <sessionRoot>/sessions/<sessionId>/subagents/agent-<agentId>.jsonl
 *
 * The full AI conversation (tool_use, tool_result payloads, subagent
 * transcripts) is preserved here regardless of the pino log level, so slow
 * runs can be analyzed without bloating run.jsonl with payload content.
 *
 * Entries are JSON-safe POJOs, one per line. `uuid` is treated as an
 * idempotency key: appends that duplicate an existing uuid are skipped so
 * SDK retries/replays cannot corrupt the transcript.
 */
export class FileSessionStore implements SessionStore {
  private readonly sessionRoot: string;

  constructor(sessionRoot: string) {
    this.sessionRoot = sessionRoot;
  }

  private keyToPath(key: SessionKey): string {
    const base = join(this.sessionRoot, "sessions", key.sessionId);
    const file = key.subpath !== undefined ? join(base, ...key.subpath.split("/")) : join(base, "main.jsonl");
    // Only allow the transcript under the session dir (fail closed).
    if (!file.startsWith(base)) {
      throw new Error(`refusing session path outside session dir: ${file}`);
    }
    return file;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const path = this.keyToPath(key);
    mkdirSync(join(path, ".."), { recursive: true });
    // Read existing uuids to skip duplicate appends (idempotency).
    const seen = new Set<string>();
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(line) as { uuid?: unknown };
          if (typeof parsed.uuid === "string") seen.add(parsed.uuid);
        } catch {
          // Ignore a partial trailing line from a concurrent writer.
        }
      }
    }
    const fresh = entries.filter((entry) => {
      if (typeof entry.uuid !== "string") return true; // no uuid → always append
      if (seen.has(entry.uuid)) return false;
      seen.add(entry.uuid);
      return true;
    });
    if (fresh.length > 0) {
      appendFileSync(path, `${fresh.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const path = this.keyToPath(key);
    if (!existsSync(path)) return null;
    const entries: SessionStoreEntry[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as SessionStoreEntry);
      } catch {
        // Ignore partial lines (concurrent write).
      }
    }
    return entries;
  }
}
