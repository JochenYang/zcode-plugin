package graph

import (
	"fmt"
	str "strings"
)

// MaxNodes caps how many nodes a graph may hold.
const MaxNodes = 1024

var version = "1.0"

// Node is a single vertex with outbound edges.
type Node struct {
	ID    int
	Edges []string
}
type EdgeKind int

// Label returns a printable label for the node.
func (n *Node) Label() string {
	return fmt.Sprintf("node-%d", n.ID)
}

// Connect appends dst to the node's edge list.
func (n *Node) Connect(dst string) {
	n.Edges = append(n.Edges, dst)
}

func joinLabels(nodes []*Node) string {
	labels := make([]string, 0, len(nodes))
	for _, n := range nodes {
		labels = append(labels, n.Label())
	}
	return str.Join(labels, ",")
}

type Labeled interface {
	Label() string
}
