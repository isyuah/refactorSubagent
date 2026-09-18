export const workflowKind = "workflow-driven";

/*
 * libuv v1.52.1 — build the statically linked test runner.
 *
 * Measured facts this source encodes (Windows 11 x64, GCC 15.2, CMake 4.3.1,
 * Ninja 1.13.2), all established by running the build, not by guessing:
 *
 *   - GCC 15 turns -Wincompatible-pointer-types into an error and uv 1.52.1
 *     trips it at src/win/util.c:630 (uv__convert_utf16_to_utf8 takes char**,
 *     the call passes const char**), with -Wdiscarded-qualifiers at :644.
 *     Without those two -Wno-error flags the build dies inside uv_a and the
 *     whole run aborts, so they are part of the task definition.
 *   - LIBUV_BUILD_TESTS needs LIBUV_BUILD_SHARED=ON (CMakeLists.txt:30-32).
 *   - The static runner (uv_run_tests_a) links uv_a and needs no uv.dll next
 *     to it, unlike uv_run_tests.exe.
 *   - A full -j 8 build measured 32 s; the target build is idempotent.
 *
 * Both declared artifacts must exist afterwards: the verification stage treats
 * a missing artifact as a build failure and never reaches a verdict.
 */
export default async (ctx) => {
  const required = ["cmake", "ninja", "gcc"];
  const unavailable = [];
  for (const tool of required) {
    if (!(await ctx.tools.available(tool))) unavailable.push(tool);
  }
  if (unavailable.length > 0) {
    throw new Error("required build tools are unavailable: " + unavailable.join(", "));
  }

  const configure = await ctx.process.run({
    program: "cmake",
    args: [
      "-S", ".",
      "-B", "build",
      "-G", "Ninja",
      "-DCMAKE_BUILD_TYPE=Debug",
      "-DBUILD_TESTING=ON",
      "-DCMAKE_C_FLAGS=-Wno-error=incompatible-pointer-types -Wno-error=discarded-qualifiers",
    ],
    cwd: ".",
    timeoutMs: 300000,
  });
  if (configure.status !== "exited" || configure.exitCode !== 0) {
    throw new Error(
      "cmake configure failed: " + configure.status + " exit=" + String(configure.exitCode) +
      " :: " + (configure.stderr || configure.stdout || configure.error || "").trim().slice(-1500),
    );
  }

  const compile = async () => await ctx.process.run({
    program: "cmake",
    args: ["--build", "build", "--target", "uv_run_tests_a", "-j", "8"],
    cwd: ".",
    timeoutMs: 900000,
  });

  const built = await compile();
  if (built.status !== "exited" || built.exitCode !== 0) {
    throw new Error(
      "cmake build failed: " + built.status + " exit=" + String(built.exitCode) +
      " :: " + (built.stderr || built.stdout || built.error || "").trim().slice(-1500),
    );
  }

  // Observed hazard: the linked runner disappeared once within a minute of a
  // successful build (external tooling). Re-running the target is idempotent
  // and costs about a second when everything is up to date.
  if (!(await ctx.fs.exists("build/uv_run_tests_a.exe"))) {
    const rebuilt = await compile();
    if (rebuilt.status !== "exited" || rebuilt.exitCode !== 0) {
      throw new Error("cmake rebuild failed: " + (rebuilt.stderr || rebuilt.stdout || "").trim().slice(-1000));
    }
  }

  await ctx.validator.assertFile("build/uv_run_tests_a.exe", "libuv static test runner");
  await ctx.validator.assertFile("build/libuv.a", "libuv static library");
};
