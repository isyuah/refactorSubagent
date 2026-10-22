#include "frame.h"
#include "wire.h"
int frame_parse(const unsigned char *wire, size_t size, const FrameMemory *memory, Frame *out) {
    unsigned char *data;
    size_t payload;
    if (size < 3) return -1;
    payload = wire[1];
    if (payload % 2 != 0 || size != payload + 3) return -1;
    if (wire_checksum(wire, size - 1) != wire[size - 1]) return -2;
    data = memory->alloc(memory->ctx, payload / 2 + 1);
    if (!data) return -4;
    if (hex_decode(wire + 2, payload, data) != 0) {
        memory->release(memory->ctx, data);
        return -3;
    }
    data[payload / 2] = 0;
    out->data = data;
    out->size = payload / 2;
    return 0;
}
void frame_release(const FrameMemory *memory, Frame *frame) {
    if (frame->data) memory->release(memory->ctx, frame->data);
    frame->data = 0;
    frame->size = 0;
}
