/* oracle_threadpool.c — behavior oracle for src/threadpool.c (libuv v1.52.1, win x64).
 *
 * Scope: the work-request lifecycle and the uv_cancel() protocol —
 *   uv_queue_work() argument validation, work_cb/after_work_cb threading and
 *   ordering, the request-type switch of uv_cancel(), the three cancel
 *   outcomes (pending -> 0 with UV_ECANCELED delivered, executing -> UV_EBUSY,
 *   finished -> UV_EBUSY), repeated cancel, the work-queue state protocol that
 *   uv_cancel()/uv__work_done() agree on, and the UV_THREADPOOL_SIZE-driven
 *   worker count.
 *
 * Determinism: the pool is pinned to a single worker (UV_THREADPOOL_SIZE=1 is
 * exported before the pool is first used), so "a request submitted while
 * another one executes is still queued" is a structural invariant rather than
 * a timing guess; every work_cb blocks on a semaphore that only this thread
 * posts, so each cancel decision is taken at a state this program establishes
 * itself.  The loop is driven with bounded UV_RUN_NOWAIT spins that wait on
 * state, never on wall time (uv_sleep() is used only to reschedule, and only
 * after the spin has already observed progress).  Each round is repeated three
 * times to show the conclusions are stable.
 *
 * Not covered (cannot be made deterministic here, see the accompanying
 * report): the UV_THREADPOOL_SIZE clamps other than "1" (init_threads() runs
 * once per process and uv_once is never reset on Windows, so only one value is
 * observable per process) and the slow-I/O concurrency threshold
 * (slow_work_thread_threshold()) — the only slow-I/O producers are
 * uv_getaddrinfo()/uv_getnameinfo(), whose work_cb cannot be held in a
 * controlled state, so "two slow requests run at once" is not constructible
 * without DNS and wall-clock guesses.  The queueing and cancellation of a
 * pending slow-I/O request *are* covered.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "uv.h"

/* The pool's private queue helpers: uv__work.wq is the state both uv_cancel()
 * and the worker agree on (include/uv/threadpool.h). */
#include "queue.h"

#define ORACLE "threadpool-oracle"
#define ROUNDS 3

/* Bounded loop drains: a pass is cheap, and the bound only turns "never
 * happens" into a failed check instead of a hang. */
#define SPINS 20000
/* Bounded "work_cb has started" waits (millisecond sleeps); 2s is far above
 * any plausible scheduling delay for an idle pool thread. */
#define START_SPINS 2000

static int oracle_failures;
static uv_thread_t caller_thread;
static uv_loop_t loop_storage;
static uv_loop_t* loop;
static uv_req_t unsupported_req;
static int done_seq;

static int fs_done_calls;
static long long fs_result;

static int gai_done_calls;
static int gai_status;
static void* gai_result;

static void fatal(const char* what) {
  oracle_failures++;
  printf("%s: %s FAIL (oracle cannot continue)\n", ORACLE, what);
  printf("%s: total_failures=%d\n", ORACLE, oracle_failures);
  exit(oracle_failures);
}

static void check_i64(const char* name, long long expected, long long got) {
  if (expected != got) {
    oracle_failures++;
    printf("%s: %s FAIL expected=%lld got=%lld\n", ORACLE, name, expected, got);
  } else {
    printf("%s: %s ok\n", ORACLE, name);
  }
}

/* Round-qualified check name. */
static const char* rn(char* buf, size_t len, int round, const char* name) {
  snprintf(buf, len, "r%d_%s", round, name);
  return buf;
}

/* ------------------------------------------------------------------ *
 * work items: work_cb blocks until the loop thread posts |release|
 * ------------------------------------------------------------------ */
typedef struct item {
  uv_work_t req;
  uv_sem_t started;
  uv_sem_t release;
  int block;
  int work_calls;
  int done_calls;
  int last_status;
  int done_order;
  int alive_in_done;
  uv_thread_t work_thread;
  uv_thread_t done_thread;
} item_t;

