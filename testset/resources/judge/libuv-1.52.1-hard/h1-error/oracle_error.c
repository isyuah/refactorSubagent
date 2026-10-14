/* oracle_error.c - behavior oracle for the Windows system-error translation
 * table (src/win/error.c:66-190):
 *
 *   int uv_translate_sys_error(int sys_errno);        [ public, uv.h ]
 *   int uv_translate_write_sys_error(int sys_errno);  [ src/win/internal.h ]
 *
 * Why this oracle exists: the shipped suite pins this cluster in exactly one
 * place -- test/test-error.c:testsys_error -- and only there with four Windows
 * codes (ERROR_NOACCESS, ERROR_ELEVATION_REQUIRED, WSAEADDRINUSE,
 * ERROR_BAD_PIPE) plus the "<=" 0 passthrough.  The write-path variant
 * uv_translate_write_sys_error() is asserted *nowhere*, and the two codes whose
 * write-path meaning differs from their read-path meaning (ERROR_BROKEN_PIPE,
 * ERROR_NO_DATA) are not asserted at all.  Callers: stream.c:152/188 and
 * fs.c:1125 hand every synchronous WriteFile() failure through the write-path
 * variant, so uv_write()/uv_write2() error codes depend on it (a closed pipe
 * must report UV_EPIPE, never UV_EOF/UV_EAGAIN -- EAGAIN means "retry", and no
 * amount of retrying revives a dead pipe).
 *
 * Frozen against: libuv v1.52.1 (commit 1cfa32f), Windows 11 x64, MinGW GCC 15.2.
 *
 * Pinned semantics:
 *   - sys_errno <= 0 passes through unchanged (0, -1 and every uv_* code,
 *     including UV_EINVAL/UV_EPIPE/UV_EOF/UV_UNKNOWN themselves)
 *   - every Win32/Winsock code in the switch maps to the frozen uv code below,
 *     and an unlisted positive code maps to UV_UNKNOWN
 *   - uv_translate_write_sys_error() diverges from uv_translate_sys_error()
 *     for exactly two inputs, ERROR_BROKEN_PIPE and ERROR_NO_DATA, both -> UV_EPIPE
 *
 * The oracle asserts the *pair* (generic, write) for every row, so it also
 * catches a refactor that "dedupes" the write variant into the generic one
 * (that would silently reclassify those two codes on the write path).
 */
#include <stdio.h>
#include <string.h>

#include "uv.h"

/* Declared in src/win/internal.h:333.  Spelled out here so this oracle needs no
 * libuv-internal header; libuv.a resolves it at link time. */
int uv_translate_write_sys_error(int sys_errno);

#define ORACLE "error-oracle"

static int total_failures;

static void check_int(const char* name, int actual, int expected) {
  if (actual == expected)
    return;

  fprintf(stderr, "FAIL %s actual=%d(%s) expected=%d(%s)\n",
          name, actual, uv_err_name(actual), expected, uv_err_name(expected));
  total_failures++;
}

static void check_str(const char* name, const char* actual,
                      const char* expected) {
  if (strcmp(actual, expected) == 0)
    return;

  fprintf(stderr, "FAIL %s actual=\"%s\" expected=\"%s\"\n",
          name, actual, expected);
  total_failures++;
}

/* One row per frozen mapping.  expect_write is what the write-path variant must
 * return; for all but two rows it equals expect_generic. */
typedef struct {
  const char* label;
  int sys;              /* input code */
  int expect_generic;   /* uv_translate_sys_error(sys) */
  int expect_write;     /* uv_translate_write_sys_error(sys) */
} row_t;

/* ERROR_SYMLINK_NOT_SUPPORTED is defined by libuv itself (src/win/winapi.h:4701)
 * as 1464; spelled out numerically here to keep the oracle standalone. */
#define ERROR_SYMLINK_NOT_SUPPORTED_ 1464

