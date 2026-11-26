// Two questions about the import graph (CONTRACTS.md §8): which files import each other in a
// cycle, and which test files would notice a change to given files. Both are read-only, and
// both cap what they visit (files, edges, hops). What is not capped is the cost of one reverse
// step, which scans `refs` and `imports` once (linear in their size, see `dependentsOf`).
//
// This module is re-exported by graph/queries.mjs, which is what the tool layer resolves through
// `resolveGraph(context).queries`.

import { isTestPath, prepare } from '../store/repo.mjs';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_CYCLES_LIMIT = 10;
const DEFAULT_AFFECTED_DEPTH = 3;
/** Files one cycle walk reads; beyond this the graph is cut to the first paths (sorted). */
export const MAX_CYCLE_FILES = 20000;
/**
 * Import edges one cycle walk reads at most, so a huge `imports` table costs bounded memory. The
 * statement itself still scans the table up to that many resolved rows (fewer resolved means a
 * longer scan), which is why `affectedTests` reports its own cost in `dependentsOf`.
 */
export const MAX_CYCLE_EDGES = 200000;
/** Files one reverse walk visits (inputs included); `truncated` says the walk stopped. */
export const MAX_AFFECTED_FILES = 5000;
/**
 * The closed walk of a component runs one breadth-first search per member, which is quadratic on
 * a hub-shaped component (`index.ts` importing and imported by everything): measured 1 s at 6000
 * files. A component up to this size gets the walk; a bigger one is listed by path instead, so
 * the cost of listing stays linear in the graph.
 */
export const MAX_WALK_FILES = 60;
/** Ids bound per statement, well under SQLite's parameter limit (`repo.mjs` reads it for inserts). */
const IN_CHUNK = 500;

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function requireDb(fn, db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError(`${fn}: "db" must be a DatabaseSync (got ${describe(db)})`);
}

function limitOf(fn, limit, fallback) {
  if (limit === undefined || limit === null) return fallback;
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`${fn}: "limit" must be a positive integer (got ${describe(limit)})`);
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Files that import each other, one entry per strongly connected component of the resolved
 * import graph (`imports.resolved_file_id`), self-imports ignored. Each entry is
 * `{ paths, walked }`. With `walked` true `paths` is a closed walk: it starts at the component's
 * smallest path, follows import edges, and ends at the start again (`a → b → c → a`); a
 * component that is not one simple cycle repeats a file where the walk has to (a strongly
 * connected component always has such a walk), so its file count is the distinct paths, not the
 * list length. With `walked` false (a component of more than `MAX_WALK_FILES` files) `paths` is
 * the component's files sorted by path, and the first is still the smallest.
 *
 * Order: more files first, then the first path. `limit` cuts the list; `total` counts every
 * cycle found, so the caller can say "N of M shown". `truncated` also covers the two graph
 * caps: beyond `MAX_CYCLE_FILES` files (first paths by sort) or `MAX_CYCLE_EDGES` import
 * edges, the walk covers what it read, so cycles beyond the cut are not listed.
 *
 * @param {DatabaseSync} db
 * @param {{ limit?: number }} [options]
 * @returns {{ cycles: { paths: string[], walked: boolean }[], total: number, truncated: boolean }}
 */
export function importCycles(db, options = {}) {
  requireDb('importCycles', db);
  const { limit = DEFAULT_CYCLES_LIMIT } = requireObject('importCycles', options);
  const maxCycles = limitOf('importCycles', limit, DEFAULT_CYCLES_LIMIT);

  const files = db.prepare('SELECT id, path FROM files ORDER BY path LIMIT ?').all(MAX_CYCLE_FILES + 1);
  const filesCapped = files.length > MAX_CYCLE_FILES;
  const nodes = files.slice(0, MAX_CYCLE_FILES).map((row) => ({ id: Number(row.id), path: row.path }));
  const at = new Map(nodes.map((node, i) => [node.id, i]));
  const adjacency = nodes.map(() => []);
  const edges = db.prepare('SELECT file_id, resolved_file_id FROM imports WHERE resolved_file_id IS NOT NULL LIMIT ?').all(MAX_CYCLE_EDGES + 1);
  const edgesCapped = edges.length > MAX_CYCLE_EDGES;
  for (const row of edges.slice(0, MAX_CYCLE_EDGES)) {
    const from = at.get(Number(row.file_id));
    const to = at.get(Number(row.resolved_file_id));
    // A file cannot import itself into a cycle; files outside the walk are not in the graph.
    if (from === undefined || to === undefined || from === to) continue;
    adjacency[from].push(to);
  }

  const components = stronglyConnected(adjacency).filter((component) => component.length >= 2);
  const paths = nodes.map((node) => node.path);
  const cycles = components
    .map((component) => {
      const walked = component.length <= MAX_WALK_FILES;
      const listed = component.map((v) => paths[v]).sort(compareText);
      return {
        paths: walked ? closedWalk(adjacency, component, paths) : listed,
        walked,
        size: component.length,
        first: listed[0],
      };
    })
    .sort((a, b) => b.size - a.size || compareText(a.first, b.first));
  return {
    cycles: cycles.slice(0, maxCycles).map(({ paths: listed, walked }) => ({ paths: listed, walked })),
    total: cycles.length,
    truncated: filesCapped || edgesCapped || cycles.length > maxCycles,
  };
}

