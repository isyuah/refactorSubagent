#include "text_copy.h"
#include <string.h>
#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)
int main(void) {
    char out[8];
    memset(out, 'X', sizeof out);
    CHECK(text_copy(NULL, 0, "abc") == 3);
    CHECK(text_copy(out, 0, "abc") == 3 && out[0] == 'X');
    CHECK(text_copy(out, 1, "abc") == 3 && out[0] == 0 && out[1] == 'X');
    memset(out, 'X', sizeof out);
    CHECK(text_copy(out, 3, "abcdef") == 6 && memcmp(out, "ab\0X", 4) == 0);
    CHECK(text_copy(out, 4, "abc") == 3 && memcmp(out, "abc\0X", 5) == 0);
    CHECK(text_copy(out, 4, "") == 0 && out[0] == 0 && out[1] == 'b');
    return 0;
}