static const row_t rows[] = {
  /* ---- passthrough: already-libuv (<= 0) and zero inputs ---- */
  { "passthrough-0",              0,                       0,                       0 },
  { "passthrough-neg1",           -1,                      -1,                      -1 },
  { "passthrough-min",            -2147483647,             -2147483647,             -2147483647 },
  { "passthrough-uv-einval",      UV_EINVAL,               UV_EINVAL,               UV_EINVAL },
  { "passthrough-uv-eof",         UV_EOF,                  UV_EOF,                  UV_EOF },
  { "passthrough-uv-epipe",       UV_EPIPE,                UV_EPIPE,                UV_EPIPE },
  { "passthrough-uv-unknown",     UV_UNKNOWN,              UV_UNKNOWN,              UV_UNKNOWN },
  { "passthrough-uv-echarset",    UV_ECHARSET,             UV_ECHARSET,             UV_ECHARSET },

  /* ---- the two write-path divergences ---- */
  { "broken-pipe-109",            ERROR_BROKEN_PIPE,       UV_EOF,                  UV_EPIPE },
  { "no-data-232",                ERROR_NO_DATA,           UV_EAGAIN,               UV_EPIPE },

  /* ---- codes that look like a sibling but map elsewhere ---- */
  { "bad-pipe-230",               ERROR_BAD_PIPE,          UV_EPIPE,                UV_EPIPE },
  { "pipe-not-connected-233",     ERROR_PIPE_NOT_CONNECTED, UV_EPIPE,               UV_EPIPE },
  { "no-data-detected-1104",      ERROR_NO_DATA_DETECTED,  UV_EIO,                  UV_EIO },
  { "wsaewouldblock-10035",       WSAEWOULDBLOCK,          UV_EAGAIN,               UV_EAGAIN },
  { "wsaeshutdown-10058",         WSAESHUTDOWN,            UV_EPIPE,                UV_EPIPE },
  { "wsaecanceled-alike-10004",   WSAEINTR,                UV_ECANCELED,            UV_ECANCELED },
  { "invalid-function-1",         ERROR_INVALID_FUNCTION,  UV_EISDIR,               UV_EISDIR },
  { "invalid-parameter-87",       ERROR_INVALID_PARAMETER, UV_EINVAL,               UV_EINVAL },
  { "access-denied-5",            ERROR_ACCESS_DENIED,     UV_EPERM,                UV_EPERM },
  { "wsaaccess-10013",            WSAEACCES,               UV_EACCES,               UV_EACCES },
  { "elevation-required-740",     ERROR_ELEVATION_REQUIRED, UV_EACCES,              UV_EACCES },
  { "cant-access-file-1920",      ERROR_CANT_ACCESS_FILE,  UV_EACCES,               UV_EACCES },
  { "privilege-not-held-1314",    ERROR_PRIVILEGE_NOT_HELD, UV_EPERM,               UV_EPERM },

  /* ---- address / socket family ---- */
  { "addr-in-use-1227",           ERROR_ADDRESS_ALREADY_ASSOCIATED, UV_EADDRINUSE,  UV_EADDRINUSE },
  { "wsaaddrinuse-10048",         WSAEADDRINUSE,           UV_EADDRINUSE,           UV_EADDRINUSE },
  { "wsaaddrnotavail-10049",      WSAEADDRNOTAVAIL,        UV_EADDRNOTAVAIL,        UV_EADDRNOTAVAIL },
  { "wsaafnosupport-10047",       WSAEAFNOSUPPORT,         UV_EAFNOSUPPORT,         UV_EAFNOSUPPORT },
  { "wsaealready-10037",          WSAEALREADY,             UV_EALREADY,             UV_EALREADY },
  { "wsapisconn-10056",           WSAEISCONN,              UV_EISCONN,              UV_EISCONN },
  { "wsanotsock-10038",           WSAENOTSOCK,             UV_ENOTSOCK,             UV_ENOTSOCK },
  { "wsaemsgsize-10040",          WSAEMSGSIZE,             UV_EMSGSIZE,             UV_EMSGSIZE },
  { "wsanobufs-10055",            WSAENOBUFS,              UV_ENOBUFS,              UV_ENOBUFS },
  { "wsaconnreset-10054",         WSAECONNRESET,           UV_ECONNRESET,           UV_ECONNRESET },
  { "netname-deleted-64",         ERROR_NETNAME_DELETED,   UV_ECONNRESET,           UV_ECONNRESET },
  { "wsaconnaborted-10053",       WSAECONNABORTED,         UV_ECONNABORTED,         UV_ECONNABORTED },
  { "connection-aborted-1236",    ERROR_CONNECTION_ABORTED, UV_ECONNABORTED,        UV_ECONNABORTED },
  { "wsaconnrefused-10061",       WSAECONNREFUSED,         UV_ECONNREFUSED,         UV_ECONNREFUSED },
  { "connection-refused-1225",    ERROR_CONNECTION_REFUSED, UV_ECONNREFUSED,        UV_ECONNREFUSED },
  { "wsaenetunreach-10051",       WSAENETUNREACH,          UV_ENETUNREACH,          UV_ENETUNREACH },
  { "network-unreachable-1231",   ERROR_NETWORK_UNREACHABLE, UV_ENETUNREACH,        UV_ENETUNREACH },
  { "wsaehostunreach-10065",      WSAEHOSTUNREACH,         UV_EHOSTUNREACH,         UV_EHOSTUNREACH },
  { "host-unreachable-1232",      ERROR_HOST_UNREACHABLE,  UV_EHOSTUNREACH,         UV_EHOSTUNREACH },
  { "wsaetimeout-10060",          WSAETIMEDOUT,            UV_ETIMEDOUT,            UV_ETIMEDOUT },
  { "sem-timeout-121",            ERROR_SEM_TIMEOUT,       UV_ETIMEDOUT,            UV_ETIMEDOUT },
  { "wsaeconnnotconn-10057",      WSAENOTCONN,             UV_ENOTCONN,             UV_ENOTCONN },
  { "not-connected-2250",         ERROR_NOT_CONNECTED,     UV_ENOTCONN,             UV_ENOTCONN },
  { "socktnosupport-10044",       WSAESOCKTNOSUPPORT,      UV_ESOCKTNOSUPPORT,      UV_ESOCKTNOSUPPORT },
  { "wsapservnosupport-10043",    WSAEPROTONOSUPPORT,      UV_EPROTONOSUPPORT,      UV_EPROTONOSUPPORT },
  { "wsapfnosupport-10046",       WSAEPFNOSUPPORT,         UV_EINVAL,               UV_EINVAL },
  { "wsaeinval-10022",            WSAEINVAL,               UV_EINVAL,               UV_EINVAL },
  { "wsaefault-10014",            WSAEFAULT,               UV_EFAULT,               UV_EFAULT },
  { "wsahostnotfound-11001",      WSAHOST_NOT_FOUND,       UV_ENOENT,               UV_ENOENT },
  { "wsanodata-11004",            WSANO_DATA,              UV_ENOENT,               UV_ENOENT },
  { "wsaemfile-10024",            WSAEMFILE,               UV_EMFILE,               UV_EMFILE },

  /* ---- filesystem / handle codes ---- */
  { "noaccess-998",               ERROR_NOACCESS,          UV_EFAULT,               UV_EFAULT },
  { "invalid-flags-1008",         ERROR_INVALID_FLAGS,     UV_EBADF,                UV_EBADF },
  { "invalid-handle-6",           ERROR_INVALID_HANDLE,    UV_EBADF,                UV_EBADF },
  { "lock-violation-33",          ERROR_LOCK_VIOLATION,    UV_EBUSY,                UV_EBUSY },
  { "pipe-busy-231",              ERROR_PIPE_BUSY,         UV_EBUSY,                UV_EBUSY },
  { "sharing-violation-32",       ERROR_SHARING_VIOLATION, UV_EBUSY,                UV_EBUSY },
  { "operation-aborted-995",      ERROR_OPERATION_ABORTED, UV_ECANCELED,            UV_ECANCELED },
  { "no-unicode-translation-1113", ERROR_NO_UNICODE_TRANSLATION, UV_ECHARSET,       UV_ECHARSET },
  { "already-exists-183",         ERROR_ALREADY_EXISTS,    UV_EEXIST,               UV_EEXIST },
  { "file-exists-80",             ERROR_FILE_EXISTS,       UV_EEXIST,               UV_EEXIST },
  { "insufficient-buffer-122",    ERROR_INSUFFICIENT_BUFFER, UV_EINVAL,             UV_EINVAL },
  { "invalid-data-13",            ERROR_INVALID_DATA,      UV_EINVAL,               UV_EINVAL },
  { "symlink-not-supported-1464", ERROR_SYMLINK_NOT_SUPPORTED_, UV_EINVAL,          UV_EINVAL },
  { "cant-resolve-filename-1921", ERROR_CANT_RESOLVE_FILENAME, UV_ELOOP,            UV_ELOOP },
  { "too-many-open-files-4",      ERROR_TOO_MANY_OPEN_FILES, UV_EMFILE,             UV_EMFILE },
  { "buffer-overflow-111",        ERROR_BUFFER_OVERFLOW,   UV_ENAMETOOLONG,         UV_ENAMETOOLONG },
  { "filename-exced-range-206",   ERROR_FILENAME_EXCED_RANGE, UV_ENAMETOOLONG,      UV_ENAMETOOLONG },
  { "bad-pathname-161",           ERROR_BAD_PATHNAME,      UV_ENOENT,               UV_ENOENT },
  { "directory-267",              ERROR_DIRECTORY,         UV_ENOENT,               UV_ENOENT },
  { "envvar-not-found-203",       ERROR_ENVVAR_NOT_FOUND,  UV_ENOENT,               UV_ENOENT },
  { "file-not-found-2",           ERROR_FILE_NOT_FOUND,    UV_ENOENT,               UV_ENOENT },
  { "invalid-name-123",           ERROR_INVALID_NAME,      UV_ENOENT,               UV_ENOENT },
  { "invalid-drive-15",           ERROR_INVALID_DRIVE,     UV_ENOENT,               UV_ENOENT },
  { "mod-not-found-126",          ERROR_MOD_NOT_FOUND,     UV_ENOENT,               UV_ENOENT },
  { "path-not-found-3",           ERROR_PATH_NOT_FOUND,    UV_ENOENT,               UV_ENOENT },
  { "not-enough-memory-8",        ERROR_NOT_ENOUGH_MEMORY, UV_ENOMEM,               UV_ENOMEM },
  { "outofmemory-14",             ERROR_OUTOFMEMORY,       UV_ENOMEM,               UV_ENOMEM },
  { "cannot-make-82",             ERROR_CANNOT_MAKE,       UV_ENOSPC,               UV_ENOSPC },
  { "disk-full-112",              ERROR_DISK_FULL,         UV_ENOSPC,               UV_ENOSPC },
  { "handle-disk-full-39",        ERROR_HANDLE_DISK_FULL,  UV_ENOSPC,               UV_ENOSPC },
  { "end-of-media-1100",          ERROR_END_OF_MEDIA,      UV_ENOSPC,               UV_ENOSPC },
  { "dir-not-empty-145",          ERROR_DIR_NOT_EMPTY,     UV_ENOTEMPTY,            UV_ENOTEMPTY },
  { "not-supported-50",           ERROR_NOT_SUPPORTED,     UV_ENOTSUP,              UV_ENOTSUP },
  { "write-protect-19",           ERROR_WRITE_PROTECT,     UV_EROFS,                UV_EROFS },
  { "not-same-device-17",         ERROR_NOT_SAME_DEVICE,   UV_EXDEV,                UV_EXDEV },
  { "io-device-1117",             ERROR_IO_DEVICE,         UV_EIO,                  UV_EIO },
  { "crc-23",                     ERROR_CRC,               UV_EIO,                  UV_EIO },
  { "gen-failure-31",             ERROR_GEN_FAILURE,       UV_EIO,                  UV_EIO },
  { "beginning-of-media-1102",    ERROR_BEGINNING_OF_MEDIA, UV_EIO,                 UV_EIO },
  { "meta-expansion-too-long-208", ERROR_META_EXPANSION_TOO_LONG, UV_E2BIG,         UV_E2BIG },
  { "bad-exe-format-193",         ERROR_BAD_EXE_FORMAT,    UV_EFTYPE,               UV_EFTYPE },

  /* ---- unlisted codes fall into the default arm ---- */
  { "unknown-1337",               1337,                    UV_UNKNOWN,              UV_UNKNOWN },
  { "unknown-999999",             999999,                  UV_UNKNOWN,              UV_UNKNOWN },
  { "unknown-int-max",            2147483647,              UV_UNKNOWN,              UV_UNKNOWN }
};

