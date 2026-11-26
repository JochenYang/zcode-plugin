// Graph queries used by the MCP tools (CONTRACTS.md §8). Read-only over the
// index; every function takes the DatabaseSync handle first. Row shapes follow
// §8 / §11 (camelCase, `path` relative to the project root) so the renderer
// needs no knowledge of the schema.

import { findSymbolsByName, importsOfFile, pathRank, searchRefs, searchSymbolsDetailed, symbolsInFile, usageCounts } from '../store/repo.mjs';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
/** Impact BFS stops here; `truncated` tells the caller it was cut. */
const MAX_IMPACT_NODES = 2000;
const RESOLUTION_RANK = { '=': 3, '~': 2, '?': 1 };
/** Search results say who uses only this many of their leading rows (tokens per search). */
export const SEARCH_USAGE_ROWS = 3;
/** A name used in more places than this is a hub: symbols that share one of its words stay in front of it. */
export const REF_LEAD_MAX = 200;

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
  owner_qual: 'ownerQual', owner_kind: 'ownerKind',
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
// A place that uses a name no symbol defines (CONTRACTS.md §8 `search`, the reference rows).
const refRow = (row) => pick(row, ['kind', 'name', 'receiver', 'count', 'path', 'startLine', 'owner', 'ownerQual', 'ownerKind']);
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

// One list out of the two sources of places that use a name (CONTRACTS.md §8): the rows of the
// index and the rows a source scan found, in the order either keeps on its own — source files
// before tests and scripts, generated files last, then by path and line — with the index's row
// first where both have the same place. Totals are summed; files are counted over every row of
// either, cut or not; a cut in either is a cut of the whole. Neither has a row: null, unless one
// was cut or the scan said why it has nothing (`skipped`), which is passed on so the caller knows
// the answer is not "nothing" and the header does not claim a look that never happened. `kinds`
// lists the kinds the rows have, so that a caller can tell a list of property reads from a mixed
// one; `cut` names a lookup of the scan that was cut while the other has rows.
function mergePlaces(indexed, scan) {
  const a = indexed?.rows.length > 0 ? indexed : null;
  const b = scan?.rows.length > 0 ? scan : null;
  const capped = Boolean(indexed?.capped || scan?.capped);
  const skipped = b ? null : (scan?.skipped ?? null);
  const kindsOf = (rows) => [...new Set(rows.map((row) => row.kind))];
  if (!a && !b) return capped || skipped ? { rows: [], uses: 0, files: 0, names: [], kinds: [], cut: null, capped, skipped, fromIndex: 0, fromScan: 0 } : null;
  if (!b) return { ...a, capped, skipped, cut: null, fromIndex: a.rows.length, fromScan: 0, kinds: kindsOf(a.rows) };
  if (!a) return { ...b, capped, skipped, fromIndex: 0, fromScan: b.rows.length, kinds: kindsOf(b.rows) };
  const place = (row) => [pathRank(row.path), row.path, row.start_line];
  const compare = (p, q) => p[0] - q[0] || (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0) || p[2] - q[2];
  const rows = [
    ...a.rows.map((row, i) => ({ row, source: 0, i })),
    ...b.rows.map((row, i) => ({ row, source: 1, i })),
  ]
    .sort((x, y) => compare(place(x.row), place(y.row)) || x.source - y.source || x.i - y.i)
    .map((entry) => entry.row);
  const fileIds = new Set([...a.fileIds, ...b.fileIds]);
  return {
    rows,
    uses: a.uses + b.uses,
    files: fileIds.size,
    fileIds: [...fileIds],
    names: [...new Set([...a.names, ...b.names])],
    kinds: kindsOf(rows),
    cut: b.cut ?? null,
    capped,
    skipped: null,
    fromIndex: a.rows.length,
    fromScan: b.rows.length,
  };
}

// Whether a symbol search leaves the name to the places that use it: no symbol carries it, or
// the symbols found only share words with it.
const listsPlaces = (found) => found.rows.length === 0 || found.dropped.length > 0;