/**
 * Test files that depend on `files`, walking the two reverse edges the index has: a file that
 * imports one of them (`imports.resolved_file_id`) and a file whose reference is resolved by
 * import to a symbol inside one of them (`refs.target_id`, `resolution = '='` only; a name-only
 * `~` match says nothing about dependence). The walk goes `depth` hops (default 3) or until
 * `MAX_AFFECTED_FILES` files have been visited, whichever comes first.
 *
 * `files` are paths as stored (`/`-separated, relative to the project root); a path the index
 * does not know is listed in `unknown` and is not walked. `tests` lists the reachable test files
 * (`isTestPath`) other than the inputs, cut to `limit` and sorted by path; `otherFiles` counts
 * the other reachable files (inputs excluded), `scanned` every file the walk visited (inputs
 * included). `truncated` says the walk stopped at the depth or the file cap, so more dependents
 * may exist; a `tests` list cut by `limit` is not "truncated" (the caller knows its own limit).
 *
 * @param {DatabaseSync} db
 * @param {{ files?: string[], depth?: number, limit?: number }} [options]
 * @returns {{ tests: string[], otherFiles: number, scanned: number, truncated: boolean, unknown: string[] }}
 */
export function affectedTests(db, options = {}) {
  requireDb('affectedTests', db);
  const { files = [], depth = DEFAULT_AFFECTED_DEPTH, limit = DEFAULT_LIMIT } = requireObject('affectedTests', options);
  if (!Array.isArray(files)) throw new TypeError(`affectedTests: "files" must be an array (got ${describe(files)})`);
  files.forEach((file, i) => {
    if (typeof file !== 'string' || file.length === 0) throw new TypeError(`affectedTests: "files[${i}]" must be a non-empty string (got ${describe(file)})`);
  });
  if (!Number.isInteger(depth) || depth < 1) throw new TypeError(`affectedTests: "depth" must be an integer >= 1 (got ${describe(depth)})`);
  const maxDepth = Math.min(depth, 6);
  const maxTests = limitOf('affectedTests', limit, DEFAULT_LIMIT);

  const wanted = [...new Set(files)];
  const known = new Map();
  for (const chunk of chunksOf(wanted, IN_CHUNK)) {
    const marks = chunk.map(() => '?').join(', ');
    for (const row of prepare(db, `SELECT id, path FROM files WHERE path IN (${marks})`).all(...chunk)) known.set(row.path, Number(row.id));
  }
  const unknown = wanted.filter((path) => !known.has(path)).sort(compareText);
  const inputs = new Set([...known.values()]);
  const visited = new Set(inputs);
  let frontier = [...inputs];
  let truncated = false;
  for (let level = 1; level <= maxDepth && frontier.length > 0 && !truncated; level += 1) {
    const next = [];
    for (const id of dependentsOf(db, frontier)) {
      if (visited.has(id)) continue;
      if (visited.size >= MAX_AFFECTED_FILES) {
        truncated = true;
        break;
      }
      visited.add(id);
      next.push(id);
    }
    frontier = truncated ? [] : next;
  }
  // Dependents beyond the requested depth: say so instead of reporting a complete list. Files
  // already visited (a cycle back into the result) are not "beyond".
  if (!truncated && frontier.length > 0 && [...dependentsOf(db, frontier)].some((id) => !visited.has(id))) truncated = true;

  const paths = new Map();
  for (const chunk of chunksOf([...visited], IN_CHUNK)) {
    const marks = chunk.map(() => '?').join(', ');
    for (const row of prepare(db, `SELECT id, path FROM files WHERE id IN (${marks})`).all(...chunk)) paths.set(Number(row.id), row.path);
  }
  const reachable = [...visited].map((id) => paths.get(id)).filter((path) => typeof path === 'string');
  const tests = [];
  let otherFiles = 0;
  for (const path of reachable) {
    if (inputs.has(known.get(path))) continue;
    if (isTestPath(path)) tests.push(path);
    else otherFiles += 1;
  }
  tests.sort(compareText);
  return {
    tests: tests.slice(0, maxTests),
    otherFiles,
    scanned: visited.size,
    truncated,
    unknown,
  };
}

