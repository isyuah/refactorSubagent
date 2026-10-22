#include "counter_api.h"
#include <stdlib.h>
struct Counter { int value; };
static int open_counter(Counter **out, unsigned seed) {
    Counter *counter;
    if (!out || seed > 100) return -1;
    counter = (Counter *)malloc(sizeof *counter);
    if (!counter) return -2;
    counter->value = (int)seed;
    *out = counter;
    return 0;
}
static int step(Counter *counter, int delta, int *out) {
    if (!counter || !out) return -1;
    if (delta < -100 - counter->value || delta > 100 - counter->value) return -3;
    counter->value += delta;
    *out = counter->value;
    return 0;
}
static void close_counter(Counter *counter) { free(counter); }
static const CounterApi API = { 1, sizeof(CounterApi), open_counter, step, close_counter };
const CounterApi *counter_get_api(unsigned version, size_t size) {
    return version == 1 && size == sizeof(CounterApi) ? &API : NULL;
}
