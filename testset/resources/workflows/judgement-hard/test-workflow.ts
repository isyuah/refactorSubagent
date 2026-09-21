export const workflowKind = "test-workflow-driven";

/*
 * Hard-tier judgement (H1-H7): targets the T1-T6 judgement does not reach,
 * each with its own oracle under refactor-task/oracle-hard/<target>/.
 *
 *   H1 src/win/error.c            system-error translation tables
 *   H2 src/win/fs-fd-hash-inl.h   fd -> filemap hash: collision chains, group
 *                                 backfill, group release timing
 *   H3 src/timer.c                timer heap/queue union, ordering, snapshot
 *                                 semantics of uv__run_timers
 *   H4 src/uv-common.c            uv_walk queue rotation, uv_loop_close and the
 *                                 Debug-build loop.data contract
 *   H5 src/win/util.c             environment-variable ownership + UTF-16
 *                                 conversion, incl. large-value round trips
 *   H6 src/win/core.c             event-loop body: pending-request ring, backend
 *                                 timeout guards, uv_run mode semantics
 *   H7 src/threadpool.c           work-item lifecycle and the cancel protocol
 *                                 (two-lock order, uv__cancelled sentinel)
 *
 * Layer A declares only upstream cases that FAIL FAST. Cases that can HANG are
 * deliberately absent: on Windows libuv's own runner returns from
 * process_wait() on timeout WITHOUT terminating the child (runner.c:269 assumes
 * it did, runner-win.c:205-207 does not), so a hung test leaves an orphan that
 * still holds the inherited stdout handle and the host would wait on it until
 * the case timeout. Loop/timer/walk semantics are covered by oracle_loop /
 * oracle_walk / oracle_timer instead, which are written to fail, not to hang.
 *
 * Layer B compiles and runs the oracles against build/libuv.a. Declaration
 * count and order are identical on both sides.
 */

const ORACLE_PINS = {
  "h1-error/oracle_error.c": "43f0c23e01a965a5b5fa79210aee41a45174376c3a2f32aa2c4f257359211f8b",
  "h2-fdhash/oracle_fd_hash.c": "8ebd5808e1c5182fd99178970efdc38442e1a351e4582a1a23e0dea86cd7bd48",
  "h3-timer/oracle_timer.c": "7f6e078d808d08dbfd7b70484c09af0b2f66b75a1337308545353e237622d5d3",
  "h4-walk/oracle_walk.c": "e8295561d3f149cac685a7ba464a9e853cb9abe0f1581adbf7685a86ee228ce0",
  "h5-env/oracle_env.c": "b8d332248ac97aa93d22809e7f91a709d443468c6cce4d1eb0ddf16b6c1f814d",
  "h6-loop/oracle_loop.c": "22b226f9574f27721a24521a0870980d625681a8ff6a5333c8f9a828bc3fc928",
  "h7-threadpool/oracle_threadpool.c": "b0b7ee1334ece2f98afd8e34aa43ec7b758ea2f8858c20a1b60cbb80b240dd06",
};

const UPSTREAM_PINS = {
  "test/run-tests.c": "088c0025f897eea64e1530a54d7cae819099f14ecadbc31b90492aa10fdce89d",
  "test/runner-win.c": "0edf790dcebe3c8a36778b4d864ad437da6a9567421079c589222075c23f928a",
  "test/runner.c": "16b58ebd3bf00a014c8d078712498d5996ff0a3017f64cb79f348e938d08ad2c",
  "test/task.h": "4e987e7f1127d5ec1ad26a98dd17f4dd5635031f4c9faaf449f60bd25ade2707",
  "test/test-list.h": "b9dff249f9871ade6ded915df8afe2ff359069355be42b0e26c48400e9d0062b",
  "test/test-close-order.c": "5b2f6507d9f3e515614304ce76dcf326371e02b56fac678651bbf71a130cb00c",
  "test/test-env-vars.c": "d18cb3850e77e9dc5ca2a79977c54944308350a9f6a42031671685a2c080b34b",
  "test/test-error.c": "5acc81f33be87d3f905dabd85b742f8d86eefc8a57966822a98beb07e802e59f",
  "test/test-loop-time.c": "95d2002a5968ad4dbb8747fe070843523d345418b9bb18e32c9e7350df9de3e9",
  "test/test-spawn.c": "c537bd294166acc5b0c9d7ea6ba666a5eb5881ca2bf4211bcbf0de679e260e7e",
};

