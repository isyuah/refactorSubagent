#include "config.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int parse(const char *text, Config *out) {
    char *end;
    long value;
    if (strncmp(text, "limit=", 6) != 0 || text[6] < '0' || text[6] > '9') return -3;
    errno = 0;
    value = strtol(text + 6, &end, 10);
    if (*end == '\n') ++end;
    if (*end != '\0' || errno == ERANGE || value < 1 || value > 99) return -3;
    out->limit = (int)value;
    return 0;
}
int config_load(const char *path, Config *out) {
    FILE *file = fopen(path, "rb");
    char text[64];
    size_t count;
    int extra, failed;
    if (!file) return -1;
    count = fread(text, 1, sizeof text - 1, file);
    failed = ferror(file);
    extra = fgetc(file);
    if (ferror(file)) failed = 1;
    fclose(file);
    if (failed) return -2;
    if (extra != EOF || memchr(text, 0, count) != NULL) return -3;
    text[count] = 0;
    return parse(text, out);
}