#define ROW_COUNT (sizeof(rows) / sizeof(rows[0]))

/* Compile-time premises of the table above: if the platform headers disagreed
 * with the frozen literals, the table would be meaningless. */
static void check_premises(void) {
  check_int("premise-ERROR_BROKEN_PIPE-109", ERROR_BROKEN_PIPE, 109);
  check_int("premise-ERROR_NO_DATA-232", ERROR_NO_DATA, 232);
  check_int("premise-ERROR_DIRECTORY-267", ERROR_DIRECTORY, 267);
  check_int("premise-ERROR_INVALID_FUNCTION-1", ERROR_INVALID_FUNCTION, 1);
  check_int("premise-WSAEWOULDBLOCK-10035", WSAEWOULDBLOCK, 10035);
  check_int("premise-WSAEACCES-10013", WSAEACCES, 10013);
  check_int("premise-ERROR_BAD_PIPE-230", ERROR_BAD_PIPE, 230);
  check_int("premise-ERROR_NO_DATA_DETECTED-1104", ERROR_NO_DATA_DETECTED, 1104);
  check_int("premise-ERROR_ACCESS_DENIED-5", ERROR_ACCESS_DENIED, 5);
  check_int("premise-ERROR_INVALID_PARAMETER-87", ERROR_INVALID_PARAMETER, 87);
}

