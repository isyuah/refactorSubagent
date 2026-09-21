/* oracle_timer.c — behavior oracle for src/timer.c (libuv v1.52.1, win x64).
 *
 * Judged surface
 *   uv_timer_init / uv_timer_start / uv_timer_stop / uv_timer_again /
 *   uv_timer_set_repeat / uv_timer_get_repeat / uv_timer_get_due_in, the
 *   timer.c export uv__next_timeout(), and the pass structure of
 *   uv__run_timers() as observed through uv_run(loop, UV_RUN_NOWAIT).
 *
 * Why the stock suite is not enough
 *   test/test-timer.c pins one-shot and repeating firing, timer_order with two
 *   equal-timeout handles, huge timeout/repeat clamping, run_once, closing and
 *   NULL-callback rejection, no-double-call and unref.  It never pins
 *     1. the (timeout, start_id) tie-break for more than two equal-timeout
 *        handles in one pass, nor that a restarted handle moves to the tail;
 *     2. the two-phase snapshot: a timer that becomes due while another
 *        timer's callback runs must not run in that same pass;
 *     3. that uv_timer_stop() from a callback suppresses the callback already
 *        queued for a due handle, and that re-starting it does the same;
 *     4. uv_timer_get_due_in() across stop / set_repeat / re-arm, and
 *        uv__next_timeout()'s -1 / 0 / INT_MAX clamps.
 *
 * Determinism
 *   Every value compared below is a call order, a return value, or an exact
 *   difference against the loop's own loop->time, which uv_run() refreshes
 *   once per pass (uv_timer_start() anchors on the frozen value and never
 *   refreshes it).  Nothing sleeps and nothing measures wall time.
 */
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "uv.h"

/* Implemented in src/timer.c, declared in src/uv-common.h and called by
 * src/win/core.c and src/unix/core.c: part of timer.c's cross-TU contract. */
int uv__next_timeout(const uv_loop_t* loop);

#define ORACLE "timer-oracle"
#define MAX_LOOPS 16

static int oracle_failures;
static uv_loop_t loops[MAX_LOOPS];
static int loop_count;

static void check_u64(const char* name, uint64_t expected, uint64_t got) {
  if (expected != got) {
    oracle_failures++;
    printf("%s: %s FAIL expected=%llu got=%llu\n",
           ORACLE, name,
           (unsigned long long) expected, (unsigned long long) got);
  } else {
    printf("%s: %s ok\n", ORACLE, name);
  }
}

static void check_i64(const char* name, long long expected, long long got) {
  if (expected != got) {
    oracle_failures++;
    printf("%s: %s FAIL expected=%lld got=%lld\n", ORACLE, name, expected, got);
  } else {
    printf("%s: %s ok\n", ORACLE, name);
  }
}

static void check_str(const char* name, const char* expected, const char* got) {
  if (strcmp(expected, got) != 0) {
    oracle_failures++;
    printf("%s: %s FAIL expected=\"%s\" got=\"%s\"\n",
           ORACLE, name, expected, got);
  } else {
    printf("%s: %s ok\n", ORACLE, name);
  }
}

static void check_active(const char* name, int expected, const uv_handle_t* h) {
  check_i64(name, expected, uv_is_active(h));
}

