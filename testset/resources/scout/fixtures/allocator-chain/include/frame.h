#ifndef FRAME_H
#define FRAME_H
#include <stddef.h>
typedef struct { void *ctx; void *(*alloc)(void *, size_t); void (*release)(void *, void *); } FrameMemory;
typedef struct { unsigned char *data; size_t size; } Frame;
/* Caller provides a vacant out and paired memory callbacks; wire is borrowed.
 * Success transfers allocated data to out. Errors leave out unchanged.
 * -1 framing, -2 checksum, -3 hex data, -4 allocation failure. */
int frame_parse(const unsigned char *wire, size_t size, const FrameMemory *memory, Frame *out);
void frame_release(const FrameMemory *memory, Frame *frame);
#endif
