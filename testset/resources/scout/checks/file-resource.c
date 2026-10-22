#include "config.h"
#include <stdio.h>
#include <string.h>
#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)
static int put(const char *path, const void *bytes, size_t size) {
    FILE *file = fopen(path, "wb");
    size_t written;
    int closed;
    if (!file) return 1;
    written = fwrite(bytes, 1, size, file);
    closed = fclose(file);
    return written != size || closed != 0;
}
int main(int argc, char **argv) {
    Config out = { 777 };
    char long_text[80];
    const char *path;
    const char *invalid[] = { "", "limit=0", "limit=100", "limit=+1", "limit=1\nextra", "other=1", "limit=2\n\n" };
    size_t i;
    CHECK(argc == 2);
    path = argv[1];
    remove(path);
    CHECK(config_load(path, &out) == -1 && out.limit == 777);
    CHECK(put(path, "limit=1", 7) == 0);
    CHECK(config_load(path, &out) == 0 && out.limit == 1);
    CHECK(put(path, "limit=99\n", 9) == 0);
    CHECK(config_load(path, &out) == 0 && out.limit == 99);
    out.limit = 777;
    for (i = 0; i < sizeof invalid / sizeof *invalid; ++i) {
        CHECK(put(path, invalid[i], strlen(invalid[i])) == 0);
        CHECK(config_load(path, &out) == -3 && out.limit == 777);
    }
    CHECK(put(path, "limit=2\0x", 9) == 0);
    CHECK(config_load(path, &out) == -3 && out.limit == 777);
    memset(long_text, '1', sizeof long_text);
    CHECK(put(path, long_text, sizeof long_text) == 0);
    CHECK(config_load(path, &out) == -3 && out.limit == 777);
    CHECK(remove(path) == 0);
    return 0;
}
