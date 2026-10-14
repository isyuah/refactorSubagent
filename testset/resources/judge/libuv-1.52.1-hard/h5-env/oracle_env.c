/* oracle_env.c — behavior oracle for the Windows environment-variable family
 * and the UTF-16 <-> UTF-8 conversion helpers of libuv v1.52.1.
 *
 * Why this oracle exists: the upstream case `env_vars` (test/test-env-vars.c)
 * only probes `*size` at one boundary, never inspects the bytes past the
 * written prefix, never observes the name/value allocation sharing that
 * `uv_os_free_environ()` (src/uv-common.c, a different translation unit) has
 * to honour, and never touches the conversion helpers directly. This oracle
 * is a separate process that drives the real API surface behind
 * uv_os_getenv/uv_os_setenv/uv_os_unsetenv/uv_os_environ/uv_os_free_environ
 * plus the internal helpers uv__convert_utf16_to_utf8()/
 * uv__copy_utf16_to_utf8()/uv__convert_utf8_to_utf16().
 *
 * Frozen against: libuv v1.52.1 (commit 1cfa32f), Windows 11 x64,
 * MinGW GCC 15.2. Deterministic, no network, no timing dependence.
 *
 * Pinned semantics (must NOT change):
 *   getenv success        -> *size = strlen(value) (NUL excluded)
 *   getenv UV_ENOBUFS     -> *size = required length INCLUDING the NUL
 *   getenv writes exactly min(*size, len) bytes: the prefix plus a NUL at
 *                            index *size_in - 1, never past that
 *   empty value           -> r == 0, *size == 0, only buf[0] becomes NUL
 *   environ entries       -> name and value live in ONE allocation whose base
 *                            is `name`; uv_os_free_environ() frees exactly
 *                            that base once per entry, nothing else, and
 *                            leaks nothing
 *   special "=X:" vars    -> survive the parse with a non-empty name
 *   utf16 -> wtf8         -> BMP, surrogate pairs, lone surrogates, explicit
 *                            lengths and embedded NULs are all preserved
 */
#include <stdio.h>
#include <string.h>
#include "uv.h"
#include "win/internal.h"

#define ORACLE "env-oracle"

#define NAME_A "REFACTOR_ORACLE_A"
#define NAME_B "REFACTOR_ORACLE_B"
#define NAME_MISSING "REFACTOR_ORACLE_MISSING"
#define NAME_SPECIAL "=Z:"
#define SPECIAL_VALUE "\\"
#define VALUE_A "123456789"
#define BIG_N (2 * 32768)
#define UNTOUCHED 0x5A

static int h5_failures;

/* ------------------------------------------------------------------ */
/* Allocation ledger.                                                  */
/*                                                                     */
/* uv_replace_allocator() redirects every libuv allocation through the  */
/* hooks below, so the oracle can observe, without reading any source,  */
/* which pointers libuv is entitled to hand to uv__free():              */
/*   - a pointer that is not an allocation base is an invalid free      */
/*   - a base released twice is a double free                           */
/*   - a base still live after uv_os_free_environ() is a leak           */
/* It also answers "do two pointers live in the same allocation?", which*/
/* is exactly the name/value ownership relation uv_os_free_environ()    */
/* (uv-common.c) relies on when it frees only `name`.                   */
/* ------------------------------------------------------------------ */

#define H5_MAX_BLOCKS 8192

typedef struct {
  unsigned char* base;
  size_t size;
  int live;
} h5_block_t;

static h5_block_t h5_blocks[H5_MAX_BLOCKS];
static int h5_nblocks;
static long h5_live_blocks;
static long h5_bad_frees;
static long h5_double_frees;
static long h5_overflow;

static void h5_record(void* p, size_t n) {
  if (p == NULL)
    return;
  if (h5_nblocks >= H5_MAX_BLOCKS) {
    h5_overflow++;
    return;
  }
  h5_blocks[h5_nblocks].base = p;
  h5_blocks[h5_nblocks].size = n;
  h5_blocks[h5_nblocks].live = 1;
  h5_nblocks++;
  h5_live_blocks++;
}

