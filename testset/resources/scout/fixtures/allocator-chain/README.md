# Frame codec
Wire format: type byte, encoded payload length byte, hex payload bytes, checksum
byte. FrameMemory belongs to the caller. No network transport is included here.