static void item_init(item_t* it, int block) {
  memset(it, 0, sizeof(*it));
  it->block = block;
  it->req.data = it;
  if (uv_sem_init(&it->started, 0) != 0)
    fatal("uv_sem_init");
  if (uv_sem_init(&it->release, 0) != 0)
    fatal("uv_sem_init");
}

static void work_cb(uv_work_t* req) {
  item_t* it = req->data;

  it->work_thread = uv_thread_self();
  it->work_calls++;
  uv_sem_post(&it->started);
  if (it->block)
    uv_sem_wait(&it->release);
}

static void after_cb(uv_work_t* req, int status) {
  item_t* it = req->data;

  it->done_thread = uv_thread_self();
  it->last_status = status;
  it->alive_in_done = uv_loop_alive(req->loop);
  it->done_order = ++done_seq;
  it->done_calls++;
  /* Nothing can touch these any more: work_cb has returned (or never ran). */
  uv_sem_destroy(&it->started);
  uv_sem_destroy(&it->release);
}

/* Blocks (bounded) until work_cb has begun; pairs with the post inside work_cb
 * so the fields written by the worker are ordered before we read them. */
static int wait_started(item_t* it) {
  int i;

  for (i = 0; i < START_SPINS && it->work_calls == 0; i++)
    uv_sleep(1);

  if (it->work_calls == 0)
    return 0;

  uv_sem_wait(&it->started);
  return 1;
}

/* Drives the loop until |*flag == want| (or the bound is hit); returns *flag. */
static int drain_flag(const int* flag, int want) {
  int i;

  for (i = 0; i < SPINS && *flag != want; i++) {
    uv_run(loop, UV_RUN_NOWAIT);
    if ((i & 1023) == 1023)
      uv_sleep(1);
  }

  return *flag;
}

/* Drives the loop until it has no active requests/handles left. */
static int drain_dead(void) {
  int i;

  for (i = 0; i < SPINS && uv_loop_alive(loop) != 0; i++) {
    uv_run(loop, UV_RUN_NOWAIT);
    if ((i & 1023) == 1023)
      uv_sleep(1);
  }

  return uv_loop_alive(loop) != 0;
}

static void fs_cb(uv_fs_t* req) {
  fs_result = req->result;
  fs_done_calls++;
}

static void gai_cb(uv_getaddrinfo_t* req, int status, struct addrinfo* res) {
  gai_status = status;
  gai_result = res;
  gai_done_calls++;
}

/* ------------------------------------------------------------------ *
 * one round of the lifecycle/cancel protocol
 * ------------------------------------------------------------------ */