/* Index of the ledger entry whose base is exactly p.
 * A base may be handed out again after it was released, so a live entry wins;
 * otherwise the (dead) entry is returned so the caller sees the double free. */
static int h5_base_of(void* p) {
  int i;
  int dead;

  dead = -1;
  for (i = 0; i < h5_nblocks; i++) {
    if (h5_blocks[i].base != (unsigned char*) p)
      continue;
    if (h5_blocks[i].live)
      return i;
    dead = i;
  }
  return dead;
}

/* Index of the live ledger entry whose extent contains p (base or interior). */
static int h5_owner_of(void* p) {
  unsigned char* q = p;
  int i;

  for (i = 0; i < h5_nblocks; i++)
    if (h5_blocks[i].live &&
        q >= h5_blocks[i].base &&
        q < h5_blocks[i].base + h5_blocks[i].size)
      return i;
  return -1;
}

static void* h5_malloc(size_t size) {
  void* p = malloc(size);

  h5_record(p, size);
  return p;
}

static void* h5_calloc(size_t count, size_t size) {
  void* p = calloc(count, size);

  h5_record(p, count * size);
  return p;
}

static void* h5_realloc(void* ptr, size_t size) {
  int i;
  void* p;

  if (ptr == NULL)
    return h5_malloc(size);

  i = h5_base_of(ptr);
  if (i < 0) {
    h5_bad_frees++;
    return NULL;
  }

  p = realloc(ptr, size);
  if (p == NULL)
    return NULL;

  h5_blocks[i].base = p;
  h5_blocks[i].size = size;
  return p;
}

static void h5_free(void* ptr) {
  int i;

  if (ptr == NULL)
    return;

  i = h5_base_of(ptr);
  if (i < 0) {
    /* Not an allocation base: freeing it would corrupt the heap, so the
     * ledger records the violation and leaves the heap alone. */
    h5_bad_frees++;
    return;
  }

  if (!h5_blocks[i].live) {
    h5_double_frees++;
    return;
  }

  h5_blocks[i].live = 0;
  h5_live_blocks--;
  free(ptr);
}

/* ------------------------------------------------------------------ */
/* Reporting.                                                          */
/* ------------------------------------------------------------------ */

static void h5_ok(const char* name) {
  printf(ORACLE ": %s ok\n", name);
}

static void h5_fail_int(const char* name, long long expected, long long got) {
  h5_failures++;
  printf(ORACLE ": %s FAIL expected=%lld got=%lld\n", name, expected, got);
}

static void h5_fail_str(const char* name, const char* expected, const char* got) {
  h5_failures++;
  printf(ORACLE ": %s FAIL expected=\"%s\" got=\"%s\"\n", name, expected, got);
}

static void h5_check_int(const char* name, long long expected, long long got) {
  if (expected == got)
    h5_ok(name);
  else
    h5_fail_int(name, expected, got);
}

/* "61 c3 a9" — deterministic, never prints a pointer or a stray byte. */
static const char* h5_hex(const unsigned char* p, size_t n, char* out, size_t outlen) {
  size_t i;
  size_t used = 0;
  int n_written;

  out[0] = '\0';
  for (i = 0; i < n; i++) {
    if (used + 4 >= outlen)
      break;
    n_written = snprintf(out + used, outlen - used, i == 0 ? "%02x" : " %02x", p[i]);
    if (n_written < 0)
      break;
    used += (size_t) n_written;
  }
  return out;
}

static void h5_check_bytes(const char* name,
                           const unsigned char* expected,
                           const unsigned char* got,
                           size_t n) {
  char exp_hex[256];
  char got_hex[256];

  if (memcmp(expected, got, n) == 0) {
    h5_ok(name);
    return;
  }

  h5_fail_str(name,
              h5_hex(expected, n, exp_hex, sizeof(exp_hex)),
              h5_hex(got, n, got_hex, sizeof(got_hex)));
}