function requireObject(fn, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${fn}: "options" must be an object (got ${describe(value)})`);
  return value;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Distinct files that depend on any of `ids`: those importing one of them, and those holding a
// reference that resolves into one of them.
//
// The reference query is left to the planner on purpose. Its plan scans `refs` once and probes
// `symbols` per row, so one call costs O(refs): 190 ms on the largest index here (8384 files,
// 1.6 M refs). Pinning the join order the other way (symbols first, `CROSS JOIN`) looks better
// for one file (7 ms against 175 ms) and falls apart for a frontier of two files or more: the
// inner loop loses `refs_target` and scans `refs` once per symbol (4.5 s at 2 files, 40 s at 32;
// measured 2026-11-26 with .tmp/t39/pinned-curve.mjs). A reverse index by target file would
// make it O(matches); that is a storage change, not made here.
function dependentsOf(db, ids) {
  const out = new Set();
  for (const chunk of chunksOf(ids, IN_CHUNK)) {
    const marks = chunk.map(() => '?').join(', ');
    for (const row of prepare(db, `SELECT DISTINCT file_id FROM imports WHERE resolved_file_id IN (${marks})`).all(...chunk)) {
      out.add(Number(row.file_id));
    }
    // Only import-resolved refs count. A `~` ref is a name-only match (`add` in some language
    // fixture standing for `add` anywhere), and following those turns a precise answer into noise:
    // on this repository the 8 test files that import graph/queries.mjs became 68 with 20
    // language fixtures (measured 2026-11-26 with .tmp/t39/affected-precision.mjs).
    for (const row of prepare(db, "SELECT DISTINCT r.file_id AS file_id FROM refs r JOIN symbols s ON s.id = r.target_id WHERE s.file_id IN (" + marks + ") AND r.resolution = '='").all(...chunk)) {
      out.add(Number(row.file_id));
    }
  }
  return out;
}

function* chunksOf(items, size) {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

// Tarjan's algorithm, iterative: a recursive walk over 20 000 files would overflow the stack.
// Returns components in no meaningful order; `importCycles` sorts them.
function stronglyConnected(adjacency) {
  const n = adjacency.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack = [];
  const components = [];
  let counter = 0;
  for (let start = 0; start < n; start += 1) {
    if (index[start] !== -1) continue;
    const work = [{ node: start, edge: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.node;
      if (frame.edge === 0 && index[v] === -1) {
        index[v] = counter;
        low[v] = counter;
        counter += 1;
        stack.push(v);
        onStack[v] = 1;
      }
      let descended = false;
      while (frame.edge < adjacency[v].length) {
        const w = adjacency[v][frame.edge];
        frame.edge += 1;
        if (index[w] === -1) {
          work.push({ node: w, edge: 0 });
          descended = true;
          break;
        }
        if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      }
      if (descended) continue;
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] === index[v]) {
        const component = [];
        let w;
        do {
          w = stack.pop();
          onStack[w] = 0;
          component.push(w);
        } while (w !== v);
        components.push(component);
      }
    }
  }
  return components;
}

// A closed walk through every member of an SCC: start at the smallest path, repeatedly take the
// shortest path to a file not yet visited, and close back to the start. A simple cycle produces
// exactly `a → b → c → a`; a denser component repeats a file where the walk needs it.
function closedWalk(adjacency, component, paths) {
  const members = new Set(component);
  const start = component.reduce((best, v) => (paths[v] < paths[best] ? v : best), component[0]);
  const order = [start];
  const visited = new Set([start]);
  let guard = component.length * 2 + 2;
  while (visited.size < component.length && guard > 0) {
    const segment = shortestPath(adjacency, members, order[order.length - 1], (v) => !visited.has(v));
    if (!segment) break;
    for (const v of segment) {
      order.push(v);
      visited.add(v);
      guard -= 1;
    }
  }
  const closing = shortestPath(adjacency, members, order[order.length - 1], (v) => v === start);
  if (closing) order.push(...closing);
  else order.push(start);
  return order.map((v) => paths[v]);
}

// Node indices after `from`, ending at the first node that satisfies `isTarget`; null when the
// component has no path there (only possible past a cap, since a component is strongly connected).
function shortestPath(adjacency, members, from, isTarget) {
  const previous = new Map([[from, -1]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head += 1) {
    const v = queue[head];
    for (const w of adjacency[v]) {
      if (!members.has(w) || previous.has(w)) continue;
      previous.set(w, v);
      if (isTarget(w)) {
        const path = [];
        for (let node = w; node !== -1; node = previous.get(node)) path.push(node);
        return path.reverse().slice(1);
      }
      queue.push(w);
    }
  }
  return null;
}
