#include <stdio.h>
#include "graph.h"

#define MAX_NODES 1024
#define SQUARE(x) ((x) * (x))

/** A vertex with a short label. */
typedef struct {
    int id;
    char label[32];
} Node;

enum Color { RED, GREEN };

struct Point {
    double x, y;
};

/** Creates a node with the given id. */
static Node make_node(int id) {
    Node n = { .id = id };
    snprintf(n.label, sizeof n.label, "node-%d", id);
    return n;
}

double norm(struct Point p) {
    return sqrt(p.x * p.x + p.y * p.y);
}

int main(void) {
    Node n = make_node(1);
    struct Point origin = { 0.0, 0.0 };
    printf("%f %d\n", norm(origin), n.id);
    return 0;
}