/* ------------------------------------------------------------------ */
/* Checks.                                                             */
/* ------------------------------------------------------------------ */

static void check_invalid_arguments(void) {
  char buf[32];
  size_t size;
  int r;

  size = sizeof(buf);
  r = uv_os_getenv(NULL, buf, &size);
  h5_check_int("getenv-reject-null-name", UV_EINVAL, r);

  size = sizeof(buf);
  r = uv_os_getenv(NAME_A, NULL, &size);
  h5_check_int("getenv-reject-null-buffer", UV_EINVAL, r);

  r = uv_os_getenv(NAME_A, buf, NULL);
  h5_check_int("getenv-reject-null-size", UV_EINVAL, r);

  size = 0;
  r = uv_os_getenv(NAME_A, buf, &size);
  h5_check_int("getenv-reject-zero-size", UV_EINVAL, r);

  r = uv_os_setenv(NULL, "value");
  h5_check_int("setenv-reject-null-name", UV_EINVAL, r);

  r = uv_os_setenv(NAME_A, NULL);
  h5_check_int("setenv-reject-null-value", UV_EINVAL, r);

  r = uv_os_setenv(NULL, NULL);
  h5_check_int("setenv-reject-null-both", UV_EINVAL, r);

  r = uv_os_unsetenv(NULL);
  h5_check_int("unsetenv-reject-null-name", UV_EINVAL, r);

  size = sizeof(buf);
  r = uv_os_getenv(NAME_MISSING, buf, &size);
  h5_check_int("getenv-missing-is-enoent", UV_ENOENT, r);

  r = uv_os_unsetenv(NAME_MISSING);
  h5_check_int("unsetenv-missing-is-ok", 0, r);
}

