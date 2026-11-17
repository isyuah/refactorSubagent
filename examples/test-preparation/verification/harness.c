#include <stdio.h>
#include <string.h>
#include "text_copy.h"

typedef struct {
    const char *id;
    const char *source;
    size_t capacity;
    int null_destination;
} copy_case;

int main(void)
{
    char long_source[321];
    size_t i;
    memset(long_source, 'x', sizeof(long_source) - 1);
    long_source[sizeof(long_source) - 1] = '\0';
    {
        const copy_case cases[] = {
            { "normal", "hello", 16, 0 },
            { "exact-fit", "hello", 6, 0 },
            { "truncated", "hello", 4, 0 },
            { "capacity-one", "hello", 1, 0 },
            { "empty", "", 4, 0 },
            { "capacity-zero", "hello", 0, 1 },
            { "empty-zero", "", 0, 1 },
            { "null-source", NULL, 8, 0 },
            { "null-destination", "hello", 4, 1 },
            { "long-truncated", long_source, 8, 0 }
        };
        for (i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
            const copy_case *c = &cases[i];
            char buffer[32];
            char observed[32];
            size_t j;
            size_t used = 0;
            int terminated = 0;
            int guards = 1;
            int untouched = 1;
            text_copy_result result;
            memset(buffer, '#', sizeof(buffer));
            result = text_copy(c->null_destination ? NULL : buffer + 1, c->capacity, c->source);
            /* Bounded observation still terminates if the implementation forgets NUL. */
            if (!c->null_destination) {
                for (j = 0; j < c->capacity; ++j) {
                    if (buffer[j + 1] == '\0') { terminated = 1; break; }
                    observed[used++] = buffer[j + 1];
                }
            }
            observed[used] = '\0';
            if (buffer[0] != '#') guards = 0;
            for (j = c->capacity + 1; j < sizeof(buffer); ++j) {
                if (buffer[j] != '#') guards = 0;
            }
            for (j = 0; j < sizeof(buffer); ++j) {
                if (buffer[j] != '#') untouched = 0;
            }
            printf("{\"id\":\"%s\",\"status\":%d,\"copied\":%zu,\"required\":%zu,"
                   "\"text\":\"%s\",\"terminated\":%s,\"guards\":%s,\"untouched\":%s}\n",
                   c->id, (int)result.status, result.copied, result.required, observed,
                   terminated ? "true" : "false", guards ? "true" : "false",
                   untouched ? "true" : "false");
        }
    }
    return 0;
}
