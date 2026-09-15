/* oracle_common.h — shared reporting helpers for the libuv behavior oracles.
 *
 * Contract:
 *   - every case prints exactly one deterministic line: "<oracle>: <case> ok"
 *     or "<oracle>: <case> FAIL expected=... got=..."
 *   - main() returns the number of failed cases (0 = oracle passed)
 *   - no timings, pointers, or addresses are ever printed
 */
#ifndef LIBUV_ORACLE_COMMON_H
#define LIBUV_ORACLE_COMMON_H

#include <stdio.h>
#include <string.h>

static int oracle_failures;

static void oracle_ok(const char* oracle, const char* name) {
  printf("%s: %s ok\n", oracle, name);
}

static void oracle_fail_str(const char* oracle, const char* name,
                            const char* expected, const char* got) {
  oracle_failures++;
  printf("%s: %s FAIL expected=\"%s\" got=\"%s\"\n",
         oracle, name, expected == NULL ? "(null)" : expected,
         got == NULL ? "(null)" : got);
}

static void oracle_fail_int(const char* oracle, const char* name,
                            long expected, long got) {
  oracle_failures++;
  printf("%s: %s FAIL expected=%ld got=%ld\n", oracle, name, expected, got);
}

static void check_str(const char* oracle, const char* name,
                      const char* expected, const char* got) {
  if (got == NULL || strcmp(expected, got) != 0)
    oracle_fail_str(oracle, name, expected, got);
  else
    oracle_ok(oracle, name);
}

static void check_int(const char* oracle, const char* name,
                      long expected, long got) {
  if (expected != got)
    oracle_fail_int(oracle, name, expected, got);
  else
    oracle_ok(oracle, name);
}

/* Bounded append used to build deterministic token transcripts. */
static void app(char* out, size_t outlen, const char* s) {
  size_t used = strlen(out);
  size_t room = outlen > used + 1 ? outlen - used - 1 : 0;
  if (room > 0) strncat(out, s, room);
}

static int oracle_summary(const char* oracle) {
  printf("%s: total_failures=%d\n", oracle, oracle_failures);
  return oracle_failures;
}

#endif /* LIBUV_ORACLE_COMMON_H */
