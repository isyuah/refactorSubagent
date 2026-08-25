#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "util.h"

/*
 * Prints "[<timestamp>] #<ticket> <trimmed>" for each argument.
 * timestamp and ticket come from time()/rand() — nondeterministic sources
 * that the verification environment pins via shim/determinism.h.
 */
int main(int argc, char **argv) {
    long now = (long)time(NULL);
    int ticket = rand() % 100;
    for (int i = 1; i < argc; i++) {
        printf("[%ld] #%02d %s\n", now, ticket, trim(argv[i]));
    }
    return 0;
}
