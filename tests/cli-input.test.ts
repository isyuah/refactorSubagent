import { describe, expect, spyOn, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { CliUsageError, parseCliArgs, RunTaskRequiredError } from "../src/cli/args.js";
import { CliInputCancelled, createRunSessionId, resolveCliInput } from "../src/cli/input.js";

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode(mode: boolean) { this.isRaw = mode; return this; } });
  const chunks: string[] = [];
  const output = Object.assign(new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } }),
    { isTTY: true, columns: 120 });
  let cursor = 0;
  return { input, output, text: () => stripVTControlCharacters(chunks.join("")),
    async until(marker: string) {
      for (let tries = 0; tries < 100; tries++) {
        const text = stripVTControlCharacters(chunks.join(""));
        const index = text.indexOf(marker, cursor);
        if (index >= 0) { cursor = index + marker.length; return; }
        await new Promise<void>((done) => setImmediate(done));
      }
      throw new Error(`prompt not found: ${marker}\n${chunks.join("")}`);
    },
    options: { input, output, env: {} },
  };
}

describe("CLI launch input", () => {
  test("a task supplied in argv never opens a prompt, and session naming remains optional", async () => {
    const t = terminal();
    const command = await resolveCliInput(["run", "repo", "--task", "保持输出行为"], t.options);
    expect(command).toMatchObject({ task: "保持输出行为", session: null, noInteractive: false });
    expect(t.text()).toBe("");
    expect(t.input.isRaw).toBeFalse();
    expect(parseCliArgs(["run", "--task", "task", "--session", "readable-name", "--no-interactive"]))
      .toMatchObject({ session: "readable-name", noInteractive: true });
  });

  test("validates all arguments before considering a missing-task prompt", async () => {
    const t = terminal();
    for (const argv of [["run", "--unknown"], ["run", "--format", "bad"], ["run", "--task"], ["workflow", "run"]]) {
      await expect(resolveCliInput(argv, t.options)).rejects.toThrow(CliUsageError);
    }
    expect(t.text()).toBe("");
    expect(() => parseCliArgs(["run"])).toThrow(RunTaskRequiredError);
    expect(() => parseCliArgs(["run", "--task", "   "])).toThrow(RunTaskRequiredError);
  });

  test("nonterminal input/output, CI and the explicit opt-out fail instead of waiting", async () => {
    const t = terminal();
    for (const options of [
      { ...t.options, input: Object.assign(new PassThrough(), { isTTY: false }) },
      { ...t.options, output: Object.assign(new PassThrough(), { isTTY: false }) },
      { ...t.options, env: { CI: "true" } }, { ...t.options, env: { CI: "1" } },
    ]) await expect(resolveCliInput(["run"], options)).rejects.toThrow(RunTaskRequiredError);
    await expect(resolveCliInput(["run", "--no-interactive"], t.options)).rejects.toThrow(RunTaskRequiredError);
    expect(t.text()).toBe("");
    expect(t.input.isRaw).toBeFalse();
  });

  test("collects a missing/blank task, supports correction and preserves run options including JSON", async () => {
    const t = terminal();
    const intBefore = process.listenerCount("SIGINT"), termBefore = process.listenerCount("SIGTERM");
    const pending = resolveCliInput(["run", "demo", "--task", "  ", "--format", "json", "--resume", "older", "--session", "newer", "--no-color"], t.options);
    try {
      await t.until("重构任务 > "); t.input.write("\n");
      await t.until("任务不能为空");
      await t.until("重构任务 > "); t.input.write("初始任务\n");
      await t.until("[1] 开始运行"); t.input.write("invalid\n");
      await t.until("请输入 1、2 或 0");
      await t.until("[1] 开始运行"); t.input.write("2\n");
      await t.until("重构任务 > "); t.input.write(" 提取重复校验，保持错误文本不变。 \n");
      await t.until("[1] 开始运行"); t.input.write("1\n");
      const command = await pending;
      expect(command).toMatchObject({ kind: "run", repo: "demo", task: "提取重复校验，保持错误文本不变。", format: "json", resume: "older", session: "newer", color: false });
      expect(t.text()).toContain("恢复自会话: older");
      expect(t.input.isRaw).toBeFalse();
      expect(process.listenerCount("SIGINT")).toBe(intBefore);
      expect(process.listenerCount("SIGTERM")).toBe(termBefore);
    } finally { t.input.end(); await pending.catch(() => {}); }
  });

  for (const action of ["cancel-command", "cancel-choice", "empty-choice", "ctrl-c", "ctrl-d", "eof", "sigterm"] as const) {
    test(`${action}: cancellation restores terminal input and never produces a run command`, async () => {
      const t = terminal();
      const intBefore = process.listenerCount("SIGINT"), termBefore = process.listenerCount("SIGTERM");
      const pending = resolveCliInput(["run", "repo"], t.options).catch((error: unknown) => error);
      await t.until("重构任务 > ");
      if (action === "cancel-command") t.input.write("/cancel\n");
      else if (action === "ctrl-c") t.input.write("\u0003");
      else if (action === "ctrl-d") t.input.write("\u0004");
      else if (action === "eof") t.input.end();
      else if (action === "sigterm") process.emit("SIGTERM");
      else {
        t.input.write("重构但不改变行为\n");
        await t.until("[1] 开始运行");
        t.input.write(action === "cancel-choice" ? "0\n" : "\n");
      }
      const result = await pending;
      expect(result).toBeInstanceOf(CliInputCancelled);
      expect((result as CliInputCancelled).exitCode).toBe(action === "sigterm" ? 143 : 130);
      expect(t.input.isRaw).toBeFalse();
      expect(process.listenerCount("SIGINT")).toBe(intBefore);
      expect(process.listenerCount("SIGTERM")).toBe(termBefore);
      t.input.destroy();
    });
  }

  test("input failures remain errors and still release terminal and signal listeners", async () => {
    const t = terminal();
    const before = process.listenerCount("SIGINT");
    const pending = resolveCliInput(["run"], t.options).catch((error: unknown) => error);
    await t.until("重构任务 > ");
    t.input.destroy(new Error("fixture input failed"));
    const result = await pending;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("fixture input failed");
    expect(result).not.toBeInstanceOf(CliInputCancelled);
    expect(t.input.isRaw).toBeFalse();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("automatic session ids stay distinct when launches share a timestamp", () => {
    const clock = spyOn(Date, "now").mockReturnValue(1234567890);
    try {
      const a = createRunSessionId(), b = createRunSessionId();
      expect(a).not.toBe(b);
      expect(a).toStartWith(`run-${(1234567890).toString(36)}-`);
      expect(b).toStartWith(`run-${(1234567890).toString(36)}-`);
    } finally { clock.mockRestore(); }
  });
});
