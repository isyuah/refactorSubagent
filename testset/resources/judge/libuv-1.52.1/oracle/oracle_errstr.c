/* oracle_errstr.c — behavior oracle for the uv_err_name / uv_strerror family
 * (src/uv-common.c:198-250).
 *
 * Why this oracle exists: test/test-error.c:49-58 is the ONLY place in the
 * shipped suite that asserts these functions, and it is unreachable — its guard
 * compares uv_strerror(0) against "Success", but uv_strerror(0) is
 * "Unknown system error 0", so the case prints "i18n error messages detected,
 * skipping test." and returns 0 (TEST_SKIP-adjacent path). Nothing else pins
 * these strings, their truncation rule, or the buffer-return contract on the
 * _r variants. The cluster is also the only place where uv__strscpy's
 * truncation semantics are user-visible (uv-common.c:210).
 *
 * Frozen against: libuv v1.52.1 (commit 1cfa32f), Windows 11 x64, MinGW GCC 15.2.
 *
 * Pinned semantics (must NOT change):
 *   - uv_err_name/uv_strerror return the UV_ERRNO_MAP name/message verbatim
 *   - unknown codes return a heap string "Unknown system error <n>" (the caller
 *     owns that allocation — the apparent leak is intentional)
 *   - uv_err_name_r/uv_strerror_r always return the buffer they were given and
 *     NUL-terminate, truncating to n-1 bytes
 */
#include <stdio.h>
#include <string.h>
#include "uv.h"
#include "oracle_common.h"

#define ORACLE "errstr-oracle"

int main(void) {
  char buf[32];
  char small[4];
  char tiny[2];
  char* ret;

  /* Known codes. */
  check_str(ORACLE, "err-name-einval", "EINVAL", uv_err_name(UV_EINVAL));
  check_str(ORACLE, "strerror-einval", "invalid argument", uv_strerror(UV_EINVAL));
  check_str(ORACLE, "err-name-enoent", "ENOENT", uv_err_name(UV_ENOENT));
  check_str(ORACLE, "strerror-enoent", "no such file or directory",
            uv_strerror(UV_ENOENT));
  check_str(ORACLE, "err-name-e2big", "E2BIG", uv_err_name(UV_E2BIG));
  check_str(ORACLE, "strerror-eacces", "permission denied",
            uv_strerror(UV_EACCES));

  /* Code 0 and out-of-range codes fall through to the unknown-code path. */
  check_str(ORACLE, "strerror-zero", "Unknown system error 0", uv_strerror(0));
  check_str(ORACLE, "err-name-zero", "Unknown system error 0", uv_err_name(0));
  check_str(ORACLE, "strerror-unknown", "Unknown system error 1337",
            uv_strerror(1337));
  check_str(ORACLE, "err-name-unknown", "Unknown system error 1337",
            uv_err_name(1337));
  check_str(ORACLE, "strerror-negative-unknown", "Unknown system error -9999",
            uv_strerror(-9999));

  /* _r variants: the buffer is returned and always NUL-terminated. */
  memset(buf, 0x55, sizeof(buf));
  ret = uv_err_name_r(UV_EINVAL, buf, sizeof(buf));
  check_int(ORACLE, "err-name-r-returns-buf", 1, ret == buf);
  check_str(ORACLE, "err-name-r-content", "EINVAL", buf);

  memset(buf, 0x55, sizeof(buf));
  ret = uv_strerror_r(UV_ENOENT, buf, sizeof(buf));
  check_int(ORACLE, "strerror-r-returns-buf", 1, ret == buf);
  check_str(ORACLE, "strerror-r-content", "no such file or directory", buf);

  /* Truncation: n-1 characters plus NUL, for both table and unknown paths. */
  memset(small, 0x55, sizeof(small));
  ret = uv_strerror_r(UV_EINVAL, small, sizeof(small));
  check_int(ORACLE, "strerror-r-small-returns-buf", 1, ret == small);
  check_str(ORACLE, "strerror-r-small-content", "inv", small);
  check_int(ORACLE, "strerror-r-small-nul", 0, (unsigned char) small[3]);

  memset(tiny, 0x55, sizeof(tiny));
  ret = uv_err_name_r(UV_EINVAL, tiny, sizeof(tiny));
  check_int(ORACLE, "err-name-r-tiny-returns-buf", 1, ret == tiny);
  check_str(ORACLE, "err-name-r-tiny-content", "E", tiny);

  memset(small, 0x55, sizeof(small));
  ret = uv_strerror_r(1337, small, sizeof(small));
  check_int(ORACLE, "strerror-r-unknown-returns-buf", 1, ret == small);
  check_str(ORACLE, "strerror-r-unknown-content", "Unk", small);

  /* n == 1 leaves an empty but terminated buffer. */
  {
    char one[1];
    one[0] = 0x55;
    ret = uv_err_name_r(UV_EINVAL, one, 1);
    check_int(ORACLE, "err-name-r-n1-returns-buf", 1, ret == one);
    check_int(ORACLE, "err-name-r-n1-terminated", 0, (unsigned char) one[0]);
  }

  return oracle_summary(ORACLE);
}
