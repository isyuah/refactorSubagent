#ifndef CONFIG_H
#define CONFIG_H
typedef struct { int limit; } Config;
/* File: limit=N with an optional final newline; N is an integer in [1,99].
 * Returns 0, -1 open error, -2 read error, -3 invalid format/range.
 * out is unchanged on every error. */
int config_load(const char *path, Config *out);
#endif