static void check_getenv_size_contract(void) {
  char buf[32];
  unsigned char expected[10];
  size_t size;
  int r;

  r = uv_os_setenv(NAME_A, VALUE_A);
  if (r != 0) {
    h5_fail_int("setenv-fixture-ok", 0, r);
    return;
  }
  h5_ok("setenv-fixture-ok");

  /* Room to spare: *size reports the value length, NUL excluded. */
  memset(buf, UNTOUCHED, sizeof(buf));
  size = sizeof(buf);
  r = uv_os_getenv(NAME_A, buf, &size);
  h5_check_int("getenv-roomy-code", 0, r);
  h5_check_int("getenv-roomy-size-excludes-nul", (long long) strlen(VALUE_A), (long long) size);
  h5_check_bytes("getenv-roomy-bytes",
                 (const unsigned char*) VALUE_A,
                 (const unsigned char*) buf,
                 strlen(VALUE_A));
  h5_check_int("getenv-roomy-terminator", 0, (unsigned char) buf[strlen(VALUE_A)]);
  h5_check_int("getenv-roomy-tail-untouched", UNTOUCHED, (unsigned char) buf[strlen(VALUE_A) + 1]);

  /* Exactly one byte of headroom: the same success contract holds. */
  memset(buf, UNTOUCHED, sizeof(buf));
  size = strlen(VALUE_A) + 1;
  r = uv_os_getenv(NAME_A, buf, &size);
  h5_check_int("getenv-exact-fit-code", 0, r);
  h5_check_int("getenv-exact-fit-size", (long long) strlen(VALUE_A), (long long) size);
  memcpy(expected, VALUE_A, sizeof(expected));
  h5_check_bytes("getenv-exact-fit-bytes-with-terminator", expected, (const unsigned char*) buf, sizeof(expected));

  /* One byte short: UV_ENOBUFS plus *size = needed length INCLUDING the NUL. */
  memset(buf, UNTOUCHED, sizeof(buf));
  size = strlen(VALUE_A);
  r = uv_os_getenv(NAME_A, buf, &size);
  h5_check_int("getenv-enobufs-code", UV_ENOBUFS, r);
  h5_check_int("getenv-enobufs-size-includes-nul", (long long) sizeof(expected), (long long) size);
  memcpy(expected, "12345678", 8);
  expected[8] = 0;
  h5_check_bytes("getenv-enobufs-prefix-and-terminator", expected, (const unsigned char*) buf, 9);
  h5_check_int("getenv-enobufs-tail-untouched", UNTOUCHED, (unsigned char) buf[9]);

  /* A single byte of buffer holds only the NUL. */
  memset(buf, UNTOUCHED, sizeof(buf));
  size = 1;
  r = uv_os_getenv(NAME_A, buf, &size);
  h5_check_int("getenv-size1-code", UV_ENOBUFS, r);
  h5_check_int("getenv-size1-size-includes-nul", (long long) sizeof(expected), (long long) size);
  h5_check_int("getenv-size1-terminator-only", 0, (unsigned char) buf[0]);
  h5_check_int("getenv-size1-tail-untouched", UNTOUCHED, (unsigned char) buf[1]);

  /* An existing but empty value is a success with a zero length. */
  r = uv_os_setenv(NAME_B, "");
  h5_check_int("setenv-empty-ok", 0, r);

  memset(buf, UNTOUCHED, sizeof(buf));
  size = sizeof(buf);
  r = uv_os_getenv(NAME_B, buf, &size);
  h5_check_int("getenv-empty-code", 0, r);
  h5_check_int("getenv-empty-size-is-zero", 0, (long long) size);
  h5_check_int("getenv-empty-writes-only-terminator", 0, (unsigned char) buf[0]);
  h5_check_int("getenv-empty-tail-untouched", UNTOUCHED, (unsigned char) buf[1]);

  /* Deleting really deletes: the value must be gone afterwards. */
  r = uv_os_unsetenv(NAME_A);
  h5_check_int("unsetenv-existing-ok", 0, r);

  size = sizeof(buf);
  r = uv_os_getenv(NAME_A, buf, &size);
  h5_check_int("getenv-after-unset-is-enoent", UV_ENOENT, r);

  r = uv_os_setenv(NAME_A, VALUE_A);
  h5_check_int("setenv-restore-ok", 0, r);
}

static void check_large_value(void) {
  char* value;
  char* expected;
  size_t size;
  size_t i;
  int r;

  value = malloc(BIG_N + 1);
  expected = malloc(BIG_N + 1);
  if (value == NULL || expected == NULL) {
    h5_fail_int("big-alloc", 1, 0);
    free(value);
    free(expected);
    return;
  }

  memset(value, 'y', BIG_N);
  value[BIG_N] = '\0';
  memset(expected, 'y', BIG_N);
  expected[BIG_N] = '\0';

  r = uv_os_setenv("REFACTOR_ORACLE_BIG", value);
  h5_check_int("big-setenv-code", 0, r);

  /* 2 * 32768 bytes: the 512 wchar_t fast path is overrun and the retry
   * allocation plus the copy path are exercised. */
  memset(value, UNTOUCHED, BIG_N + 1);
  size = BIG_N + 1;
  r = uv_os_getenv("REFACTOR_ORACLE_BIG", value, &size);
  h5_check_int("big-getenv-code", 0, r);
  h5_check_int("big-getenv-size", (long long) BIG_N, (long long) size);
  for (i = 0; i < BIG_N; i++)
    if ((unsigned char) value[i] != (unsigned char) expected[i])
      break;
  h5_check_int("big-getenv-first-mismatch-index", (long long) BIG_N, (long long) i);
  h5_check_int("big-getenv-terminator", 0, (unsigned char) value[BIG_N]);

  /* A short buffer still reports the full requirement. */
  size = 1000;
  r = uv_os_getenv("REFACTOR_ORACLE_BIG", value, &size);
  h5_check_int("big-getenv-enobufs-code", UV_ENOBUFS, r);
  h5_check_int("big-getenv-enobufs-size-includes-nul", (long long) BIG_N + 1, (long long) size);

  r = uv_os_unsetenv("REFACTOR_ORACLE_BIG");
  h5_check_int("big-unsetenv-code", 0, r);

  free(value);
  free(expected);
}

