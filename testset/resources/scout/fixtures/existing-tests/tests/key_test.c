#include <string.h>
#include "key.h"
#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)
int main(void) {
    char out[12] = "unchanged";
    CHECK(normalize_key("Ab_09-Z", out, sizeof out) == 0);
    CHECK(strcmp(out, "ab-09-z") == 0);
    CHECK(normalize_key("", out, 1) == 0 && out[0] == '\0');
    memcpy(out, "sentinel", 9);
    CHECK(normalize_key("ABC", out, 3) == -2 && strcmp(out, "sentinel") == 0);
    CHECK(normalize_key("A?", out, sizeof out) == -1 && strcmp(out, "sentinel") == 0);
    CHECK(normalize_key("\xFF", out, sizeof out) == -1 && strcmp(out, "sentinel") == 0);
    CHECK(normalize_key("?", out, 0) == -1 && strcmp(out, "sentinel") == 0);
    CHECK(normalize_key("A", out, 0) == -2 && strcmp(out, "sentinel") == 0);
    CHECK(normalize_key("ABC", out, 4) == 0 && strcmp(out, "abc") == 0);
    return 0;
}
