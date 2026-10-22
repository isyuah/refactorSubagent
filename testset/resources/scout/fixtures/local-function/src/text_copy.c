#include "text_copy.h"

size_t text_copy(char *dst, size_t capacity, const char *src) {
    size_t length = 0;
    while (src[length] != '\0') ++length;
    if (capacity != 0) {
        size_t copied = length < capacity - 1 ? length : capacity - 1;
        size_t i;
        for (i = 0; i < copied; ++i) dst[i] = src[i];
        dst[copied] = '\0';
    }
    return length;
}