static void check_environ_ownership(void) {
  uv_env_item_t* items;
  int count;
  int i;
  int found_special;
  int found_special_named;
  int found_a;
  int found_b;
  int shared;
  long live_before;
  long bad_before;
  long double_before;
  int r;

  items = NULL;
  count = 0;

  r = uv_os_setenv(NAME_SPECIAL, SPECIAL_VALUE);
  if (r != 0) {
    h5_fail_int("environ-special-fixture-ok", 0, r);
    return;
  }
  h5_ok("environ-special-fixture-ok");

  live_before = h5_live_blocks;
  bad_before = h5_bad_frees;
  double_before = h5_double_frees;

  r = uv_os_environ(&items, &count);
  h5_check_int("environ-code", 0, r);
  h5_check_int("environ-count-positive", 1, count > 0);
  if (r != 0 || count <= 0) {
    uv_os_free_environ(items, count);
    uv_os_unsetenv(NAME_SPECIAL);
    return;
  }

  found_special = 0;
  found_special_named = 0;
  found_a = 0;
  found_b = 0;
  shared = 0;

  for (i = 0; i < count; i++) {
    const char* name = items[i].name;
    const char* value = items[i].value;

    /* Windows keeps hidden per-drive "current directory" variables whose
     * name starts with '='.  Parsing them means searching for the '=' from
     * the second byte on, which is why the name may never come back empty. */
    if (name[0] == '=') {
      if (strlen(name) > 1)
        found_special++;
      if (strcmp(name, NAME_SPECIAL) == 0 && strcmp(value, SPECIAL_VALUE) == 0)
        found_special_named++;
    }

    if (strcmp(name, NAME_A) == 0 && strcmp(value, VALUE_A) == 0) {
      found_a++;
      /* name carries the allocation base and value points inside it: that is
       * what lets uv_os_free_environ() (uv-common.c) release the whole item by
       * freeing `name` alone, without knowing how the item was built. */
      if (h5_owner_of((void*) name) >= 0 &&
          h5_owner_of((void*) name) == h5_owner_of((void*) value))
        shared++;
    }

    /* A variable whose value is empty is still split at its '='. */
    if (strcmp(name, NAME_B) == 0 && value[0] == '\0')
      found_b++;
  }

  h5_check_int("environ-special-name-not-empty", 1, found_special > 0);
  h5_check_int("environ-special-roundtrip", 1, found_special_named > 0);
  h5_check_int("environ-value-roundtrip", 1, found_a > 0);
  h5_check_int("environ-empty-value-entry", 1, found_b > 0);
  h5_check_int("environ-name-and-value-share-one-allocation", 1, shared > 0);

  uv_os_free_environ(items, count);

  h5_check_int("free-environ-no-invalid-pointer", 0, h5_bad_frees - bad_before);
  h5_check_int("free-environ-no-double-free", 0, h5_double_frees - double_before);
  h5_check_int("free-environ-no-leak", 0, h5_live_blocks - live_before);

  /* Freeing nothing must stay a no-op. */
  bad_before = h5_bad_frees;
  double_before = h5_double_frees;
  uv_os_free_environ(NULL, 0);
  h5_check_int("free-environ-empty-no-invalid-pointer", 0, h5_bad_frees - bad_before);
  h5_check_int("free-environ-empty-no-double-free", 0, h5_double_frees - double_before);

  uv_os_unsetenv(NAME_SPECIAL);
}