/* Every row, in both directions. */
static void check_table(void) {
  char name[128];
  size_t i;

  for (i = 0; i < ROW_COUNT; i++) {
    snprintf(name, sizeof(name), "generic:%s", rows[i].label);
    check_int(name, uv_translate_sys_error(rows[i].sys), rows[i].expect_generic);

    snprintf(name, sizeof(name), "write:%s", rows[i].label);
    check_int(name,
              uv_translate_write_sys_error(rows[i].sys),
              rows[i].expect_write);
  }
}

/* The write-path variant is the generic table plus exactly two overrides.  Any
 * (un)widening of that override set -- however it is spelled -- is a behavior
 * change, so assert the divergence set itself, not only its members. */
static void check_divergence_set(void) {
  char name[128];
  int divergences = 0;
  size_t i;
  int generic;
  int write_path;
  int expect_diverge;

  for (i = 0; i < ROW_COUNT; i++) {
    generic = uv_translate_sys_error(rows[i].sys);
    write_path = uv_translate_write_sys_error(rows[i].sys);
    expect_diverge = rows[i].sys == ERROR_BROKEN_PIPE ||
                     rows[i].sys == ERROR_NO_DATA;

    if (expect_diverge)
      divergences++;

    if ((generic != write_path) == expect_diverge)
      continue;

    snprintf(name, sizeof(name), "write-vs-generic:%s", rows[i].label);
    check_int(name, write_path, generic);
  }

  check_int("divergence-count", divergences, 2);

  /* Spelled out, so the failure line names the two codes rather than a row. */
  check_int("write:ERROR_BROKEN_PIPE-promoted",
            uv_translate_write_sys_error(ERROR_BROKEN_PIPE),
            UV_EPIPE);
  check_int("write:ERROR_NO_DATA-promoted",
            uv_translate_write_sys_error(ERROR_NO_DATA),
            UV_EPIPE);
  check_int("generic:ERROR_BROKEN_PIPE-is-EOF",
            uv_translate_sys_error(ERROR_BROKEN_PIPE),
            UV_EOF);
  check_int("generic:ERROR_NO_DATA-is-EAGAIN",
            uv_translate_sys_error(ERROR_NO_DATA),
            UV_EAGAIN);
}