const UPSTREAM_CASES = [
  "error_message",
  "env_vars",
  "environment_creation",
  "close_order",
  "loop_backend_timeout",
];

/* Each oracle prints "<name>: total_failures=N" as its last line. */
const ORACLE_SUMMARY_NAMES = {
  "h1-error/oracle_error": "error-oracle",
  "h2-fdhash/oracle_fd_hash": "fd-hash-oracle",
  "h3-timer/oracle_timer": "timer-oracle",
  "h4-walk/oracle_walk": "walk-oracle",
  "h5-env/oracle_env": "env-oracle",
  "h6-loop/oracle_loop": "loop-oracle",
  "h7-threadpool/oracle_threadpool": "threadpool-oracle",
};

/* Paths are relative to refactor-task/oracle-hard/. */
const ORACLES = [
  "h1-error/oracle_error",
  "h2-fdhash/oracle_fd_hash",
  "h3-timer/oracle_timer",
  "h4-walk/oracle_walk",
  "h5-env/oracle_env",
  "h6-loop/oracle_loop",
  "h7-threadpool/oracle_threadpool",
];

const ORACLE_LINK_ARGS = [
  "-lpsapi", "-luser32", "-ladvapi32", "-liphlpapi", "-luserenv",
  "-lws2_32", "-ldbghelp", "-lole32", "-lshell32",
];

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
  await ctx.validator.assertFile("build/uv_run_tests_a.exe", "libuv static test runner");
  await ctx.validator.assertFile("build/libuv.a", "libuv static library");

  // Layer 0: judgement material.
  const oracleSnapshot = await ctx.fs.snapshot("refactor-task/oracle-hard");
  const oracleActual = canonical(oracleSnapshot);
  ctx.expect(
    "oracle.sources.digest",
    "both-matches",
    oracleActual,
    "^" + pinnedCanonical("refactor-task/oracle-hard/", ORACLE_PINS),
  );
  ctx.expect("oracle.sources.snapshot", oracleActual);

  for (const file of Object.keys(UPSTREAM_PINS).sort()) {
    const actual = canonical(await ctx.fs.snapshot(file));
    ctx.expect(file + ".digest", "both-matches", actual, "^" + file + "=" + UPSTREAM_PINS[file]);
    ctx.expect(file + ".snapshot", actual);
  }

  const compiledOracles = [];
  for (const oracle of ORACLES) {
    const compiled = await ctx.process.run({
      program: "gcc",
      args: [
        "-O0", "-g",
        "-I", ".", "-I", "include", "-I", "src", "-I", "refactor-task/oracle-hard",
        "refactor-task/oracle-hard/" + oracle + ".c",
        "build/libuv.a",
        "-o", "build/" + oracle.split("/").join("-") + ".exe",
      ].concat(ORACLE_LINK_ARGS),
      cwd: ".",
      timeoutMs: 120000,
    });
    compiledOracles.push(compiled);
    const ok = compiled.status === "exited" && compiled.exitCode === 0;
    ctx.expect(oracle + ".compile", "both-matches", ok ? "0" : outcome(compiled), "^0");
  }

  for (const name of UPSTREAM_CASES) {
    const run = await ctx.process.run({
      program: "build/uv_run_tests_a.exe",
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
    const exe = "build/" + oracle.split("/").join("-") + ".exe";
    if (compiled.status !== "exited" || compiled.exitCode !== 0) {
      const failure = "oracle-not-built: " + outcome(compiled);
      ctx.expect(oracle + ".exit", "both-matches", failure, "^0");
      ctx.expect(oracle + ".summary", "both-matches", failure, "^" + ORACLE_SUMMARY_NAMES[oracle] + ": total_failures=0");
      ctx.expect(oracle + ".stdout", failure);
      continue;
    }
    const run = await ctx.process.run({
      program: exe,
      args: [],
      cwd: ".",
      timeoutMs: 120000,
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
      upstream_files: Object.keys(UPSTREAM_PINS).length,
      upstream_cases: UPSTREAM_CASES.length,
      oracles: ORACLES.length,
    },
  };
};
