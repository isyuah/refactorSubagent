#include "wire.h"
unsigned char wire_checksum(const unsigned char *bytes, size_t count) {
    unsigned int sum = 0;
    size_t i;
    for (i = 0; i < count; ++i) sum += bytes[i];
    return (unsigned char)sum;
}
