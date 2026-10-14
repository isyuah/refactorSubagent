export const workflowKind = "test-workflow-driven";

/*
 * Structural refactor judgement (H8) — the target is not a leaf function but
 * the *shape* of a translation unit: move a chunk of src/uv-common.c into a
 * new source file and wire it into the build, with the public symbols and all
 * observable behaviour unchanged.
 *
 * The judgement is deliberately built from material that already exists and is
 * already calibrated:
 *
 *   A. upstream cases that exercise uv-common.c through public API
 *      (error_message / env_vars cover the moved error-string island and
 *      uv_translate_sys_error; the loop_* / walk / close_order family covers
 *      the handle-queue and loop-close semantics in the same TU)
 *   B. the same six oracles the T1-T6 judgement uses, so a candidate that
 *      breaks strscpy/inet/errstr/getters/version on the way is still caught
 *
 * What this case adds that no other case covers: a patch that creates a file
 * and edits CMakeLists.txt. The host measures the change set itself, so a
 * candidate that fails to register the new TU in the build gets a link error
 * (or a stale archive) and fails here.
 */

const ORACLE_PINS = {
  "oracle_common.h": "248fd65783b637720934818acb25f72d13465bc45cc6847409c4dc0866e1e951",
  "oracle_errstr.c": "d8763d48d227c4c2038d3fc8a9851f32caeb5b4ad88e10109da70b23cae3e0c2",
  "oracle_getters.c": "c03256185aef847657ef4e98d7ddeeb077b9e4ad03d14eaee34a06a5083f9515",
  "oracle_inet.c": "c59b1e069a5109b628ce5e40086bca2e71c7ced9e94da5f6101abd67581b607f",
  "oracle_strscpy.c": "9c19cd65b8ef9a3c13f008bdfbaa682116049539713ca73619bda42cfed12e13",
  "oracle_strtok.c": "b781ef0b6fbb18b36195936ab98f5298479312b828a4668859bef118200561e8",
  "oracle_version.c": "65540f59f9eb6451d1f964c9807f29eccfd1da2a090bc59dcd934bc036141732",
}

const UPSTREAM_PINS = {
  "test/run-tests.c": "088c0025f897eea64e1530a54d7cae819099f14ecadbc31b90492aa10fdce89d",
  "test/runner.c": "16b58ebd3bf00a014c8d078712498d5996ff0a3017f64cb79f348e938d08ad2c",
  "test/task.h": "4e987e7f1127d5ec1ad26a98dd17f4dd5635031f4c9faaf449f60bd25ade2707",
  "test/test-list.h": "b9dff249f9871ade6ded915df8afe2ff359069355be42b0e26c48400e9d0062b",
  "test/test-close-order.c": "5b2f6507d9f3e515614304ce76dcf326371e02b56fac678651bbf71a130cb00c",
  "test/test-default-loop-close.c": "7aef33fc1cd624a7b8c996231a07c45990e659737a5ce81146916fd1e9bbad64",
  "test/test-env-vars.c": "d18cb3850e77e9dc5ca2a79977c54944308350a9f6a42031671685a2c080b34b",
  "test/test-error.c": "5acc81f33be87d3f905dabd85b742f8d86eefc8a57966822a98beb07e802e59f",
  "test/test-idle.c": "5d1270ccd447612d119761a860d81228e953c543439a8540f79e8ab871fa06f3",
  "test/test-loop-alive.c": "cdff71b57ac055098ee01b1c238fa54f8ea669c0987ef80d6d7e93c04d584d2c",
  "test/test-loop-close.c": "4f46954133252840c14cdf2bd1211c03154dc57321fb822c2af276b2c2c5d9e5",
  "test/test-loop-handles.c": "6aed415148111e57f8d8c84b149522e1a7b1711ecf23c58c8871ba5a7f0ba199",
  "test/test-run-once.c": "67dc99aaee4db4ce7b470821316c1cf1672afd02110639469685ccfe417a547c",
  "test/test-timer.c": "66020ed00e81e1d6edb479e0b529c67370b13f0a342344169d90d43e8c95a0f1",
  "test/test-walk-handles.c": "7bb9d92343757117be447fe8b2a3a563c64eb1fa288692370d4ac6f1065e6760",
}

const UPSTREAM_CASES = [
  "error_message",
  "env_vars",
  "close_order",
  "run_once",
  "loop_alive",
  "loop_close",
  "default_loop_close",
  "loop_handles",
  "walk_handles",
  "timer_run_once",
  "idle_check",
];

const ORACLE_SUMMARY_NAMES = {
  oracle_strtok: "strtok-oracle",
  oracle_strscpy: "strscpy-oracle",
  oracle_inet: "inet-oracle",
  oracle_errstr: "errstr-oracle",
  oracle_getters: "getters-oracle",
  oracle_version: "version-oracle",
};

const ORACLES = [
  "oracle_strtok",
  "oracle_strscpy",
  "oracle_inet",
  "oracle_errstr",
  "oracle_getters",
  "oracle_version",
];

const ORACLE_LINK_ARGS = [
  "-lpsapi", "-luser32", "-ladvapi32", "-liphlpapi", "-luserenv",
  "-lws2_32", "-ldbghelp", "-lole32", "-lshell32",
];

