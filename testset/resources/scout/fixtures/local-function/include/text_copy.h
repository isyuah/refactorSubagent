#ifndef TEXT_COPY_H
#define TEXT_COPY_H
#include <stddef.h>
/* src is NUL terminated; dst may be NULL only when capacity is zero.
 * Returns the full source length even when truncated. No overlapping buffers. */
size_t text_copy(char *dst, size_t capacity, const char *src);
#endif