static void run_round(int r) {
  item_t a;
  item_t p;
  item_t n;
  item_t f0;
  item_t f1;
  item_t f2;
  uv_fs_t fs;
  uv_getaddrinfo_t gai;
  struct addrinfo hints;
  uv_thread_t work_thread;
  char nm[192];
  int rc;

  /* --- argument validation (no pool interaction) ------------------ */
  check_i64(rn(nm, sizeof nm, r, "queue_work_null_work_cb_is_einval"),
            UV_EINVAL, uv_queue_work(loop, &a.req, NULL, after_cb));

  memset(&unsupported_req, 0, sizeof unsupported_req);
  unsupported_req.type = UV_WRITE;
  check_i64(rn(nm, sizeof nm, r, "cancel_write_req_is_einval"),
            UV_EINVAL, uv_cancel(&unsupported_req));
  unsupported_req.type = UV_UNKNOWN_REQ;
  check_i64(rn(nm, sizeof nm, r, "cancel_unknown_req_is_einval"),
            UV_EINVAL, uv_cancel(&unsupported_req));

  /* --- submit a work item that blocks inside work_cb -------------- */
  item_init(&a, 1);
  memset(&work_thread, 0, sizeof work_thread);
  check_i64(rn(nm, sizeof nm, r, "queue_work_returns_0"),
            0, uv_queue_work(loop, &a.req, work_cb, after_cb));
  check_i64(rn(nm, sizeof nm, r, "queued_req_type_is_uv_work"),
            UV_WORK, a.req.type);
  /* The pool may already have picked the request up, so its queue state is
     only inspected where a busy worker makes "still queued" structural. */
  check_i64(rn(nm, sizeof nm, r, "pending_req_carries_work_pointer"),
            1, a.req.work_req.work != NULL);
  check_i64(rn(nm, sizeof nm, r, "loop_alive_while_work_is_pending"),
            1, uv_loop_alive(loop) != 0);

  check_i64(rn(nm, sizeof nm, r, "work_cb_started"), 1, wait_started(&a));
  check_i64(rn(nm, sizeof nm, r, "work_cb_ran_once"), 1, a.work_calls);
  check_i64(rn(nm, sizeof nm, r, "work_cb_off_loop_thread"),
            1, !uv_thread_equal(&a.work_thread, &caller_thread));
  check_i64(rn(nm, sizeof nm, r, "after_work_cb_not_called_while_running"),
            0, a.done_calls);
  check_i64(rn(nm, sizeof nm, r, "executing_req_unlinked_from_work_queue"),
            1, uv__queue_empty(&a.req.work_req.wq));

  rc = uv_cancel((uv_req_t*) &a.req);
  check_i64(rn(nm, sizeof nm, r, "cancel_executing_req_is_ebusy"), UV_EBUSY, rc);
  if (rc != UV_EBUSY) {
    /* Without the "executing" marker the request ends up queued in the loop
       twice and draining would never terminate: report and stop here. */
    fatal("cancel_executing_req_protocol_broken");
  }

  /* --- a request queued behind the busy worker is cancellable ----- */
  item_init(&p, 1);
  check_i64(rn(nm, sizeof nm, r, "queue_second_blocked_work_returns_0"),
            0, uv_queue_work(loop, &p.req, work_cb, after_cb));
  check_i64(rn(nm, sizeof nm, r, "second_work_stays_queued_while_busy_1_worker"),
            1, !uv__queue_empty(&p.req.work_req.wq));
  check_i64(rn(nm, sizeof nm, r, "second_work_cb_has_not_started"),
            0, p.work_calls);
  check_i64(rn(nm, sizeof nm, r, "cancel_pending_req_returns_0"),
            0, uv_cancel((uv_req_t*) &p.req));
  check_i64(rn(nm, sizeof nm, r, "cancelled_req_keeps_work_pointer"),
            1, p.req.work_req.work != NULL);
  check_i64(rn(nm, sizeof nm, r, "repeat_cancel_pending_req_returns_0"),
            0, uv_cancel((uv_req_t*) &p.req));
  check_i64(rn(nm, sizeof nm, r, "cancelled_req_keeps_loop_alive"),
            1, uv_loop_alive(loop) != 0);

  uv_sem_post(&p.release);  /* no-op if the cancel won; lets it finish if not */
  check_i64(rn(nm, sizeof nm, r, "cancelled_after_work_cb_called"),
            1, drain_flag(&p.done_calls, 1));
  check_i64(rn(nm, sizeof nm, r, "cancelled_after_work_status_ecanceled"),
            UV_ECANCELED, p.last_status);
  check_i64(rn(nm, sizeof nm, r, "cancelled_after_work_cb_called_once"),
            1, p.done_calls);
  check_i64(rn(nm, sizeof nm, r, "cancelled_work_cb_never_ran"),
            0, p.work_calls);

  /* --- the same protocol for an fs (fast I/O) request ------------- */
  memset(&fs, 0, sizeof fs);
  fs_done_calls = 0;
  fs_result = 0;
  check_i64(rn(nm, sizeof nm, r, "fs_open_returns_0"),
            0, uv_fs_open(loop, &fs, "oracle-no-such-file", UV_FS_O_RDONLY,
                          0, fs_cb));
  check_i64(rn(nm, sizeof nm, r, "fs_req_stays_queued_while_busy"),
            1, !uv__queue_empty(&fs.work_req.wq));
  check_i64(rn(nm, sizeof nm, r, "cancel_pending_fs_req_returns_0"),
            0, uv_cancel((uv_req_t*) &fs));
  check_i64(rn(nm, sizeof nm, r, "cancelled_fs_cb_called"),
            1, drain_flag(&fs_done_calls, 1));
  check_i64(rn(nm, sizeof nm, r, "cancelled_fs_result_ecanceled"),
            UV_ECANCELED, fs_result);
  uv_fs_req_cleanup(&fs);

  /* --- the same protocol for a slow-I/O request ------------------- */
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_NUMERICHOST;
  memset(&gai, 0, sizeof gai);
  gai_done_calls = 0;
  gai_status = 0;
  gai_result = NULL;
  check_i64(rn(nm, sizeof nm, r, "getaddrinfo_returns_0"),
            0, uv_getaddrinfo(loop, &gai, gai_cb, "127.0.0.1", "80", &hints));
  check_i64(rn(nm, sizeof nm, r, "slow_io_req_stays_queued_while_busy"),
            1, !uv__queue_empty(&gai.work_req.wq));
  check_i64(rn(nm, sizeof nm, r, "cancel_pending_slow_io_req_returns_0"),
            0, uv_cancel((uv_req_t*) &gai));
  check_i64(rn(nm, sizeof nm, r, "cancelled_getaddrinfo_cb_called"),
            1, drain_flag(&gai_done_calls, 1));
  check_i64(rn(nm, sizeof nm, r, "cancelled_getaddrinfo_status_eai_canceled"),
            UV_EAI_CANCELED, gai_status);
  check_i64(rn(nm, sizeof nm, r, "cancelled_getaddrinfo_result_null"),
            0, gai_result != NULL);

  /* --- let the blocked request run to completion ------------------ */
  uv_sem_post(&a.release);
  check_i64(rn(nm, sizeof nm, r, "completed_after_work_cb_called"),
            1, drain_flag(&a.done_calls, 1));
  check_i64(rn(nm, sizeof nm, r, "completed_after_work_status_is_0"),
            0, a.last_status);
  check_i64(rn(nm, sizeof nm, r, "completed_after_work_cb_called_once"),
            1, a.done_calls);
  check_i64(rn(nm, sizeof nm, r, "completed_work_cb_ran_once"),
            1, a.work_calls);
  check_i64(rn(nm, sizeof nm, r, "after_work_cb_on_loop_thread"),
            1, uv_thread_equal(&a.done_thread, &caller_thread));
  check_i64(rn(nm, sizeof nm, r, "req_unregistered_before_after_work_cb"),
            0, a.alive_in_done);
  check_i64(rn(nm, sizeof nm, r, "finished_req_has_no_work_pointer"),
            0, a.req.work_req.work != NULL);
  check_i64(rn(nm, sizeof nm, r, "cancel_finished_req_is_ebusy"),
            UV_EBUSY, uv_cancel((uv_req_t*) &a.req));
  check_i64(rn(nm, sizeof nm, r, "loop_alive_is_0_with_no_work_left"),
            0, uv_loop_alive(loop));

  /* --- NULL after_work_cb ---------------------------------------- */
  item_init(&n, 0);
  check_i64(rn(nm, sizeof nm, r, "queue_work_null_after_work_cb_returns_0"),
            0, uv_queue_work(loop, &n.req, work_cb, NULL));
  check_i64(rn(nm, sizeof nm, r, "null_after_work_cb_loop_goes_idle"),
            0, drain_dead());
  check_i64(rn(nm, sizeof nm, r, "null_after_work_cb_work_still_ran"),
            1, n.work_calls);
  check_i64(rn(nm, sizeof nm, r, "null_after_work_cb_never_called"),
            0, n.done_calls);
  uv_sem_destroy(&n.started);
  uv_sem_destroy(&n.release);

  /* --- three queued requests run one after another, in order ------ */
  item_init(&f0, 1);
  item_init(&f1, 1);
  item_init(&f2, 1);
  check_i64(rn(nm, sizeof nm, r, "queue_trio_0_returns_0"),
            0, uv_queue_work(loop, &f0.req, work_cb, after_cb));
  check_i64(rn(nm, sizeof nm, r, "queue_trio_1_returns_0"),
            0, uv_queue_work(loop, &f1.req, work_cb, after_cb));
  check_i64(rn(nm, sizeof nm, r, "queue_trio_2_returns_0"),
            0, uv_queue_work(loop, &f2.req, work_cb, after_cb));
  check_i64(rn(nm, sizeof nm, r, "trio_first_started"), 1, wait_started(&f0));
  check_i64(rn(nm, sizeof nm, r, "trio_second_not_started_while_first_runs"),
            0, f1.work_calls);
  check_i64(rn(nm, sizeof nm, r, "trio_third_not_started_while_first_runs"),
            0, f2.work_calls);

  uv_sem_post(&f0.release);
  check_i64(rn(nm, sizeof nm, r, "trio_second_started_after_first_was_released"),
            1, wait_started(&f1));
  check_i64(rn(nm, sizeof nm, r, "trio_third_not_started_while_second_runs"),
            0, f2.work_calls);
  check_i64(rn(nm, sizeof nm, r, "trio_first_done"), 1, drain_flag(&f0.done_calls, 1));
  check_i64(rn(nm, sizeof nm, r, "trio_first_status_is_0"), 0, f0.last_status);

  uv_sem_post(&f1.release);
  check_i64(rn(nm, sizeof nm, r, "trio_third_started_after_second_was_released"),
            1, wait_started(&f2));
  check_i64(rn(nm, sizeof nm, r, "trio_second_done"), 1, drain_flag(&f1.done_calls, 1));
  check_i64(rn(nm, sizeof nm, r, "trio_second_status_is_0"), 0, f1.last_status);
  check_i64(rn(nm, sizeof nm, r, "trio_done_callbacks_in_work_order_1"),
            1, f0.done_order < f1.done_order);

  uv_sem_post(&f2.release);
  check_i64(rn(nm, sizeof nm, r, "trio_third_done"), 1, drain_flag(&f2.done_calls, 1));
  check_i64(rn(nm, sizeof nm, r, "trio_third_status_is_0"), 0, f2.last_status);
  check_i64(rn(nm, sizeof nm, r, "trio_done_callbacks_in_work_order_2"),
            1, f1.done_order < f2.done_order);
  check_i64(rn(nm, sizeof nm, r, "trio_first_work_ran_once"), 1, f0.work_calls);
  check_i64(rn(nm, sizeof nm, r, "trio_second_work_ran_once"), 1, f1.work_calls);
  check_i64(rn(nm, sizeof nm, r, "trio_third_work_ran_once"), 1, f2.work_calls);
  check_i64(rn(nm, sizeof nm, r, "loop_idle_after_trio"), 0, drain_dead());
}

int main(void) {
  int r;

  /* Pin the pool to a single worker before it is first used: the checks below
   * rely on it (UV_THREADPOOL_SIZE is read once, in init_threads()). */
  if (uv_os_setenv("UV_THREADPOOL_SIZE", "1") != 0)
    fatal("uv_os_setenv");

  caller_thread = uv_thread_self();
  loop = &loop_storage;
  if (uv_loop_init(loop) != 0)
    fatal("uv_loop_init");

  for (r = 1; r <= ROUNDS; r++)
    run_round(r);

  /* Every request unregistered itself: the loop has nothing left to close. */
  check_i64("loop_close_after_all_rounds", 0, uv_loop_close(loop));

  printf("%s: total_failures=%d\n", ORACLE, oracle_failures);
  return oracle_failures;
}
