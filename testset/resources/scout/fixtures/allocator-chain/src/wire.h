#ifndef WIRE_H
#define WIRE_H
#include <stddef.h>
unsigned char wire_checksum(const unsigned char *bytes, size_t count);
int hex_decode(const unsigned char *text, size_t length, unsigned char *out);
#endif
