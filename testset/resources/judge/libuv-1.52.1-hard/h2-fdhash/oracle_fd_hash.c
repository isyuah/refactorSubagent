/* oracle_fd_hash.c — behavior oracle for the uv__fd_hash* table
 * (fd -> file mapping info) in src/win/fs-fd-hash-inl.h.
 *
 * What this file is: the table maps a libuv file descriptor to the file
 * mapping / read-write cursor state that winsock-overlapped file I/O needs
 * when UV_FS_O_FILEMAP is set (13 call sites in src/win/fs.c: the open,
 * read, write, fstat and close paths). Every one of those call sites trusts
 * uv__fd_hash_get() to answer "no such fd" for a descriptor that is not in
 * the table, so a lookup that returns a stale entry hands fs.c a bogus
 * HANDLE to read from or to CloseHandle().
 *
 * The shipped case (test/test-fs-fd-hash.c, `fs_fd_hash`) only ever touches
 * buckets 0, 1 and 2 (which is why the table has 256 of them), and it never
 * looks at a fd->info round trip beyond `flags`. This oracle drives the same
 * header directly with real calls, but pins the invariants that survive a
 * refactor of the group bookkeeping:
 *
 *   - an empty bucket must never answer with an entry: the first group of a
 *     bucket is a statically allocated array that still holds the slots of
 *     descriptors that were removed (a removal only copies the last live
 *     slot over the removed one; it never clears the vacated slot), so the
 *     number of slots a lookup may inspect is bounded by the live count and
 *     MUST be 0 for an empty bucket;
 *   - when a bucket holds a whole number of full groups (size % GROUP == 0,
 *     size != 0) the first group is completely live although the modulo
 *     yields 0 — a lookup that forgets this skips GROUP_SIZE live entries;
 *   - removing an entry must move the group's last live entry into the
 *     vacated slot (no entry may be dropped, the size counter is the only
 *     record of how many slots are live), and a group may only be released
 *     once it no longer holds a live entry;
 *   - a repeated add of a live fd updates its info in place (exactly one
 *     removal is then enough), and a removal followed by a re-add of the
 *     same fd must not resurrect any neighbouring entry;
 *   - lookups and removals are confined to one bucket: fd and fd +/- 256
 *     (UV__FD_HASH_SIZE) are independent, even when they are 16 (or any
 *     multiple of UV__FD_HASH_GROUP_SIZE) entries apart inside a bucket.
 *
 * Frozen against libuv v1.52.1 (commit 1cfa32f), Windows 11 x64, MinGW GCC
 * 15.2. The oracle is single threaded on purpose: the table's mutex is only
 * there to keep the 13 fs.c call sites from interleaving, it is not part of
 * the observable contract of a single thread.
 */

#include <stdio.h>
#include <string.h>
#include <stdint.h>

#include "uv.h"
#include "win/fs-fd-hash-inl.h"

#define ORACLE "fd-hash-oracle"

#define HASH_SIZE ((int) UV__FD_HASH_SIZE)
#define GROUP_SIZE ((int) UV__FD_HASH_GROUP_SIZE)

static int failures;

static void oracle_ok(const char* name) {
  printf("%s: %s ok\n", ORACLE, name);
}

static void oracle_fail(const char* name, long expected, long got) {
  failures++;
  printf("%s: %s FAIL expected=%ld got=%ld\n", ORACLE, name, expected, got);
}

static void check_int(const char* name, long expected, long got) {
  if (expected == got)
    oracle_ok(name);
  else
    oracle_fail(name, expected, got);
}

/* Deterministic fd for slot `index` of `bucket`: fds collide exactly when
 * they are HASH_SIZE apart, which is how the fs.c callers end up chaining
 * groups inside one bucket. */
static int fdb(int bucket, int index) {
  return bucket + index * HASH_SIZE;
}

/* Deterministic, fd-derived payload: every field of struct uv__fd_info_s is
 * distinguishable, so a lookup that answers with a neighbouring entry (or
 * with a zeroed-out stale slot) cannot pass as a hit. */
static struct uv__fd_info_s make_info(int fd) {
  struct uv__fd_info_s info;
  memset(&info, 0, sizeof(info));
  info.flags = fd * 7 + 1;
  info.is_directory = (BOOLEAN) (fd & 1);
  info.mapping = (HANDLE) (intptr_t) (fd + 1000);
  info.size.QuadPart = (LONGLONG) fd * 3 + 5;
  info.current_pos.QuadPart = (LONGLONG) fd * 11 + 9;
  return info;
}

