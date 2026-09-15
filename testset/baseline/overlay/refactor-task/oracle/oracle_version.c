/* oracle_version.c — behavior oracle for src/version.c.
 *
 * Why this oracle exists: no case in the shipped suite calls uv_version() or
 * uv_version_string() — a search for `uv_version` under test/ returns nothing.
 * A refactor of version.c therefore has zero signal from the stock suite.
 *
 * Frozen against: libuv v1.52.1 (commit 1cfa32f), Windows 11 x64, MinGW GCC 15.2.
 *
 * Pinned semantics: uv_version() == UV_VERSION_HEX (0x00013401 for 1.52.1) and
 * uv_version_string() == "1.52.1" — both must track include/uv/version.h.
 */
#include <stdio.h>
#include <string.h>
#include "uv.h"
#include "oracle_common.h"

#define ORACLE "version-oracle"

#ifndef UV_VERSION_HEX
#error "UV_VERSION_HEX is missing from include/uv/version.h"
#endif

int main(void) {
  check_int(ORACLE, "version-hex-literal", 0x00013401L, (long) uv_version());
  check_int(ORACLE, "version-hex-macro", (long) UV_VERSION_HEX, (long) uv_version());
  check_str(ORACLE, "version-string", "1.52.1", uv_version_string());

  /* The string must be derived from the macro triple, not from a literal that
   * drifted: MAJOR.MINOR.PATCH. */
  {
    char expected[32];
    snprintf(expected, sizeof(expected), "%d.%d.%d",
             UV_VERSION_MAJOR, UV_VERSION_MINOR, UV_VERSION_PATCH);
    check_str(ORACLE, "version-string-consistent", expected, uv_version_string());
  }

  /* Both functions are pure: repeated calls return identical values. */
  check_int(ORACLE, "version-stable", (long) uv_version(), (long) uv_version());
  check_int(ORACLE, "version-string-stable", 1,
            uv_version_string() == uv_version_string());

  return oracle_summary(ORACLE);
}
