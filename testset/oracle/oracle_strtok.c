/* oracle_strtok.c — behavior oracle for `uv__strtok` (src/strtok.c).
 *
 * Why this oracle exists: the shipped case `strtok` (test/test-strtok.c:61-86)
 * only tokenizes inputs WITHOUT adjacent, leading or trailing separators, and
 * it compiles ../src/strtok.c into the test TU. On Windows uv__strtok has no
 * production caller at all (only src/unix/core.c:2004,2023), so the library
 * copy reachable from libuv.a has zero coverage from the stock suite.
 *
 * Frozen against: libuv v1.52.1 (commit 1cfa32f), Windows 11 x64, MinGW GCC 15.2
 * Build: -O0 -g, linked against the static libuv.a.
 *
 * Deliberately pinned quirks (bug-compatible, must NOT be "fixed"):
 *   - empty tokens are returned for adjacent separators ("a..b" -> a, "", b)
 *   - a trailing separator yields one final empty token ("abc." -> "abc", "")
 *   - a leading separator yields a leading empty token (".abc" -> "", "abc")
 *   - an all-separator string yields one empty token per separator ("..." -> 4x "")
 *   - sep == "" makes the whole remaining string a single token
 *   - the input buffer is mutated in place at the separator that ends the token
 */
#include <stdio.h>
#include <string.h>
#include "uv.h"
#include "strtok.h"
#include "oracle_common.h"

#define ORACLE "strtok-oracle"

/* Tokenize `input`, recording each returned token as "[tok]" separated by '|',
 * terminated by "|END". A NULL return ends the transcript. */
static void transcript(const char* input, const char* sep, char* out, size_t outlen) {
  char buf[64];
  char* itr = NULL;
  char* tok;
  int i = 0;

  snprintf(buf, sizeof(buf), "%s", input);
  out[0] = '\0';
  tok = uv__strtok(buf, sep, &itr);
  while (tok != NULL && i < 16) {
    app(out, outlen, "[");
    app(out, outlen, tok);
    app(out, outlen, "]|");
    i++;
    tok = uv__strtok(NULL, sep, &itr);
  }
  app(out, outlen, "END");
}

static void case_transcript(const char* name, const char* input, const char* sep,
                            const char* expected) {
  char got[256];
  transcript(input, sep, got, sizeof(got));
  check_str(ORACLE, name, expected, got);
}

int main(void) {
  case_transcript("empty-token-between", "a..b", ".",
                  "[a]|[]|[b]|END");
  case_transcript("trailing-separator", "abc.", ".",
                  "[abc]|[]|END");
  case_transcript("leading-separator", ".abc", ".",
                  "[]|[abc]|END");
  case_transcript("all-separators", "...", ".",
                  "[]|[]|[]|[]|END");
  case_transcript("empty-input", "", ".",
                  "[]|END");
  case_transcript("empty-separator", "abc", "",
                  "[abc]|END");
  case_transcript("runs-and-edges", "  x  y ", " ",
                  "[]|[]|[x]|[]|[y]|[]|END");
  case_transcript("stock-vectors", "Hello This-is-a-nice.-string", " .",
                  "[Hello]|[This-is-a-nice]|[-string]|END");

  /* In-place mutation and iterator state, asserted byte by byte. */
  {
    char buf[8] = "a..b";
    char* itr = NULL;
    char* tok = uv__strtok(buf, ".", &itr);
    check_str(ORACLE, "mutate-first-token", "a", tok == NULL ? "(null)" : tok);
    check_int(ORACLE, "mutate-nul-written", 0, (int) buf[1]);
    check_int(ORACLE, "mutate-second-sep-preserved", '.', (int) buf[2]);
    check_int(ORACLE, "mutate-rest-preserved", 'b', (int) buf[3]);
    check_int(ORACLE, "iterator-advanced", 1, itr == buf + 2);

    tok = uv__strtok(NULL, ".", &itr);
    check_str(ORACLE, "mutate-second-token", "", tok == NULL ? "(null)" : tok);
    check_int(ORACLE, "iterator-after-empty-token", 1, itr == buf + 3);

    tok = uv__strtok(NULL, ".", &itr);
    check_str(ORACLE, "mutate-third-token", "b", tok == NULL ? "(null)" : tok);
    check_int(ORACLE, "iterator-cleared-at-end", 1, itr == NULL);

    /* Once the iterator is NULL, further calls keep returning NULL. */
    check_int(ORACLE, "null-iterator-returns-null", 1,
              uv__strtok(NULL, ".", &itr) == NULL);
    check_int(ORACLE, "null-iterator-stays-null", 1,
              uv__strtok(NULL, ".", &itr) == NULL);
  }

  /* A NULL iterator with a non-NULL string is a fresh scan. */
  {
    char buf[8] = "q.r";
    char* itr = NULL;
    char* tok = uv__strtok(buf, ".", &itr);
    check_str(ORACLE, "fresh-scan-first", "q", tok == NULL ? "(null)" : tok);
    tok = uv__strtok(NULL, ".", &itr);
    check_str(ORACLE, "fresh-scan-second", "r", tok == NULL ? "(null)" : tok);
  }

  return oracle_summary(ORACLE);
}
