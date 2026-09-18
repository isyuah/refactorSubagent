export const workflowKind = "test-workflow-driven";

/*
 * libuv v1.52.1 behavior-preserving refactor task — judgement workflow.
 *
 * The host runs this source once per worktree (baseline, then candidate) and
 * pairs the declarations below BY POSITION, comparing each pair with the
 * declared relation. Two layers, both required:
 *
 *   A. the 14 upstream cases of the shipped runner (`uv_run_tests_a.exe <case>`)
 *   B. 6 oracles linked against build/libuv.a (174 checks), covering what the
 *      shipped suite is structurally blind to: empty/trailing tokens in
 *      uv__strtok, the whole AF_INET6 rendering path of uv_inet_ntop, the
 *      uv_err_name/uv_strerror family, six getters, uv_version*.
 *
 * The pins live in THIS source, not in refactor-task/PINS.json: the worktree
 * copy of PINS.json is candidate-writable, this source is not (the host
 * resolves it from the base repository). Edits to a pinned file change the
 * verdict while every TAP line stays green — the digests are the only
 * detector.
 *
 * Declaration count and order are identical on both sides: everything that
 * can fail hard (missing artifacts) throws before the first declaration, and
 * everything after that degrades into a declared value instead of an early
 * return.
 */

const ORACLE_PINS = {
  "oracle_common.h": "248fd65783b637720934818acb25f72d13465bc45cc6847409c4dc0866e1e951",
  "oracle_errstr.c": "d8763d48d227c4c2038d3fc8a9851f32caeb5b4ad88e10109da70b23cae3e0c2",
  "oracle_getters.c": "412777db8b958f6757bbfc06ac7b734b15fb36c3366a744e8fa86d76aa3fc093",
  "oracle_inet.c": "e7ce49e41c7f1d29e2a381aa1ae6afacb720a4e70adfc06c6a7be7474bbcb5c7",
  "oracle_strscpy.c": "bbc7e16eddb71da526530f0c831b164b32879dbc693bd260d8ebe27b084cd639",
  "oracle_strtok.c": "b781ef0b6fbb18b36195936ab98f5298479312b828a4668859bef118200561e8",
  "oracle_version.c": "65540f59f9eb6451d1f964c9807f29eccfd1da2a090bc59dcd934bc036141732",
}

const UPSTREAM_PINS = {
  "test/run-tests.c": "088c0025f897eea64e1530a54d7cae819099f14ecadbc31b90492aa10fdce89d",
  "test/runner-win.c": "0edf790dcebe3c8a36778b4d864ad437da6a9567421079c589222075c23f928a",
  "test/runner.c": "16b58ebd3bf00a014c8d078712498d5996ff0a3017f64cb79f348e938d08ad2c",
  "test/task.h": "4e987e7f1127d5ec1ad26a98dd17f4dd5635031f4c9faaf449f60bd25ade2707",
  "test/test-gethostname.c": "1fd741eed28f2cb9765792516f790d08637554c43dd696a715e048715b0a883c",
  "test/test-getters-setters.c": "df3365b98af72f1eb270ed296a8c5d57028c0d04d3896c9dfee41e38c46f74db",
  "test/test-idna.c": "63ea3c66af38f8db40216e26236180fe57ad0953586cd53dbd10659d804e296f",
  "test/test-ip-name.c": "c03bf33fb34c535546e77e71e85bbb93d9644a4786a91c84f0f2f0f3053e906f",
  "test/test-ip4-addr.c": "514f94186ce83ad1f1d4e6cdd0de364583c973f2a01798b2b888e76434fc08ce",
  "test/test-ip6-addr.c": "03578f4a89763750d36cb8acf8e6e43c2da95ef99a6dc4ff361efe24a2d62d8d",
  "test/test-list.h": "b9dff249f9871ade6ded915df8afe2ff359069355be42b0e26c48400e9d0062b",
  "test/test-queue-foreach-delete.c": "2f233ffee05d5f8a1dae19e43625788dfbc47a411c6be87f6fa8f8a0c5d6633d",
  "test/test-strscpy.c": "43b0aeae5b5935dcd26ce6eb732c7e391058818af074cafd255f984c95e45207",
  "test/test-strtok.c": "02532c1bc1ea15842405b7100743f0d4be41918af7674c005288d11bea22275e",
  "test/test-uname.c": "972f0c2644f1a5c7508daee2f50614ce2f03ee12ef38632da1e0f737ce1641ba",
}

