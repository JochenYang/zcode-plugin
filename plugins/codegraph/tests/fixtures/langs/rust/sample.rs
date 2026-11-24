use std::collections::HashMap;
use crate::graph::{Edge, Node as Vertex};

/// Maximum number of nodes a graph may hold.
pub const MAX_NODES: usize = 1024;
static VERSION: &str = "1.0";

/// A node with outbound edges.
#[derive(Debug, Clone)]
pub struct Node {
    pub id: u32,
    edges: Vec<String>,
}
#[derive(Debug, PartialEq)]
pub enum Color { Red, Green(u8) }

pub trait Label {
    /// Short label for rendering.
    fn label(&self) -> String;
}
impl Node {
    /// Builds an empty node.
    pub fn new(id: u32) -> Self {
        Node { id, edges: Vec::new() }
    }
}
impl Label for Node {
    fn label(&self) -> String {
        format!("node-{}", self.id)
    }
}
pub type Index = HashMap<String, u32>;
/// Concatenates node labels.
pub fn join_labels(nodes: &[Vertex]) -> String {
    nodes.iter().map(|n| n.label()).collect::<Vec<_>>().join(",")
}
macro_rules! shout {
    ($e:expr) => { println!("{}", $e) };
}
