/* oracle_loop.c — behavior oracle for the Windows event loop in
 * src/win/core.c (libuv v1.52.1, win x64).
 *
 * Target range of src/win/core.c:
 *   uv__loop_alive / uv_loop_alive    (liveness of a loop)
 *   uv_backend_timeout                (how long the backend may sleep)
 *   uv__poll                          (IOCP wait + timeout backoff)
 *   uv__process_reqs                  (pending-req dispatch)
 *   uv_run                            (UV_RUN_DEFAULT / ONCE / NOWAIT)
 *   uv__insert_pending_req            (circular pending-req queue)
 *
 * Everything below is observed through the public API only (uv.h): handle
 * and request creation, uv_run in all three modes, uv_loop_alive,
 * uv_backend_timeout, uv_stop, uv_ref/uv_unref, uv_loop_init/close, and
 * callback transcripts.  No wall clock is asserted, no network is used and
 * no test sleeps on a deadline: every iteration is driven by a callback,
 * by uv_stop, or by an already-queued wake-up packet.
 *
 * Build/run (see the task brief for the exact recipe):
 *   gcc -O0 -g -I <libuv>/include -I <libuv>/src -I . oracle_loop.c libuv.a \
 *     -o oracle_loop.exe -lpsapi -luser32 -ladvapi32 -liphlpapi -luserenv \
 *     -lws2_32 -ldbghelp -lole32 -lshell32
 *
 * Last line of output: "loop-oracle: total_failures=N"; exit status is N.
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "uv.h"

#define ORACLE "loop-oracle"
#define MAX_LOOPS 16
#define SEQ_MAX 32

static int failures;

static uv_loop_t loops[MAX_LOOPS];
static int loop_count;

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

static void check_i64(const char* name, long long expected, long long got) {
  if (expected != got) {
    failures++;
    printf("%s: %s FAIL expected=%lld got=%lld\n",
           ORACLE, name, expected, got);
  } else {
    printf("%s: %s ok\n", ORACLE, name);
  }
}

static void check_str(const char* name, const char* expected, const char* got) {
  if (strcmp(expected, got) != 0) {
    failures++;
    printf("%s: %s FAIL expected=\"%s\" got=\"%s\"\n",
           ORACLE, name, expected, got);
  } else {
    printf("%s: %s ok\n", ORACLE, name);
  }
}

static void check_true(const char* name, int cond) {
  check_i64(name, 1, cond ? 1 : 0);
}

static void fatal(const char* what) {
  failures++;
  printf("%s: %s FAIL expected=0 got=nonzero\n", ORACLE, what);
  printf("%s: total_failures=%d\n", ORACLE, failures);
  exit(1);
}

static uv_loop_t* nl(void) {
  uv_loop_t* loop;

  if (loop_count == MAX_LOOPS)
    fatal("loop_budget");
  loop = &loops[loop_count++];
  if (uv_loop_init(loop) != 0)
    fatal("uv_loop_init");
  return loop;
}

/* Bounded append; used to build deterministic callback transcripts. */
static void app(char* out, size_t outlen, char c) {
  size_t len = strlen(out);

  if (len + 1 < outlen) {
    out[len] = c;
    out[len + 1] = '\0';
  }
}

static void noop_timer_cb(uv_timer_t* handle) {
  (void) handle;
}

static void noop_idle_cb(uv_idle_t* handle) {
  (void) handle;
}

/* A watchdog only fires when the loop under test failed to make progress on
 * its own; it exists so that a broken uv_run/uv_backend_timeout cannot make
 * this oracle hang.  Its callback deliberately does not touch any
 * transcript, so it is invisible to the checks when the code is correct. */
static void watchdog_cb(uv_timer_t* handle) {
  uv_stop(handle->loop);
}

static void watchdog_arm(uv_loop_t* loop, uv_timer_t* handle, uint64_t ms) {
  if (uv_timer_init(loop, handle) != 0)
    fatal("watchdog_init");
  if (uv_timer_start(handle, watchdog_cb, ms, 0) != 0)
    fatal("watchdog_start");
}

/* ------------------------------------------------------------------ *
 * 1. uv_loop_alive() / uv_run() gating across handle states
 *    (fresh, initialised, active, closing/endgame, fully closed)
 * ------------------------------------------------------------------ */
