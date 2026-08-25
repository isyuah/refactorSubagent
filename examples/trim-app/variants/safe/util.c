#include <ctype.h>
#include "util.h"

/* SAFE REFACTOR: extract helpers; observable behavior identical. */
static char *skip_leading(char *s) {
    while (*s && isspace((unsigned char)*s)) s++;
    return s;
}

static char *cut_trailing(char *s) {
    char *end = s;
    while (*end) end++;
    while (end > s && isspace((unsigned char)end[-1])) end--;
    *end = '\0';
    return s;
}

char *trim(char *s) {
    return cut_trailing(skip_leading(s));
}
