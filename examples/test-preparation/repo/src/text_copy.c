#include "text_copy.h"
#include <string.h>

text_copy_result text_copy(char *dst, size_t capacity, const char *src)
{
    text_copy_result result = { TEXT_COPY_INVALID, 0, 0 };
    size_t length;
    size_t i;

    if (src == NULL || (dst == NULL && capacity > 0)) {
        return result;
    }
    length = strlen(src);
    result.required = length;
    if (capacity == 0) {
        result.status = TEXT_COPY_TRUNCATED;
        return result;
    }
    if (length < capacity) {
        for (i = 0; i < length; ++i) {
            dst[i] = src[i];
        }
        dst[i] = '\0';
        result.copied = i;
        result.status = TEXT_COPY_OK;
        return result;
    }
    for (i = 0; i < capacity - 1; ++i) {
        dst[i] = src[i];
    }
    dst[i] = '\0';
    result.copied = i;
    result.status = TEXT_COPY_TRUNCATED;
    return result;
}