static void fatal(const char* what) {
  printf("%s: %s FAIL expected=0 got=nonzero\n", ORACLE, what);
  oracle_failures++;
  printf("%s: total_failures=%d\n", ORACLE, oracle_failures);
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

/* Bounded append, used to build deterministic callback transcripts. */
static void app(char* out, size_t outlen, char c) {
  size_t used = strlen(out);
  if (used + 1 < outlen) {
    out[used] = c;
    out[used + 1] = '\0';
  }
}

static void noop_cb(uv_timer_t* handle) {
  (void) handle;
}

/* ------------------------------------------------------------------ *
 * 1. defaults + uv_timer_stop() idempotence on a never-started handle
 * ------------------------------------------------------------------ */
static void check_init_and_stop_defaults(void) {
  uv_loop_t* loop;
  uv_timer_t t;

  loop = nl();
  check_i64("init_returns_zero", 0, uv_timer_init(loop, &t));
  check_u64("init_repeat_is_zero", 0, uv_timer_get_repeat(&t));
  check_u64("init_due_in_is_zero", 0, uv_timer_get_due_in(&t));
  check_active("init_handle_inactive", 0, (uv_handle_t*) &t);
  check_i64("stop_never_started_returns_zero_1", 0, uv_timer_stop(&t));
  check_i64("stop_never_started_returns_zero_2", 0, uv_timer_stop(&t));
  check_i64("stop_never_started_returns_zero_3", 0, uv_timer_stop(&t));
  check_active("stop_never_started_keeps_inactive", 0, (uv_handle_t*) &t);
}

/* ------------------------------------------------------------------ *
 * 2. argument validation: NULL callback, closing handle
 * ------------------------------------------------------------------ */
static void check_start_validation(void) {
  uv_loop_t* loop;
  uv_timer_t null_cb;
  uv_timer_t closing;

  loop = nl();

  check_i64("start_null_cb_init", 0, uv_timer_init(loop, &null_cb));
  check_i64("start_null_cb_is_einval", UV_EINVAL,
            uv_timer_start(&null_cb, NULL, 100, 100));
  check_active("start_null_cb_left_inactive", 0, (uv_handle_t*) &null_cb);

  check_i64("start_closing_init", 0, uv_timer_init(loop, &closing));
  uv_close((uv_handle_t*) &closing, NULL);
  check_i64("start_closing_is_einval", UV_EINVAL,
            uv_timer_start(&closing, noop_cb, 1, 0));
  check_active("start_closing_left_inactive", 0, (uv_handle_t*) &closing);
  check_i64("stop_closing_returns_zero", 0, uv_timer_stop(&closing));
}

/* ------------------------------------------------------------------ *
 * 3. (timeout, start_id) heap order for equal and unequal timeouts
 * ------------------------------------------------------------------ */
static uv_timer_t order_t[6];
static char order_seq[32];

static void order_cb(uv_timer_t* handle) {
  app(order_seq, sizeof(order_seq),
      (char) ('0' + (int) (intptr_t) handle->data));
}

static void order_start(uv_loop_t* loop, int idx, uint64_t timeout) {
  order_t[idx].data = (void*) (intptr_t) idx;
  if (uv_timer_init(loop, &order_t[idx]) != 0)
    fatal("order_timer_init");
  if (uv_timer_start(&order_t[idx], order_cb, timeout, 0) != 0)
    fatal("order_timer_start");
}

static void check_order(void) {
  uv_loop_t* loop;
  char name[64];
  int i;

  loop = nl();
  order_seq[0] = '\0';

  /* Equal timeouts, started in ascending order: fire in start_id order. */
  for (i = 0; i < 6; i++)
    order_start(loop, i, 0);
  /* Every handle in the pass fires and stays one-shot: the loop is drained
   * by the end of the pass, so uv_run() reports no live handles. */
  check_i64("order_equal_pass1_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("order_equal_ascending", "012345", order_seq);
  for (i = 0; i < 6; i++) {
    snprintf(name, sizeof(name), "order_equal_drained_%d", i);
    check_active(name, 0, (uv_handle_t*) &order_t[i]);
  }

  /* Equal timeouts, restarted in descending order: start_id, not storage
   * order, decides. */
  order_seq[0] = '\0';
  for (i = 5; i >= 0; i--) {
    if (uv_timer_start(&order_t[i], order_cb, 0, 0) != 0)
      fatal("order_timer_restart");
  }
  check_i64("order_desc_pass1_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("order_equal_descending", "543210", order_seq);

  /* Large timeouts stay in the heap while the due ones drain; restarting a
   * handle re-inserts it with a fresh start_id. */
  order_seq[0] = '\0';
  order_start(loop, 0, 100000);
  order_start(loop, 1, 0);
  order_start(loop, 2, 100000);
  order_start(loop, 3, 0);
  check_i64("order_mixed_pass1_returns_1", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_str("order_mixed_only_due_fire", "13", order_seq);
  check_active("order_mixed_far_timer_still_active", 1,
               (uv_handle_t*) &order_t[0]);
  check_u64("order_mixed_far_due_in_unchanged", 100000,
            uv_timer_get_due_in(&order_t[0]));

  check_i64("order_mixed_restart_mid", 0,
            uv_timer_start(&order_t[2], order_cb, 0, 0));
  check_i64("order_mixed_pass2_returns_1", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_str("order_mixed_restart_fires_next", "132", order_seq);

  check_i64("order_mixed_restart_first", 0,
            uv_timer_start(&order_t[0], order_cb, 0, 0));
  check_i64("order_mixed_pass3_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("order_mixed_all_fired_in_order", "1320", order_seq);
}

/* ------------------------------------------------------------------ *
 * 4. two-phase snapshot: due timer started from a callback waits a pass
 * ------------------------------------------------------------------ */
static uv_timer_t snap_a;
static uv_timer_t snap_c;
static char snap_seq[16];
static int snap_c_calls;

static void snap_c_cb(uv_timer_t* handle) {
  (void) handle;
  snap_c_calls++;
  app(snap_seq, sizeof(snap_seq), 'C');
}

static void snap_a_cb(uv_timer_t* handle) {
  (void) handle;
  app(snap_seq, sizeof(snap_seq), 'A');
  if (uv_timer_start(&snap_c, snap_c_cb, 0, 0) != 0)
    fatal("snapshot_deferred_start");
}

static void check_snapshot(void) {
  uv_loop_t* loop;

  loop = nl();
  snap_seq[0] = '\0';
  snap_c_calls = 0;

  check_i64("snapshot_init_a", 0, uv_timer_init(loop, &snap_a));
  check_i64("snapshot_init_c", 0, uv_timer_init(loop, &snap_c));
  check_i64("snapshot_start_a", 0, uv_timer_start(&snap_a, snap_a_cb, 0, 0));

  check_i64("snapshot_pass1_returns_1", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_str("snapshot_pass1_runs_only_queued", "A", snap_seq);
  check_i64("snapshot_pass1_c_not_run", 0, snap_c_calls);
  check_u64("snapshot_pass1_c_due_in_zero", 0, uv_timer_get_due_in(&snap_c));
  check_active("snapshot_pass1_c_active", 1, (uv_handle_t*) &snap_c);

  check_i64("snapshot_pass2_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("snapshot_pass2_runs_deferred", "AC", snap_seq);
  check_i64("snapshot_pass2_c_ran_once", 1, snap_c_calls);

  check_i64("snapshot_pass3_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("snapshot_pass3_nothing_more", "AC", snap_seq);
  check_i64("snapshot_pass3_c_still_once", 1, snap_c_calls);
}

/* ------------------------------------------------------------------ *
 * 5. stop() from a callback suppresses a due handle's queued callback
 * ------------------------------------------------------------------ */
static uv_timer_t sup_s;
static uv_timer_t sup_t;
static int sup_t_calls;
static int sup_stop_rc;
static char sup_seq[16];

static void sup_t_cb(uv_timer_t* handle) {
  (void) handle;
  sup_t_calls++;
  app(sup_seq, sizeof(sup_seq), 'T');
}

static void sup_s_cb(uv_timer_t* handle) {
  (void) handle;
  app(sup_seq, sizeof(sup_seq), 'S');
  sup_stop_rc = uv_timer_stop(&sup_t);
}

static void check_stop_suppresses_queued(void) {
  uv_loop_t* loop;
  uv_timer_t late;

  loop = nl();
  sup_seq[0] = '\0';
  sup_t_calls = 0;
  sup_stop_rc = -1;

  check_i64("stop_suppress_init_s", 0, uv_timer_init(loop, &sup_s));
  check_i64("stop_suppress_init_t", 0, uv_timer_init(loop, &sup_t));
  check_i64("stop_suppress_start_s", 0,
            uv_timer_start(&sup_s, sup_s_cb, 0, 0));
  check_i64("stop_suppress_start_t", 0,
            uv_timer_start(&sup_t, sup_t_cb, 0, 0));

  check_i64("stop_suppress_pass1_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("stop_suppress_only_s_ran", "S", sup_seq);
  check_i64("stop_suppress_stop_rc", 0, sup_stop_rc);
  check_i64("stop_suppress_t_never_ran", 0, sup_t_calls);
  check_active("stop_suppress_t_inactive", 0, (uv_handle_t*) &sup_t);

  check_i64("stop_suppress_pass2_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("stop_suppress_no_catchup", "S", sup_seq);
  check_i64("stop_suppress_t_still_never_ran", 0, sup_t_calls);

  /* The suppressed handle must still be usable afterwards. */
  check_i64("stop_suppress_restart_t", 0,
            uv_timer_start(&sup_t, sup_t_cb, 0, 0));
  check_i64("stop_suppress_pass3_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("stop_suppress_restart_runs", "ST", sup_seq);
  check_i64("stop_suppress_t_ran_once", 1, sup_t_calls);

  /* Never-started handle, stopped twice before any use. */
  check_i64("stop_suppress_late_init", 0, uv_timer_init(loop, &late));
  check_i64("stop_suppress_late_stop_1", 0, uv_timer_stop(&late));
  check_i64("stop_suppress_late_stop_2", 0, uv_timer_stop(&late));
  check_i64("stop_suppress_late_start", 0,
            uv_timer_start(&late, sup_t_cb, 0, 0));
  check_i64("stop_suppress_pass4_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("stop_suppress_late_runs", "STT", sup_seq);
}

/* ------------------------------------------------------------------ *
 * 6. start() from a callback cancels the queued callback of the same pass
 * ------------------------------------------------------------------ */
static uv_timer_t re_a;
static uv_timer_t re_b;
static char re_seq[16];
static int re_restart_rc;

static void re_b_old_cb(uv_timer_t* handle) {
  (void) handle;
  app(re_seq, sizeof(re_seq), 'L');
}

static void re_b_new_cb(uv_timer_t* handle) {
  (void) handle;
  app(re_seq, sizeof(re_seq), 'N');
}

static void re_a_cb(uv_timer_t* handle) {
  (void) handle;
  app(re_seq, sizeof(re_seq), 'A');
  re_restart_rc = uv_timer_start(&re_b, re_b_new_cb, 0, 0);
}

static void check_restart_replaces_queued(void) {
  uv_loop_t* loop;

  loop = nl();
  re_seq[0] = '\0';
  re_restart_rc = -1;

  check_i64("restart_init_a", 0, uv_timer_init(loop, &re_a));
  check_i64("restart_init_b", 0, uv_timer_init(loop, &re_b));
  check_i64("restart_start_a", 0, uv_timer_start(&re_a, re_a_cb, 0, 0));
  check_i64("restart_start_b", 0, uv_timer_start(&re_b, re_b_old_cb, 0, 0));

  check_i64("restart_pass1_returns_1", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_str("restart_pass1_only_a", "A", re_seq);
  check_i64("restart_rc_zero", 0, re_restart_rc);
  check_active("restart_b_armed_again", 1, (uv_handle_t*) &re_b);
  check_u64("restart_b_due_in_zero", 0, uv_timer_get_due_in(&re_b));

  check_i64("restart_pass2_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("restart_pass2_new_cb_only", "AN", re_seq);
}

/* ------------------------------------------------------------------ *
 * 7. a handle restarted during a pass fires after the untouched due ones
 * ------------------------------------------------------------------ */
static uv_timer_t tail_p;
static uv_timer_t tail_q;
static uv_timer_t tail_r;
static char tail_seq[16];

static void tail_q_old_cb(uv_timer_t* handle) {
  (void) handle;
  app(tail_seq, sizeof(tail_seq), 'Q');
}

static void tail_q_new_cb(uv_timer_t* handle) {
  (void) handle;
  app(tail_seq, sizeof(tail_seq), 'q');
}

static void tail_r_cb(uv_timer_t* handle) {
  (void) handle;
  app(tail_seq, sizeof(tail_seq), 'R');
}

static void tail_p_cb(uv_timer_t* handle) {
  (void) handle;
  app(tail_seq, sizeof(tail_seq), 'P');
  if (uv_timer_start(&tail_q, tail_q_new_cb, 0, 0) != 0)
    fatal("tail_q_restart");
}

static void check_restart_moves_to_tail(void) {
  uv_loop_t* loop;

  loop = nl();
  tail_seq[0] = '\0';

  check_i64("tail_init_p", 0, uv_timer_init(loop, &tail_p));
  check_i64("tail_init_q", 0, uv_timer_init(loop, &tail_q));
  check_i64("tail_init_r", 0, uv_timer_init(loop, &tail_r));
  check_i64("tail_start_p", 0, uv_timer_start(&tail_p, tail_p_cb, 0, 0));
  check_i64("tail_start_q", 0, uv_timer_start(&tail_q, tail_q_old_cb, 0, 0));
  check_i64("tail_start_r", 0, uv_timer_start(&tail_r, tail_r_cb, 0, 0));

  check_i64("tail_pass1_returns_1", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_str("tail_pass1_skips_restarted", "PR", tail_seq);

  check_i64("tail_pass2_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_str("tail_pass2_restarted_last", "PRq", tail_seq);
}

/* ------------------------------------------------------------------ *
 * 8. uv_timer_again(): NULL callback, no repeat, re-arm anchor
 * ------------------------------------------------------------------ */
static uv_timer_t again_t;
static uv_timer_t again_never;

static void check_again_anchoring(void) {
  uv_loop_t* loop;

  loop = nl();

  check_i64("again_never_init", 0, uv_timer_init(loop, &again_never));
  check_i64("again_never_started_is_einval", UV_EINVAL,
            uv_timer_again(&again_never));

  check_i64("again_init", 0, uv_timer_init(loop, &again_t));
  check_i64("again_start", 0,
            uv_timer_start(&again_t, noop_cb, 100000, 7));
  check_u64("again_due_in_after_start", 100000, uv_timer_get_due_in(&again_t));
  check_active("again_active_after_start", 1, (uv_handle_t*) &again_t);
  check_i64("again_returns_zero", 0, uv_timer_again(&again_t));
  check_u64("again_rearms_at_loop_time_plus_repeat", 7,
            uv_timer_get_due_in(&again_t));
  check_i64("again_still_active", 1, uv_is_active((uv_handle_t*) &again_t));
  check_u64("again_repeat_unchanged", 7, uv_timer_get_repeat(&again_t));

  /* Again is idempotent for a repeating timer: same anchor, same value. */
  check_i64("again_second_call_returns_zero", 0, uv_timer_again(&again_t));
  check_u64("again_second_call_same_due_in", 7,
            uv_timer_get_due_in(&again_t));

  /* stop() leaves the last timeout in place ... */
  check_i64("again_stop_returns_zero", 0, uv_timer_stop(&again_t));
  check_active("again_stop_deactivates", 0, (uv_handle_t*) &again_t);
  check_u64("stop_keeps_previous_due_in", 7, uv_timer_get_due_in(&again_t));
  /* ... and again() re-arms even from the inactive state. */
  check_i64("again_after_stop_returns_zero", 0, uv_timer_again(&again_t));
  check_active("again_after_stop_rearms", 1, (uv_handle_t*) &again_t);
  check_u64("again_after_stop_due_in", 7, uv_timer_get_due_in(&again_t));

  /* Repeat 0: again() is accepted but arms nothing. */
  check_i64("again_zero_repeat_init", 0, uv_timer_init(loop, &again_t));
  check_i64("again_zero_repeat_start", 0,
            uv_timer_start(&again_t, noop_cb, 100000, 0));
  check_i64("again_zero_repeat_returns_zero", 0, uv_timer_again(&again_t));
  check_u64("again_zero_repeat_no_restart", 100000,
            uv_timer_get_due_in(&again_t));
  check_u64("again_zero_repeat_value", 0, uv_timer_get_repeat(&again_t));
}

/* ------------------------------------------------------------------ *
 * 9. repeating timer across passes: in-callback state, set_repeat
 * ------------------------------------------------------------------ */
static uv_timer_t rep_t;
static int rep_calls;
static int rep_active_in_cb;
static int rep_due_in_cb;
static int rep_repeat_in_cb;

static void rep_cb(uv_timer_t* handle) {
  rep_calls++;
  rep_active_in_cb = uv_is_active((uv_handle_t*) handle);
  rep_due_in_cb = (int) uv_timer_get_due_in(handle);
  rep_repeat_in_cb = (int) uv_timer_get_repeat(handle);
  if (rep_calls == 1)
    uv_timer_set_repeat(handle, 3);
  else
    uv_timer_stop(handle);
}

static void check_repeat_lifecycle(void) {
  uv_loop_t* loop;

  loop = nl();
  rep_calls = 0;
  rep_active_in_cb = -1;
  rep_due_in_cb = -1;
  rep_repeat_in_cb = -1;

  check_i64("repeat_init", 0, uv_timer_init(loop, &rep_t));
  check_i64("repeat_start", 0, uv_timer_start(&rep_t, rep_cb, 0, 7));

  check_i64("repeat_pass1_returns_1", 1, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("repeat_one_call_per_pass", 1, rep_calls);
  check_i64("repeat_active_during_cb", 1, rep_active_in_cb);
  check_i64("repeat_due_in_during_cb", 7, rep_due_in_cb);
  check_i64("repeat_value_during_cb", 7, rep_repeat_in_cb);
  check_u64("set_repeat_applied", 3, uv_timer_get_repeat(&rep_t));
  check_u64("set_repeat_not_retroactive", 7, uv_timer_get_due_in(&rep_t));
  check_active("repeat_still_active_after_cb", 1, (uv_handle_t*) &rep_t);

  check_i64("repeat_again_returns_zero", 0, uv_timer_again(&rep_t));
  check_u64("again_uses_updated_repeat", 3, uv_timer_get_due_in(&rep_t));

  /* Re-anchor at the frozen loop time so the next pass is deterministic. */
  check_i64("repeat_rearm_stop", 0, uv_timer_stop(&rep_t));
  check_i64("repeat_rearm_start", 0, uv_timer_start(&rep_t, rep_cb, 0, 3));
  check_i64("repeat_pass2_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("repeat_two_calls_total", 2, rep_calls);
  check_i64("repeat_due_in_during_cb2", 3, rep_due_in_cb);
  check_i64("repeat_repeat_during_cb2", 3, rep_repeat_in_cb);
  check_active("repeat_stopped_inside_cb", 0, (uv_handle_t*) &rep_t);
  /* stop() removes the handle from the heap but keeps the timeout it was
   * last armed with. */
  check_u64("repeat_stop_keeps_armed_due_in", 3, uv_timer_get_due_in(&rep_t));

  check_i64("repeat_pass3_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("repeat_never_fires_again", 2, rep_calls);
}

/* ------------------------------------------------------------------ *
 * 10. one-shot timer state while its callback runs + again() afterwards
 * ------------------------------------------------------------------ */
static uv_timer_t once_t;
static int once_calls;
static int once_active_in_cb;
static int once_due_in_cb;
static int once_repeat_in_cb;

static void once_cb(uv_timer_t* handle) {
  once_calls++;
  once_active_in_cb = uv_is_active((uv_handle_t*) handle);
  once_due_in_cb = (int) uv_timer_get_due_in(handle);
  once_repeat_in_cb = (int) uv_timer_get_repeat(handle);
}

static void check_one_shot_state(void) {
  uv_loop_t* loop;

  loop = nl();
  once_calls = 0;
  once_active_in_cb = -1;
  once_due_in_cb = -1;
  once_repeat_in_cb = -1;

  check_i64("once_init", 0, uv_timer_init(loop, &once_t));
  check_i64("once_start", 0, uv_timer_start(&once_t, once_cb, 0, 0));
  check_active("once_active_before_run", 1, (uv_handle_t*) &once_t);

  check_i64("once_pass1_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("once_call_count", 1, once_calls);
  check_i64("once_inactive_during_cb", 0, once_active_in_cb);
  check_i64("once_due_in_zero_during_cb", 0, once_due_in_cb);
  check_i64("once_repeat_zero_during_cb", 0, once_repeat_in_cb);
  check_active("once_inactive_after_run", 0, (uv_handle_t*) &once_t);
  check_u64("once_due_in_zero_after_run", 0, uv_timer_get_due_in(&once_t));

  check_i64("once_again_returns_zero", 0, uv_timer_again(&once_t));
  check_i64("once_pass2_returns_0", 0, uv_run(loop, UV_RUN_NOWAIT));
  check_i64("once_no_replay", 1, once_calls);
}

/* ------------------------------------------------------------------ *
 * 11. uv__next_timeout(): -1 / 0 / ms / INT_MAX clamps
 * ------------------------------------------------------------------ */
static void check_next_timeout(void) {
  uv_loop_t* loop;
  uv_timer_t a;
  uv_timer_t b;
  uv_timer_t c;
  uv_timer_t huge;
  uv_timer_t overflow;

  loop = nl();

  check_i64("next_timeout_empty_heap_is_minus_one", -1,
            uv__next_timeout(loop));

  check_i64("next_timeout_init_a", 0, uv_timer_init(loop, &a));
  check_i64("next_timeout_start_a", 0, uv_timer_start(&a, noop_cb, 1, 0));
  check_u64("due_in_after_start_1ms", 1, uv_timer_get_due_in(&a));
  check_i64("next_timeout_reports_1ms", 1, uv__next_timeout(loop));

  check_i64("next_timeout_init_b", 0, uv_timer_init(loop, &b));
  check_i64("next_timeout_start_b", 0, uv_timer_start(&b, noop_cb, 0, 0));
  check_u64("due_in_zero_timeout", 0, uv_timer_get_due_in(&b));
  check_i64("next_timeout_zero_when_min_is_due", 0, uv__next_timeout(loop));

  check_i64("next_timeout_init_c", 0, uv_timer_init(loop, &c));
  check_i64("next_timeout_start_c", 0, uv_timer_start(&c, noop_cb, 5000, 0));
  check_u64("due_in_after_start_5000ms", 5000, uv_timer_get_due_in(&c));
  check_i64("next_timeout_still_zero", 0, uv__next_timeout(loop));

  check_i64("next_timeout_stop_b", 0, uv_timer_stop(&b));
  check_i64("next_timeout_after_stop_of_zero", 1, uv__next_timeout(loop));
  check_i64("next_timeout_stop_a", 0, uv_timer_stop(&a));
  check_i64("next_timeout_after_stop_of_one", 5000, uv__next_timeout(loop));

  check_i64("next_timeout_init_huge", 0, uv_timer_init(loop, &huge));
  check_i64("next_timeout_start_huge", 0,
            uv_timer_start(&huge, noop_cb, 0xffffffffffffLL, 0));
  check_u64("due_in_huge_timeout", 281474976710655ULL,
            uv_timer_get_due_in(&huge));
  check_i64("next_timeout_huge_not_min", 5000, uv__next_timeout(loop));
  check_i64("next_timeout_stop_c", 0, uv_timer_stop(&c));
  check_i64("next_timeout_huge_clamped_to_int_max", INT_MAX,
            uv__next_timeout(loop));

  check_i64("next_timeout_init_overflow", 0, uv_timer_init(loop, &overflow));
  check_i64("next_timeout_start_overflow", 0,
            uv_timer_start(&overflow, noop_cb, (uint64_t) -1, 0));
  check_u64("due_in_overflow_saturates_to_uint64_max",
            (uint64_t) -1 - uv_now(loop),
            uv_timer_get_due_in(&overflow));
  check_i64("next_timeout_stop_huge", 0, uv_timer_stop(&huge));
  check_i64("next_timeout_overflow_clamped_to_int_max", INT_MAX,
            uv__next_timeout(loop));
  check_i64("next_timeout_stop_overflow", 0, uv_timer_stop(&overflow));
  check_i64("next_timeout_back_to_minus_one", -1, uv__next_timeout(loop));
}

/* ------------------------------------------------------------------ *
 * 12. unref'd timers are not run by UV_RUN_DEFAULT
 * ------------------------------------------------------------------ */
static uv_timer_t unref_t;
static int unref_calls;

static void unref_cb(uv_timer_t* handle) {
  (void) handle;
  unref_calls++;
}

static void check_unref(void) {
  uv_loop_t* loop;

  loop = nl();
  unref_calls = 0;

  check_i64("unref_init", 0, uv_timer_init(loop, &unref_t));
  check_i64("unref_start", 0, uv_timer_start(&unref_t, unref_cb, 0, 0));
  check_active("unref_active", 1, (uv_handle_t*) &unref_t);
  uv_unref((uv_handle_t*) &unref_t);
  check_i64("unref_run_default_returns_0", 0, uv_run(loop, UV_RUN_DEFAULT));
  check_i64("unref_not_run", 0, unref_calls);

  uv_ref((uv_handle_t*) &unref_t);
  check_i64("ref_run_default_returns_0", 0, uv_run(loop, UV_RUN_DEFAULT));
  check_i64("ref_then_run", 1, unref_calls);
}

int main(void) {
  check_init_and_stop_defaults();
  check_start_validation();
  check_order();
  check_snapshot();
  check_stop_suppresses_queued();
  check_restart_replaces_queued();
  check_restart_moves_to_tail();
  check_again_anchoring();
  check_repeat_lifecycle();
  check_one_shot_state();
  check_next_timeout();
  check_unref();

  printf("%s: total_failures=%d\n", ORACLE, oracle_failures);
  return oracle_failures == 0 ? 0 : 1;
}