const RUNNER_PINS = {
  win32: { "test/runner-win.c": "0edf790dcebe3c8a36778b4d864ad437da6a9567421079c589222075c23f928a" },
  linux: {
    "test/runner-unix.c": "6a713766335da86114eed026564e2620116fcfef77193f017675bc38aa2d3911",
    "test/runner-unix.h": "4bda95a56e740921f4a2f1e6f9b3bd6a9415b0096bbc1a56218766a237c7e408",
  },
};

/* "name=sha256" sorted and joined: stable, diffable, regex-checkable. */
function canonical(snapshot) {
  const parts = [];
  for (const name of Object.keys(snapshot).sort()) {
    parts.push(name + "=" + snapshot[name]);
  }
  return parts.join(";");
}

function pinnedCanonical(prefix, pins) {
  const parts = [];
  for (const name of Object.keys(pins).sort()) {
    parts.push(prefix + name + "=" + pins[name]);
  }
  return parts.join(";");
}

function tail(value, limit) {
  const text = (value === null || value === undefined) ? "" : String(value).trim();
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function outcome(result) {
  const detail = tail(result.stderr || result.stdout || result.error || "", 300);
  return result.status + " exit=" + String(result.exitCode) + (detail.length > 0 ? " :: " + detail : "");
}

export default async (ctx) => {
  const host = ctx.facts.host;
  if (!host || !RUNNER_PINS[host.platform]) {
    throw new Error("libuv judgement requires Windows or Linux host facts");
  }
  const suffix = host.executable_suffix;
  const runner = "build/uv_run_tests_a" + suffix;
  const upstreamPins = { ...UPSTREAM_PINS, ...RUNNER_PINS[host.platform] };
  const linkArgs = host.platform === "win32" ? ORACLE_LINK_ARGS : ["-pthread", "-ldl", "-lrt", "-lm"];
  await ctx.validator.assertFile(runner, "libuv static test runner");
  await ctx.validator.assertFile("build/libuv.a", "libuv static library");

  // Layer 0: judgement material. The structural task is free to add files, so
  // the oracle directory snapshot is the only thing that notices a candidate
  // rewriting the judgement instead of the target.
  const oracleSnapshot = await ctx.fs.snapshot("refactor-task/oracle");
  const oracleActual = canonical(oracleSnapshot);
  ctx.expect(
    "oracle.sources.digest",
    "both-matches",
    oracleActual,
    "^" + pinnedCanonical("refactor-task/oracle/", ORACLE_PINS),
  );
  ctx.expect("oracle.sources.snapshot", oracleActual);

  for (const file of Object.keys(upstreamPins).sort()) {
    const actual = canonical(await ctx.fs.snapshot(file));
    ctx.expect(file + ".digest", "both-matches", actual, "^" + file + "=" + upstreamPins[file]);
    ctx.expect(file + ".snapshot", actual);
  }

  const compiledOracles = [];
  for (const oracle of ORACLES) {
    const compiled = await ctx.process.run({
      program: "gcc",
      args: [
        "-O0", "-g",
        "-I", ".", "-I", "include", "-I", "src", "-I", "refactor-task/oracle",
        "refactor-task/oracle/" + oracle + ".c",
        "build/libuv.a",
        "-o", "build/" + oracle + suffix,
      ].concat(linkArgs),
      cwd: ".",
      timeoutMs: 120000,
    });
    compiledOracles.push(compiled);
    const ok = compiled.status === "exited" && compiled.exitCode === 0;
    ctx.expect(oracle + ".compile", "both-matches", ok ? "0" : outcome(compiled), "^0");
  }

  for (const name of UPSTREAM_CASES) {
    const run = await ctx.process.run({
      program: runner,
      args: [name],
      cwd: ".",
      timeoutMs: 60000,
    });
    const stdout = run.stdout.trim();
    ctx.expect(name + ".exit", "both-matches", String(run.exitCode), "^0");
    ctx.expect(name + ".tap", "both-matches", stdout, "^ok 1 - " + name);
    ctx.expect(name + ".stdout", stdout);
  }

  for (let index = 0; index < ORACLES.length; index++) {
    const oracle = ORACLES[index];
    const compiled = compiledOracles[index];
    if (compiled.status !== "exited" || compiled.exitCode !== 0) {
      const failure = "oracle-not-built: " + outcome(compiled);
      ctx.expect(oracle + ".exit", "both-matches", failure, "^0");
      ctx.expect(oracle + ".summary", "both-matches", failure, "^" + ORACLE_SUMMARY_NAMES[oracle] + ": total_failures=0");
      ctx.expect(oracle + ".stdout", failure);
      continue;
    }
    const run = await ctx.process.run({
      program: "build/" + oracle + suffix,
      args: [],
      cwd: ".",
      timeoutMs: 60000,
    });
    const stdout = run.stdout.trim();
    const lines = stdout.length === 0 ? [] : stdout.split(/\r?\n/);
    const summary = lines.length === 0 ? "no-output" : lines[lines.length - 1];
    ctx.expect(oracle + ".exit", "both-matches", String(run.exitCode), "^0");
    ctx.expect(oracle + ".summary", "both-matches", summary, "^" + ORACLE_SUMMARY_NAMES[oracle] + ": total_failures=0");
    ctx.expect(oracle + ".stdout", stdout);
  }

  return {
    declared: {
      platform: host.platform,
      upstream_files: Object.keys(upstreamPins).length,
      upstream_cases: UPSTREAM_CASES.length,
      oracles: ORACLES.length,
    },
  };
};
