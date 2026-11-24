#define GRAPH_VERSION 1
#include <string>
#include <vector>
#include "graph.h"

namespace graph {

/// A vertex with outbound edges.
class Node {
public:
    Node(int id) : id_(id) {}

    /// Short label for rendering.
    std::string label() const { return "node"; }

    void connect(const Node& other);

    static int count() { return GRAPH_VERSION; }

private:
    int id_;
    std::vector<int> edges_;
};

void Node::connect(const Node& other) {
    edges_.push_back(other.id_);
}

template <typename T>
T first(const std::vector<T>& xs) { return xs.at(0); }

using Index = std::vector<int>;

}  // namespace graph
