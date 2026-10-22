import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeHost } from "../src/runtime/host-preflight.js";
import { runCTest } from "../src/runtime/ctest-runner.js";
import { runWorkflow } from "../src/workflow/runner.js";
import { exec } from "../testset/runner/exec.js";

const measured = probeHost(process.cwd());
const host = {
  ...measured,
  tools: { ...measured.tools, bun: { available: true, path: process.execPath, version: Bun.version } },
};
const windows = process.platform === "win32";
const caseTimeout = windows ? 120_000 : 10_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A Linux zombie cannot execute or retain a pipe. Its adopter owns reaping it.
    if (process.platform === "linux" && readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) {
      return false;
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function fixture(workflow: string, tool?: string) {
  const root = mkdtempSync(join(tmpdir(), "rfr-life-"));
  const entry = join(root, "workflow.ts");
  writeFileSync(entry, workflow);
  writeFileSync(join(root, "marker.txt"), "before cancellation");
  writeFileSync(join(root, "tool.ts"), tool ?? `
    import { writeFileSync } from "node:fs";
    process.on("SIGTERM", () => {});
    writeFileSync("tool.pid", String(process.pid));
    console.log("ready");
    setInterval(() => {}, 1000);
  `);
  const pids = () => ["tool.pid", "descendant.pid"]
    .filter((file) => existsSync(join(root, file)))
    .map((file) => Number(readFileSync(join(root, file), "utf8")));
  const cancellation = new AbortController();
  let active: ReturnType<typeof runWorkflow> | null = null;
  const cleanup = () => {
    // Independent cleanup keeps failing regressions from leaking fixture tools.
    for (const pid of pids()) {
      if (!alive(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  return {
    root, entry, pids, cleanup,
    run: (extra: Partial<Parameters<typeof runWorkflow>[0]> = {}) => {
      active = runWorkflow({
        entry, cwd: root, facts: { host },
        policy: { allowedTools: ["bun"], readableGlobs: ["**"], readyTimeoutMs: windows ? 60_000 : 5000 },
        timeoutMs: windows ? 90_000 : 5000, ...extra,
        signal: extra.signal === undefined ? cancellation.signal : AbortSignal.any([cancellation.signal, extra.signal]),
      });
      return active;
    },
    dispose: async () => {
      cancellation.abort();
      cleanup();
      if (active !== null) await active;
      await until(() => !pids().some(alive));
      const deadline = Date.now() + 5000;
      for (;;) {
        try { rmSync(root, { recursive: true, force: true }); break; } catch (error) {
          // Windows can briefly retain cwd handles after a process is dead.
          if (!windows || !["EBUSY", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) {
            throw error;
          }
          await Bun.sleep(25);
        }
      }
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + (windows ? 60_000 : 5000);
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("fixture did not become ready");
    await Bun.sleep(10);
  }
}

async function bounded<T>(task: Promise<T>, cleanup: () => void, ms = windows ? 60_000 : 3500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { cleanup(); reject(new Error("process cleanup exceeded its bound")); }, ms);
  });
  try { return await Promise.race([task, deadline]); } finally { clearTimeout(timer!); }
}

describe("owned process lifecycle", () => {
  for (const shutdown of ["exit", "SIGINT", "SIGTERM"] as const) {
    test(`host ${shutdown} reaps its owned tool`, async () => {
      const f = fixture("export default () => null");
      const adapter = fileURLToPath(new URL("../shared/owned-process.ts", import.meta.url));
      writeFileSync(join(f.root, "host.ts"), `
        import { existsSync, writeFileSync } from 'node:fs';
        import { spawnOwnedProcess, installOwnedProcessSignalHandlers } from ${JSON.stringify(adapter)};
        installOwnedProcessSignalHandlers();
        const owned = spawnOwnedProcess({ program: process.execPath, args: ['tool.ts'], cwd: process.cwd(), stdin: 'ignore' });
        owned.child.stdout.resume();
        owned.child.stderr.resume();
        while (!existsSync('tool.pid')) await Bun.sleep(10);
        writeFileSync('host.ready', 'ready');
        ${shutdown === "exit" ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
      `);
      // The fixture host is deliberately unowned: an outer process group or Job
      // must not hide missing cleanup by the host under test.
      const child = spawn(process.execPath, ["host.ts"], {
        cwd: f.root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let stderr = "";
      child.stdout!.resume();
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const exited = new Promise<{ code: number | null; error: Error | null }>((resolveExit) => {
        child.once("exit", (code) => resolveExit({ code, error: null }));
        child.once("error", (error) => resolveExit({ code: null, error }));
      });
      const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
      const cleanup = () => { child.kill("SIGKILL"); f.cleanup(); };
      try {
        if (shutdown !== "exit") {
          await until(() => existsSync(join(f.root, "host.ready")));
          // On Windows this is abrupt termination; IPC disconnect must close
          // the helper's Job. POSIX delivers the signal to the CLI handler.
          child.kill(shutdown);
        }
        const exit = await bounded(exited, cleanup);
        await bounded(closed, cleanup, 5000);
        if (exit.error !== null) throw exit.error;
        if (shutdown === "exit" || !windows) {
          expect(exit.code, stderr).toBe(shutdown === "exit" ? 0 : shutdown === "SIGINT" ? 130 : 143);
        }
        expect(f.pids()).toHaveLength(1);
        await bounded(until(() => !f.pids().some(alive)), cleanup, 5000);
        expect(f.pids().some(alive)).toBeFalse();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        await f.dispose();
      }
    }, caseTimeout);
  }

  for (const completion of ["return 'done'", "throw new Error('fixture failure')"]) {
    test(`workflow cleans background tools after ${completion.startsWith("return") ? "success" : "failure"}`, async () => {
      const f = fixture(`export default async (ctx) => {
        await ctx.process.start({ program: 'bun', args: ['tool.ts'], ready: { kind: 'file', path: 'tool.pid' } });
        ${completion};
      };`);
      try {
        const result = await f.run();
        if (completion.startsWith("return") && result.status !== "pass") throw new Error(result.failure ?? "workflow did not pass");
        expect(result.status).toBe(completion.startsWith("return") ? "pass" : "failed");
        if (completion.startsWith("throw")) expect(result.failure).toContain("fixture failure");
        expect(f.pids()).toHaveLength(1);
        expect(f.pids().some(alive)).toBeFalse();
      } finally { await f.dispose(); }
    }, caseTimeout);
  }

  test("workflow timeout stops a running tool and retains earlier capability evidence", async () => {
    const f = fixture(`export default async (ctx) => {
      await ctx.fs.readFile('marker.txt');
      return ctx.process.run({ program: 'bun', args: ['tool.ts'] });
    };`);
    try {
      const result = await bounded(f.run({ timeoutMs: windows ? 40_000 : 1000 }), f.cleanup);
      expect(result.status).toBe("timeout");
      expect(f.pids()).toHaveLength(1);
      expect(f.pids().some(alive)).toBeFalse();
      expect(result.events).toContainEqual(expect.objectContaining({ capability: "fs", method: "readFile", ok: true }));
    } finally { await f.dispose(); }
  }, caseTimeout);

  test("cancellation interrupts a pending readiness probe and reaps its tool", async () => {
    const f = fixture(`export default async (ctx) => ctx.process.start({
      program: 'bun', args: ['tool.ts'], ready: { kind: 'file', path: 'never-ready', timeoutMs: 60000 }
    });`);
    const controller = new AbortController();
    try {
      const task = f.run({ signal: controller.signal });
      await until(() => f.pids().length === 1);
      controller.abort();
      const result = await bounded(task, f.cleanup, 5000);
      expect(result.status).toBe("failed");
      expect(result.failure).toContain("cancel");
      expect(f.pids().some(alive)).toBeFalse();
    } finally { await f.dispose(); }
  }, caseTimeout);

  test("cancelling an outer executor lets a nested CLI reap TERM-resistant tools", async () => {
    const f = fixture("export default () => null");
    const adapter = fileURLToPath(new URL("../shared/owned-process.ts", import.meta.url));
    writeFileSync(join(f.root, "host.ts"), `
      import { spawnOwnedProcess, installOwnedProcessSignalHandlers } from ${JSON.stringify(adapter)};
      installOwnedProcessSignalHandlers();
      const owned = spawnOwnedProcess({ program: process.execPath, args: ['tool.ts'], cwd: process.cwd(), stdin: 'ignore' });
      owned.child.stdout.resume();
      owned.child.stderr.resume();
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const task = exec({
      program: process.execPath, args: ["host.ts"], cwd: f.root,
      timeoutMs: windows ? 90_000 : 5000, signal: controller.signal, cooperativeShutdown: true,
    });
    try {
      await until(() => f.pids().length === 1);
      controller.abort();
      const result = await bounded(task, f.cleanup, 5000);
      expect(result.status).toBe("error");
      expect(result.error).toContain("cancelled");
      await bounded(until(() => !f.pids().some(alive)), f.cleanup, 5000);
      expect(f.pids().some(alive)).toBeFalse();
    } finally {
      controller.abort();
      await task;
      await f.dispose();
    }
  }, caseTimeout);

  test("concurrent wait does not prevent stop from completing", async () => {
    const f = fixture(`export default async (ctx) => {
      const h = await ctx.process.start({ program: 'bun', args: ['tool.ts'], ready: { kind: 'file', path: 'tool.pid' } });
      return Promise.all([ctx.process.wait(h), ctx.process.stop(h)]);
    };`);
    try {
      const result = await bounded(f.run(), f.cleanup);
      expect(result.status).toBe("pass");
      expect(result.result).toEqual([expect.objectContaining({ status: "stopped" }), expect.objectContaining({ status: "stopped" })]);
      expect(f.pids().some(alive)).toBeFalse();
    } finally { await f.dispose(); }
  }, caseTimeout);

  test("testset exec reaps descendants that retain pipes after their parent exits", async () => {
    const f = fixture("export default () => null", `
      import { spawn } from 'node:child_process';
      import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync('tool.pid', String(process.pid));
      spawn(process.execPath, ['descendant.ts'], { stdio: 'inherit' });
      while (!existsSync('descendant.pid')) await Bun.sleep(10);
      console.log('parent output');
      process.exit(7);
    `);
    writeFileSync(join(f.root, "descendant.ts"), `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      writeFileSync('descendant.pid', String(process.pid));
      setInterval(() => {}, 1000);
    `);
    try {
      const result = await bounded(exec({ program: process.execPath, args: ["tool.ts"], cwd: f.root, timeoutMs: windows ? 60_000 : 2000 }), f.cleanup);
      expect(result.status).toBe("exited");
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain("parent output");
      expect(f.pids()).toHaveLength(2);
      expect(f.pids().some(alive)).toBeFalse();
    } finally { await f.dispose(); }
  }, caseTimeout);

  test("testset exec preserves piped input, environment and the target exit result", async () => {
    const f = fixture("export default () => null", `
      const input = await Bun.stdin.text();
      console.log(JSON.stringify({ size: input.length, suffix: input.slice(-2), marker: process.env.RFR_LIFECYCLE_MARKER }));
      console.error('tool stderr');
      process.exit(9);
    `);
    const input = "x".repeat(128 * 1024) + "中文";
    try {
      const result = await exec({
        program: process.execPath, args: ["tool.ts"], cwd: f.root,
        timeoutMs: windows ? 60_000 : 2000, stdin: input,
        env: { RFR_LIFECYCLE_MARKER: "forwarded" },
      });
      expect(result.status).toBe("exited");
      expect(result.exitCode).toBe(9);
      expect(JSON.parse(result.stdout)).toEqual({ size: input.length, suffix: "中文", marker: "forwarded" });
      expect(result.stderr).toContain("tool stderr");
    } finally { await f.dispose(); }
  }, caseTimeout);

  test("CTest timeout takes precedence over incomplete declared tests and reaps TERM-resistant tools", async () => {
    const f = fixture("export default () => null");
    const quote = (s: string) => s.replaceAll("\\", "/").replaceAll('"', '\\"');
    writeFileSync(join(f.root, "CTestTestfile.cmake"), `add_test(stubborn "${quote(process.execPath)}" "${quote(join(f.root, "tool.ts"))}")\n`);
    try {
      const result = await bounded(runCTest({
        repoDir: f.root, host, requiredTopLevelTests: ["stubborn"],
        spec: {
          kind: "ctest-suite-spec", version: 1, build_dir: ".", configuration: "Debug",
          extra_args: [], environment: {}, parallelism: null, timeout_ms: windows ? 30_000 : 5000,
        },
      }), f.cleanup, windows ? 60_000 : 8000);
      expect(result.status).toBe("timeout");
      expect(f.pids(), Buffer.from(result.stdout_b64, "base64").toString("utf8")).toHaveLength(1);
      expect(f.pids().some(alive)).toBeFalse();
    } finally { await f.dispose(); }
  }, caseTimeout);
});
