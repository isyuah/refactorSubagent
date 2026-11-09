import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostPreflight } from "../src/artifacts/index.js";
import { LocalCapabilityBroker } from "../src/workflow/capabilities.js";
import type { ProgressUpdate } from "../src/runtime/progress.js";

describe("native execution progress", () => {
  for (const launch of ["normal", "missing-program"] as const) {
    test(`${launch}: preserves execution results and reports start, streamed bytes and end`, async () => {
      const root = mkdtempSync(join(tmpdir(), "rfr-output-"));
      const events: ProgressUpdate[] = [];
      writeFileSync(join(root, "tool.ts"), `
        const bytes = Buffer.from("中文分块输出");
        process.stdout.write(bytes.subarray(0, 2));
        await Bun.sleep(30);
        process.stdout.write(bytes.subarray(2));
        process.stderr.write("diagnostic output");
      `);
      const host = HostPreflight.parse({ kind: "host-preflight", version: 1, platform: process.platform, arch: process.arch,
        shell: "unknown", supports_posix_shell: false, executable_suffix: process.platform === "win32" ? ".exe" : "", working_directory: root,
        tools: { bun: { available: true, path: launch === "normal" ? process.execPath : join(root, "missing-executable"), version: null } } });
      const broker = new LocalCapabilityBroker({ workspaceRoot: root, host, policy: { allowedTools: ["bun"] }, onProgress: (event) => events.push(event) });
      try {
        const response = await broker.handle({ type: "capability-request", id: "native", capability: "process", method: "run", args: [{ program: "bun", args: ["tool.ts"], timeoutMs: 30_000 }] });
        expect(events[0]?.type).toBe("command-start");
        expect(events.at(-1)?.type).toBe("command-end");
        const ended = events.find((event) => event.type === "command-end");
        if (launch === "normal") {
          expect(response.ok).toBeTrue();
          expect(response.value).toMatchObject({ status: "exited", exitCode: 0 });
          expect(events.flatMap((event) => event.type === "command-output" && event.stream === "stdout" ? [event.text] : []).join("")).toBe("中文分块输出");
          expect(events.flatMap((event) => event.type === "command-output" && event.stream === "stderr" ? [event.text] : []).join("")).toBe("diagnostic output");
          expect(ended).toMatchObject({ status: "exited", exit_code: 0 });
        } else {
          expect(ended).toMatchObject({ status: "spawn_error", exit_code: null });
          expect(ended?.error).toBeTruthy();
        }
      } finally { await broker.close(); }
    }, 60_000);
  }
});
