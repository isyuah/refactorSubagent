#include <ctype.h>
#include "util.h"

/* BROKEN REFACTOR: trims trailing whitespace only — behavior change that the
 * differential run must catch (e.g. input "  hi  "). */
char *trim(char *s) {
    char *end = s;
    while (*end) end++;
    while (end > s && isspace((unsigned char)end[-1])) end--;
    *end = '\0';
    return s;
}