static void check_utf16_to_utf8(void) {
  /* "a", U+00E9, U+4E2D -> 1 + 2 + 3 bytes of UTF-8. */
  static const WCHAR bmp[] = { 0x0061, 0x00E9, 0x4E2D, 0x0000 };
  static const unsigned char bmp_utf8[] = { 0x61, 0xC3, 0xA9, 0xE4, 0xB8, 0xAD, 0x00 };

  /* U+1F600: one surrogate pair -> 4 bytes. */
  static const WCHAR pair[] = { 0xD83D, 0xDE00, 0x0000 };
  static const unsigned char pair_utf8[] = { 0xF0, 0x9F, 0x98, 0x80, 0x00 };

  /* A lone high surrogate is preserved as WTF-8, not dropped or paired. */
  static const WCHAR lone_high[] = { 0xD83D, 0x0000 };
  static const unsigned char lone_high_utf8[] = { 0xED, 0xA0, 0xBD, 0x00 };

  /* A high surrogate followed by a non-surrogate must not be consumed. */
  static const WCHAR high_then_bmp[] = { 0xD83D, 0x0041, 0x0000 };
  static const unsigned char high_then_bmp_utf8[] = { 0xED, 0xA0, 0xBD, 0x41, 0x00 };

  /* An explicit length that stops after the high surrogate. */
  static const unsigned char truncated_utf8[] = { 0xED, 0xA0, 0xBD, 0x00 };

  /* Explicit length: an embedded NUL is data, not a terminator. */
  static const WCHAR embedded[] = { 0x0041, 0x0000, 0x0042 };
  static const unsigned char embedded_utf8[] = { 0x41, 0x00, 0x42, 0x00 };

  char* utf8;
  int r;

  utf8 = NULL;
  r = uv__convert_utf16_to_utf8(bmp, (size_t) -1, &utf8);
  h5_check_int("convert-bmp-code", 0, r);
  if (r == 0 && utf8 != NULL)
    h5_check_bytes("convert-bmp-bytes", bmp_utf8, (const unsigned char*) utf8, sizeof(bmp_utf8));
  else
    h5_fail_str("convert-bmp-bytes", "hex", "null");
  uv__free(utf8);

  utf8 = NULL;
  r = uv__convert_utf16_to_utf8(pair, (size_t) -1, &utf8);
  h5_check_int("convert-surrogate-pair-code", 0, r);
  if (r == 0 && utf8 != NULL)
    h5_check_bytes("convert-surrogate-pair-bytes", pair_utf8, (const unsigned char*) utf8, sizeof(pair_utf8));
  else
    h5_fail_str("convert-surrogate-pair-bytes", "hex", "null");
  uv__free(utf8);

  utf8 = NULL;
  r = uv__convert_utf16_to_utf8(lone_high, (size_t) -1, &utf8);
  h5_check_int("convert-lone-high-surrogate-code", 0, r);
  if (r == 0 && utf8 != NULL)
    h5_check_bytes("convert-lone-high-surrogate-bytes", lone_high_utf8, (const unsigned char*) utf8, sizeof(lone_high_utf8));
  else
    h5_fail_str("convert-lone-high-surrogate-bytes", "hex", "null");
  uv__free(utf8);

  utf8 = NULL;
  r = uv__convert_utf16_to_utf8(high_then_bmp, (size_t) -1, &utf8);
  h5_check_int("convert-high-then-bmp-code", 0, r);
  if (r == 0 && utf8 != NULL)
    h5_check_bytes("convert-high-then-bmp-bytes", high_then_bmp_utf8, (const unsigned char*) utf8, sizeof(high_then_bmp_utf8));
  else
    h5_fail_str("convert-high-then-bmp-bytes", "hex", "null");
  uv__free(utf8);

  utf8 = NULL;
  r = uv__convert_utf16_to_utf8(pair, 1, &utf8);
  h5_check_int("convert-truncated-pair-code", 0, r);
  if (r == 0 && utf8 != NULL)
    h5_check_bytes("convert-truncated-pair-bytes", truncated_utf8, (const unsigned char*) utf8, sizeof(truncated_utf8));
  else
    h5_fail_str("convert-truncated-pair-bytes", "hex", "null");
  uv__free(utf8);

  utf8 = NULL;
  r = uv__convert_utf16_to_utf8(embedded, 3, &utf8);
  h5_check_int("convert-embedded-nul-code", 0, r);
  if (r == 0 && utf8 != NULL)
    h5_check_bytes("convert-embedded-nul-bytes", embedded_utf8, (const unsigned char*) utf8, sizeof(embedded_utf8));
  else
    h5_fail_str("convert-embedded-nul-bytes", "hex", "null");
  uv__free(utf8);

  utf8 = NULL;
  r = uv__convert_utf16_to_utf8(NULL, (size_t) -1, &utf8);
  h5_check_int("convert-null-input-code", UV_EINVAL, r);
  uv__free(utf8);
}

