#ifndef VENDOR_TRANSPORT_H
#define VENDOR_TRANSPORT_H
#include <stddef.h>
/* Declaration imported from the prior SDK; the current implementation and
 * provider lifecycle documentation are distributed separately. */
int transport_exchange(const unsigned char *request, size_t request_size,
                       unsigned char *reply, size_t *reply_size);
#endif