/* Cases whose verdict is one deterministic TAP line, measured 0.44-0.52 s. */
const UPSTREAM_CASES = [
  "strscpy",
  "strtok",
  "utf8_decode1",
  "utf8_decode1_overrun",
  "wtf8",
  "idna_toascii",
  "ip4_addr",
  "ip6_pton",
  "ip6_sin6_len",
  "ip_name",
  "uname",
  "gethostname",
  "getters_setters",
  "queue_foreach_delete",
];

/* Each oracle prints its own summary name (`<name>: total_failures=N`). */
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

/* One deterministic line describing a finished process, for failure text. */
function outcome(result) {
  const detail = tail(result.stderr || result.stdout || result.error || "", 300);
  return result.status + " exit=" + String(result.exitCode) + (detail.length > 0 ? " :: " + detail : "");
}

export default async (ctx) => {
  // Fail-closed before any declaration: a missing artifact aborts the run
  // instead of producing a half-declared comparison.
  await ctx.validator.assertFile("build/uv_run_tests_a.exe", "libuv static test runner");
  await ctx.validator.assertFile("build/libuv.a", "libuv static library");

  // Layer 0: judgement material. A candidate that "tidies up" an oracle or
  // weakens an upstream assertion keeps every TAP line green; these digests
  // are the only thing that notices.
  const oracleSnapshot = await ctx.fs.snapshot("refactor-task/oracle");
  const oracleActual = canonical(oracleSnapshot);
  ctx.expect(
    "oracle.sources.digest",
    "both-matches",
    oracleActual,
    "^" + pinnedCanonical("refactor-task/oracle/", ORACLE_PINS),
  );
  ctx.expect("oracle.sources.snapshot", oracleActual);

  for (const file of Object.keys(UPSTREAM_PINS).sort()) {
    const actual = canonical(await ctx.fs.snapshot(file));
    ctx.expect(file + ".digest", "both-matches", actual, "^" + file + "=" + UPSTREAM_PINS[file]);
    ctx.expect(file + ".snapshot", actual);
  }

  // Layer B compiles first: a candidate that renames an internal symbol an
  // oracle binds to must show up as a declared, compared value — not as an
  // exception that would skip the remaining declarations.
  const compiledOracles = [];
  for (const oracle of ORACLES) {
    const compiled = await ctx.process.run({
      program: "gcc",
      args: [
        "-O0", "-g",
        "-I", ".", "-I", "include", "-I", "src", "-I", "refactor-task/oracle",
        "refactor-task/oracle/" + oracle + ".c",
        "build/libuv.a",
        "-o", "build/" + oracle + ".exe",
      ].concat(ORACLE_LINK_ARGS),
      cwd: ".",
      timeoutMs: 120000,
    });
    compiledOracles.push(compiled);
    const ok = compiled.status === "exited" && compiled.exitCode === 0;
    ctx.expect(oracle + ".compile", "both-matches", ok ? "0" : outcome(compiled), "^0");
  }

  // Layer A: the shipped runner, one case per process (no filter exists).
  for (const name of UPSTREAM_CASES) {
    const run = await ctx.process.run({
      program: "build/uv_run_tests_a.exe",
      args: [name],
      cwd: ".",
      timeoutMs: 60000,
    });
    const stdout = run.stdout.trim();
    // exit ^0 catches both ASSERT failures (3) and SKIP (7): no case in this
    // list may skip on a correct host.
    ctx.expect(name + ".exit", "both-matches", String(run.exitCode), "^0");
    ctx.expect(name + ".tap", "both-matches", stdout, "^ok 1 - " + name);
    ctx.expect(name + ".stdout", stdout);
  }

  // Layer B: run the oracles, one process each.
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
      program: "build/" + oracle + ".exe",
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
      upstream_files: Object.keys(UPSTREAM_PINS).length,
      upstream_cases: UPSTREAM_CASES.length,
      oracles: ORACLES.length,
      oracle_source_digest: oracleActual,
    },
  };
};