static int exists(int fd) {
  struct uv__fd_info_s info;
  memset(&info, 0, sizeof(info));
  return uv__fd_hash_get(fd, &info);
}

/* The whole payload of an entry has to survive the add -> get -> remove
 * round trip; HANDLEs are compared by identity, never printed. */
static void check_entry(const char* what, int fd,
                        const struct uv__fd_info_s* got) {
  struct uv__fd_info_s want = make_info(fd);
  char name[128];

  snprintf(name, sizeof(name), "%s-fd%d-flags", what, fd);
  check_int(name, want.flags, got->flags);
  snprintf(name, sizeof(name), "%s-fd%d-is-directory", what, fd);
  check_int(name, want.is_directory != 0, got->is_directory != 0);
  snprintf(name, sizeof(name), "%s-fd%d-mapping", what, fd);
  check_int(name, 1, got->mapping == want.mapping);
  snprintf(name, sizeof(name), "%s-fd%d-size", what, fd);
  check_int(name, (long) want.size.QuadPart, (long) got->size.QuadPart);
  snprintf(name, sizeof(name), "%s-fd%d-current-pos", what, fd);
  check_int(name, (long) want.current_pos.QuadPart,
            (long) got->current_pos.QuadPart);
}

int main(void) {
  struct uv__fd_info_s info;
  int bucket;
  int index;
  int fd;
  int count;

  uv__fd_hash_init();

  /* ---- 1. an empty table answers "no such fd" for every bucket -------- */
  count = 0;
  for (bucket = 0; bucket < HASH_SIZE; bucket++) {
    memset(&info, 0, sizeof(info));
    if (uv__fd_hash_get(fdb(bucket, 0), &info))
      count++;
  }
  check_int("empty-table-get-misses", 0, count);

  count = 0;
  for (bucket = 0; bucket < HASH_SIZE; bucket++) {
    memset(&info, 0, sizeof(info));
    if (uv__fd_hash_remove(fdb(bucket, 0), &info))
      count++;
  }
  check_int("empty-table-remove-misses", 0, count);

  /* ... and probing an empty table must not have planted anything. */
  count = 0;
  for (bucket = 0; bucket < HASH_SIZE; bucket++)
    if (exists(fdb(bucket, 0)))
      count++;
  check_int("empty-table-still-empty", 0, count);

  /* ---- 2. one entry: add / get / remove / add again ------------------- */
  fd = fdb(1, 0);
  memset(&info, 0, sizeof(info));
  check_int("single-get-before-add", 0, uv__fd_hash_get(fd, &info));

  info = make_info(fd);
  uv__fd_hash_add(fd, &info);

  memset(&info, 0, sizeof(info));
  check_int("single-get-after-add", 1, uv__fd_hash_get(fd, &info));
  check_entry("single-get", fd, &info);

  /* the neighbouring buckets are untouched */
  memset(&info, 0, sizeof(info));
  check_int("single-next-bucket-miss", 0, uv__fd_hash_get(fd + 1, &info));
  memset(&info, 0, sizeof(info));
  check_int("single-prev-bucket-miss", 0, uv__fd_hash_get(fd - 1, &info));

  memset(&info, 0, sizeof(info));
  check_int("single-remove-hit", 1, uv__fd_hash_remove(fd, &info));
  check_entry("single-remove", fd, &info);

  memset(&info, 0, sizeof(info));
  check_int("single-get-after-remove", 0, uv__fd_hash_get(fd, &info));
  memset(&info, 0, sizeof(info));
  check_int("single-remove-twice", 0, uv__fd_hash_remove(fd, &info));

  /* a bucket that went empty can be used again */
  info = make_info(fd);
  uv__fd_hash_add(fd, &info);
  memset(&info, 0, sizeof(info));
  check_int("single-readd-get", 1, uv__fd_hash_get(fd, &info));
  check_entry("single-readd", fd, &info);
  memset(&info, 0, sizeof(info));
  check_int("single-readd-remove", 1, uv__fd_hash_remove(fd, &info));
  memset(&info, 0, sizeof(info));
  check_int("single-final-miss", 0, uv__fd_hash_get(fd, &info));

  /* ---- 3. adding a live fd again updates it in place ------------------ */
  fd = fdb(2, 0);
  info = make_info(fd);
  uv__fd_hash_add(fd, &info);

  memset(&info, 0, sizeof(info));
  info.flags = 4242;
  info.is_directory = TRUE;
  info.mapping = (HANDLE) (intptr_t) 7777;
  info.size.QuadPart = 424242;
  info.current_pos.QuadPart = 24;
  uv__fd_hash_add(fd, &info);

  memset(&info, 0, sizeof(info));
  check_int("dup-add-get", 1, uv__fd_hash_get(fd, &info));
  check_int("dup-add-flags", 4242, info.flags);
  check_int("dup-add-is-directory", 1, info.is_directory != 0);
  check_int("dup-add-mapping", 1, info.mapping == (HANDLE) (intptr_t) 7777);
  check_int("dup-add-size", 424242, (long) info.size.QuadPart);
  check_int("dup-add-current-pos", 24, (long) info.current_pos.QuadPart);

  /* one removal is enough: the update must not have added a second slot */
  memset(&info, 0, sizeof(info));
  check_int("dup-add-single-remove", 1, uv__fd_hash_remove(fd, &info));
  check_int("dup-add-removed-info", 4242, info.flags);
  memset(&info, 0, sizeof(info));
  check_int("dup-add-gone", 0, uv__fd_hash_get(fd, &info));
  /* the slot the removal became live in must not answer for fd 0 either */
  memset(&info, 0, sizeof(info));
  check_int("dup-add-no-phantom-fd0", 0, uv__fd_hash_get(0, &info));

  /* ---- 4. different buckets are independent -------------------------- */
  {
    int a = fdb(3, 0);
    int b = fdb(4, 0);

    info = make_info(a);
    uv__fd_hash_add(a, &info);
    info = make_info(b);
    uv__fd_hash_add(b, &info);

    memset(&info, 0, sizeof(info));
    check_int("cross-both-present-a", 1, uv__fd_hash_get(a, &info));
    check_entry("cross-both-present-a", a, &info);
    memset(&info, 0, sizeof(info));
    check_int("cross-both-present-b", 1, uv__fd_hash_get(b, &info));
    check_entry("cross-both-present-b", b, &info);

    memset(&info, 0, sizeof(info));
    check_int("cross-remove-a", 1, uv__fd_hash_remove(a, &info));
    check_entry("cross-remove-a", a, &info);

    memset(&info, 0, sizeof(info));
    check_int("cross-b-survives", 1, uv__fd_hash_get(b, &info));
    check_entry("cross-b-survives", b, &info);
    memset(&info, 0, sizeof(info));
    check_int("cross-a-gone", 0, uv__fd_hash_get(a, &info));

    memset(&info, 0, sizeof(info));
    check_int("cross-remove-b", 1, uv__fd_hash_remove(b, &info));
    memset(&info, 0, sizeof(info));
    check_int("cross-b-gone", 0, uv__fd_hash_get(b, &info));
  }

  /* ---- 5. exactly GROUP_SIZE entries fill the first group completely -- */
  for (index = 0; index < GROUP_SIZE; index++) {
    fd = fdb(5, index);
    info = make_info(fd);
    uv__fd_hash_add(fd, &info);
  }

  count = 0;
  for (index = 0; index < GROUP_SIZE; index++)
    if (exists(fdb(5, index)))
      count++;
  check_int("full-group-all-present", GROUP_SIZE, count);

  /* the most recently added fd lives in the last slot of the full group */
  memset(&info, 0, sizeof(info));
  check_int("full-group-last-present",
            1, uv__fd_hash_get(fdb(5, GROUP_SIZE - 1), &info));
  check_entry("full-group-last", fdb(5, GROUP_SIZE - 1), &info);

  /* one entry more: the new fd starts a new group in front of the full one */
  fd = fdb(5, GROUP_SIZE);
  info = make_info(fd);
  uv__fd_hash_add(fd, &info);

  count = 0;
  for (index = 0; index <= GROUP_SIZE; index++)
    if (exists(fdb(5, index)))
      count++;
  check_int("full-group-overflow-present", GROUP_SIZE + 1, count);

  /* removing the oldest entry (it sits in the group behind the new one) has
   * to move the new group's last live entry into the vacated slot and then
   * release the emptied group. */
  memset(&info, 0, sizeof(info));
  check_int("full-group-cross-remove", 1, uv__fd_hash_remove(fdb(5, 0), &info));
  check_entry("full-group-cross-remove", fdb(5, 0), &info);

  count = 0;
  for (index = 1; index <= GROUP_SIZE; index++)
    if (exists(fdb(5, index)))
      count++;
  check_int("full-group-survivors-present", GROUP_SIZE, count);
  memset(&info, 0, sizeof(info));
  check_int("full-group-removed-gone", 0, uv__fd_hash_get(fdb(5, 0), &info));

  /* the entry that was moved down must still be readable in full */
  memset(&info, 0, sizeof(info));
  check_int("full-group-moved-present",
            1, uv__fd_hash_get(fdb(5, GROUP_SIZE), &info));
  check_entry("full-group-moved", fdb(5, GROUP_SIZE), &info);

  /* drain the bucket, then use it again */
  count = 0;
  for (index = 1; index <= GROUP_SIZE; index++) {
    memset(&info, 0, sizeof(info));
    if (uv__fd_hash_remove(fdb(5, index), &info))
      count++;
  }
  check_int("full-group-drain-removals", GROUP_SIZE, count);

  count = 0;
  for (index = 0; index <= GROUP_SIZE; index++)
    if (exists(fdb(5, index)))
      count++;
  check_int("full-group-drained-empty", 0, count);

  fd = fdb(5, 0);
  info = make_info(fd);
  uv__fd_hash_add(fd, &info);
  memset(&info, 0, sizeof(info));
  check_int("full-group-readd-present", 1, uv__fd_hash_get(fd, &info));
  check_entry("full-group-readd", fd, &info);
  count = 0;
  for (index = 1; index <= GROUP_SIZE; index++)
    if (exists(fdb(5, index)))
      count++;
  check_int("full-group-readd-no-resurrection", 0, count);
  memset(&info, 0, sizeof(info));
  check_int("full-group-readd-remove", 1, uv__fd_hash_remove(fd, &info));

  /* ---- 6. two fds in the same group, interleaved add/remove ----------- */
  {
    int a = fdb(6, 0);
    int b = fdb(6, 1);

    info = make_info(a);
    uv__fd_hash_add(a, &info);
    info = make_info(b);
    uv__fd_hash_add(b, &info);

    memset(&info, 0, sizeof(info));
    check_int("pair-both-present-a", 1, uv__fd_hash_get(a, &info));
    memset(&info, 0, sizeof(info));
    check_int("pair-both-present-b", 1, uv__fd_hash_get(b, &info));

    /* removing the first slot hands the group's last live slot over to it */
    memset(&info, 0, sizeof(info));
    check_int("pair-remove-a", 1, uv__fd_hash_remove(a, &info));
    check_entry("pair-remove-a", a, &info);

    memset(&info, 0, sizeof(info));
    check_int("pair-b-survives", 1, uv__fd_hash_get(b, &info));
    check_entry("pair-b-survives", b, &info);
    /* the vacated slot still holds a copy of `a`; it must stay invisible */
    memset(&info, 0, sizeof(info));
    check_int("pair-a-stays-gone", 0, uv__fd_hash_get(a, &info));

    info = make_info(a);
    uv__fd_hash_add(a, &info);
    memset(&info, 0, sizeof(info));
    check_int("pair-a-readded", 1, uv__fd_hash_get(a, &info));
    check_entry("pair-a-readded", a, &info);
    memset(&info, 0, sizeof(info));
    check_int("pair-b-still-live", 1, uv__fd_hash_get(b, &info));
    check_entry("pair-b-still-live", b, &info);

    memset(&info, 0, sizeof(info));
    check_int("pair-remove-b", 1, uv__fd_hash_remove(b, &info));
    check_entry("pair-remove-b", b, &info);
    memset(&info, 0, sizeof(info));
    check_int("pair-a-alone", 1, uv__fd_hash_get(a, &info));
    check_entry("pair-a-alone", a, &info);
    memset(&info, 0, sizeof(info));
    check_int("pair-b-gone", 0, uv__fd_hash_get(b, &info));

    memset(&info, 0, sizeof(info));
    check_int("pair-final-remove", 1, uv__fd_hash_remove(a, &info));
    memset(&info, 0, sizeof(info));
    check_int("pair-final-miss", 0, uv__fd_hash_get(b, &info));
  }

  /* ---- 7. one bucket per fd, three entries deep, over 16 buckets ------ */
  for (bucket = 8; bucket < 24; bucket++) {
    for (index = 0; index < 3; index++) {
      fd = fdb(bucket, index);
      info = make_info(fd);
      uv__fd_hash_add(fd, &info);
    }
  }

  count = 0;
  for (bucket = 8; bucket < 24; bucket++)
    for (index = 0; index < 3; index++)
      if (exists(fdb(bucket, index)))
        count++;
  check_int("sweep-all-present", 48, count);

  count = 0;
  for (bucket = 8; bucket < 24; bucket++) {
    memset(&info, 0, sizeof(info));
    if (uv__fd_hash_remove(fdb(bucket, 1), &info))
      count++;
  }
  check_int("sweep-middle-removals", 16, count);

  count = 0;
  for (bucket = 8; bucket < 24; bucket++)
    if (exists(fdb(bucket, 0)))
      count++;
  check_int("sweep-first-present", 16, count);

  count = 0;
  for (bucket = 8; bucket < 24; bucket++)
    if (exists(fdb(bucket, 2)))
      count++;
  check_int("sweep-last-present", 16, count);

  count = 0;
  for (bucket = 8; bucket < 24; bucket++)
    if (exists(fdb(bucket, 1)))
      count++;
  check_int("sweep-middle-gone", 0, count);

  /* drain the sweep again so that the table is empty afterwards */
  count = 0;
  for (bucket = 8; bucket < 24; bucket++) {
    memset(&info, 0, sizeof(info));
    if (uv__fd_hash_remove(fdb(bucket, 0), &info))
      count++;
    memset(&info, 0, sizeof(info));
    if (uv__fd_hash_remove(fdb(bucket, 2), &info))
      count++;
  }
  check_int("sweep-drain-removals", 32, count);

  count = 0;
  for (bucket = 8; bucket < 24; bucket++)
    for (index = 0; index < 3; index++)
      if (exists(fdb(bucket, index)))
        count++;
  check_int("sweep-drained-empty", 0, count);

  /* ---- 8. churn a deeper bucket down onto a full-group boundary ------- */
  {
    /* a deterministic, deliberately non-sequential removal order */
    static const int order[8] = { 0, 39, 7, 16, 31, 8, 23, 5 };
    int removed = 0;

    for (index = 0; index < 40; index++) {
      fd = fdb(24, index);
      info = make_info(fd);
      uv__fd_hash_add(fd, &info);
    }

    count = 0;
    for (index = 0; index < 40; index++)
      if (exists(fdb(24, index)))
        count++;
    check_int("churn-all-present", 40, count);

    for (index = 0; index < 8; index++) {
      memset(&info, 0, sizeof(info));
      if (uv__fd_hash_remove(fdb(24, order[index]), &info))
        removed++;
    }
    check_int("churn-boundary-removals", 8, removed);

    /* 40 - 8 == 32 == 2 full groups: every remaining entry must be found */
    count = 0;
    for (index = 0; index < 40; index++)
      if (exists(fdb(24, index)))
        count++;
    check_int("churn-remaining-present", 32, count);

    count = 0;
    for (index = 0; index < 8; index++)
      if (exists(fdb(24, order[index])))
        count++;
    check_int("churn-removed-gone", 0, count);

    /* an entry that the backfill moved down into an emptied group's slot
     * must still be readable in full (the payload travels with the entry) */
    memset(&info, 0, sizeof(info));
    check_int("churn-moved-present", 1, uv__fd_hash_get(fdb(24, 38), &info));
    check_entry("churn-moved", fdb(24, 38), &info);

    /* drain the rest and confirm the whole table is empty again */
    count = 0;
    for (index = 0; index < 40; index++) {
      memset(&info, 0, sizeof(info));
      if (uv__fd_hash_remove(fdb(24, index), &info))
        count++;
    }
    check_int("churn-drain-removals", 32, count);

    count = 0;
    for (bucket = 0; bucket < HASH_SIZE; bucket++)
      if (exists(fdb(bucket, 0)))
        count++;
    check_int("churn-table-empty-again", 0, count);

    /* an emptied bucket accepts new entries and keeps the old ones gone */
    fd = fdb(24, 0);
    info = make_info(fd);
    uv__fd_hash_add(fd, &info);
    memset(&info, 0, sizeof(info));
    check_int("churn-readd-present", 1, uv__fd_hash_get(fd, &info));
    check_entry("churn-readd", fd, &info);

    count = 0;
    for (index = 1; index < 40; index++)
      if (exists(fdb(24, index)))
        count++;
    check_int("churn-readd-no-resurrection", 0, count);

    memset(&info, 0, sizeof(info));
    check_int("churn-readd-remove", 1, uv__fd_hash_remove(fd, &info));
  }

  printf("%s: total_failures=%d\n", ORACLE, failures);
  return failures;
}
