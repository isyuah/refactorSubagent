/* oracle_inet.c — behavior oracle for uv_inet_ntop / uv_inet_pton (src/inet.c).
 *
 * Why this oracle exists: the shipped cases (`ip4_addr`, `ip6_pton`,
 * `ip6_sin6_len`, `ip_name`) pin AF_INET formatting and v6 parsing but never
 * render an IPv6 address through uv_inet_ntop, so the whole v6 formatting path
 * — single-zero-group suppression, v4-mapped rendering, the short-buffer rule —
 * has no coverage. Measurements on the pinned checkout:
 *   - a single zero group is NOT compressed: 2001:db8:0:1:1:1:1:1
 *   - two or more zero groups are:            2001:db8::1 / ::
 *   - the rule is size >= strlen(rendered) + 1, otherwise UV_ENOSPC and the
 *     destination buffer is left completely untouched (no partial write)
 *
 * Frozen against: libuv v1.52.1 (commit 1cfa32f), Windows 11 x64, MinGW GCC 15.2.
 */
#include <stdio.h>
#include <string.h>
#include "uv.h"
#include "oracle_common.h"

#define ORACLE "inet-oracle"
#define UNTOUCHED '#'

static const unsigned char V6_PLAIN[16] = {0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 1,
                                           0, 1, 0, 1, 0, 1, 0, 1};
static const unsigned char V6_MULTI[16] = {0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0,
                                           0, 0, 0, 0, 0, 0, 0, 1};
static const unsigned char V6_MAPPED[16] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff,
                                            0xff, 1, 2, 3, 4};
static const unsigned char V6_LOOP[16] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                                          0, 0, 0, 1};
static const unsigned char V6_ZERO[16] = {0};
static const unsigned char V4[4] = {1, 2, 3, 4};

static void ntop6_case(const char* name, const unsigned char* addr, size_t size,
                       int expected_rc, const char* expected_out) {
  char out[64];
  int rc;
  memset(out, UNTOUCHED, sizeof(out));
  out[sizeof(out) - 1] = '\0';
  rc = uv_inet_ntop(AF_INET6, addr, out, size);
  check_int(ORACLE, name, expected_rc, rc);
  if (expected_out == NULL) {
    /* Failure must not modify the destination at all. */
    check_int(ORACLE, name, UNTOUCHED, (unsigned char) out[0]);
  } else {
    check_str(ORACLE, name, expected_out, out);
  }
}

