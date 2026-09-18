/* oracle_strscpy.c — behavior oracle for `uv__strscpy` (src/strscpy.c).
 *
 * Why this oracle exists: the shipped case `strscpy` (test/test-strscpy.c:29-55)
 * never exercises n == 1, never checks bytes past the written region, and never
 * checks aliasing (d == s). It also compiles ../src/strscpy.c into the test TU,
 * so the copy inside libuv.a (the one every real caller links) is untested.
 * uv__strscpy has 16 call sites compiled on Windows (src/inet.c:57,141,
 * src/uv-common.c:210, src/win/util.c:1659-1714, src/win/thread.c:360).
 *
 * Frozen against: libuv v1.52.1 (commit 1cfa32f), Windows 11 x64, MinGW GCC 15.2.
 *
 * Pinned semantics (must NOT change):
 *   n == 0            -> returns 0 and writes NOTHING
 *   fits              -> returns strlen(s), writes s plus NUL
 *   does not fit      -> writes exactly n-1 bytes of s, terminates d[n-1] = 0,
 *                        returns UV_E2BIG (-4093)
 *   bytes beyond the written region are never touched
 */
#include <stdio.h>
#include <string.h>
#include "uv.h"
#include "strscpy.h"
#include "oracle_common.h"

#define ORACLE "strscpy-oracle"
#define UNTOUCHED 0xAA

int main(void) {
  char d[8];
  ssize_t r;

  /* The return code for truncation is part of the observable contract. */
  check_int(ORACLE, "uv-e2big-value", -4093, (long) UV_E2BIG);

  /* n == 0: no write at all, returns 0 (NOT UV_E2BIG). */
  memset(d, UNTOUCHED, sizeof(d));
  r = uv__strscpy(d, "x", 0);
  check_int(ORACLE, "n0-return", 0, (long) r);
  check_int(ORACLE, "n0-no-write", UNTOUCHED, (unsigned char) d[0]);

  /* n == 1: one byte of room is not enough for "x" + NUL -> E2BIG, d[0] = 0. */
  memset(d, UNTOUCHED, sizeof(d));
  r = uv__strscpy(d, "x", 1);
  check_int(ORACLE, "n1-return", -4093, (long) r);
  check_int(ORACLE, "n1-terminated", 0, (unsigned char) d[0]);
  check_int(ORACLE, "n1-tail-untouched", UNTOUCHED, (unsigned char) d[1]);

  /* n == 1 with an empty source: the NUL fits. */
  memset(d, UNTOUCHED, sizeof(d));
  r = uv__strscpy(d, "", 1);
  check_int(ORACLE, "n1-empty-return", 0, (long) r);
  check_int(ORACLE, "n1-empty-terminated", 0, (unsigned char) d[0]);

  /* Exact fit: "xyz" in 4 bytes. */
  memset(d, UNTOUCHED, sizeof(d));
  r = uv__strscpy(d, "xyz", 4);
  check_int(ORACLE, "exact-fit-return", 3, (long) r);
  check_int(ORACLE, "exact-fit-bytes", 0, memcmp(d, "xyz", 4));
  check_int(ORACLE, "exact-fit-tail-untouched", UNTOUCHED, (unsigned char) d[4]);

  /* Larger buffer: "xyz" in 8 bytes, tail untouched. */
  memset(d, UNTOUCHED, sizeof(d));
  r = uv__strscpy(d, "xyz", sizeof(d));
  check_int(ORACLE, "roomy-return", 3, (long) r);
  check_int(ORACLE, "roomy-bytes", 0, memcmp(d, "xyz\0", 4));
  check_int(ORACLE, "roomy-tail-untouched", UNTOUCHED, (unsigned char) d[4]);

  /* Truncation into 4 bytes: exactly 3 bytes of source + NUL. */
  memset(d, UNTOUCHED, sizeof(d));
  r = uv__strscpy(d, "abcdefghij", 4);
  check_int(ORACLE, "truncate-return", -4093, (long) r);
  check_int(ORACLE, "truncate-bytes", 0, memcmp(d, "abc\0", 4));
  check_int(ORACLE, "truncate-tail-untouched", UNTOUCHED, (unsigned char) d[4]);

  /* n == 2 truncation keeps a single character. */
  memset(d, UNTOUCHED, sizeof(d));
  r = uv__strscpy(d, "xy", 2);
  check_int(ORACLE, "n2-truncate-return", -4093, (long) r);
  check_int(ORACLE, "n2-truncate-bytes", 0, memcmp(d, "x\0", 2));

  /* Aliasing: d == s must not corrupt the result. */
  {
    char alias[8] = "abc";
    r = uv__strscpy(alias, alias, sizeof(alias));
    check_int(ORACLE, "alias-return", 3, (long) r);
    check_int(ORACLE, "alias-bytes", 0, memcmp(alias, "abc\0", 4));
  }

  /* The n == 0 early return must also hold for an empty source. */
  memset(d, UNTOUCHED, sizeof(d));
  r = uv__strscpy(d, "", 0);
  check_int(ORACLE, "n0-empty-return", 0, (long) r);
  check_int(ORACLE, "n0-empty-no-write", UNTOUCHED, (unsigned char) d[0]);

  return oracle_summary(ORACLE);
}