static void check_utf8_to_utf16(void) {
  WCHAR* utf16;
  int r;

  utf16 = NULL;
  r = uv__convert_utf8_to_utf16("a\xc3\xa9", &utf16);
  h5_check_int("convert-u8-to-u16-bmp-code", 0, r);
  if (r == 0 && utf16 != NULL) {
    h5_check_int("convert-u8-to-u16-bmp-first", 0x0061, (long long) utf16[0]);
    h5_check_int("convert-u8-to-u16-bmp-second", 0x00E9, (long long) utf16[1]);
    h5_check_int("convert-u8-to-u16-bmp-terminator", 0, (long long) utf16[2]);
  } else {
    h5_fail_str("convert-u8-to-u16-bmp-first", "0x61", "null");
  }
  uv__free(utf16);

  /* U+1F600 must round-trip into a surrogate pair. */
  utf16 = NULL;
  r = uv__convert_utf8_to_utf16("\xf0\x9f\x98\x80", &utf16);
  h5_check_int("convert-u8-to-u16-pair-code", 0, r);
  if (r == 0 && utf16 != NULL) {
    h5_check_int("convert-u8-to-u16-pair-high", 0xD83D, (long long) utf16[0]);
    h5_check_int("convert-u8-to-u16-pair-low", 0xDE00, (long long) utf16[1]);
  } else {
    h5_fail_str("convert-u8-to-u16-pair-high", "0xd83d", "null");
  }
  uv__free(utf16);

  /* Invalid UTF-8 is rejected, it must not be silently translated. */
  utf16 = NULL;
  r = uv__convert_utf8_to_utf16("\xff", &utf16);
  h5_check_int("convert-u8-to-u16-invalid-code", UV_EINVAL, r);
  uv__free(utf16);

  utf16 = NULL;
  r = uv__convert_utf8_to_utf16(NULL, &utf16);
  h5_check_int("convert-u8-to-u16-null-code", UV_EINVAL, r);
  uv__free(utf16);
}

