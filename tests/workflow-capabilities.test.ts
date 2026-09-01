import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeHost } from "../src/runtime/host-preflight.js";
import { runWorkflow } from "../src/workflow/runner.js";

function tempWorkflow(source: string): { root: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), "rfr-capability-"));
  const entry = join(root, "workflow.ts");
  writeFileSync(entry, source);
  return { root, entry };
}

const policy = {
  readableGlobs: ["**"],
  writableGlobs: ["build/**"],
  executableGlobs: ["build/**"],
  allowedTools: ["gcc"],
  maxOutputBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
};

describe("Workflow Capability Context", () => {
  test("runs allowlisted filesystem and measured compiler capabilities", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ fs, process, tools, adapters }) => {
        await fs.writeFile("build/main.c", "#include <stdio.h>\\nint main(void){puts(\\"ok\\");return 0;}\\n");
        const source = await fs.readFile("build/main.c");
        const compiled = await adapters.compiler.compile({
          args: ["build/main.c", "-o", "build/app.exe"],
          cwd: ".",
          timeoutMs: 10000,
        });
        const started = await process.start({
          program: "build/app.exe",
          cwd: "build",
          timeoutMs: 10000,
        });
        const ran = await process.wait(started);
        return {
          source,
          compiler: await tools.available("gcc"),
          compiled: { status: compiled.status, exitCode: compiled.exitCode },
          ran: {
            status: ran.status,
            exitCode: ran.exitCode,
            stdout: Buffer.from(ran.stdoutBase64, "base64").toString("utf8").replaceAll("\\r\\n", "\\n"),
          },
        };
      };
    `);
    const result = await runWorkflow({
      entry,
      cwd: root,
      facts: { host: probeHost(root, { skipCMakeProbe: true }) },
      policy,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("pass");
    expect(result.result).toEqual({
      source: '#include <stdio.h>\nint main(void){puts("ok");return 0;}\n',
      compiler: true,
      compiled: { status: "exited", exitCode: 0 },
      ran: { status: "exited", exitCode: 0, stdout: "ok\n" },
    });
    expect(result.events.filter((event) => event.ok)).toHaveLength(6);
  }, 60_000);

  test("rejects writes outside policy and records failed capability event", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ fs }) => {
        await fs.writeFile("secrets.txt", "must not be written");
        return "unreachable";
      };
    `);
    const result = await runWorkflow({
      entry,
      cwd: root,
      policy,
      timeoutMs: 10_000,
    });

    expect(result.status).toBe("failed");
    expect(result.failure).toContain("not writable");
    expect(result.events).toEqual([
      expect.objectContaining({
        capability: "fs",
        method: "writeFile",
        ok: false,
      }),
    ]);
    expect(existsSync(join(root, "secrets.txt"))).toBeFalse();
  }, 60_000);

  test("rejects path traversal before reading outside the workspace", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ fs }) => await fs.readFile("../outside.txt");
    `);
    const outside = join(root, "..", "outside.txt");
    writeFileSync(outside, "not readable");
    try {
      const result = await runWorkflow({ entry, cwd: root, policy, timeoutMs: 10_000 });
      expect(result.status).toBe("failed");
      expect(result.failure).toContain("escapes workspace");
      expect(result.events[0]).toEqual(expect.objectContaining({ ok: false, method: "readFile" }));
    } finally {
      // The fixture is outside the temporary project and must not remain behind.
      Bun.file(outside).delete();
    }
  }, 60_000);

  test("enforces the broker output limit for measured tools", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ process }) => process.run({
        program: "gcc",
        args: ["--version"],
        maxOutputBytes: 1,
        timeoutMs: 10000,
      });
    `);
    const result = await runWorkflow({
      entry,
      cwd: root,
      facts: { host: probeHost(root, { skipCMakeProbe: true }) },
      policy,
      timeoutMs: 20_000,
    });

    expect(result.status).toBe("pass");
    expect(result.result).toEqual(expect.objectContaining({ status: "output_limit" }));
  }, 60_000);

  test("returns a deterministic failure for unavailable measured tools", async () => {
    const { root, entry } = tempWorkflow(`
      export default async ({ process }) => process.run({
        program: "cmake",
        args: ["--version"],
      });
    `);
    const result = await runWorkflow({ entry, cwd: root, policy, timeoutMs: 10_000 });

    expect(result.status).toBe("failed");
    expect(result.failure).toContain("measured tool is unavailable");
  }, 60_000);
});
