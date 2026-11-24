#include <stdio.h>

typedef struct {
    const char *name;
} Greeter;

static const char *greet(const Greeter *g) {
    return g->name;
}

int main(void) {
    Greeter greeter = {"world"};
    printf("Hello, %s!\n", greet(&greeter));
    return 0;
}
