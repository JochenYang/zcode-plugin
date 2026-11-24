// Graph queries used by the MCP tools (CONTRACTS.md §8). Read-only over the
// index; every function takes the DatabaseSync handle first. Row shapes follow
// §8 / §11 (camelCase, `path` relative to the project root) so the renderer
// needs no knowledge of the schema.

import { findSymbolsByName, importsOfFile, searchSymbolsDetailed, symbolsInFile, usageCounts } from '../store/repo.mjs';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
/** Impact BFS stops here; `truncated` tells the caller it was cut. */
const MAX_IMPACT_NODES = 2000;
const RESOLUTION_RANK = { '=': 3, '~': 2, '?': 1 };
/** Search results say who uses only this many of their leading rows (tokens per search). */
export const SEARCH_USAGE_ROWS = 3;

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function requireDb(fn, db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError(`${fn}: "db" must be a DatabaseSync (got ${describe(db)})`);
}

function limitOf(fn, limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`${fn}: "limit" must be a positive integer (got ${describe(limit)})`);
  return Math.min(limit, MAX_LIMIT);
}

// repo rows are snake_case column names; the §8 shapes are camelCase.
const CAMEL_KEYS = {
  file_id: 'fileId', parent_id: 'parentId', symbol_id: 'symbolId', target_id: 'targetId', local_def_id: 'localDefId',
  resolved_file_id: 'resolvedFileId', start_line: 'startLine', end_line: 'endLine', start_col: 'startCol', end_col: 'endCol',
};

function camelRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[CAMEL_KEYS[key] ?? key] = value;
  return out;
}

const pick = (row, keys) => {
  const mapped = camelRow(row);
  return Object.fromEntries(keys.filter((k) => mapped[k] !== undefined).map((k) => [k, mapped[k]]));
};

const searchRow = (row) => pick(row, ['id', 'kind', 'name', 'qual', 'path', 'startLine', 'endLine', 'startCol', 'signature']);
const symbolRow = (row) => {
  const out = pick(row, ['id', 'kind', 'name', 'qual', 'path', 'startLine', 'endLine', 'startCol', 'endCol', 'signature', 'doc', 'parentId']);
  out.exported = row.exported === null || row.exported === undefined ? null : row.exported === 1;
  return out;
};
const outlineRow = (row) => pick(row, ['id', 'kind', 'name', 'qual', 'startLine', 'endLine', 'signature']);

// Exactly one symbol for `name` (optionally narrowed by path / qual), else null.
function uniqueSymbol(db, { name, path = null, qual = null } = {}) {
  if (typeof name !== 'string' || name.length === 0) return null;
  let rows = findSymbolsByName(db, name);
  if (path !== null && path !== undefined) {
    if (typeof path !== 'string') throw new TypeError('symbol lookup: "path" must be a string');
    rows = rows.filter((r) => r.path === path);
  }
  if (qual !== null && qual !== undefined) {
    if (typeof qual !== 'string') throw new TypeError('symbol lookup: "qual" must be a string');
    rows = rows.filter((r) => r.qual === qual);
  }
  return rows.length === 1 ? rows[0] : null;
}

const bestResolution = (values) => values.reduce((best, v) => (RESOLUTION_RANK[v] ?? 0) > (RESOLUTION_RANK[best] ?? 0) ? v : best, values[0]);

/**
 * Symbols by name (CONTRACTS.md §8 `search`), best match first. When `info` is given it
 * receives the words the search matched and those it had to drop (`matched`, `dropped`).
 * @returns {{ id: number, kind: string, name: string, qual: string, path: string, startLine: number, endLine: number, signature: string|null, usage?: object }[]}
 */
