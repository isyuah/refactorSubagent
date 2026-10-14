/* oracle_walk.c - behaviour oracle for libuv's handle-table / queue semantics in
 * src/uv-common.c: uv_walk(), uv__print_handles() (reached through the public
 * uv_print_all_handles() / uv_print_active_handles()) and uv_loop_close().
 *
 * Frozen against libuv v1.52.1 (commit 1cfa32f), Windows 11 x64, MinGW GCC 15.2,
 * Debug build (NDEBUG undefined, so the #ifndef NDEBUG teardown of uv_loop_close
 * really runs).
 *
 * Why this oracle exists: the shipped test/test-walk-handles.c drives uv_walk()
 * over a loop that holds exactly one timer, and test/test-loop-close.c only
 * covers "active handle -> UV_EBUSY" and "loop.data survives". Neither can see
 *   (a) that a handle created from inside the walk callback is NOT handed to the
 *       walk that is in progress (the walk visits a snapshot of the handle
 *       table, not a live iteration),
 *   (b) that a handle closed from inside the callback stays visible to further
 *       walks until the loop reaps it,
 *   (c) that the loop's own internal handles are never handed to the callback,
 *   (d) that uv_loop_close() rejects every still-open non-internal handle, not
 *       just the active ones (docs/src/loop.rst: "Call this function only when
 *       ... all open handles and requests have been closed, or it will return
 *       UV_EBUSY"), and
 *   (e) that the reserved loop.data field survives uv_loop_init() and the Debug
 *       teardown of uv_loop_close().
 *
 * Everything here is public uv_* API; nothing inspects source text or internal
 * structs. Output contract: one line per observation,
 *   "<oracle>: <name> ok"
 *   "<oracle>: <name> FAIL expected=... got=..."
 * followed by the final line "<oracle>: total_failures=N"; exit status is N.
 * Addresses/timings are never printed. Runtime is well under a second.
 */
#include <stdio.h>
#include <string.h>
#include <stdint.h>

#include "uv.h"

#define ORACLE "walk-oracle"
#define MAX_NAMED 32
#define MAX_LOG 64

/* Unix loops also own an inactive internal child-signal watcher. */
#if defined(_WIN32)
#define PRINT_ALL_LINE_COUNT 5
#define PRINT_INTERNAL_HANDLES "-AI:async"
#else
#define PRINT_ALL_LINE_COUNT 6
#define PRINT_INTERNAL_HANDLES "--I:signal|-AI:async"
#endif

static int failures;

static void pass(const char* name) {
  printf("%s: %s ok\n", ORACLE, name);
}

static void check_long(const char* name, long expected, long got) {
  if (expected == got) {
    pass(name);
  } else {
    failures++;
    printf("%s: %s FAIL expected=%ld got=%ld\n", ORACLE, name, expected, got);
  }
}

static void check_str(const char* name, const char* expected, const char* got) {
  if (strcmp(expected, got) == 0) {
    pass(name);
  } else {
    failures++;
    printf("%s: %s FAIL expected=\"%s\" got=\"%s\"\n",
           ORACLE, name, expected, got);
  }
}

