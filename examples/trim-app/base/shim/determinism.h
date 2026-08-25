/*
 * Determinism shim — force-fed into EVERY translation unit via
 * `gcc -include determinism.h`, i.e. BEFORE the source's own includes.
 *
 * It deliberately includes the real system headers FIRST (so genuine
 * declarations are seen), then replaces the nondeterministic entry points
 * with macros. Any later #include of <time.h>/<stdlib.h> is a no-op due to
 * include guards, so no conflicting redeclaration can occur.
 */
#ifndef DETERMINISM_SHIM_H
#define DETERMINISM_SHIM_H

#include <time.h>
#include <stdlib.h>

#define time(t) ((time_t)1700000000)
#define rand() (77)
#define srand(seed) ((void)(seed))

#endif
