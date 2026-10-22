#ifndef DEVICE_H
#define DEVICE_H
/* On success stores a signed temperature. On error out is unchanged.
 * Requests have process-local sequence numbers. */
int device_read_temperature(int *out);
#endif
