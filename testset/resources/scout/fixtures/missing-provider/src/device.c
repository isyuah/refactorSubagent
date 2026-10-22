#include "device.h"
#include "device_options.h"
#include "vendor_transport.h"
static unsigned sequence;
#if DEVICE_VALIDATE_REPLY
static unsigned char checksum(const unsigned char *bytes, size_t count) {
    unsigned char result = 0;
    size_t i;
    for (i = 0; i < count; ++i) result ^= bytes[i];
    return result;
}
#endif
int device_read_temperature(int *out) {
    unsigned char request[2] = { 0x31, (unsigned char)++sequence };
    unsigned char reply[8];
    size_t size = sizeof reply;
    if (!out) return -1;
    if (transport_exchange(request, sizeof request, reply, &size) != 0) return -2;
    if (size < 4 || reply[0] != request[0] || reply[1] != request[1]) return -3;
#if DEVICE_VALIDATE_REPLY
    if (size != 5 || checksum(reply, 4) != reply[4]) return -4;
#endif
    *out = (int)(signed char)reply[2];
    return 0;
}
