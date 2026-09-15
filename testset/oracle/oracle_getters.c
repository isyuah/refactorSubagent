/* oracle_getters.c — behavior oracle for the uncovered accessors in
 * src/uv-data-getter-setters.c and for the two type-name tables.
 *
 * Why this oracle exists: test/test-getters-setters.c (the stock `getters_setters`
 * case) covers the handle/loop/fs/stream accessors, but never calls
 *   uv_udp_get_send_queue_size, uv_udp_get_send_queue_count, uv_process_get_pid,
 *   uv_req_get_type, uv_req_get_data, uv_req_set_data
 * so a swapped field access (send_queue_size <-> send_queue_count) or a wrong
 * struct member in the pid/req accessors passes the whole stock suite.
 *
 * Frozen against: libuv v1.52.1 (commit 1cfa32f), Windows 11 x64, MinGW GCC 15.2.
 *
 * Windows shaping: UV_REQ_TYPE_PRIVATE expands to eight extra members
 * (UV_ACCEPT .. UV_SIGNAL_REQ, include/uv/win.h:356-365), so UV_REQ_TYPE_MAX is
 * 19 here, not the 12 you get on POSIX (include/uv/unix.h:250). uv_req_type_name
 * returns NULL for every private (11..18) and out-of-range value.
 */
#include <stdio.h>
#include <string.h>
#include "uv.h"
#include "oracle_common.h"

#define ORACLE "getters-oracle"

/* UV_HANDLE_TYPE_MAP + UV_FILE (include/uv.h:161-177,198-205): 0..18. */
static const char* const HANDLE_NAMES[19] = {
  NULL,            /* UV_UNKNOWN_HANDLE */
  "async", "check", "fs_event", "fs_poll", "handle", "idle", "pipe", "poll",
  "prepare", "process", "stream", "tcp", "timer", "tty", "udp", "signal",
  "file",          /* UV_FILE */
  NULL             /* UV_HANDLE_TYPE_MAX */
};

/* UV_REQ_TYPE_MAP + the eight Windows-private members (include/uv.h:179-189,
 * 207-214 + include/uv/win.h:356-365): 0..19. */
static const char* const REQ_NAMES[20] = {
  NULL,            /* UV_UNKNOWN_REQ */
  "req", "connect", "write", "shutdown", "udp_send", "fs", "work",
  "getaddrinfo", "getnameinfo", "random",
  NULL,            /* UV_ACCEPT */
  NULL,            /* UV_FS_EVENT_REQ */
  NULL,            /* UV_POLL_REQ */
  NULL,            /* UV_PROCESS_EXIT */
  NULL,            /* UV_READ */
  NULL,            /* UV_UDP_RECV */
  NULL,            /* UV_WAKEUP */
  NULL,            /* UV_SIGNAL_REQ */
  NULL             /* UV_REQ_TYPE_MAX */
};

int main(void) {
  size_t i;
  char label[64];
  const size_t handle_max = sizeof(HANDLE_NAMES) / sizeof(HANDLE_NAMES[0]) - 1;
  const size_t req_max = sizeof(REQ_NAMES) / sizeof(REQ_NAMES[0]) - 1;

  /* Pin the enum shapes: a table edit that shifts these must fail loudly. */
  check_int(ORACLE, "handle-type-max-index", (long) handle_max,
            (long) UV_HANDLE_TYPE_MAX);
  check_int(ORACLE, "req-type-max-index", (long) req_max,
            (long) UV_REQ_TYPE_MAX);

  for (i = 0; i <= handle_max; i++) {
    const char* got = uv_handle_type_name((uv_handle_type) i);
    snprintf(label, sizeof(label), "handle-name-%zu", i);
    if (HANDLE_NAMES[i] == NULL) check_int(ORACLE, label, 1, got == NULL);
    else check_str(ORACLE, label, HANDLE_NAMES[i], got);
  }
  check_int(ORACLE, "handle-name-out-of-range", 0,
            uv_handle_type_name((uv_handle_type) 99) != NULL);

  for (i = 0; i <= req_max; i++) {
    const char* got = uv_req_type_name((uv_req_type) i);
    snprintf(label, sizeof(label), "req-name-%zu", i);
    if (REQ_NAMES[i] == NULL) check_int(ORACLE, label, 1, got == NULL);
    else check_str(ORACLE, label, REQ_NAMES[i], got);
  }
  check_int(ORACLE, "req-name-out-of-range", 0,
            uv_req_type_name((uv_req_type) 99) != NULL);

  /* uv_udp_get_send_queue_size vs uv_udp_get_send_queue_count: distinct values
   * so a swapped member read is caught. */
  {
    uv_udp_t udp;
    memset(&udp, 0, sizeof(udp));
    udp.send_queue_size = 0x1111;
    udp.send_queue_count = 0x2222;
    check_int(ORACLE, "udp-send-queue-size", 0x1111,
              (long) uv_udp_get_send_queue_size(&udp));
    check_int(ORACLE, "udp-send-queue-count", 0x2222,
              (long) uv_udp_get_send_queue_count(&udp));
  }

  /* uv_process_get_pid reads proc->pid verbatim. */
  {
    uv_process_t proc;
    memset(&proc, 0, sizeof(proc));
    proc.pid = 4242;
    check_int(ORACLE, "process-get-pid", 4242, (long) uv_process_get_pid(&proc));
    proc.pid = 0;
    check_int(ORACLE, "process-get-pid-zero", 0, (long) uv_process_get_pid(&proc));
  }

  /* uv_req_get_type / uv_req_get_data / uv_req_set_data round-trip. */
  {
    uv_req_t req;
    int marker = 7;
    memset(&req, 0, sizeof(req));
    req.type = UV_FS;
    check_int(ORACLE, "req-get-type", (long) UV_FS, (long) uv_req_get_type(&req));
    req.type = UV_GETNAMEINFO;
    check_int(ORACLE, "req-get-type-second", (long) UV_GETNAMEINFO,
              (long) uv_req_get_type(&req));
    check_int(ORACLE, "req-get-data-initial-null", 1, uv_req_get_data(&req) == NULL);
    uv_req_set_data(&req, &marker);
    check_int(ORACLE, "req-get-data-after-set", 1, uv_req_get_data(&req) == &marker);
    uv_req_set_data(&req, NULL);
    check_int(ORACLE, "req-set-data-null", 1, uv_req_get_data(&req) == NULL);
  }

  return oracle_summary(ORACLE);
}
