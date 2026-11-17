#ifndef TEXT_COPY_H
#define TEXT_COPY_H

#include <stddef.h>

typedef enum {
    TEXT_COPY_OK = 0,
    TEXT_COPY_TRUNCATED = 1,
    TEXT_COPY_INVALID = 2
} text_copy_status;

typedef struct {
    text_copy_status status;
    size_t copied;
    size_t required;
} text_copy_result;

/* src must be a NUL-terminated string and must not overlap dst.
 * required excludes the final NUL. With capacity > 0, valid inputs always
 * produce a NUL-terminated destination. capacity == 0 performs no writes and
 * reports TRUNCATED, including for an empty source; dst may then be NULL.
 * A NULL src or a NULL dst with positive capacity is INVALID: no writes,
 * copied == 0, required == 0. Bytes outside the capacity are never changed.
 */
text_copy_result text_copy(char *dst, size_t capacity, const char *src);

#endif
