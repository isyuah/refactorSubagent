#include "wire.h"
static int nibble(unsigned char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
int hex_decode(const unsigned char *text, size_t length, unsigned char *out) {
    size_t i;
    for (i = 0; i < length; i += 2) {
        int a = nibble(text[i]), b = nibble(text[i + 1]);
        if (a < 0 || b < 0) return -1;
        out[i / 2] = (unsigned char)(a * 16 + b);
    }
    return 0;
}