static uv_timer_t g1_timer;
static int g1_close_calls;

static void g1_close_cb(uv_handle_t* handle) {
  (void) handle;
  g1_close_calls++;
}

static void check_loop_alive_states(void) {
  uv_loop_t* loop;

  loop = nl();
  g1_close_calls = 0;

  /* Nothing at all: the loop is not alive and every run mode returns at once
   * without entering an iteration. */
  check_i64("alive_fresh_loop", 0, uv_loop_alive(loop));
  check_i64("backend_timeout_fresh_loop", 0, uv_backend_timeout(loop));
  check_i64("run_nowait_fresh_loop", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("run_once_fresh_loop", 0, uv_run(loop, UV_RUN_ONCE));
  check_i64("run_default_fresh_loop", 0, uv_run(loop, UV_RUN_DEFAULT));

  /* An initialised but never started handle does not make a loop alive. */
  check_i64("alive_timer_init", 0, uv_timer_init(loop, &g1_timer));
  check_i64("alive_inactive_handle", 0, uv_loop_alive(loop));
  check_i64("run_nowait_inactive_handle", 0, uv_run(loop, UV_RUN_NOWAIT));

  /* A started (ref'd) handle does. */
  check_i64("alive_timer_start", 0, uv_timer_start(&g1_timer, noop_timer_cb, 0, 0));
  check_i64("alive_active_handle", 1, uv_loop_alive(loop));
  check_i64("backend_timeout_due_timer", 0, uv_backend_timeout(loop));

  /* Closing drops the handle out of the active set but keeps the loop alive
   * until the endgame pass has run the close callback. */
  uv_close((uv_handle_t*) &g1_timer, g1_close_cb);
  check_i64("alive_endgame_only", 1, uv_loop_alive(loop));
  check_i64("backend_timeout_endgame_only", 0, uv_backend_timeout(loop));

  /* One NOWAIT iteration drains the endgame list; the loop then reports dead
   * and uv_run() becomes a no-op again. */
  check_i64("run_nowait_drains_endgame", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("close_cb_called_once", 1, g1_close_calls);
  check_i64("alive_all_closed", 0, uv_loop_alive(loop));
  check_i64("backend_timeout_all_closed", 0, uv_backend_timeout(loop));
  check_i64("run_default_all_closed", 0, uv_run(loop, UV_RUN_DEFAULT));
  check_i64("run_nowait_all_closed", 0, uv_run(loop, UV_RUN_NOWAIT));
}

/* ------------------------------------------------------------------ *
 * 2. uv_backend_timeout(): the loop must not sleep when it has work
 * ------------------------------------------------------------------ */
static uv_timer_t g2_timer;
static uv_timer_t g2_closed;
static uv_idle_t g2_idle;
static int g2_close_calls;

static void g2_close_cb(uv_handle_t* handle) {
  (void) handle;
  g2_close_calls++;
}

static void check_backend_timeout_guards(void) {
  uv_loop_t* loop;

  loop = nl();
  g2_close_calls = 0;

  check_i64("backend_timeout_empty_loop_is_0", 0, uv_backend_timeout(loop));

  check_i64("backend_timer_init", 0, uv_timer_init(loop, &g2_timer));
  check_i64("backend_timeout_inactive_timer_is_0", 0, uv_backend_timeout(loop));
  check_i64("backend_timer_start", 0,
            uv_timer_start(&g2_timer, noop_timer_cb, 5000, 0));
  check_i64("backend_timeout_reports_timer_delay", 5000,
            uv_backend_timeout(loop));

  /* An idle handle means "keep spinning", so the timeout must collapse to 0
   * even though a timer is armed far in the future. */
  check_i64("backend_idle_init", 0, uv_idle_init(loop, &g2_idle));
  check_i64("backend_idle_start", 0, uv_idle_start(&g2_idle, noop_idle_cb));
  check_i64("backend_timeout_active_idle_is_0", 0, uv_backend_timeout(loop));
  check_i64("backend_idle_stop", 0, uv_idle_stop(&g2_idle));
  check_i64("backend_timeout_after_idle_stop", 5000,
            uv_backend_timeout(loop));

  /* A requested stop is another reason not to sleep. */
  uv_stop(loop);
  check_i64("backend_timeout_stop_requested_is_0", 0, uv_backend_timeout(loop));
  check_i64("run_nowait_clears_stop_flag", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_true("backend_timeout_positive_when_idle_and_armed",
             uv_backend_timeout(loop) > 0);
  check_i64("backend_alive_with_armed_timer", 1, uv_loop_alive(loop));

  /* A closed handle that still has to run its close callback keeps the loop
   * alive; the backend still must not sleep. */
  check_i64("backend_closed_timer_init", 0, uv_timer_init(loop, &g2_closed));
  check_i64("backend_closed_timer_start", 0,
            uv_timer_start(&g2_closed, noop_timer_cb, 100000, 0));
  uv_close((uv_handle_t*) &g2_closed, g2_close_cb);
  check_i64("backend_timeout_while_endgame_is_0", 0, uv_backend_timeout(loop));
  check_i64("run_nowait_processes_endgame", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("backend_close_cb_called_once", 1, g2_close_calls);

  check_i64("backend_timer_stop", 0, uv_timer_stop(&g2_timer));
  uv_close((uv_handle_t*) &g2_timer, NULL);
  check_i64("backend_drain_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("backend_alive_after_drain", 0, uv_loop_alive(loop));
}

/* ------------------------------------------------------------------ *
 * 3. uv_run(UV_RUN_NOWAIT) / uv_run(UV_RUN_ONCE): return value is the
 *    liveness of the loop and each call performs one iteration
 * ------------------------------------------------------------------ */
static uv_idle_t g3_idle;
static uv_prepare_t g3_prepare;
static uv_check_t g3_check;
static int g3_idle_calls;
static int g3_idle_limit;
static char g3_seq[SEQ_MAX];

static void g3_idle_cb(uv_idle_t* handle) {
  g3_idle_calls++;
  if (g3_idle_calls >= g3_idle_limit)
    uv_idle_stop(handle);
}

static void g3_prepare_cb(uv_prepare_t* handle) {
  (void) handle;
  app(g3_seq, sizeof(g3_seq), 'p');
}

static void g3_check_cb(uv_check_t* handle) {
  (void) handle;
  app(g3_seq, sizeof(g3_seq), 'c');
}

static void run_until_dead(uv_loop_t* loop, uv_run_mode mode,
                           const char* name, int* calls_out, int* last_out) {
  int calls;
  int r;

  calls = 0;
  r = 1;
  while (r != 0 && calls < 200) {
    r = uv_run(loop, mode);
    calls++;
  }
  if (calls >= 200)
    fatal(name);
  *calls_out = calls;
  *last_out = r;
}

static void check_run_mode_iterations(void) {
  uv_loop_t* loop;
  int calls;
  int last;

  /* NOWAIT: one iteration per call, and the return value flips to 0 on the
   * iteration that deactivates the last handle. */
  loop = nl();
  g3_idle_calls = 0;
  g3_idle_limit = 64;
  check_i64("nowait_idle_init", 0, uv_idle_init(loop, &g3_idle));
  check_i64("nowait_idle_start", 0, uv_idle_start(&g3_idle, g3_idle_cb));
  run_until_dead(loop, UV_RUN_NOWAIT, "nowait_iteration_budget", &calls, &last);
  check_i64("nowait_calls_until_dead", 64, calls);
  check_i64("nowait_idle_cb_calls", 64, g3_idle_calls);
  check_i64("nowait_final_return", 0, last);

  /* ONCE: same shape, the loop ends when the idle handle stops itself. */
  loop = nl();
  g3_idle_calls = 0;
  g3_idle_limit = 8;
  check_i64("once_idle_init", 0, uv_idle_init(loop, &g3_idle));
  check_i64("once_idle_start", 0, uv_idle_start(&g3_idle, g3_idle_cb));
  run_until_dead(loop, UV_RUN_ONCE, "once_iteration_budget", &calls, &last);
  check_i64("once_calls_until_dead", 8, calls);
  check_i64("once_idle_cb_calls", 8, g3_idle_calls);
  check_i64("once_final_return", 0, last);

  /* One NOWAIT iteration invokes prepare before check, exactly once each. */
  loop = nl();
  g3_seq[0] = '\0';
  check_i64("watcher_prepare_init", 0, uv_prepare_init(loop, &g3_prepare));
  check_i64("watcher_check_init", 0, uv_check_init(loop, &g3_check));
  check_i64("watcher_prepare_start", 0,
            uv_prepare_start(&g3_prepare, g3_prepare_cb));
  check_i64("watcher_check_start", 0, uv_check_start(&g3_check, g3_check_cb));
  check_i64("watcher_alive", 1, uv_loop_alive(loop));
  check_i64("watcher_run_nowait_1", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_str("watcher_first_pass_transcript", "pc", g3_seq);
  check_i64("watcher_run_nowait_2", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_str("watcher_second_pass_transcript", "pcpc", g3_seq);
  check_i64("watcher_still_alive", 1, uv_loop_alive(loop));

  uv_close((uv_handle_t*) &g3_prepare, NULL);
  uv_close((uv_handle_t*) &g3_check, NULL);
  check_i64("watcher_drain_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("watcher_alive_after_drain", 0, uv_loop_alive(loop));
}

/* ------------------------------------------------------------------ *
 * 4. UV_RUN_DEFAULT: timers are serviced before the first iteration
 *    (order of the first pass through the loop body)
 * ------------------------------------------------------------------ */
static uv_timer_t g4_timer;
static uv_timer_t g4_watchdog;
static uv_prepare_t g4_prepare;
static uv_check_t g4_check;
static char g4_seq[SEQ_MAX];
static int g4_timer_calls;

static void g4_timer_cb(uv_timer_t* handle) {
  g4_timer_calls++;
  app(g4_seq, sizeof(g4_seq), 'T');
  uv_close((uv_handle_t*) handle, NULL);
}

static void g4_prepare_cb(uv_prepare_t* handle) {
  (void) handle;
  app(g4_seq, sizeof(g4_seq), 'P');
}

static void g4_check_cb(uv_check_t* handle) {
  (void) handle;
  app(g4_seq, sizeof(g4_seq), 'C');
  uv_stop(handle->loop);
}

static void check_default_first_pass_order(void) {
  uv_loop_t* loop;

  loop = nl();
  g4_seq[0] = '\0';
  g4_timer_calls = 0;

  check_i64("default_order_prepare_init", 0, uv_prepare_init(loop, &g4_prepare));
  check_i64("default_order_check_init", 0, uv_check_init(loop, &g4_check));
  check_i64("default_order_prepare_start", 0,
            uv_prepare_start(&g4_prepare, g4_prepare_cb));
  check_i64("default_order_check_start", 0,
            uv_check_start(&g4_check, g4_check_cb));
  check_i64("default_order_timer_init", 0, uv_timer_init(loop, &g4_timer));
  check_i64("default_order_timer_start", 0,
            uv_timer_start(&g4_timer, g4_timer_cb, 0, 0));
  watchdog_arm(loop, &g4_watchdog, 800);

  check_i64("default_order_alive", 1, uv_loop_alive(loop));
  check_i64("default_order_stop_leaves_loop_alive", 1,
            uv_run(loop, UV_RUN_DEFAULT));
  check_i64("default_order_timer_cb_called_once", 1, g4_timer_calls);
  check_str("default_order_first_pass_transcript", "TPC", g4_seq);

  uv_close((uv_handle_t*) &g4_prepare, NULL);
  uv_close((uv_handle_t*) &g4_check, NULL);
  uv_close((uv_handle_t*) &g4_watchdog, NULL);
  check_i64("default_order_drain_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("default_order_alive_after_drain", 0, uv_loop_alive(loop));
}

/* ------------------------------------------------------------------ *
 * 5. pending-req queue (uv__poll -> uv__insert_pending_req ->
 *    uv__process_reqs): every queued wake-up is delivered exactly once,
 *    in the order it was posted
 * ------------------------------------------------------------------ */
static uv_async_t g5_a;
static uv_async_t g5_b;
static uv_async_t g5_c;
static char g5_seq[SEQ_MAX];
static int g5_total;

static void g5_a_cb(uv_async_t* handle) {
  (void) handle;
  app(g5_seq, sizeof(g5_seq), 'A');
  g5_total++;
}

static void g5_b_cb(uv_async_t* handle) {
  (void) handle;
  app(g5_seq, sizeof(g5_seq), 'B');
  g5_total++;
}

static void g5_c_cb(uv_async_t* handle) {
  (void) handle;
  app(g5_seq, sizeof(g5_seq), 'C');
  g5_total++;
}

static void check_pending_req_ring(void) {
  uv_loop_t* loop;

  loop = nl();
  g5_seq[0] = '\0';
  g5_total = 0;

  check_i64("pending_a_init", 0, uv_async_init(loop, &g5_a, g5_a_cb));
  check_i64("pending_b_init", 0, uv_async_init(loop, &g5_b, g5_b_cb));
  check_i64("pending_c_init", 0, uv_async_init(loop, &g5_c, g5_c_cb));
  check_i64("pending_loop_alive", 1, uv_loop_alive(loop));

  /* Three wake-ups are already queued by the time the loop polls. */
  check_i64("pending_send_a", 0, uv_async_send(&g5_a));
  check_i64("pending_send_b", 0, uv_async_send(&g5_b));
  check_i64("pending_send_c", 0, uv_async_send(&g5_c));
  check_i64("pending_run_nowait_returns_alive", 1,
            uv_run(loop, UV_RUN_NOWAIT));
  check_str("pending_wakeups_in_posted_order", "ABC", g5_seq);
  check_i64("pending_callbacks_once_each", 3, g5_total);

  /* Nothing is delivered twice by a later pass. */
  check_i64("pending_idle_pass_returns_alive", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_str("pending_no_redelivery", "ABC", g5_seq);
  check_i64("pending_total_unchanged", 3, g5_total);

  /* The queue must be reusable after it has been drained. */
  check_i64("pending_resend_a", 0, uv_async_send(&g5_a));
  check_i64("pending_resend_c", 0, uv_async_send(&g5_c));
  check_i64("pending_resend_run_returns_alive", 1,
            uv_run(loop, UV_RUN_NOWAIT));
  check_str("pending_resend_order", "ABCAC", g5_seq);
  check_i64("pending_resend_total", 5, g5_total);

  uv_close((uv_handle_t*) &g5_a, NULL);
  uv_close((uv_handle_t*) &g5_b, NULL);
  uv_close((uv_handle_t*) &g5_c, NULL);
  check_i64("pending_drain_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("pending_alive_after_drain", 0, uv_loop_alive(loop));
}

/* ------------------------------------------------------------------ *
 * 6. requests (not handles) keep a loop alive: an outstanding fs request
 *    on an otherwise empty loop
 * ------------------------------------------------------------------ */
static uv_fs_t g6_req;
static uv_timer_t g6_watchdog;
static int g6_calls;
static int g6_result;
static int g6_alive_in_cb;

static void g6_fs_cb(uv_fs_t* req) {
  g6_calls++;
  g6_result = (int) req->result;
  g6_alive_in_cb = uv_loop_alive(req->loop);
  uv_fs_req_cleanup(req);
  /* Drop the watchdog so the loop can finish in this same pass. */
  uv_close((uv_handle_t*) &g6_watchdog, NULL);
}

static void check_request_aliveness(void) {
  uv_loop_t* loop;

  loop = nl();
  g6_calls = 0;
  g6_result = -1234;
  g6_alive_in_cb = -1;

  check_i64("req_fs_stat_submitted", 0, uv_fs_stat(loop, &g6_req, ".", g6_fs_cb));
  check_i64("req_alive_with_outstanding_req", 1, uv_loop_alive(loop));
  /* Only a request is outstanding: the backend may block until it completes. */
  check_i64("req_backend_timeout_blocks_until_completion", -1,
            uv_backend_timeout(loop));

  /* An unref'd watchdog keeps the backend wait bounded without contributing
   * to the loop's liveness; it never fires while the request completes. */
  check_i64("req_watchdog_init", 0, uv_timer_init(loop, &g6_watchdog));
  check_i64("req_watchdog_start", 0,
            uv_timer_start(&g6_watchdog, watchdog_cb, 1000, 1000));
  uv_unref((uv_handle_t*) &g6_watchdog);
  check_i64("req_alive_with_unrefd_watchdog", 1, uv_loop_alive(loop));

  check_i64("req_default_run_returns_0", 0, uv_run(loop, UV_RUN_DEFAULT));
  check_i64("req_fs_cb_called_once", 1, g6_calls);
  check_i64("req_fs_stat_succeeded", 0, g6_result);
  check_i64("req_not_alive_inside_completed_cb", 0, g6_alive_in_cb);
  check_i64("req_alive_after_completion", 0, uv_loop_alive(loop));
  check_i64("req_backend_timeout_after_completion", 0, uv_backend_timeout(loop));
}

/* ------------------------------------------------------------------ *
 * 7. ref/unref accounting as seen by uv_run(): an unref'd loop never
 *    enters an iteration, even with a wake-up already queued
 * ------------------------------------------------------------------ */
static uv_async_t g7_async;
static int g7_calls;

static void g7_cb(uv_async_t* handle) {
  (void) handle;
  g7_calls++;
}

static void check_unref_gates_iteration(void) {
  uv_loop_t* loop;

  loop = nl();
  g7_calls = 0;

  check_i64("unref_async_init", 0, uv_async_init(loop, &g7_async, g7_cb));
  check_i64("unref_send", 0, uv_async_send(&g7_async));
  uv_unref((uv_handle_t*) &g7_async);
  check_i64("unref_loop_not_alive", 0, uv_loop_alive(loop));
  check_i64("unref_run_nowait_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("unref_run_once_returns_0", 0, uv_run(loop, UV_RUN_ONCE));
  check_i64("unref_no_iteration_ran", 0, g7_calls);

  uv_ref((uv_handle_t*) &g7_async);
  check_i64("ref_loop_alive_again", 1, uv_loop_alive(loop));
  check_i64("ref_run_nowait_returns_alive", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("ref_queued_wakeup_delivered", 1, g7_calls);

  uv_close((uv_handle_t*) &g7_async, NULL);
  check_i64("unref_drain_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("unref_alive_after_drain", 0, uv_loop_alive(loop));
}

/* ------------------------------------------------------------------ *
 * 8. uv_loop_close() refuses to close a loop that is still alive and
 *    succeeds once everything has been drained
 * ------------------------------------------------------------------ */
static uv_loop_t g8_loop;
static uv_timer_t g8_timer;
static int g8_stop_calls;
static int g8_close_calls;

static void g8_stop_cb(uv_timer_t* handle) {
  g8_stop_calls++;
  uv_stop(handle->loop);
}

static void g8_close_cb(uv_handle_t* handle) {
  (void) handle;
  g8_close_calls++;
}

static void check_loop_close_lifecycle(void) {
  g8_stop_calls = 0;
  g8_close_calls = 0;

  check_i64("close_loop_init", 0, uv_loop_init(&g8_loop));
  check_i64("close_timer_init", 0, uv_timer_init(&g8_loop, &g8_timer));
  check_i64("close_ebusy_with_open_handle", UV_EBUSY,
            uv_loop_close(&g8_loop));

  check_i64("close_timer_start", 0,
            uv_timer_start(&g8_timer, g8_stop_cb, 0, 1000));
  check_i64("close_loop_alive", 1, uv_loop_alive(&g8_loop));
  check_i64("close_default_run_stops_alive", 1,
            uv_run(&g8_loop, UV_RUN_DEFAULT));
  check_i64("close_stop_cb_called_once", 1, g8_stop_calls);
  check_i64("close_alive_after_stop", 1, uv_loop_alive(&g8_loop));

  uv_close((uv_handle_t*) &g8_timer, g8_close_cb);
  check_i64("close_ebusy_while_endgame", UV_EBUSY, uv_loop_close(&g8_loop));
  check_i64("close_alive_while_endgame", 1, uv_loop_alive(&g8_loop));
  check_i64("close_drain_returns_0", 0, uv_run(&g8_loop, UV_RUN_NOWAIT));
  check_i64("close_cb_called_once", 1, g8_close_calls);
  check_i64("close_alive_after_drain", 0, uv_loop_alive(&g8_loop));
  check_i64("close_loop_close_ok", 0, uv_loop_close(&g8_loop));
}

int main(void) {
  check_loop_alive_states();
  check_backend_timeout_guards();
  check_run_mode_iterations();
  check_default_first_pass_order();
  check_pending_req_ring();
  check_request_aliveness();
  check_unref_gates_iteration();
  check_loop_close_lifecycle();

  printf("%s: total_failures=%d\n", ORACLE, failures);
  return failures;
}
