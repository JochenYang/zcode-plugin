// Text returned in MCP `initialize.instructions` (CONTRACTS.md §10).
export const INSTRUCTIONS = [
  'codegraph is a local code graph for this workspace with three tools: codegraph_status, codegraph_lookup, codegraph_map.',
  'Use codegraph_lookup INSTEAD of Grep/Read to find where a symbol is defined, who calls or uses it, what it calls, or what a change impacts; search also takes a short description ("gift card redeem"); it returns exact file:line ranges, so read only those ranges afterwards.',
  'Use codegraph_map INSTEAD of Glob when you need to see what a project or directory contains.',
  'Use Read/Grep for text, configs, strings, logs and languages the graph does not cover.',
  'If codegraph_status reports the project is not indexed, fall back to the built-in tools and do not try to index it yourself.',
].join(' ');