export function search(db, { query, kind = null, limit = DEFAULT_LIMIT } = {}, info = null) {
  requireDb('search', db);
  if (typeof query !== 'string' || query.trim() === '') return [];
  const found = searchSymbolsDetailed(db, query, { limit: limitOf('search', limit), kind });
  if (info) {
    info.matched = found.matched;
    info.dropped = found.dropped;
  }
  const rows = found.rows.map(searchRow);
  // The leading rows carry who uses them: codegraph is an orientation tool, and in the T20
  // sessions the model never came back for `callers` once it had started editing. Symbols with
  // no reference from another file get no entry, hence no field.
  const leading = rows.slice(0, SEARCH_USAGE_ROWS);
  const usage = usageCounts(db, leading.map((row) => row.id));
  for (const row of leading) {
    const counts = usage.get(row.id);
    if (counts) row.usage = counts;
  }
  return rows;
}

/**
 * Refs that point at `target`, grouped by the symbol that contains them.
 * Module-level refs (import statements) form one group per file, named after
 * the ref. `resolution` is the strongest marker in the group.
 */
function callerGroups(db, target, limit) {
  const rows = db.prepare(
    'SELECT r.*, s.name AS owner_name, s.qual AS owner_qual, s.kind AS owner_kind, f.path AS path' +
    ' FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols s ON s.id = r.symbol_id' +
    ' WHERE r.target_id = ? ORDER BY f.path, r.start_line, r.start_col, r.id'
  ).all(target.id);
  const groups = new Map();
  for (const r of rows) {
    const key = r.symbol_id === null ? `file:${r.file_id}` : `sym:${r.symbol_id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        name: r.owner_name ?? r.name,
        qual: r.owner_qual ?? null,
        kind: r.owner_kind ?? r.kind,
        path: r.path,
        startLine: r.start_line,
        resolution: r.resolution ?? '?',
        count: 0,
      };
      groups.set(key, g);
    }
    g.count++;
    if (r.start_line < g.startLine) g.startLine = r.start_line;
    g.resolution = bestResolution([g.resolution, r.resolution ?? '?']);
  }
  return [...groups.values()].slice(0, limit);
}

/** Calls made directly inside `target`, grouped by resolved target (or name). */
function calleeGroups(db, target, limit) {
  const rows = db.prepare(
    'SELECT r.name, r.resolution, r.start_line, r.target_id, s.name AS target_name, s.path AS target_path, s.start_line AS target_line' +
    ' FROM refs r LEFT JOIN (SELECT s.id, s.name, s.start_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id) s ON s.id = r.target_id' +
    ' WHERE r.symbol_id = ? AND r.kind = ? ORDER BY r.start_line, r.start_col, r.id'
  ).all(target.id, 'call');
  const groups = new Map();
  for (const r of rows) {
    const key = r.target_id === null ? `name:${r.name}` : `id:${r.target_id}`;
    let g = groups.get(key);
    if (!g) {
      g = { name: r.target_name ?? r.name, path: r.target_path ?? null, startLine: r.target_line ?? r.start_line, resolution: r.resolution ?? '?', count: 0 };
      groups.set(key, g);
    }
    g.count++;
    g.resolution = bestResolution([g.resolution, r.resolution ?? '?']);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, limit);
}

function fileImports(db, path) {
  const pathOf = db.prepare('SELECT path FROM files WHERE id = ?');
  return importsOfFile(db, path).map((imp) => ({
    spec: imp.spec,
    kind: imp.kind,
    startLine: imp.start_line,
    names: typeof imp.names === 'string' ? imp.names : null,
    resolvedPath: imp.resolved_file_id === null ? null : pathOf.get(imp.resolved_file_id)?.path ?? null,
  }));
}

/**
 * One symbol with its relations (CONTRACTS.md §8 `symbol`).
 * @returns {{ symbol: object, callers: object[], callees: object[], imports: object[] }|null}
 */
export function symbol(db, { name, path = null, qual = null } = {}) {
  requireDb('symbol', db);
  const target = uniqueSymbol(db, { name, path, qual });
  if (!target) return null;
  return {
    symbol: symbolRow(target),
    callers: callerGroups(db, target, DEFAULT_LIMIT),
    callees: calleeGroups(db, target, DEFAULT_LIMIT),
    imports: fileImports(db, target.path),
  };
}

/** @returns {{ name: string, qual: string|null, kind: string, path: string, startLine: number, resolution: string, count: number }[]} */
export function callers(db, { name, path = null, limit = DEFAULT_LIMIT } = {}) {
  requireDb('callers', db);
  const target = uniqueSymbol(db, { name, path });
  return target ? callerGroups(db, target, limitOf('callers', limit)) : [];
}

/** @returns {{ name: string, path: string|null, startLine: number, resolution: string, count: number }[]} */
export function callees(db, { name, path = null, limit = DEFAULT_LIMIT } = {}) {
  requireDb('callees', db);
  const target = uniqueSymbol(db, { name, path });
  return target ? calleeGroups(db, target, limitOf('callees', limit)) : [];
}

// Symbols owning refs that point at any of `ids` (reverse edges), minus `exclude`.
function ownersOf(db, ids, exclude = null) {
  const out = new Set();
  const query = db.prepare('SELECT DISTINCT symbol_id FROM refs WHERE target_id = ? AND symbol_id IS NOT NULL');
  for (const id of ids) {
    for (const row of query.all(id)) {
      if (!exclude?.has(row.symbol_id)) out.add(row.symbol_id);
    }
  }
  return out;
}

/**
 * Transitive dependents of a symbol along refs.target_id, breadth-first up to
 * `depth` hops (CONTRACTS.md §8 `impact`). `truncated` is set when dependents
 * exist beyond the requested depth or the node cap stopped the walk; owners
 * already visited (a cycle back into the result) are not "beyond".
 *
 * @returns {{ nodes: object[], files: string[], truncated: boolean, total: number }}
 */
export function impact(db, { name, path = null, depth = 2 } = {}) {
  requireDb('impact', db);
  const target = uniqueSymbol(db, { name, path });
  if (!target) return { nodes: [], files: [], truncated: false, total: 0 };
  const maxDepth = Number.isInteger(depth) ? Math.min(Math.max(depth, 1), 6) : 2;
  const found = []; // { id, depth }
  const visited = new Set([target.id]);
  let frontier = [target.id];
  let truncated = false;
  for (let level = 1; level <= maxDepth && frontier.length > 0; level++) {
    const owners = ownersOf(db, frontier, visited);
    const next = [];
    for (const id of owners) {
      visited.add(id);
      next.push(id);
      found.push({ id, depth: level });
    }
    if (found.length >= MAX_IMPACT_NODES) {
      truncated = true;
      frontier = [];
      break;
    }
    frontier = next;
  }
  // Deeper dependents than asked for: say so instead of silently looking complete.
  if (!truncated && frontier.length > 0 && ownersOf(db, frontier, visited).size > 0) truncated = true;

  const byId = new Map();
  for (let i = 0; i < found.length; i += 500) {
    const chunk = found.slice(i, i + 500);
    const marks = chunk.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT s.*, f.path AS path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (${marks})`).all(...chunk.map((f) => f.id))) {
      byId.set(row.id, row);
    }
  }
  const nodes = found.map((f) => {
    const row = byId.get(f.id);
    return row ? { ...pick(row, ['id', 'kind', 'name', 'qual', 'path', 'startLine', 'endLine', 'signature']), depth: f.depth } : null;
  }).filter(Boolean);
  nodes.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine);
  const files = [...new Set(nodes.map((n) => n.path))].sort();
  return { nodes, files, truncated, total: nodes.length };
}

/**
 * Symbols of one file in source order (CONTRACTS.md §8 `outline`).
 * @returns {{ id: number, kind: string, name: string, qual: string, startLine: number, endLine: number, signature: string|null }[]}
 */
export function outline(db, { path } = {}) {
  requireDb('outline', db);
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('outline: "path" must be a non-empty string');
  return symbolsInFile(db, path).map(outlineRow);
}
