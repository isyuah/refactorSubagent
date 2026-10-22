#include "counter_api.h"
#include <limits.h>
#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)
int main(void) {
    const CounterApi *api = counter_get_api(1, sizeof(CounterApi));
    Counter *a = NULL, *b = NULL;
    int out = 777;
    CHECK(counter_get_api(0, sizeof(CounterApi)) == NULL);
    CHECK(counter_get_api(1, sizeof(CounterApi) - 1) == NULL);
    CHECK(api && api->abi_version == 1 && api->struct_size == sizeof(CounterApi));
    CHECK(api->open(&a, 101) == -1 && a == NULL);
    CHECK(api->open(&a, 5) == 0 && api->open(&b, 2) == 0);
    CHECK(api->step(a, 80, &out) == 0 && out == 85);
    out = 777;
    CHECK(api->step(a, INT_MAX, &out) == -3 && out == 777);
    CHECK(api->step(a, INT_MIN, &out) == -3 && out == 777);
    CHECK(api->step(a, 1, &out) == 0 && out == 86);
    CHECK(api->step(b, -3, &out) == 0 && out == -1);
    CHECK(api->step(a, 14, &out) == 0 && out == 100);
    CHECK(api->step(a, -200, &out) == 0 && out == -100);
    CHECK(api->step(NULL, 0, &out) == -1);
    api->close(a);
    api->close(b);
    return 0;
}