int main(void) {
  char out[64];
  int rc;

  check_int(ORACLE, "enospec-value", -4055, (long) UV_ENOSPC);
  check_int(ORACLE, "eafnosupport-value", -4089, (long) UV_EAFNOSUPPORT);
  check_int(ORACLE, "einval-value", -4071, (long) UV_EINVAL);

  /* IPv6 rendering (len("2001:db8:0:1:1:1:1:1") == 20). */
  ntop6_case("ntop6-plain", V6_PLAIN, sizeof(out), 0,
             "2001:db8:0:1:1:1:1:1");
  ntop6_case("ntop6-multi-zero", V6_MULTI, sizeof(out), 0, "2001:db8::1");
  ntop6_case("ntop6-v4-mapped", V6_MAPPED, sizeof(out), 0, "::ffff:1.2.3.4");
  ntop6_case("ntop6-loopback", V6_LOOP, sizeof(out), 0, "::1");
  ntop6_case("ntop6-all-zero", V6_ZERO, sizeof(out), 0, "::");

  /* Boundary: size == len -> ENOSPC and untouched; size == len + 1 -> ok. */
  ntop6_case("ntop6-multi-zero-short", V6_MULTI, 11, (int) UV_ENOSPC, NULL);
  ntop6_case("ntop6-multi-zero-exact", V6_MULTI, 12, 0, "2001:db8::1");
  ntop6_case("ntop6-plain-short", V6_PLAIN, 20, (int) UV_ENOSPC, NULL);
  ntop6_case("ntop6-plain-exact", V6_PLAIN, 21, 0, "2001:db8:0:1:1:1:1:1");
  ntop6_case("ntop6-loopback-short", V6_LOOP, 3, (int) UV_ENOSPC, NULL);
  ntop6_case("ntop6-loopback-exact", V6_LOOP, 4, 0, "::1");

  /* IPv4 rendering (len("1.2.3.4") == 7). */
  memset(out, UNTOUCHED, sizeof(out));
  out[sizeof(out) - 1] = '\0';
  rc = uv_inet_ntop(AF_INET, V4, out, 8);
  check_int(ORACLE, "ntop4-exact", 0, rc);
  check_str(ORACLE, "ntop4-exact", "1.2.3.4", out);

  memset(out, UNTOUCHED, sizeof(out));
  out[sizeof(out) - 1] = '\0';
  rc = uv_inet_ntop(AF_INET, V4, out, 7);
  check_int(ORACLE, "ntop4-short", (int) UV_ENOSPC, rc);
  check_int(ORACLE, "ntop4-short-untouched", UNTOUCHED, (unsigned char) out[0]);

  /* Unsupported family, both directions. */
  memset(out, UNTOUCHED, sizeof(out));
  check_int(ORACLE, "ntop-unsupported-family", (int) UV_EAFNOSUPPORT,
            uv_inet_ntop(AF_UNIX, V4, out, sizeof(out)));

  /* Parsing. */
  {
    unsigned char dst[16];

    memset(dst, 0xEE, sizeof(dst));
    check_int(ORACLE, "pton4-ok", 0, uv_inet_pton(AF_INET, "1.2.3.4", dst));
    check_int(ORACLE, "pton4-bytes", 0,
              memcmp(dst, "\x01\x02\x03\x04", 4));

    memset(dst, 0xEE, sizeof(dst));
    check_int(ORACLE, "pton6-ok", 0, uv_inet_pton(AF_INET6, "::1", dst));
    check_int(ORACLE, "pton6-last-byte", 1, (int) dst[15]);
    check_int(ORACLE, "pton6-first-byte-untouched", 0, (int) dst[0]);

    /* The zone suffix is stripped before parsing and never validated. */
    memset(dst, 0xEE, sizeof(dst));
    check_int(ORACLE, "pton6-zone-ok", 0,
              uv_inet_pton(AF_INET6, "fe80::1%7", dst));
    check_int(ORACLE, "pton6-zone-first-byte", 0xFE, (int) dst[0]);
    check_int(ORACLE, "pton6-zone-last-byte", 1, (int) dst[15]);

    /* Full 39-character form is accepted. */
    memset(dst, 0xEE, sizeof(dst));
    check_int(ORACLE, "pton6-full-form-ok", 0,
              uv_inet_pton(AF_INET6, "2001:0db8:0000:0000:0000:0000:0000:1", dst));

    check_int(ORACLE, "pton4-trailing-dot", (int) UV_EINVAL,
              uv_inet_pton(AF_INET, "1.2.3.4.", dst));
    check_int(ORACLE, "pton4-short", (int) UV_EINVAL,
              uv_inet_pton(AF_INET, "1.2.3", dst));
    check_int(ORACLE, "pton4-overflow", (int) UV_EINVAL,
              uv_inet_pton(AF_INET, "1.2.3.256", dst));
    check_int(ORACLE, "pton4-empty-element", (int) UV_EINVAL,
              uv_inet_pton(AF_INET, "1..2.3", dst));
    check_int(ORACLE, "pton6-double-compression", (int) UV_EINVAL,
              uv_inet_pton(AF_INET6, "1::2::3", dst));
    check_int(ORACLE, "pton6-oversized-group", (int) UV_EINVAL,
              uv_inet_pton(AF_INET6, "12345::1", dst));
    check_int(ORACLE, "pton-null-src", (int) UV_EINVAL,
              uv_inet_pton(AF_INET, NULL, dst));
    check_int(ORACLE, "pton-null-dst", (int) UV_EINVAL,
              uv_inet_pton(AF_INET, "1.2.3.4", NULL));
    check_int(ORACLE, "pton-unsupported-family", (int) UV_EAFNOSUPPORT,
              uv_inet_pton(9999, "1.2.3.4", dst));
  }

  return oracle_summary(ORACLE);
}
