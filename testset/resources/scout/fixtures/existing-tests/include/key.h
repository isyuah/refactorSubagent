#ifndef KEY_H
#define KEY_H
#include <stddef.h>
/* ASCII letters, digits, '-' and '_' only. Empty keys are allowed.
 * Returns 0 on success, -1 for an invalid character, -2 for insufficient space.
 * On error dst is unchanged. Input and output buffers do not overlap. */
int normalize_key(const char *src, char *dst, size_t capacity);
#endif
