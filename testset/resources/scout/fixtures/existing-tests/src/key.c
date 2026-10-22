#include "key.h"
int normalize_key(const char *src, char *dst, size_t capacity) {
    size_t i, length = 0;
    while (src[length]) {
        unsigned char c = (unsigned char)src[length++];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_')) return -1;
    }
    if (capacity <= length) return -2;
    for (i = 0; i < length; ++i) {
        char c = src[i];
        dst[i] = c >= 'A' && c <= 'Z' ? (char)(c + ('a' - 'A')) : c == '_' ? '-' : c;
    }
    dst[length] = '\0';
    return 0;
}