/* Observable consequence for uv_err_name() users. */
static void check_names(void) {
  check_str("errname-EOF-broken-pipe",
            uv_err_name(uv_translate_sys_error(ERROR_BROKEN_PIPE)), "EOF");
  check_str("errname-EPIPE-broken-pipe-write",
            uv_err_name(uv_translate_write_sys_error(ERROR_BROKEN_PIPE)),
            "EPIPE");
  check_str("errname-EAGAIN-no-data",
            uv_err_name(uv_translate_sys_error(ERROR_NO_DATA)), "EAGAIN");
  check_str("errname-EPIPE-no-data-write",
            uv_err_name(uv_translate_write_sys_error(ERROR_NO_DATA)), "EPIPE");
  check_str("errname-EAGAIN-would-block-write",
            uv_err_name(uv_translate_write_sys_error(WSAEWOULDBLOCK)),
            "EAGAIN");
  check_str("errname-EPIPE-bad-pipe",
            uv_err_name(uv_translate_sys_error(ERROR_BAD_PIPE)), "EPIPE");
  check_str("errname-ENOENT-directory",
            uv_err_name(uv_translate_sys_error(ERROR_DIRECTORY)), "ENOENT");
  check_str("errname-EISDIR-invalid-function",
            uv_err_name(uv_translate_sys_error(ERROR_INVALID_FUNCTION)),
            "EISDIR");
  check_str("errname-EACCES-wsaaccess",
            uv_err_name(uv_translate_sys_error(WSAEACCES)), "EACCES");
  check_str("errname-EPERM-access-denied",
            uv_err_name(uv_translate_sys_error(ERROR_ACCESS_DENIED)), "EPERM");
  check_str("errname-UNKNOWN-1337",
            uv_err_name(uv_translate_sys_error(1337)), "UNKNOWN");
}

int main(void) {
  check_premises();
  check_table();
  check_divergence_set();
  check_names();

  printf("%s: total_failures=%d\n", ORACLE, total_failures);

  return total_failures == 0 ? 0 : 1;
}