/**
 * Symbols by name (CONTRACTS.md §8 `search`), best match first. When `info` is given it
 * receives the words the search matched and those it had to drop (`matched`, `dropped`).
 *
 * No symbol carries the name, or none carries all of its words: the rows are the places that
 * use such a name, and `info.refs` says how many there are (`{ uses, files, names, capped,
 * fromIndex, fromScan, kinds, cut, skipped, symbols, symbolCount }`). That is the name the T20 sessions
 * went to grep for (`membershipKind`). The places come from two sources, merged into one list:
 * the index (a call, a type name, a read a language records) and, when the caller passed
 * `extra.propertyReads`, a scan of the JS/TS source for a property read (`row.membershipKind`),
 * the key of an object (`{ membershipKind }`), the attribute of a JSX element or the member of a
 * type (CONTRACTS.md §8 "property reads"); `fromIndex` and `fromScan` count the rows of each,
 * `kinds` lists the kinds the rows have, `cut` names a lookup of the scan that was cut while the
 * other has rows (`reads` or `keys`), and `skipped` says why the scan has none: `not-asked` when
 * the caller passed no scan; otherwise not ready, not a single name, a hub: read or used as a
 * key in more files than it lists, a limit: more hits or more bytes than one scan takes, or files
 * it could not read. Rows are cut to `limit`; the totals are not. A symbol that carries
 * every word outranks the places, and so does a symbol that shares one word with a name used
 * in more than `REF_LEAD_MAX` places: where such a name is used says nothing about
 * orientation. When nothing leads, `info.hub` is set for a name that is read as a property or
 * used as a key in more files than the scan lists. With a `kind` only symbols qualify.
 * @returns {{ id: number, kind: string, name: string, qual: string, path: string, startLine: number, endLine: number, signature: string|null, usage?: object }[]}
 *   or reference rows `{ kind, name, receiver, count, path, startLine, owner, ownerQual, ownerKind }`
 */
export function search(db, { query, kind = null, limit = DEFAULT_LIMIT } = {}, info = null, extra = null) {
  requireDb('search', db);
  if (typeof query !== 'string' || query.trim() === '') return [];
  const found = searchSymbolsDetailed(db, query, { limit: limitOf('search', limit), kind });
  const partial = listsPlaces(found);
  const indexed = !kind && partial ? searchRefs(db, query, { limit: limitOf('search', limit) }) : null;
  // The scan is asked whether or not the index has the name: an index row may be a call or a
  // read in another language, and the JS/TS property reads are still only in the source.
  const scan = !kind && partial && extra?.propertyReads ? extra.propertyReads(query) : null;
  const places = mergePlaces(indexed, scan);
  // No scan was asked for: its having no row is not "none were found in the source".
  if (places && !extra?.propertyReads) places.skipped = 'not-asked';
  if (places?.rows.length > 0 && (found.rows.length === 0 || places.uses <= REF_LEAD_MAX)) {
    if (info) {
      info.refs = {
        uses: places.uses,
        files: places.files,
        names: places.names,
        capped: places.capped,
        fromIndex: places.fromIndex,
        fromScan: places.fromScan,
        kinds: places.kinds,
        cut: places.cut ?? null,
        skipped: places.skipped,
        symbols: found.rows.slice(0, 3).map((row) => row.name),
        symbolCount: found.rows.length,
      };
    }
    return places.rows.map(refRow).slice(0, limitOf('search', limit));
  }
  if (info) {
    info.matched = found.matched;
    info.dropped = found.dropped;
    if (places?.skipped === 'hub') info.hub = true;
  }
  if (found.rows.length === 0) return [];
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
 * Whether `search` would list the places that use `query` rather than symbols (`searchIsPartial`
 * is what `search` decides on). The symbol search alone decides it, so a caller can ask this,
 * look for property reads when it is true (CONTRACTS.md §8 "property reads"), and then make the
 * one `search` with both sources — instead of a first `search` only to find out.
 *
 * @returns {boolean}
 */
export function searchIsPartial(db, { query, kind = null, limit = DEFAULT_LIMIT } = {}) {
  requireDb('searchIsPartial', db);
  if (typeof query !== 'string' || query.trim() === '') return false;
  return listsPlaces(searchSymbolsDetailed(db, query, { limit: limitOf('search', limit), kind }));
}

/**
 * Refs that point at `target`, grouped by the symbol that contains them.
 * Module-level refs (import statements) form one group per file, named after
 * the ref. `resolution` is the strongest marker in the group. Groups are
 * ordered by the tier of their file (source, tests, generated) before the
 * limit cuts any, so a cut row is never the source one.
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
  return [...groups.values()]
    .sort((a, b) => pathRank(a.path) - pathRank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine)
    .slice(0, limit);
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
  return [...groups.values()]
    .sort((a, b) => pathRank(a.path) - pathRank(b.path) || b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit);
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
  // Source before tests and generated files, then the depth and source order the walk found:
  // the tool's row limit keeps the leading entries, so a generated file must not displace one.
  nodes.sort((a, b) => pathRank(a.path) - pathRank(b.path) || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine);
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

// The two dependency queries live in their own module (an SCC walk and a bounded reverse
// closure are more code than the rest here); re-exported so `resolveGraph(context).queries`
// still hands the tool layer one object (CONTRACTS.md §8).
export { affectedTests, importCycles } from './dependencies.mjs';