static void check_copy_utf16_to_utf8(void) {
  static const WCHAR source[] = { 0x0031, 0x0032, 0x0033, 0x0034, 0x0035,
                                  0x0036, 0x0037, 0x0038, 0x0039, 0x0000 };
  static const unsigned char needed_with_nul[] = { '1', '2', '3', '4', '5',
                                                   '6', '7', '8', '9', 0x00 };
  static const unsigned char prefix4[] = { '1', '2', '3', '4', 0x00 };
  static const unsigned char untouched = UNTOUCHED;
  char out[32];
  size_t size;
  int r;

  /* *size == 0 asks for the requirement only: the buffer stays untouched and
   * the answer counts the NUL. */
  memset(out, UNTOUCHED, sizeof(out));
  size = 0;
  r = uv__copy_utf16_to_utf8(source, (size_t) -1, out, &size);
  h5_check_int("copy-zero-size-code", UV_ENOBUFS, r);
  h5_check_int("copy-zero-size-needed-includes-nul", (long long) sizeof(needed_with_nul), (long long) size);
  h5_check_bytes("copy-zero-size-writes-nothing", &untouched, (const unsigned char*) out, 1);
  h5_check_int("copy-zero-size-out-untouched", UNTOUCHED, (unsigned char) out[1]);

  /* Room to spare. */
  memset(out, UNTOUCHED, sizeof(out));
  size = sizeof(out);
  r = uv__copy_utf16_to_utf8(source, (size_t) -1, out, &size);
  h5_check_int("copy-roomy-code", 0, r);
  h5_check_int("copy-roomy-size-excludes-nul", 9, (long long) size);
  h5_check_bytes("copy-roomy-bytes", needed_with_nul, (const unsigned char*) out, sizeof(needed_with_nul));

  /* Exact fit. */
  memset(out, UNTOUCHED, sizeof(out));
  size = sizeof(needed_with_nul);
  r = uv__copy_utf16_to_utf8(source, (size_t) -1, out, &size);
  h5_check_int("copy-exact-code", 0, r);
  h5_check_int("copy-exact-size-excludes-nul", 9, (long long) size);
  h5_check_bytes("copy-exact-bytes", needed_with_nul, (const unsigned char*) out, sizeof(needed_with_nul));

  /* Too small: the prefix plus a terminator fit, and the requirement counts
   * the NUL. */
  memset(out, UNTOUCHED, sizeof(out));
  size = 5;
  r = uv__copy_utf16_to_utf8(source, (size_t) -1, out, &size);
  h5_check_int("copy-enobufs-code", UV_ENOBUFS, r);
  h5_check_int("copy-enobufs-needed-includes-nul", (long long) sizeof(needed_with_nul), (long long) size);
  h5_check_bytes("copy-enobufs-prefix-and-terminator", prefix4, (const unsigned char*) out, sizeof(prefix4));
  h5_check_int("copy-enobufs-tail-untouched", UNTOUCHED, (unsigned char) out[5]);

  /* A one byte buffer holds only the terminator. */
  memset(out, UNTOUCHED, sizeof(out));
  size = 1;
  r = uv__copy_utf16_to_utf8(source, (size_t) -1, out, &size);
  h5_check_int("copy-size1-code", UV_ENOBUFS, r);
  h5_check_int("copy-size1-needed-includes-nul", (long long) sizeof(needed_with_nul), (long long) size);
  h5_check_int("copy-size1-terminator-only", 0, (unsigned char) out[0]);
  h5_check_int("copy-size1-tail-untouched", UNTOUCHED, (unsigned char) out[1]);

  /* NULL outputs are rejected, not dereferenced. */
  size = sizeof(out);
  r = uv__copy_utf16_to_utf8(source, (size_t) -1, NULL, &size);
  h5_check_int("copy-null-buffer-code", UV_EINVAL, r);
  r = uv__copy_utf16_to_utf8(source, (size_t) -1, out, NULL);
  h5_check_int("copy-null-size-code", UV_EINVAL, r);
}

int main(void) {
  int r;

  r = uv_replace_allocator(h5_malloc, h5_realloc, h5_calloc, h5_free);
  h5_check_int("allocator-hook-installed", 0, r);

  check_invalid_arguments();
  check_getenv_size_contract();
  check_large_value();
  check_environ_ownership();
  check_utf16_to_utf8();
  check_utf8_to_utf16();
  check_copy_utf16_to_utf8();

  h5_check_int("ledger-did-not-overflow", 0, h5_overflow);
  h5_check_int("no-invalid-frees-overall", 0, h5_bad_frees);
  h5_check_int("no-double-frees-overall", 0, h5_double_frees);

  /* Leave no trace in the host environment. */
  uv_os_unsetenv(NAME_A);
  uv_os_unsetenv(NAME_B);
  uv_os_unsetenv(NAME_SPECIAL);

  printf(ORACLE ": total_failures=%d\n", h5_failures);
  return h5_failures != 0;
}