/* Pointer comparisons are reported as booleans so no address ever leaks. */
static void check_same_handle(const char* name, const void* expected,
                              const void* got) {
  check_long(name, 1, expected == got ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/* Handle registry: map a handle pointer back to a readable name so the */
/* walk/close transcripts are deterministic strings.                     */
/* ------------------------------------------------------------------ */

typedef struct {
  const uv_handle_t* handle;
  const char* name;
} named_handle_t;

static named_handle_t named[MAX_NAMED];
static int named_count;

static void name_handle(const char* name, const void* handle) {
  if (named_count >= MAX_NAMED)
    return;
  named[named_count].handle = (const uv_handle_t*) handle;
  named[named_count].name = name;
  named_count++;
}

static const char* handle_name(const uv_handle_t* handle) {
  int i;
  for (i = 0; i < named_count; i++)
    if (named[i].handle == handle)
      return named[i].name;
  return "?";  /* not a user handle: internal handle or unknown memory */
}

static char visit_log[MAX_LOG * 4];
static int visit_count;
static int arg_mismatches;

static void log_reset(void) {
  visit_log[0] = '\0';
  visit_count = 0;
  arg_mismatches = 0;
}

static void log_visit(uv_handle_t* handle) {
  if (visit_count >= MAX_LOG)
    return;
  visit_count++;
  if (visit_log[0] != '\0')
    strcat(visit_log, ",");
  strcat(visit_log, handle_name(handle));
}

static int log_contains(const char* name) {
  return strstr(visit_log, name) != NULL;
}

static int arg_magic;
static int* const expected_arg = &arg_magic;

static char close_log[MAX_LOG * 4];

static void close_cb(uv_handle_t* handle) {
  if (close_log[0] != '\0')
    strcat(close_log, ",");
  strcat(close_log, handle_name(handle));
}

static void walk_cb(uv_handle_t* handle, void* arg) {
  if (arg != (void*) expected_arg)
    arg_mismatches++;
  log_visit(handle);
}

static void walk_close_cb(uv_handle_t* handle, void* arg) {
  if (arg != (void*) expected_arg)
    arg_mismatches++;
  log_visit(handle);
  uv_close(handle, close_cb);
}

/* Spawns one timer the first time it sees spawn_target. */
static uv_loop_t* spawn_loop;
static uv_timer_t* spawn_handle;
static const uv_handle_t* spawn_target;
static int spawn_done;
static int spawn_rc;

static void walk_spawn_cb(uv_handle_t* handle, void* arg) {
  if (arg != (void*) expected_arg)
    arg_mismatches++;
  log_visit(handle);
  if (handle == spawn_target && !spawn_done) {
    spawn_rc = uv_timer_init(spawn_loop, spawn_handle);
    spawn_done = 1;
  }
}

/* Same, but also closes every handle it is shown ("close everything"). */
static void walk_spawn_close_cb(uv_handle_t* handle, void* arg) {
  if (arg != (void*) expected_arg)
    arg_mismatches++;
  log_visit(handle);
  if (handle == spawn_target && !spawn_done) {
    spawn_rc = uv_timer_init(spawn_loop, spawn_handle);
    spawn_done = 1;
  }
  uv_close(handle, NULL);
}

static void noop_timer_cb(uv_timer_t* handle) {
  (void) handle;
}

static void noop_async_cb(uv_async_t* handle) {
  (void) handle;
}

/* uv_loop_init() must be fed a loop whose data field already holds user state:
 * that field is reserved for the user and must survive both init and close. */
static int loop_start(uv_loop_t* loop) {
  memset(loop, 0, sizeof(*loop));
  loop->data = loop;
  return uv_loop_init(loop);
}

static void close_and_reap(uv_handle_t** handles, int count, uv_loop_t* loop) {
  int i;
  for (i = 0; i < count; i++)
    uv_close(handles[i], NULL);
  uv_run(loop, UV_RUN_DEFAULT);
}

/* ------------------------------------------------------------------ */
/* Capture of uv_print_all_handles()/uv_print_active_handles() output.  */
/* ------------------------------------------------------------------ */

typedef struct {
  int lines;
  char internal[128];     /* "<flags>:<type>|..." for internal handles */
  char transcript[256];   /* "<flags>:<type>|..." for user handles */
  int address_mismatches;
} print_capture_t;

static void capture_prints(FILE* stream,
                           const uv_handle_t* const* expected,
                           int expected_count,
                           print_capture_t* cap) {
  char line[256];
  char flags[4];
  char type[16];
  void* address;
  int index = 0;

  memset(cap, 0, sizeof(*cap));
  rewind(stream);

  while (fgets(line, sizeof(line), stream) != NULL) {
    if (sscanf(line, "[%c%c%c] %15s %p",
               &flags[0], &flags[1], &flags[2], type, &address) != 5)
      continue;

    flags[3] = '\0';
    cap->lines++;

    if (flags[2] == 'I') {
      size_t used = strlen(cap->internal);
      snprintf(cap->internal + used, sizeof(cap->internal) - used,
               "%s%s:%s", used == 0 ? "" : "|", flags, type);
      continue;
    }

    if (cap->transcript[0] != '\0')
      strcat(cap->transcript, "|");
    strcat(cap->transcript, flags);
    strcat(cap->transcript, ":");
    strcat(cap->transcript, type);

    if (index >= expected_count || address != (void*) expected[index])
      cap->address_mismatches++;
    index++;
  }
}

/* ------------------------------------------------------------------ */

static uv_loop_t loop_walk;
static uv_timer_t walk_t1;
static uv_async_t walk_async;
static uv_timer_t walk_t2;
static uv_prepare_t walk_prep;
static uv_timer_t walk_t3;

static uv_loop_t loop_closing;
static uv_timer_t closing_t1;
static uv_async_t closing_async;
static uv_timer_t closing_t2;
static uv_prepare_t closing_prep;
static uv_timer_t closing_t3;
static uv_timer_t closing_t4;

static uv_loop_t loop_spawn;
static uv_timer_t spawn_t1;
static uv_timer_t spawn_t2;
static uv_timer_t spawn_t3;

static uv_loop_t loop_guard;
static uv_timer_t guard_t1;
static uv_timer_t guard_t2;

static uv_loop_t loop_plain;
static uv_loop_t loop_open;
static uv_timer_t open_t;
static uv_loop_t loop_closing_handle;
static uv_timer_t closing_handle_t;

static uv_loop_t loop_alive;
static uv_timer_t alive_t1;
static uv_timer_t alive_t2;

static uv_loop_t loop_print;
static uv_timer_t print_t1;
static uv_async_t print_async;
static uv_prepare_t print_prep;
static uv_timer_t print_t2;

int main(void) {
  uv_handle_t* batch[8];
  print_capture_t cap;
  const uv_handle_t* expected[4];
  FILE* stream;
  int rc;
  int open_consumed;

  setvbuf(stdout, NULL, _IONBF, 0);

  /* ---------------------------------------------------------------- */
  /* 1. uv_walk() on a loop that holds only internal handles, then on a */
  /*    loop with a known insertion order.                             */
  /* ---------------------------------------------------------------- */
  check_long("loop-init-returns-0", 0, loop_start(&loop_walk));
  check_same_handle("loop-init-keeps-user-data", &loop_walk, loop_walk.data);

  log_reset();
  uv_walk(&loop_walk, walk_cb, expected_arg);
  check_str("walk-internal-handles-hidden", "", visit_log);
  check_long("alive-empty-loop-0", 0, uv_loop_alive(&loop_walk));

  name_handle("t1", &walk_t1);
  name_handle("async", &walk_async);
  name_handle("t2", &walk_t2);
  name_handle("prep", &walk_prep);
  name_handle("t3", &walk_t3);

  rc = uv_timer_init(&loop_walk, &walk_t1);
  rc |= uv_async_init(&loop_walk, &walk_async, noop_async_cb);
  rc |= uv_timer_init(&loop_walk, &walk_t2);
  rc |= uv_prepare_init(&loop_walk, &walk_prep);
  rc |= uv_timer_init(&loop_walk, &walk_t3);
  check_long("init-handle-set-returns-0", 0, rc);

  log_reset();
  uv_walk(&loop_walk, walk_cb, expected_arg);
  check_str("walk-visits-insertion-order", "t1,async,t2,prep,t3", visit_log);
  check_long("walk-passes-arg-unchanged", 0, arg_mismatches);

  log_reset();
  uv_walk(&loop_walk, walk_cb, expected_arg);
  check_str("walk-repeat-visits-same-order", "t1,async,t2,prep,t3", visit_log);

  batch[0] = (uv_handle_t*) &walk_t1;
  batch[1] = (uv_handle_t*) &walk_async;
  batch[2] = (uv_handle_t*) &walk_t2;
  batch[3] = (uv_handle_t*) &walk_prep;
  batch[4] = (uv_handle_t*) &walk_t3;
  close_and_reap(batch, 5, &loop_walk);

  log_reset();
  uv_walk(&loop_walk, walk_cb, expected_arg);
  check_str("walk-reaped-handles-invisible", "", visit_log);
  check_long("close-loop-after-all-reaped", 0, uv_loop_close(&loop_walk));

  /* ---------------------------------------------------------------- */
  /* 2. Closing the current handle from inside the walk callback must   */
  /*    not disturb the traversal.                                     */
  /* ---------------------------------------------------------------- */
  check_long("closing-loop-init-returns-0", 0,
             loop_start(&loop_closing));

  name_handle("c1", &closing_t1);
  name_handle("c2", &closing_async);
  name_handle("c3", &closing_t2);
  name_handle("c4", &closing_prep);
  name_handle("c5", &closing_t3);
  name_handle("c6", &closing_t4);

  rc = uv_timer_init(&loop_closing, &closing_t1);
  rc |= uv_async_init(&loop_closing, &closing_async, noop_async_cb);
  rc |= uv_timer_init(&loop_closing, &closing_t2);
  rc |= uv_prepare_init(&loop_closing, &closing_prep);
  rc |= uv_timer_init(&loop_closing, &closing_t3);
  rc |= uv_timer_init(&loop_closing, &closing_t4);
  check_long("closing-handle-set-returns-0", 0, rc);

  close_log[0] = '\0';
  log_reset();
  uv_walk(&loop_closing, walk_close_cb, expected_arg);
  check_str("walk-close-inside-visits-each-once",
            "c1,c2,c3,c4,c5,c6", visit_log);
  check_long("walk-close-inside-passes-arg", 0, arg_mismatches);
  check_str("walk-close-cb-not-called-yet", "", close_log);

  log_reset();
  uv_walk(&loop_closing, walk_cb, expected_arg);
  check_str("walk-closing-handles-still-visible",
            "c1,c2,c3,c4,c5,c6", visit_log);

  rc = uv_run(&loop_closing, UV_RUN_DEFAULT);
  check_long("run-after-close-inside-returns-0", 0, rc);
  /* Closes requested from the walk are reaped in reverse order (the loop's
   * closing-handle list is a stack), exactly once each. */
  check_str("close-cb-called-once-each",
            "c6,c5,c4,c3,c2,c1", close_log);

  log_reset();
  uv_walk(&loop_closing, walk_cb, expected_arg);
  check_str("walk-after-reap-invisible", "", visit_log);
  check_long("closing-handle-is-closed", 1,
             uv_is_closing((uv_handle_t*) &closing_t1));
  check_long("close-loop-after-walk-close", 0, uv_loop_close(&loop_closing));

  /* ---------------------------------------------------------------- */
  /* 3. A handle created from inside the callback is not part of the    */
  /*    walk that is in progress.                                       */
  /* ---------------------------------------------------------------- */
  check_long("spawn-loop-init-returns-0", 0, loop_start(&loop_spawn));

  name_handle("s1", &spawn_t1);
  name_handle("s2", &spawn_t2);
  name_handle("s3", &spawn_t3);

  rc = uv_timer_init(&loop_spawn, &spawn_t1);
  rc |= uv_timer_init(&loop_spawn, &spawn_t2);
  check_long("spawn-handle-set-returns-0", 0, rc);

  spawn_loop = &loop_spawn;
  spawn_handle = &spawn_t3;
  spawn_target = (const uv_handle_t*) &spawn_t1;
  spawn_done = 0;
  spawn_rc = -1;

  log_reset();
  uv_walk(&loop_spawn, walk_spawn_cb, expected_arg);
  check_long("walk-spawn-init-returns-0", 0, spawn_rc);
  check_str("walk-spawn-not-visited", "s1,s2", visit_log);

  log_reset();
  uv_walk(&loop_spawn, walk_cb, expected_arg);
  check_long("walk-spawn-visited-next-time", log_contains("s3") ? 1 : 0, 1);
  check_long("walk-next-visit-count", 3, visit_count);

  batch[0] = (uv_handle_t*) &spawn_t1;
  batch[1] = (uv_handle_t*) &spawn_t2;
  batch[2] = (uv_handle_t*) &spawn_t3;
  close_and_reap(batch, 3, &loop_spawn);
  check_long("close-spawn-loop", 0, uv_loop_close(&loop_spawn));

  /* ---------------------------------------------------------------- */
  /* 4. A handle created from inside a "close everything" walk survives */
  /*    that walk: closing it would be a double close.                  */
  /* ---------------------------------------------------------------- */
  check_long("guard-loop-init-returns-0", 0, loop_start(&loop_guard));

  name_handle("g1", &guard_t1);
  name_handle("g2", &guard_t2);

  check_long("guard-handle-init-returns-0", 0,
             uv_timer_init(&loop_guard, &guard_t1));

  spawn_loop = &loop_guard;
  spawn_handle = &guard_t2;
  spawn_target = (const uv_handle_t*) &guard_t1;
  spawn_done = 0;
  spawn_rc = -1;

  log_reset();
  uv_walk(&loop_guard, walk_spawn_close_cb, expected_arg);
  check_str("walk-close-everything-visits-snapshot", "g1", visit_log);
  check_long("walk-spawned-handle-not-closed", 0,
             uv_is_closing((uv_handle_t*) &guard_t2));
  check_long("walk-visited-handle-closed", 1,
             uv_is_closing((uv_handle_t*) &guard_t1));

  uv_run(&loop_guard, UV_RUN_DEFAULT);
  if (!uv_is_closing((uv_handle_t*) &guard_t2))
    uv_close((uv_handle_t*) &guard_t2, NULL);
  uv_run(&loop_guard, UV_RUN_DEFAULT);
  check_long("close-guard-loop", 0, uv_loop_close(&loop_guard));

  /* ---------------------------------------------------------------- */
  /* 5. uv_loop_close(): every still-open non-internal handle blocks it */
  /*    (docs: "all open handles and requests have been closed"), and   */
  /*    the user's loop.data survives the teardown.                     */
  /* ---------------------------------------------------------------- */
  check_long("plain-loop-init-returns-0", 0, loop_start(&loop_plain));
  check_long("close-loop-with-no-handles", 0, uv_loop_close(&loop_plain));
  check_same_handle("close-keeps-user-data", &loop_plain, loop_plain.data);
#ifndef NDEBUG
  /* The Debug teardown poisons the whole struct; loop.data is the one field
   * that is saved and restored. 0xffffffff proves the poison really ran. */
  check_long("close-poisons-other-fields", 4294967295L,
             (long) loop_plain.active_handles);
#endif

  check_long("open-loop-init-returns-0", 0, loop_start(&loop_open));
  check_long("open-handle-init-returns-0", 0,
             uv_timer_init(&loop_open, &open_t));
  check_long("open-handle-start-returns-0", 0,
             uv_timer_start(&open_t, noop_timer_cb, 1000000, 0));

  check_long("close-active-handle-ebusy", UV_EBUSY, uv_loop_close(&loop_open));
  check_same_handle("failed-close-keeps-user-data", &loop_open, loop_open.data);

  uv_timer_stop(&open_t);
  open_consumed = 0;
  rc = uv_loop_close(&loop_open);
  if (rc != UV_EBUSY)
    open_consumed = 1;
  check_long("close-inactive-open-handle-ebusy", UV_EBUSY, rc);

  if (!open_consumed) {
    uv_close((uv_handle_t*) &open_t, NULL);
    uv_run(&loop_open, UV_RUN_DEFAULT);
    check_long("close-loop-after-handle-closed", 0, uv_loop_close(&loop_open));
  }

  check_long("cg-loop-init-returns-0", 0, loop_start(&loop_closing_handle));
  check_long("cg-handle-init-returns-0", 0,
             uv_timer_init(&loop_closing_handle, &closing_handle_t));
  uv_close((uv_handle_t*) &closing_handle_t, NULL);  /* closing, not reaped */

  open_consumed = 0;
  rc = uv_loop_close(&loop_closing_handle);
  if (rc != UV_EBUSY)
    open_consumed = 1;
  check_long("close-closing-handle-ebusy", UV_EBUSY, rc);

  if (!open_consumed) {
    uv_run(&loop_closing_handle, UV_RUN_DEFAULT);
    check_long("close-loop-after-reap", 0,
               uv_loop_close(&loop_closing_handle));
  }

  /* ---------------------------------------------------------------- */
  /* 6. Liveness: only referenced, active handles keep a loop alive.    */
  /* ---------------------------------------------------------------- */
  check_long("alive-loop-init-returns-0", 0, loop_start(&loop_alive));
  check_long("alive-handle-init-returns-0", 0,
             uv_timer_init(&loop_alive, &alive_t1) |
             uv_timer_init(&loop_alive, &alive_t2));

  check_long("alive-with-idle-handles-0", 0, uv_loop_alive(&loop_alive));

  check_long("alive-handle-start-returns-0", 0,
             uv_timer_start(&alive_t2, noop_timer_cb, 1000000, 0));
  check_long("alive-with-active-handle-1", 1, uv_loop_alive(&loop_alive));
  check_long("has-ref-default-1", 1, uv_has_ref((uv_handle_t*) &alive_t2));

  uv_unref((uv_handle_t*) &alive_t2);
  check_long("has-ref-after-unref-0", 0, uv_has_ref((uv_handle_t*) &alive_t2));
  check_long("alive-with-unref-active-handle-0", 0,
             uv_loop_alive(&loop_alive));

  uv_ref((uv_handle_t*) &alive_t2);
  check_long("alive-after-ref-again-1", 1, uv_loop_alive(&loop_alive));

  uv_timer_stop(&alive_t2);
  check_long("alive-after-stop-0", 0, uv_loop_alive(&loop_alive));

  /* ---------------------------------------------------------------- */
  /* 7. uv__print_handles(): order, flag columns, type names, and the   */
  /*    fact that internal handles are listed there (unlike uv_walk).   */
  /* ---------------------------------------------------------------- */
  check_long("print-loop-init-returns-0", 0, loop_start(&loop_print));

  rc = uv_timer_init(&loop_print, &print_t1);
  rc |= uv_async_init(&loop_print, &print_async, noop_async_cb);
  rc |= uv_prepare_init(&loop_print, &print_prep);
  rc |= uv_timer_init(&loop_print, &print_t2);
  rc |= uv_timer_start(&print_t1, noop_timer_cb, 1000000, 0);
  rc |= uv_timer_start(&print_t2, noop_timer_cb, 1000000, 0);
  check_long("print-handle-set-returns-0", 0, rc);

  uv_unref((uv_handle_t*) &print_t2);  /* active but unreferenced -> "-A-" */

  stream = tmpfile();
  if (stream == NULL) {
    check_str("print-all-handles", "tmpfile-available", "tmpfile-failed");
    check_str("print-active-handles", "tmpfile-available", "tmpfile-failed");
  } else {
    expected[0] = (const uv_handle_t*) &print_t1;
    expected[1] = (const uv_handle_t*) &print_async;
    expected[2] = (const uv_handle_t*) &print_prep;
    expected[3] = (const uv_handle_t*) &print_t2;

    uv_print_all_handles(&loop_print, stream);
    capture_prints(stream, expected, 4, &cap);
    check_long("print-all-line-count", PRINT_ALL_LINE_COUNT, cap.lines);
    check_str("print-all-order-and-flags",
              "RA-:timer|RA-:async|R--:prepare|-A-:timer", cap.transcript);
    check_str("print-all-lists-internal-handle",
              PRINT_INTERNAL_HANDLES, cap.internal);
    check_long("print-all-addresses-match", 0, cap.address_mismatches);
    fclose(stream);

    stream = tmpfile();
    if (stream == NULL) {
      check_str("print-active-handles", "tmpfile-available", "tmpfile-failed");
    } else {
      uv_print_active_handles(&loop_print, stream);
      capture_prints(stream, expected, 4, &cap);
      check_long("print-active-line-count", 4, cap.lines);
      check_str("print-active-order-and-flags",
                "RA-:timer|RA-:async|-A-:timer", cap.transcript);
      fclose(stream);
    }
  }

  batch[0] = (uv_handle_t*) &print_t1;
  batch[1] = (uv_handle_t*) &print_async;
  batch[2] = (uv_handle_t*) &print_prep;
  batch[3] = (uv_handle_t*) &print_t2;
  close_and_reap(batch, 4, &loop_print);
  check_long("close-print-loop", 0, uv_loop_close(&loop_print));

  /* ---------------------------------------------------------------- */
  /* 8. uv_loop_close() on the default loop clears the cached default   */
  /*    loop, so the next uv_default_loop() hands out a usable loop      */
  /*    again (test/test-default-loop-close.c).                          */
  /* ---------------------------------------------------------------- */
  {
    uv_loop_t* dflt;
    uv_timer_t dflt_timer;

    name_handle("d1", &dflt_timer);

    dflt = uv_default_loop();
    check_long("default-loop-available", 1, dflt != NULL ? 1 : 0);

    if (dflt != NULL) {
      rc = uv_timer_init(dflt, &dflt_timer);
      rc |= uv_timer_start(&dflt_timer, noop_timer_cb, 1000000, 0);
      uv_close((uv_handle_t*) &dflt_timer, NULL);
      uv_run(dflt, UV_RUN_DEFAULT);
      check_long("default-loop-close-returns-0", 0, uv_loop_close(dflt));

      dflt = uv_default_loop();
      check_long("default-loop-reacquired", 1, dflt != NULL ? 1 : 0);

      if (dflt != NULL) {
        check_long("default-loop-reacquired-usable", 0,
                   uv_timer_init(dflt, &dflt_timer));
        uv_close((uv_handle_t*) &dflt_timer, NULL);
        uv_run(dflt, UV_RUN_DEFAULT);
        check_long("default-loop-close-again", 0, uv_loop_close(dflt));
      }
    }
  }

  printf("%s: total_failures=%d\n", ORACLE, failures);
  return failures;
}
