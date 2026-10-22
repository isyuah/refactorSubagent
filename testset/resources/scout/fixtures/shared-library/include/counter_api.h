#ifndef COUNTER_API_H
#define COUNTER_API_H
#include <stddef.h>
#include <stdint.h>
#if defined(_WIN32)
# if defined(COUNTER_BUILD)
#  define COUNTER_API __declspec(dllexport)
# else
#  define COUNTER_API __declspec(dllimport)
# endif
#else
# define COUNTER_API __attribute__((visibility("default")))
#endif
typedef struct Counter Counter;
typedef struct {
    uint32_t abi_version;
    size_t struct_size;
    int (*open)(Counter **out, unsigned seed);
    int (*step)(Counter *counter, int delta, int *out);
    void (*close)(Counter *counter);
} CounterApi;
/* Exact ABI version 1 and exact struct size required. Tables live in the library.
 * open: seed <= 100, 0 success, -1 invalid seed, -2 allocation failure.
 * step: keep state in [-100,100]; -1 invalid handle/out, -3 range error.
 * Failed open/step leave caller outputs unchanged; failed step keeps state.
 * Every successful open requires one close before unloading the library. */
COUNTER_API const CounterApi *counter_get_api(unsigned version, size_t size);
#endif
