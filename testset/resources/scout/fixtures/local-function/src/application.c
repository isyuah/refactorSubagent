#include <vulkan/vulkan.h>
#include "text_copy.h"
int main(void) {
    char title[32];
    uint32_t version = 0;
    text_copy(title, sizeof title, "Viewer");
    return vkEnumerateInstanceVersion(&version) == VK_SUCCESS ? 0 : 1;
}
