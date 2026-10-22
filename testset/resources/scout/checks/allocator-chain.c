#include "frame.h"
#include <stdlib.h>
#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)
typedef struct { int allocations, releases, fail; } Memory;
static void *allocate(void *ctx, size_t size) {
    Memory *memory = (Memory *)ctx;
    ++memory->allocations;
    return memory->fail ? NULL : malloc(size);
}
static void release(void *ctx, void *data) {
    ++((Memory *)ctx)->releases;
    free(data);
}
int main(void) {
    /* Literal checksums: no circular oracle through wire_checksum. */
    const unsigned char valid[] = { 1, 4, '4', '1', 'a', 'f', 49 };
    const unsigned char invalid_hex[] = { 1, 2, 'G', '0', 122 };
    const unsigned char invalid_sum[] = { 1, 2, '4', '1', 0 };
    const unsigned char odd[] = { 1, 1, '0', 50 };
    const unsigned char empty[] = { 1, 0, 1 };
    Memory counts = { 0, 0, 0 };
    FrameMemory memory = { &counts, allocate, release };
    Frame out = { NULL, 0 };
    CHECK(frame_parse(valid, 1, &memory, &out) == -1);
    CHECK(frame_parse(odd, sizeof odd, &memory, &out) == -1);
    CHECK(frame_parse(invalid_sum, sizeof invalid_sum, &memory, &out) == -2);
    CHECK(counts.allocations == 0 && counts.releases == 0);
    CHECK(frame_parse(invalid_hex, sizeof invalid_hex, &memory, &out) == -3);
    CHECK(counts.allocations == 1 && counts.releases == 1 && out.data == NULL && out.size == 0);
    counts.fail = 1;
    CHECK(frame_parse(valid, sizeof valid, &memory, &out) == -4);
    CHECK(counts.allocations == 2 && counts.releases == 1 && out.data == NULL);
    counts.fail = 0;
    CHECK(frame_parse(valid, sizeof valid, &memory, &out) == 0);
    CHECK(out.size == 2 && out.data[0] == 0x41 && out.data[1] == 0xaf && out.data[2] == 0);
    frame_release(&memory, &out);
    CHECK(counts.releases == 2 && out.data == NULL && out.size == 0);
    frame_release(&memory, &out);
    CHECK(counts.releases == 2);
    CHECK(frame_parse(empty, sizeof empty, &memory, &out) == 0 && out.size == 0 && out.data[0] == 0);
    frame_release(&memory, &out);
    CHECK(counts.allocations == 4 && counts.releases == 3);
    return 0;
}
