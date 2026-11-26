// Data access over the frozen schema (CONTRACTS.md §7). Every function takes the
// DatabaseSync handle first so the indexer, resolver and query layers share a
// single connection. Rows come back as stored (snake_case column names) plus
// `path` wherever the files table is joined, so plain SQL and these helpers
// agree on column names.
//
// Two deletion invariants cannot be expressed by the schema alone and are kept
// here:
//   - symbols_fts is an external-content FTS table: its index rows are removed
//     with the FTS5 'delete' command using the values that were indexed;
//   - refs.resolution is a plain column: it is cleared explicitly whenever the
//     target symbol disappears (the FK only nulls target_id / local_def_id).

import fs from 'node:fs';

const SYMBOL_WITH_PATH =
  'SELECT s.*, f.path AS path FROM symbols s JOIN files f ON f.id = s.file_id';
const REF_WITH_PATH =
  'SELECT r.*, f.path AS path FROM refs r JOIN files f ON f.id = r.file_id';
const IMPORT_WITH_PATH =
  'SELECT i.*, f.path AS path FROM imports i JOIN files f ON f.id = i.file_id';

const RESOLUTIONS = new Set(['=', '~', '?']);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function fail(fn, field, expectation, value) {
  return new TypeError(`${fn}: "${field}" ${expectation} (got ${describe(value)})`);
}

function requireDb(fn, db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw fail(fn, 'db', 'must be a DatabaseSync', db);
  }
}

function requireString(fn, field, value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw fail(fn, field, allowEmpty ? 'must be a string' : 'must be a non-empty string', value);
  }
  return value;
}

function requireInteger(fn, field, value, min = -Infinity) {
  if (!Number.isInteger(value) || value < min) {
    throw fail(fn, field, Number.isFinite(min) ? `must be an integer >= ${min}` : 'must be an integer', value);
  }
  return value;
}

function requireArray(fn, field, value) {
  if (!Array.isArray(value)) throw fail(fn, field, 'must be an array', value);
  return value;
}

function requireObject(fn, field, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(fn, field, 'must be an object', value);
  }
  return value;
}

function optionalString(fn, field, value) {
  if (value === undefined || value === null) return null;
  return requireString(fn, field, value, { allowEmpty: true });
}

function optionalInteger(fn, field, value, min = -Infinity) {
  if (value === undefined || value === null) return null;
  return requireInteger(fn, field, value, min);
}

function optionalFlag(fn, field, value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw fail(fn, field, 'must be a boolean or null', value);
  return value ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

let savepointSeq = 0;

// SAVEPOINT instead of BEGIN so a caller that already opened a transaction
// (batching several files) nests instead of failing; RELEASE commits when this
// is the outermost level.
export function inTransaction(db, fn) {
  const name = `cg_sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      // The connection itself failed; the original error is the useful one.
    }
    throw err;
  }
}

/**
 * One commit for the transactions that follow. A WAL commit costs a few
 * milliseconds on every platform measured, whatever its size, so a build that
 * commits per file pays that once per file. Every write inside the group keeps
 * its own savepoint and stays atomic on its own; the group only decides when
 * the outermost one is released. Must be ended exactly once, on the error path
 * too (what completed before an error is consistent, the rest was rolled back
 * to its own savepoint).
 *
 * @param {DatabaseSync} db
 * @returns {() => void} commit the group; further calls are no-ops
 */
export function beginWriteGroup(db) {
  const name = `cg_sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    db.exec(`RELEASE ${name}`);
    // A bulk load runs with FKs off and the refs/symbols indexes dropped, and
    // PRAGMA foreign_keys is a connection-wide setting: every commit is the
    // moment to notice that something turned it back on.
    if (bulkLoads.has(db)) assertBulkLoadInvariants(db);
  };
}

// ---------------------------------------------------------------------------
// Bulk load (a full build over an empty or force-cleared index)
// ---------------------------------------------------------------------------

// Maintaining the refs/symbols indexes and checking their FK columns row by
// row costs several times the row itself (five B-trees per ref, parent lookups
// per FK column), and a full build writes every row exactly once. A bulk load
// therefore clears the index, drops those indexes and switches FK enforcement
// off for the load; endBulkLoad builds the indexes back in one pass, turns
// FKs on again and verifies the whole index with foreign_key_check, so the
// integrity guarantee is the same, only paid once at the end. A crash in
// between leaves an index without those indexes, which the next openDatabase
// recreates through schema.sql's CREATE INDEX IF NOT EXISTS; the files written
// so far are complete (each commit group is atomic) and the resume path
// re-indexes the rest.

const SCHEMA_FILE = new URL('./schema.sql', import.meta.url);
const SCHEMA_INDEX_RE = /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+(?:refs|symbols)\s*\([^)]*\)\s*;/gi;

// The refs/symbols CREATE INDEX statements of the frozen schema, read once
// from the file so the list cannot drift from the schema.
let schemaIndexes = null;
function loadSchemaIndexes() {
  if (schemaIndexes === null) {
    const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
    schemaIndexes = [...sql.matchAll(SCHEMA_INDEX_RE)].map((m) => ({ name: m[1], sql: m[0].trim() }));
    if (schemaIndexes.length === 0) throw new Error('beginBulkLoad: schema.sql declares no index on refs or symbols');
  }
  return schemaIndexes;
}

// db -> { indexes } while a bulk load is active on that connection.
const bulkLoads = new WeakMap();

// The load relies on FKs staying off on this connection; a commit must not find
// that changed under it. Indexes being recreated by another process opening the
// database (`openDatabase` runs the schema's CREATE INDEX IF NOT EXISTS) only
// slows the rest of the load down, so it is not an error.
function assertBulkLoadInvariants(db) {
  if (prepare(db, 'PRAGMA foreign_keys').get().foreign_keys !== 0) {
    throw new Error('bulk load: PRAGMA foreign_keys was turned back on during the load');
  }
}

/**
 * Start a bulk load: clear every indexed row and FTS entry, drop the
 * refs/symbols indexes and stop enforcing foreign keys on this connection.
 * Must run outside a transaction (PRAGMA foreign_keys is a no-op inside one).
 *
 * @param {DatabaseSync} db
 * @returns {void}
 */
export function beginBulkLoad(db) {
  requireDb('beginBulkLoad', db);
  if (bulkLoads.has(db)) throw new Error('beginBulkLoad: a bulk load is already active on this connection');
  if (db.isTransaction) throw new Error('beginBulkLoad: cannot start inside a transaction');
  const indexes = loadSchemaIndexes();
  // Everything that can fail on its own runs before FKs are turned off; a failure after
  // that point would leave the connection with FKs off and no indexes unless restored here.
  clearPurgedSymbols(db);
  clearPendingFiles(db);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    inTransaction(db, () => {
      // Children before parents; with no WHERE, no triggers and FKs off these
      // are truncations that do not visit the rows.
      db.exec('DELETE FROM refs; DELETE FROM imports; DELETE FROM symbols; DELETE FROM files;');
      for (const { name } of indexes) db.exec(`DROP INDEX IF EXISTS "${name}"`);
      // External-content FTS: rebuild the inverted index from the content table,
      // now empty, instead of a 'delete' command per former symbol row.
      db.exec("INSERT INTO symbols_fts (symbols_fts) VALUES ('rebuild')");
    });
  } catch (err) {
    try {
      inTransaction(db, () => {
        for (const { sql } of indexes) db.exec(sql);
      });
    } catch {
      // the original error is the useful one; the connection is re-opened by the caller anyway
    }
    db.exec('PRAGMA foreign_keys = ON');
    throw err;
  }
  bulkLoads.set(db, { indexes });
}

/**
 * Finish a bulk load: rebuild the indexes from the schema, enforce foreign
 * keys again and verify the index (`foreign_key_check` must be empty), then
 * ANALYZE once so the planner has statistics for the finished tables. Must run
 * outside a transaction. Idempotent for a connection without an active load.
 *
 * @param {DatabaseSync} db
 * @returns {boolean} whether a load was finished
 */
export function endBulkLoad(db) {
  requireDb('endBulkLoad', db);
  const state = bulkLoads.get(db);
  if (!state) return false;
  if (db.isTransaction) throw new Error('endBulkLoad: cannot finish inside a transaction');
  bulkLoads.delete(db);
  inTransaction(db, () => {
    for (const { sql } of state.indexes) db.exec(sql);
  });
  db.exec('PRAGMA foreign_keys = ON');
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    const first = violations[0];
    throw new Error(
      `endBulkLoad: ${violations.length} foreign key violation(s) after the bulk load ` +
      `(first: ${first.table} rowid ${first.rowid} -> ${first.parent})`
    );
  }
  db.exec('ANALYZE');
  return true;
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// node:sqlite compiles a statement on every prepare(), and the hot paths repeat
// a handful of SQL texts thousands of times per build (a multi-row insert shape
// costs ~0.3 ms to compile). Compiled statements are therefore kept per
// connection. Only constant texts and the fixed shapes below go through here,
// which keeps the cache small; ad-hoc SQL keeps using db.prepare().
const statementCache = new WeakMap();

/**
 * `db.prepare(sql)` for SQL texts that repeat, cached per connection.
 *
 * @param {DatabaseSync} db
 * @param {string} sql
 * @returns {StatementSync}
 */
export function prepare(db, sql) {
  let cache = statementCache.get(db);
  if (!cache) statementCache.set(db, (cache = new Map()));
  let stmt = cache.get(sql);
  if (!stmt) cache.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

// Multi-row INSERT shapes. Fixed row counts keep the number of distinct
// statements per table at four, so each shape is compiled once per connection
// and the remainder of a batch is served by the next smaller size down to
// single rows. 50 / 100 / 200 measured within noise of each other on the
// reference corpus in bulk mode (1.49 / 1.38 / 1.55 s for the write phase);
// 100 was the most consistent.
const INSERT_ROWS = [100, 20, 4, 1];

// SQLITE_MAX_VARIABLE_NUMBER is a compile-time setting of the SQLite build
// (32766 in Node's); a statement may not bind more parameters than that, so a
// shape is dropped when the widest row that uses it would not fit.
let maxVariables = null;
function insertSizes(db, arity) {
  if (maxVariables === null) {
    const row = db.prepare('PRAGMA compile_options').all().find((r) => /^MAX_VARIABLE_NUMBER=\d+$/.test(r.compile_options));
    maxVariables = row ? Number(row.compile_options.slice('MAX_VARIABLE_NUMBER='.length)) : 999;
  }
  const sizes = INSERT_ROWS.filter((n) => n * arity <= maxVariables);
  return sizes.includes(1) ? sizes : [...sizes, 1];
}

const insertSqlCache = new Map();
function insertSql(table, columns, size) {
  const key = `${table}|${columns.join(',')}|${size}`;
  let sql = insertSqlCache.get(key);
  if (!sql) {
    const tuple = `(${columns.map(() => '?').join(', ')})`;
    insertSqlCache.set(key, (sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${Array.from({ length: size }, () => tuple).join(', ')}`));
  }
  return sql;
}

/**
 * Insert rows of equal arity with multi-row VALUES statements.
 *
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {string[]} columns
 * @param {Array[]} rows  flat value arrays, `columns.length` entries each
 * @returns {void}
 */
function insertRows(db, table, columns, rows) {
  const arity = columns.length;
  const sizes = insertSizes(db, arity);
  let n = 0;
  let si = 0;
  while (n < rows.length) {
    while (sizes[si] > rows.length - n) si++;
    const size = sizes[si];
    const params = new Array(size * arity);
    for (let k = 0; k < size; k++) {
      const row = rows[n + k];
      for (let c = 0; c < arity; c++) params[k * arity + c] = row[c];
    }
    prepare(db, insertSql(table, columns, size)).run(...params);
    n += size;
  }
}

// Transactions that purge a file's symbols. FK ON DELETE actions are indexed
// (symbols.parent_id, refs.local_def_id), so they run with foreign keys enforced;
// the one cross-file link (refs.target_id) is additionally maintained explicitly in
// purgeFileContents. Nested calls (a caller-owned transaction) become a savepoint.
function inPurgeTransaction(db, fn) {
  return inTransaction(db, fn);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function fileRow(fn, file) {
  requireObject(fn, 'file', file);
  if (typeof file.parseOk !== 'boolean') throw fail(fn, 'parseOk', 'must be a boolean', file.parseOk);
  return {
    path: requireString(fn, 'path', file.path),
    lang: requireString(fn, 'lang', file.lang),
    hash: requireString(fn, 'hash', file.hash),
    mtimeMs: requireInteger(fn, 'mtimeMs', file.mtimeMs, 0),
    size: requireInteger(fn, 'size', file.size, 0),
    parseOk: file.parseOk ? 1 : 0,
    errorNodes: requireInteger(fn, 'errorNodes', file.errorNodes, 0),
    indexedAt: requireInteger(fn, 'indexedAt', file.indexedAt, 0),
  };
}

/**
 * Insert the file, or update it in place when the path already exists. An
 * update also drops the previous extraction (symbols, refs, imports, FTS rows)
 * so the caller always follows up with replaceAllForFile.
 *
 * @returns {number} file id
 */
export function upsertFile(db, file) {
  requireDb('upsertFile', db);
  return upsertFileRow(db, 'upsertFile', file, { purge: true }).id;
}

// The file row. `purge` drops the previous extraction (what upsertFile promises);
// replaceFile leaves it to replaceAll, which keeps the ids of definitions that
// survive. `created` tells the caller that nothing derived from this id can
// exist yet (ids of deleted files are only reused after their rows went with
// them), so it need not look for previous rows: without the file indexes, which
// a bulk load drops, those queries scan every row of the table.
function upsertFileRow(db, fn, file, { purge }) {
  const row = fileRow(fn, file);
  return inPurgeTransaction(db, () => {
    const existing = prepare(db, 'SELECT id FROM files WHERE path = ?').get(row.path);
    if (existing) {
      if (purge) purgeFileContents(db, existing.id);
      prepare(
        db,
        'UPDATE files SET lang = ?, hash = ?, mtime_ms = ?, size = ?, parse_ok = ?, error_nodes = ?, indexed_at = ? WHERE id = ?'
      ).run(row.lang, row.hash, row.mtimeMs, row.size, row.parseOk, row.errorNodes, row.indexedAt, existing.id);
      return { id: Number(existing.id), created: false };
    }
    const inserted = prepare(
      db,
      'INSERT INTO files (path, lang, hash, mtime_ms, size, parse_ok, error_nodes, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.path, row.lang, row.hash, row.mtimeMs, row.size, row.parseOk, row.errorNodes, row.indexedAt);
    return { id: Number(inserted.lastInsertRowid), created: true };
  });
}

/** @returns {object|null} the files row for `path` */
export function getFileByPath(db, path) {
  requireDb('getFileByPath', db);
  requireString('getFileByPath', 'path', path);
  return db.prepare('SELECT * FROM files WHERE path = ?').get(path) ?? null;
}

/** @returns {object[]} every file, ordered by path */
export function listFiles(db) {
  requireDb('listFiles', db);
  return db.prepare('SELECT * FROM files ORDER BY path').all();
}

/** @returns {number} */
export function countFiles(db) {
  requireDb('countFiles', db);
  return Number(db.prepare('SELECT COUNT(*) AS count FROM files').get().count);
}

/**
 * Remove the file and everything derived from it. Refs in other files that
 * pointed at its symbols lose their target and resolution.
 *
 * @returns {boolean} whether a file was removed
 */
export function deleteFile(db, path) {
  requireDb('deleteFile', db);
  requireString('deleteFile', 'path', path);
  return inPurgeTransaction(db, () => {
    const row = db.prepare('SELECT id FROM files WHERE path = ?').get(path);
    if (!row) return false;
    purgeFileContents(db, row.id);
    // Importers lose their resolved target (FK SET NULL on the FK-on path).
    db.prepare('UPDATE imports SET resolved_file_id = NULL WHERE resolved_file_id = ?').run(row.id);
    db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM dirty WHERE path = ?').run(path);
    return true;
  });
}

// Remove everything derived from a file's extraction. Must run inside the
// caller's transaction and before the files row itself is touched.
function purgeFileContents(db, fileId) {
  // External-content FTS: the 'delete' command needs the indexed values, so
  // read them from the content table while it still has the rows. Nulls were
  // indexed as '' and are passed the same way here.
  const indexed = prepare(
    db,
    "SELECT id, name, kind, exported, parent_id IS NULL AS top, COALESCE(signature, '') AS signature, COALESCE(doc, '') AS doc FROM symbols WHERE file_id = ?"
  ).all(fileId);
  // Cross-file links: refs elsewhere pointing at this file's symbols lose their
  // target and, because the schema has no trigger for it, their resolution
  // (a stale '=' would otherwise survive the target). Done explicitly so it
  // also holds on the foreign-keys-off path; local_def_id and parent_id only
  // ever reference the same file, whose rows go away below.
  logPendingFiles(db, indexed.map((r) => r.id));
  prepare(
    db,
    'UPDATE refs SET target_id = NULL, resolution = NULL WHERE target_id IN (SELECT id FROM symbols WHERE file_id = ?)'
  ).run(fileId);

  const ftsDelete = prepare(
    db,
    "INSERT INTO symbols_fts (symbols_fts, rowid, name, signature, doc) VALUES ('delete', ?, ?, ?, ?)"
  );
  for (const row of indexed) ftsDelete.run(row.id, row.name, row.signature, row.doc);

  logPurgedSymbols(db, fileId, indexed);

  prepare(db, 'DELETE FROM refs WHERE file_id = ?').run(fileId);
  prepare(db, 'DELETE FROM imports WHERE file_id = ?').run(fileId);
  prepare(db, 'DELETE FROM symbols WHERE file_id = ?').run(fileId);
}

// ---------------------------------------------------------------------------
// Purged definitions (for the resolver's recheck)
// ---------------------------------------------------------------------------

// What a file defined before its extraction was replaced or removed. The
// resolver compares it with the new definitions to tell which names may now
// resolve differently elsewhere (CONTRACTS.md §8): a '?' ref elsewhere named N
// can only change if this file's set of definitions named N changed, since
// every other input to that decision is untouched by the re-index. A TEMP table
// lives and dies with the connection; resolveFile consumes it, resolveAll
// clears it, so it holds at most one pass worth of purges.
// Created unconditionally on every entry: a ROLLBACK inside the transaction that first created
// it drops the TEMP table, and a JS-side "already created" cache would then point at nothing
// for the rest of the connection's life (CREATE ... IF NOT EXISTS is a schema lookup).
const PURGED_SYMBOLS_SQL = 'CREATE TEMP TABLE IF NOT EXISTS purged_symbols (file_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, exported INTEGER, top INTEGER NOT NULL)';

function logPurgedSymbols(db, fileId, indexed) {
  db.exec(PURGED_SYMBOLS_SQL);
  prepare(db, 'DELETE FROM purged_symbols WHERE file_id = ?').run(fileId);
  const insert = prepare(db, 'INSERT INTO purged_symbols (file_id, name, kind, exported, top) VALUES (?, ?, ?, ?, ?)');
  for (const row of indexed) insert.run(fileId, row.name, row.kind, row.exported, row.top);
}

/**
 * The definitions purged since the last call, grouped per file.
 *
 * @param {DatabaseSync} db
 * @returns {Map<number, { name: string, kind: string, exported: number|null, top: number }[]>}
 */
export function takePurgedSymbols(db) {
  requireDb('takePurgedSymbols', db);
  const rows = prepare(db, 'SELECT file_id, name, kind, exported, top FROM purged_symbols').all();
  prepare(db, 'DELETE FROM purged_symbols').run();
  const byFile = new Map();
  for (const row of rows) {
    const list = byFile.get(row.file_id);
    if (list) list.push(row);
    else byFile.set(row.file_id, [row]);
  }
  return byFile;
}

/** Drop the purged-definition log (nothing will compare against it). @returns {void} */
export function clearPurgedSymbols(db) {
  db.exec(PURGED_SYMBOLS_SQL);
  prepare(db, 'DELETE FROM purged_symbols').run();
}

// ---------------------------------------------------------------------------
// Pending files (for the resolver)
// ---------------------------------------------------------------------------

// Refs are made pending (target and resolution NULLed) in exactly one place
// each: the removal of the symbols they pointed at. The files that hold such
// refs are recorded here when that happens, so resolveFile knows which other
// files to look at without scanning every ref for `resolution IS NULL` (no
// index on that column). TEMP table: cleared after a successful resolver pass
// and by resolveAll; refs left pending by a crashed process are picked up by
// the next build's resolveAll, as before. Same creation rule as purged_symbols.
const PENDING_FILES_SQL = 'CREATE TEMP TABLE IF NOT EXISTS pending_files (file_id INTEGER PRIMARY KEY)';

// Must run before the symbols go (it reads refs.target_id), inside the
// caller's transaction. `symbolIds` may be empty.
function logPendingFiles(db, symbolIds) {
  if (symbolIds.length === 0) return;
  db.exec(PENDING_FILES_SQL);
  // The planner picks a full scan of refs for this shape despite refs_target
  // (30 ms against 0 on 342k refs), so the index is named explicitly; a bulk
  // load has dropped it, and there a scan is all there is.
  const sql = bulkLoads.has(db)
    ? 'INSERT OR IGNORE INTO pending_files (file_id) SELECT DISTINCT file_id FROM refs WHERE target_id = ?'
    : 'INSERT OR IGNORE INTO pending_files (file_id) SELECT DISTINCT file_id FROM refs INDEXED BY refs_target WHERE target_id = ?';
  const insert = prepare(db, sql);
  for (const id of symbolIds) insert.run(id);
}

/**
 * The files whose refs were made pending and not yet looked at. Cleared by
 * the resolver once its pass succeeded (a failed pass must find them again).
 *
 * @param {DatabaseSync} db
 * @returns {Set<number>} file ids
 */
export function pendingFiles(db) {
  requireDb('pendingFiles', db);
  db.exec(PENDING_FILES_SQL);
  const files = new Set();
  for (const { file_id } of prepare(db, 'SELECT file_id FROM pending_files').all()) files.add(file_id);
  return files;
}

/** Drop the pending-files log (resolveAll looks at every file anyway). @returns {void} */
export function clearPendingFiles(db) {
  db.exec(PENDING_FILES_SQL);
  prepare(db, 'DELETE FROM pending_files').run();
}

// ---------------------------------------------------------------------------
// Per-file atomic replace
// ---------------------------------------------------------------------------

function normalizeSymbol(fn, field, s) {
  requireObject(fn, field, s);
  const startLine = requireInteger(fn, `${field}.startLine`, s.startLine, 1);
  return {
    kind: requireString(fn, `${field}.kind`, s.kind),
    name: requireString(fn, `${field}.name`, s.name),
    qual: s.qual === undefined || s.qual === null ? '' : requireString(fn, `${field}.qual`, s.qual, { allowEmpty: true }),
    startLine,
    endLine: requireInteger(fn, `${field}.endLine`, s.endLine, startLine),
    startCol: optionalInteger(fn, `${field}.startCol`, s.startCol, 0) ?? 0,
    signature: optionalString(fn, `${field}.signature`, s.signature),
    doc: optionalString(fn, `${field}.doc`, s.doc),
    exported: optionalFlag(fn, `${field}.exported`, s.exported),
    parent: optionalInteger(fn, `${field}.parent`, s.parent, 0),
    block: optionalInteger(fn, `${field}.block`, s.block, 0),
  };
}

function normalizeRef(fn, field, r) {
  requireObject(fn, field, r);
  const startLine = requireInteger(fn, `${field}.startLine`, r.startLine, 1);
  return {
    name: requireString(fn, `${field}.name`, r.name),
    receiver: optionalString(fn, `${field}.receiver`, r.receiver),
    kind: requireString(fn, `${field}.kind`, r.kind),
    startLine,
    startCol: requireInteger(fn, `${field}.startCol`, r.startCol, 0),
    endLine: requireInteger(fn, `${field}.endLine`, r.endLine, startLine),
    scope: optionalString(fn, `${field}.scope`, r.scope),
    symbol: optionalInteger(fn, `${field}.symbol`, r.symbol, 0),
    localDef: optionalInteger(fn, `${field}.localDef`, r.localDef, 0),
  };
}

// The engine emits either a string or [{ imported, alias }]; the column is TEXT,
// so arrays are stored as JSON.
function normalizeImportNames(fn, field, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  throw fail(fn, `${field}.names`, 'must be a string, an array or null', value);
}

function normalizeImport(fn, field, imp) {
  requireObject(fn, field, imp);
  return {
    spec: requireString(fn, `${field}.spec`, imp.spec),
    names: normalizeImportNames(fn, field, imp.names),
    kind: requireString(fn, `${field}.kind`, imp.kind),
    startLine: requireInteger(fn, `${field}.startLine`, imp.startLine, 1),
  };
}

// Parents must be inserted before children (FK on symbols.parent_id). Input
// order is not trusted, so symbols are emitted parent-first; a cycle is a
// contract violation and is reported instead of recursing forever.
function parentFirstOrder(parents) {
  const n = parents.length;
  const state = new Uint8Array(n); // 0 unseen, 1 on the current path, 2 done
  const order = [];
  for (let start = 0; start < n; start++) {
    if (state[start] !== 0) continue;
    const stack = [start];
    while (stack.length > 0) {
      const i = stack[stack.length - 1];
      if (state[i] === 1) {
        state[i] = 2;
        order.push(i);
        stack.pop();
        continue;
      }
      state[i] = 1;
      const p = parents[i];
      if (p === null) continue;
      if (state[p] === 1) {
        throw new TypeError(`replaceAllForFile: "symbols[${i}].parent" forms a cycle through index ${p}`);
      }
      if (state[p] === 0) stack.push(p);
    }
  }
  return order;
}

// What a file defines right now, for a replace that keeps ids (see replaceAll).
const OLD_SYMBOLS_SQL =
  "SELECT id, kind, name, qual, parent_id, parent_id IS NULL AS top, exported, COALESCE(signature, '') AS signature, COALESCE(doc, '') AS doc FROM symbols WHERE file_id = ?";

// A definition keeps its row id across a re-index when exactly one old and one
// new definition share kind, qual and name: everything else about the row
// (lines, signature, doc, export flag, block, parent) may change in place.
// A key that occurs more than once on either side (overloads) is not paired:
// that group is deleted and inserted with fresh ids.
function symbolKey(s) {
  return `${s.kind}\u0000${s.qual}\u0000${s.name}`;
}

// keep: new index -> old row; removed: old rows nobody kept.
function matchSymbols(oldRows, newRows) {
  const oldByKey = new Map();
  for (const row of oldRows) {
    const key = symbolKey(row);
    const list = oldByKey.get(key);
    if (list) list.push(row);
    else oldByKey.set(key, [row]);
  }
  const newCount = new Map();
  for (const s of newRows) newCount.set(symbolKey(s), (newCount.get(symbolKey(s)) ?? 0) + 1);
  const keep = new Map();
  const kept = new Set();
  newRows.forEach((s, i) => {
    const key = symbolKey(s);
    const list = oldByKey.get(key);
    if (list && list.length === 1 && newCount.get(key) === 1) {
      keep.set(i, list[0]);
      kept.add(list[0].id);
    }
  });
  const removed = oldRows.filter((row) => !kept.has(row.id));
  return { keep, removed };
}

function* chunksOf(items, size) {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Replace a file's whole extraction in one transaction. A definition whose
 * kind, qual and name occur exactly once before and after keeps its row id and
 * is updated in place (refs elsewhere that point at it stay resolved); every
 * other previous symbol is removed (refs that pointed at it go back to pending)
 * and every other new one inserted with a fresh id. `parent`,
 * `refs[].symbol` and `refs[].localDef` are indexes into the `symbols` array
 * and are stored as row ids.
 *
 * @param {DatabaseSync} db
 * @param {number} fileId
 * @param {{ symbols?: object[], refs?: object[], imports?: object[] }} data
 * @returns {{ symbolIds: number[] }} row id per input symbol, same index order
 */
export function replaceAllForFile(db, fileId, data = {}) {
  requireDb('replaceAllForFile', db);
  return replaceAll(db, fileId, data, { existing: true });
}

// `existing: false` is for a file row created in the same transaction (see
// replaceFile): nothing derived from a brand-new id exists, and the queries
// below are the one per-file cost a bulk load cannot afford without indexes.
function replaceAll(db, fileId, data, { existing }) {
  requireInteger('replaceAllForFile', 'fileId', fileId, 1);
  requireObject('replaceAllForFile', 'data', data);
  const symbols = data.symbols === undefined ? [] : requireArray('replaceAllForFile', 'symbols', data.symbols);
  const refs = data.refs === undefined ? [] : requireArray('replaceAllForFile', 'refs', data.refs);
  const imports = data.imports === undefined ? [] : requireArray('replaceAllForFile', 'imports', data.imports);

  // Validate and normalize everything before touching the database.
  const symbolRows = symbols.map((s, i) => normalizeSymbol('replaceAllForFile', `symbols[${i}]`, s));
  const parents = symbolRows.map((s, i) => {
    const p = s.parent;
    if (p !== null && (p >= symbolRows.length || p === i)) {
      throw new TypeError(
        `replaceAllForFile: "symbols[${i}].parent" must be null or the index of another symbol (got ${p})`
      );
    }
    return p;
  });
  const order = parentFirstOrder(parents);
  const refRows = refs.map((r, i) => {
    const row = normalizeRef('replaceAllForFile', `refs[${i}]`, r);
    for (const key of ['symbol', 'localDef']) {
      if (row[key] !== null && row[key] >= symbolRows.length) {
        throw new TypeError(
          `replaceAllForFile: "refs[${i}].${key}" must be null or a symbols index (got ${row[key]})`
        );
      }
    }
    return row;
  });
  const importRows = imports.map((imp, i) => normalizeImport('replaceAllForFile', `imports[${i}]`, imp));

  return inPurgeTransaction(db, () => {
    if (!prepare(db, 'SELECT 1 FROM files WHERE id = ?').get(fileId)) {
      throw new Error(`replaceAllForFile: no file with id ${fileId}`);
    }
    // Definitions that survive the edit keep their row ids, so refs elsewhere
    // that point at them stay resolved (see symbolKey). Everything else goes
    // the old way: null the refs of removed symbols, delete, insert anew.
    const old = existing ? prepare(db, OLD_SYMBOLS_SQL).all(fileId) : [];
    const { keep, removed } = matchSymbols(old, symbolRows);
    logPurgedSymbols(db, fileId, old); // the resolver compares definitions, never ids
    const removedIds = removed.map((r) => r.id);
    logPendingFiles(db, removedIds);
    if (existing) {
      // Without the file indexes (a bulk load drops them) each of these is a
      // full scan, and a brand-new file row has nothing to delete.
      if (removedIds.length > 0) {
        for (const chunk of chunksOf(removedIds, 500)) {
          prepare(db, `UPDATE refs SET target_id = NULL, resolution = NULL WHERE target_id IN (${chunk.map(() => '?').join(', ')})`).run(...chunk);
        }
      }
      prepare(db, 'DELETE FROM refs WHERE file_id = ?').run(fileId);
      prepare(db, 'DELETE FROM imports WHERE file_id = ?').run(fileId);
    }
    const ftsDelete = prepare(db, "INSERT INTO symbols_fts (symbols_fts, rowid, name, signature, doc) VALUES ('delete', ?, ?, ?, ?)");
    const ftsInsert = prepare(db, 'INSERT INTO symbols_fts (rowid, name, signature, doc) VALUES (?, ?, ?, ?)');
    for (const row of removed) ftsDelete.run(row.id, row.name, row.signature, row.doc);

    const symbolIds = new Array(symbolRows.length);
    for (const [i, row] of keep) symbolIds[i] = row.id;
    // New rows get ids above every existing one, parent-first among themselves,
    // so a multi-row statement can name the parent of a row it inserts later
    // (the FK is checked per row). Kept rows exist already, whatever their parent.
    const base = Number(prepare(db, 'SELECT COALESCE(MAX(id), 0) + 1 AS next FROM symbols').get().next);
    const symbolTuples = [];
    const ftsTuples = [];
    let added = 0;
    for (const i of order) {
      if (keep.has(i)) continue;
      const s = symbolRows[i];
      symbolIds[i] = base + added;
      symbolTuples.push([
        base + added, fileId, parents[i] === null ? null : symbolIds[parents[i]],
        s.kind, s.name, s.qual, s.startLine, s.endLine, s.startCol, s.signature, s.doc, s.exported, s.block,
      ]);
      // External-content FTS: rowid must equal symbols.id; the content table is
      // read for display, these values only build the inverted index.
      ftsTuples.push([base + added, s.name, s.signature ?? '', s.doc ?? '']);
      added++;
    }
    if (symbolTuples.length > 0) {
      insertRows(db, 'symbols', ['id', 'file_id', 'parent_id', 'kind', 'name', 'qual', 'start_line', 'end_line', 'start_col', 'signature', 'doc', 'exported', 'block'], symbolTuples);
      insertRows(db, 'symbols_fts', ['rowid', 'name', 'signature', 'doc'], ftsTuples);
    }

    // Kept rows in place: positions, signature, doc, export flag, block and the
    // parent, which may now be a kept or a newly inserted row. Before the
    // removed rows go: deleting a parent cascades to whoever still names it.
    const update = prepare(
      db,
      'UPDATE symbols SET parent_id = ?, start_line = ?, end_line = ?, start_col = ?, signature = ?, doc = ?, exported = ?, block = ? WHERE id = ?'
    );
    for (const [i, row] of keep) {
      const s = symbolRows[i];
      update.run(parents[i] === null ? null : symbolIds[parents[i]], s.startLine, s.endLine, s.startCol, s.signature, s.doc, s.exported, s.block, row.id);
      // The inverted index only changes with the indexed values.
      if (row.signature !== (s.signature ?? '') || row.doc !== (s.doc ?? '')) {
        ftsDelete.run(row.id, row.name, row.signature, row.doc);
        ftsInsert.run(row.id, s.name, s.signature ?? '', s.doc ?? '');
      }
    }
    const deleteSymbol = prepare(db, 'DELETE FROM symbols WHERE id = ?');
    for (const row of removed) deleteSymbol.run(row.id);

    const refTuples = refRows.map((r) => [
      fileId,
      r.symbol === null ? null : symbolIds[r.symbol],
      r.name,
      r.receiver,
      r.kind,
      r.startLine,
      r.startCol,
      r.endLine,
      r.scope,
      r.localDef === null ? null : symbolIds[r.localDef],
    ]);
    insertRows(db, 'refs', ['file_id', 'symbol_id', 'name', 'receiver', 'kind', 'start_line', 'start_col', 'end_line', 'scope', 'local_def_id'], refTuples);

    insertRows(db, 'imports', ['file_id', 'spec', 'names', 'kind', 'start_line'], importRows.map((imp) => [fileId, imp.spec, imp.names, imp.kind, imp.startLine]));

    return { symbolIds };
  });
}

// Below this many entries the per-row UPDATE is as fast (one statement per row
// either way once they are grouped by target); above it, rows sharing target
// and resolution go into UPDATE ... WHERE id IN (...) batches.
const RESOLUTION_BATCH = 500;
const RESOLUTION_BATCH_MIN_ROWS = 50;

/**
 * Record resolver outcomes. `resolution` is '=' (import-resolved), '~'
 * (unique name) or '?' (unresolved / dynamic); `targetId` may be null for '?'.
 * Unknown ref ids raise instead of being skipped.
 *
 * @param {DatabaseSync} db
 * @param {{ refId: number, targetId: number|null, resolution: string }[]} entries
 * @returns {number} entries written
 */
export function setRefResolution(db, entries) {
  requireDb('setRefResolution', db);
  requireArray('setRefResolution', 'entries', entries);
  const rows = entries.map((entry, i) => {
    const field = `entries[${i}]`;
    requireObject('setRefResolution', field, entry);
    requireInteger('setRefResolution', `${field}.refId`, entry.refId, 1);
    const targetId = entry.targetId === undefined || entry.targetId === null
      ? null
      : requireInteger('setRefResolution', `${field}.targetId`, entry.targetId, 1);
    if (!RESOLUTIONS.has(entry.resolution)) {
      throw fail('setRefResolution', `${field}.resolution`, 'must be one of "=", "~", "?"', entry.resolution);
    }
    return { refId: entry.refId, targetId, resolution: entry.resolution };
  });
  return inTransaction(db, () => {
    if (rows.length < RESOLUTION_BATCH_MIN_ROWS) {
      const update = prepare(db, 'UPDATE refs SET target_id = ?, resolution = ? WHERE id = ?');
      for (const row of rows) {
        if (Number(update.run(row.targetId, row.resolution, row.refId).changes) !== 1) throw new Error(`setRefResolution: no ref with id ${row.refId}`);
      }
      return rows.length;
    }
    // Rows that end alike are one UPDATE per batch of ids. A ref listed twice
    // keeps its last entry, as the sequential updates did. The total number of
    // changed rows must equal the number of refs; a mismatch means some id does
    // not exist (nothing is written: the transaction rolls back on the throw).
    const last = new Map();
    for (const row of rows) last.set(row.refId, row);
    const groups = new Map(); // "target\0resolution" -> { targetId, resolution, ids }
    for (const row of last.values()) {
      const key = `${row.targetId}\u0000${row.resolution}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { targetId: row.targetId, resolution: row.resolution, ids: [] }));
      group.ids.push(row.refId);
    }
    let changed = 0;
    for (const group of groups.values()) {
      for (let i = 0; i < group.ids.length; i += RESOLUTION_BATCH) {
        const chunk = group.ids.slice(i, i + RESOLUTION_BATCH);
        const sql = `UPDATE refs SET target_id = ?, resolution = ? WHERE id IN (${chunk.map(() => '?').join(', ')})`;
        changed += Number(prepare(db, sql).run(group.targetId, group.resolution, ...chunk).changes);
      }
    }
    if (changed !== last.size) throw new Error(`setRefResolution: no ref with id ${firstMissingRefId(db, rows)} (changed ${changed} of ${last.size} refs)`);
    return rows.length;
  });
}

// The first ref id of `rows` (input order) that has no row in refs.
function firstMissingRefId(db, rows) {
  const known = new Set();
  const ids = [...new Set(rows.map((r) => r.refId))];
  for (let i = 0; i < ids.length; i += RESOLUTION_BATCH) {
    const chunk = ids.slice(i, i + RESOLUTION_BATCH);
    for (const { id } of prepare(db, `SELECT id FROM refs WHERE id IN (${chunk.map(() => '?').join(', ')})`).all(...chunk)) known.add(id);
  }
  for (const row of rows) if (!known.has(row.refId)) return row.refId;
  return rows[0].refId;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function escapeLike(text) {
  return text.replace(/[\\%_]/g, '\\$&');
}

/**
 * Find symbols by name. `exact` compares the identifier verbatim (languages are
 * case-sensitive); `exact: false` matches a name prefix case-insensitively.
 *
 * @returns {object[]} symbol rows with `path`
 */
export function findSymbolsByName(db, name, { exact = true } = {}) {
  requireDb('findSymbolsByName', db);
  requireString('findSymbolsByName', 'name', name);
  if (typeof exact !== 'boolean') throw fail('findSymbolsByName', 'exact', 'must be a boolean', exact);
  const sql = exact
    ? `${SYMBOL_WITH_PATH} WHERE s.name = ? ORDER BY f.path, s.start_line, s.id`
    : `${SYMBOL_WITH_PATH} WHERE s.name LIKE ? ESCAPE '\\' ORDER BY f.path, s.start_line, s.id`;
  return db.prepare(sql).all(exact ? name : `${escapeLike(name)}%`);
}

/**
 * Split a query into lowercase identifier segments: separators (`,`, `.`, `:`,
 * whitespace, `-`, `_`) and camelCase / acronym boundaries all split.
 * "parseConfig", "parse_config", "parse-config" and "Parse2Config" all give
 * the same segments, which is what makes the search style-insensitive.
 */
export function identifierSegments(query) {
  const out = [];
  // Unicode letters/digits so CJK and accented identifiers still segment instead of yielding no query.
  for (const part of query.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const spaced = part
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    for (const segment of spaced.split(' ')) out.push(segment.toLowerCase());
  }
  return out;
}

// unicode61 with '_' as a token char keeps "parse_config" as one token and
// never splits camelCase, so the same segments are offered as three shapes: the
// joined prefix ("parseconfig*" hits parseConfig / parseconfigFile), the
// snake_case prefix ("parse_config*") and a phrase ("parse config" hits
// "parse-config" / "parse.config"). Tokens are quoted to dodge FTS keywords.
function ftsMatchExpression(segments) {
  const joined = segments.join('');
  const variants = new Set([`"${joined}"*`]);
  const snake = segments.join('_');
  if (snake !== joined) variants.add(`"${snake}"*`);
  if (segments.length > 1) variants.add(`"${segments.join(' ')}"`);
  return `name:(${[...variants].join(' OR ')})`;
}

/**
 * Search symbols by name, best match first. Rows include `path`.
 *
 * Match tiers: exact name, joined prefix ("parseconfig" → parseConfig), further FTS5
 * hits by bm25, then a LIKE pool for names the tokenizer cannot reach ("parse2config"
 * for "parseConfig") and for words in another order ("config parse"). Source files come
 * before tests and scripts, which come before generated files; only a name that starts with
 * the query may outrank them from such a file.
 *
 * A query written as a description ("sign-in cookie") names more than any symbol holds.
 * When nothing matches every word, the search falls back to partial matches: names that
 * contain one of the longest words, those that also contain more of the other words first.
 * `matched` lists the words the best row contains, `dropped` the rest (later rows may
 * still contain a dropped word).
 *
 * @param {DatabaseSync} db
 * @param {string} query
 * @param {{ limit?: number, kind?: string|null }} [options]
 * @returns {{ rows: object[], matched: string[], dropped: string[] }}
 */
export function searchSymbolsDetailed(db, query, options = {}) {
  requireDb('searchSymbols', db);
  requireString('searchSymbols', 'query', query, { allowEmpty: true });
  const { limit = 20, kind = null } = requireObject('searchSymbols', 'options', options);
  requireInteger('searchSymbols', 'limit', limit, 1);
  if (kind !== null && kind !== undefined) requireString('searchSymbols', 'kind', kind);

  // A repeated word is queried and reported once.
  const segments = [...new Set(identifierSegments(query))];
  if (segments.length === 0) return { rows: [], matched: [], dropped: [] };
  const kindClause = kind ? ' AND s.kind = ?' : '';
  const kindParams = kind ? [kind] : [];
  const full = searchLevel(db, segments, { limit, kindClause, kindParams, raw: query.trim().toLowerCase() });
  if (full.length > 0) return { rows: full, matched: segments, dropped: [] };
  if (segments.length < 2) return { rows: [], matched: [], dropped: [] };

  // Partial matches from every anchor, best first: the most query words contained, then the
  // most specific words, then source before tests and generated files, then the shorter name.
  const candidates = new Map();
  for (const anchor of relaxationAnchors(segments)) {
    for (const row of anchoredLevel(db, anchor, segments, { kindClause, kindParams })) {
      const words = segments.filter((seg) => wordDistance(row.name, [seg]) !== null);
      if (words.length > 0 && !candidates.has(row.id)) candidates.set(row.id, { row, words });
    }
  }
  const ranked = [...candidates.values()]
    .map((entry) => ({ ...entry, specificity: entry.words.reduce((sum, seg) => sum + seg.length * seg.length, 0) }))
    .sort((a, b) => b.words.length - a.words.length || b.specificity - a.specificity || pathRank(a.row.path) - pathRank(b.row.path)
      || a.row.name.length - b.row.name.length || (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0));
  if (ranked.length === 0) return { rows: [], matched: [], dropped: [] };
  const best = ranked[0].words;
  return {
    rows: ranked.slice(0, limit).map((entry) => entry.row),
    matched: segments.filter((seg) => best.includes(seg)),
    dropped: segments.filter((seg) => !best.includes(seg)),
  };
}

/** `searchSymbolsDetailed` without the match information. */
export function searchSymbols(db, query, options = {}) {
  return searchSymbolsDetailed(db, query, options).rows;
}

// How much a search for a name that is only a reference reads before it stops counting. A name
// can be a fragment of very many others (`meth` sits in two million references of a large
// repository): grouping those took 18 s, so the references are cut first and the scan stops
// there. A name that is used in tens of thousands of places (`toBe`) is then cut again, by the
// groups the totals are counted over (about 100 ms for 5,000). Past a cut the totals are lower
// bounds (`capped`). References are read in the order they sit in the table, so past the first
// cut the places come from the files that were indexed first.
export const REF_ROWS_MAX = 20000;
export const REF_GROUPS_MAX = 5000;

// Places that use a name, one row per name, receiver, file and the symbol that contains it
// (`req.get` and `res.get` inside one function are two rows). The order is decided in SQL,
// because that is what decides which rows survive the cut: names equal to the query, then
// source before tests and generated files, then by place. Parameters follow their position in
// the SQL text: the WHERE clause's, the reference cut, the exact-name tier, the file tier (the
// ORDER BY), the group cut.
const REF_GROUPS_SQL = (where) =>
  "SELECT r.name AS name, CASE WHEN COUNT(DISTINCT r.kind) = 1 THEN MIN(r.kind) ELSE 'use' END AS kind, NULLIF(r.receiver, '') AS receiver, COUNT(*) AS count," +
  ' MIN(r.start_line) AS start_line, r.file_id AS file_id, f.path AS path, s.name AS owner, s.qual AS owner_qual, s.kind AS owner_kind' +
  ` FROM (SELECT * FROM refs WHERE ${where} LIMIT ?) r JOIN files f ON f.id = r.file_id LEFT JOIN symbols s ON s.id = r.symbol_id` +
  " GROUP BY r.name, NULLIF(r.receiver, ''), r.file_id, r.symbol_id" +
  ` ORDER BY r.name = ? COLLATE NOCASE DESC, ${PATH_RANK_SQL}, f.path, MIN(r.start_line), r.name, NULLIF(r.receiver, '') LIMIT ?`;

/**
 * Places that use a name no symbol defines here. What counts as a reference is what the
 * extractor records: calls with their receiver (`requirePersonalAccount(x)`,
 * `client.takePendingDeepLink()`) and type names, plus the name reads a language keeps (Python:
 * attribute reads; JS/TS/Ruby: reads of a local that has a definition). A property read in JS/TS
 * (`row.membershipKind`) is not one, nor is the read of a destructured field there; both are
 * dropped in `extract/engine.mjs`, and `tests/resolve/locals.test.mjs` holds that line.
 * One row per name, receiver, file and the symbol that contains it (module-level references form
 * one row per file), with how often it occurs there. A row whose references are not all of one
 * kind (a call and a read of the same name) says `use`.
 *
 * Called for a search whose symbols do not carry the name or all of its words (graph/queries.mjs
 * `search`). A name that is used exactly as written is read through the index on `refs.name`,
 * however many places use it. Any other query (a guess, other words of a longer name, another
 * case, separators) scans the table: about 180 ms per 2.2 million references for a word of three
 * letters or more, about 1.3 s for one or two letters (those need GLOB to see word boundaries).
 * Its words match as they do for symbols (any order; a short ASCII word must be a whole word).
 * Object keys in literals and words in strings are not references: grep finds those.
 *
 * @param {DatabaseSync} db
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {{ rows: object[], uses: number, files: number, fileIds: number[], names: string[], capped: boolean }}
 *   rows: `{ name, kind, receiver, count, start_line, file_id, path, owner, owner_qual, owner_kind }`.
 *   `uses`, `files`, `fileIds` and `names` describe every place, not only the rows the limit kept;
 *   `capped` says there were more places than were read.
 */
export function searchRefs(db, query, options = {}) {
  requireDb('searchRefs', db);
  requireString('searchRefs', 'query', query, { allowEmpty: true });
  const { limit = 20 } = requireObject('searchRefs', 'options', options);
  requireInteger('searchRefs', 'limit', limit, 1);

  const segments = [...new Set(identifierSegments(query))];
  if (segments.length === 0) return { rows: [], uses: 0, files: 0, fileIds: [], names: [], capped: false };
  const exact = query.trim();
  const groupsOf = (where, parameters) =>
    db.prepare(REF_GROUPS_SQL(where)).all(...parameters, REF_ROWS_MAX + 1, exact, ...PATH_RANK_PARAMS, REF_GROUPS_MAX + 1);
  let groups = exact ? groupsOf('name = ?', [exact]) : [];
  if (groups.length === 0) {
    // AND does not care about the order and SQLite evaluates left to right: a word of three
    // letters or more is one LIKE, a shorter one is four patterns, so the long words come first
    // and the short one is tried only on the rows that passed.
    const predicates = [...segments].sort((a, b) => b.length - a.length).map((seg) => namePoolPredicate(seg, 'name'));
    groups = groupsOf(predicates.map(([sql]) => `(${sql})`).join(' AND '), predicates.flatMap(([, parameter]) => [parameter]));
  }
  // Whether the references were cut is decided before the word filter: rows the filter takes
  // away were read all the same ("id" reads `identity` and `userId`), so they count here.
  const read = groups.reduce((total, row) => total + row.count, 0);
  const capped = groups.length > REF_GROUPS_MAX || read > REF_ROWS_MAX;
  // The pool has to hold every row the word filter could accept (see poolPredicate), so the
  // filter only removes: the order the rows came in is kept.
  groups = groups.filter((row) => wordDistance(row.name, segments) !== null);
  // `rows` are cut to `limit`; `fileIds` holds every file of every group, cut or not, so a
  // caller that merges two sources can still count the files of both over all their rows.
  const fileIds = [...new Set(groups.map((row) => row.file_id))];
  return {
    rows: groups.slice(0, limit),
    uses: groups.reduce((total, row) => total + row.count, 0),
    files: fileIds.length,
    fileIds,
    names: [...new Set(groups.map((row) => row.name))],
    capped,
  };
}

// Above this many references a symbol is a hub (`Error`, `stringify`, a core type): which files
// they sit in says nothing about orientation, and it is the one case that costs. Counting by the
// index alone took ~2 ms for the 55,000 references of cindy's three most referenced symbols;
// reading each one to group by file took ~300 ms (2026-11-24, cindy index, 3.4M refs), and a
// one-word search such as "stringify" or "map" puts such symbols in the leading rows.
export const USAGE_MAX_REFS = 2000;

/**
 * Incoming references to each of `ids` from other files: how many, in how many files, and how
 * many of those files are source rather than tests, scripts or vendored code. A slice of the
 * graph for the first rows of a search, so the orientation call also says who depends on what
 * it found. Symbols with no such reference get no entry.
 *
 * A symbol with more than `USAGE_MAX_REFS` references reports `{ refs, capped: true }` instead:
 * every reference to it, from its own file included, without the per-file breakdown.
 *
 * @param {DatabaseSync} db
 * @param {number[]} ids  symbol ids
 * @returns {Map<number, {refs: number, files: number, inSource: number, byName: number}|{refs: number, capped: true}>}
 */
export function usageCounts(db, ids) {
  requireDb('usageCounts', db);
  const out = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return out;
  for (const id of ids) requireInteger('usageCounts', 'ids', id, 1);
  // Step 1 reads refs_target alone, so a hub is recognised before any reference is read row by
  // row. Only the ids left over go into the per-file statement, whose shape depends on how many
  // there are (at most SEARCH_USAGE_ROWS in practice, so the cache holds a handful of texts).
  const totals = prepare(db, `SELECT target_id AS id, COUNT(*) AS refs FROM refs WHERE target_id IN (${ids.map(() => '?').join(', ')}) GROUP BY target_id`).all(...ids);
  const counted = [];
  for (const row of totals) {
    if (row.refs > USAGE_MAX_REFS) out.set(Number(row.id), { refs: row.refs, capped: true });
    else counted.push(row.id);
  }
  if (counted.length === 0) return out;
  // Parameters follow their position in the SQL text: the test-file CASE sits in the select
  // list, so its LIKE patterns come before the ids of the IN list. in_source counts files, not
  // references: a source file that calls the symbol five times is still one file. Only the
  // SECONDARY list excludes a file here; a generated file counts as source (CONTRACTS.md §7).
  // exact counts the references an import resolved; the rest were linked by a unique name and
  // may be same-named code elsewhere (the renderer marks those counts).
  const rows = prepare(db,
    'SELECT r.target_id AS id, COUNT(*) AS refs, COUNT(DISTINCT r.file_id) AS files,' +
    ` COUNT(DISTINCT CASE WHEN ${SECONDARY_SQL} THEN NULL ELSE r.file_id END) AS in_source,` +
    " COUNT(CASE WHEN r.resolution = '=' THEN 1 END) AS exact" +
    ' FROM refs r JOIN files f ON f.id = r.file_id JOIN symbols s ON s.id = r.target_id' +
    ` WHERE r.target_id IN (${counted.map(() => '?').join(', ')}) AND r.file_id <> s.file_id GROUP BY r.target_id`
  ).all(...SECONDARY_PARAMS, ...counted);
  for (const row of rows) {
    const refs = Number(row.refs);
    out.set(Number(row.id), { refs, files: row.files, inSource: row.in_source, byName: refs - Number(row.exact) });
  }
  return out;
}

// A short ASCII segment only matches a whole word: for "signIn", "in" must not hit "identity".
// Two characters of Chinese, Japanese or Korean are a word of their own, so there the usual
// prefix / substring rules apply.
const SHORT_SEGMENT = 2;
const ASCII_SEGMENT = /^[a-z0-9]+$/;
// The LIKE top-up reads up to LIKE_POOL_MAX candidates, whatever `limit` is: the word filter
// removes most of them, and for a two-letter query the whole-word hits (sessionId) are longer
// than the noise (width, video). The FTS read takes `limit` times LIKE_POOL_FACTOR, at least
// LIKE_POOL_MIN, for the same reason.
const LIKE_POOL_MIN = 40;
const LIKE_POOL_MAX = 2000;
const LIKE_POOL_FACTOR = 4;
// Files that show where a symbol is exercised rather than where it is defined; inside one match
// tier they sort after source files. This list feeds the SQL ORDER BY, the JS sort and "in
// source" (which excludes these files only: a generated file counts as source, CONTRACTS.md §7).
// The parts are plain substrings of the lower-cased path, so a prefix rule carries its slash:
// `/test_` is a file or directory named test_*, whereas `test_` alone would also take `latest_`.
// A mistyped entry fails silently (it matches nothing), so tests/store/search.test.mjs pairs
// every entry with a path it must recognise.
export const SECONDARY_PATH_PARTS = Object.freeze([
  '/__tests__/', '/tests/', '/test/', '/__mocks__/', '/__fixtures__/', '/fixtures/', '/spec/', '/specs/', '/e2e/',
  '/scripts/', '/examples/', '/benchmarks/', '/bench/', '/node_modules/', '/vendor/', '.test.', '.spec.', '.stories.',
  // Go (x_test.go, testdata/), pytest and Django (test_x.py, tests.py) keep tests next to the source.
  // `tests.cs` takes C#'s FooTests.cs and with it a source file whose domain word ends in "tests"
  // (Contests.cs); that is the cheaper error of the two.
  '_test.go', '/testdata/', '/tests.py', '/test_', '/__snapshots__/', 'tests.cs',
]);
// Generated sources (protobuf stubs, freezed/`build_runner` output, codegen directories) rank
// after tests: nobody edits them, so a definition or a use there says less about orientation
// than either of the other tiers. Same shape as SECONDARY: plain lower-case substrings of
// `'/' + path`, and tests/store/search.test.mjs pairs every entry with a path it must see.
export const GENERATED_PATH_PARTS = Object.freeze([
  '/generated/', '/__generated__/', '/codegen/', '.generated.', '.gen.ts', '.gen.js', '.g.dart',
  '.pb.go', '.pb.ts', '.pb.js', '.pb.cc', '.pb.h', '.min.js',
]);
// A directory entry such as `/tests/` must hold at the project root as well (`tests/a.ts`), and
// stored paths carry no leading slash: both sides test `'/' + path`. Before this, root-level
// tests/, scripts/ and e2e/ directories sorted as source.
const SECONDARY_SQL = SECONDARY_PATH_PARTS.map(() => "('/' || f.path) LIKE ? ESCAPE '\\'").join(' OR ');
const SECONDARY_PARAMS = SECONDARY_PATH_PARTS.map((part) => `%${escapeLike(part)}%`);
const GENERATED_SQL = GENERATED_PATH_PARTS.map(() => "('/' || f.path) LIKE ? ESCAPE '\\'").join(' OR ');
const GENERATED_PARAMS = GENERATED_PATH_PARTS.map((part) => `%${escapeLike(part)}%`);
// The file tier every list sorts by before it cuts rows (CONTRACTS.md §8): source 0, tests and
// scripts 1, generated 2. A generated file inside a tests/ directory is still generated, so the
// CASE tests that first; `pathRank` keeps the two in step.
const PATH_RANK_SQL = `CASE WHEN ${GENERATED_SQL} THEN 2 WHEN ${SECONDARY_SQL} THEN 1 ELSE 0 END`;
const PATH_RANK_PARAMS = [...GENERATED_PARAMS, ...SECONDARY_PARAMS];
const matchesPathPart = (path, parts) => {
  const lower = `/${String(path ?? '').toLowerCase()}`;
  return parts.some((part) => lower.includes(part));
};
/**
 * Is `path` a test, script or third-party file rather than source? `path` is a path as stored
 * in `files`: '/'-separated and relative to the project root. Matching ignores case. Any other
 * separator (a native Windows path) silently gives false, so pass paths as stored.
 *
 * @param {string|null|undefined} path
 * @returns {boolean}
 */
export const isSecondaryPath = (path) => matchesPathPart(path, SECONDARY_PATH_PARTS);
/**
 * Is `path` generated code (stubs, codegen output)? Same path spelling as `isSecondaryPath`.
 *
 * @param {string|null|undefined} path
 * @returns {boolean}
 */
export const isGeneratedPath = (path) => matchesPathPart(path, GENERATED_PATH_PARTS);
/**
 * The tier of a file in a result list: 0 source, 1 test / script / third-party, 2 generated.
 * Lists sort by this before their own keys, so a cut row is never the source one.
 *
 * @param {string|null|undefined} path
 * @returns {0|1|2}
 */
export const pathRank = (path) => (isGeneratedPath(path) ? 2 : isSecondaryPath(path) ? 1 : 0);
// The subset of SECONDARY that is a test rather than a script, an example or vendored code:
// `affected` lists these files only (CONTRACTS.md §8). A separate list on purpose (`/scripts/`
// and `/examples/` are exercises too, but nobody runs them after a change), and each entry is
// paired with a path in tests/store/search.test.mjs like the other two.
export const TEST_PATH_PARTS = Object.freeze([
  '/__tests__/', '/tests/', '/test/', '/spec/', '/specs/', '/e2e/', '/__mocks__/', '/__snapshots__/',
  '.test.', '.spec.', '_test.go', '/testdata/', '/tests.py', '/test_', 'tests.cs',
]);
/**
 * Is `path` a test file? Same path spelling as `isSecondaryPath`.
 *
 * @param {string|null|undefined} path
 * @returns {boolean}
 */
export const isTestPath = (path) => matchesPathPart(path, TEST_PATH_PARTS);

/**
 * How well every query segment lands on a word of `name`; null when a segment is missing.
 * A long segment may be a word prefix ("sign" → "signed") or, weakest, any substring
 * ("config" inside "parse2config"); a short ASCII one must be a whole word. Sortable, lower is tighter.
 *
 * @returns {[number, number]|null} `[match level, how far the word runs past the segment]`
 */
function wordDistance(name, segments) {
  const words = identifierSegments(name);
  const lower = name.toLowerCase();
  let level = 0;
  let slack = 0;
  for (const seg of segments) {
    const wholeWordOnly = seg.length <= SHORT_SEGMENT && ASCII_SEGMENT.test(seg);
    let best = Infinity;
    for (const word of words) {
      if (word === seg) best = Math.min(best, 0);
      else if (!wholeWordOnly && word.startsWith(seg)) best = Math.min(best, 1 + (word.length - seg.length) / 1e6);
    }
    if (best === Infinity) {
      if (wholeWordOnly || !lower.includes(seg)) return null;
      best = 2;
    }
    level += Math.floor(best);
    slack += best - Math.floor(best);
  }
  return [level, slack];
}

/**
 * The SQL that selects the LIKE-pool candidates for one query word: `[sql, parameter]`. The pool
 * is cut in SQL, so it has to hold every row `wordDistance` could accept. A long word may sit
 * anywhere in a name (plain LIKE). A short ASCII word must be whole, so it can only start the
 * name or sit behind a word boundary: a separator, or a letter / digit before the word in its
 * capitalised spelling (userId), or a lower-case letter before it in capitals (macOS, isIP).
 * Matching that here keeps a two-letter query's pool from filling with `width` and `video`
 * before `sessionId` is reached. GLOB is case-sensitive, hence one pattern per spelling.
 *
 * @param {string} seg
 * @returns {[string, string]} `[sql, parameter]`
 */
// One parameter on purpose: it is passed to `map` directly, which would hand the index to a
// second one. A name in another column goes through `namePoolPredicate`.
export function poolPredicate(seg) {
  return namePoolPredicate(seg, 's.name');
}

function namePoolPredicate(seg, column) {
  if (seg.length > SHORT_SEGMENT || !ASCII_SEGMENT.test(seg)) {
    return [`${column} LIKE ? ESCAPE '\\'`, `%${escapeLike(seg)}%`];
  }
  const capitalised = seg[0].toUpperCase() + seg.slice(1);
  const upper = seg.toUpperCase();
  // Either spelling of every letter, so one GLOB covers the separator case for all of them.
  const anyCase = [...seg].map((ch) => (/[0-9]/.test(ch) ? ch : `[${ch}${ch.toUpperCase()}]`)).join('');
  const sql = [
    `${column} LIKE ? ESCAPE '\\'`,
    `${column} GLOB '*[^a-zA-Z0-9]${anyCase}*'`,
    `${column} GLOB '*[a-zA-Z0-9]${capitalised}*'`,
    `${column} GLOB '*[a-z0-9]${upper}*'`,
  ].join(' OR ');
  return [sql, `${escapeLike(seg)}%`];
}

// How many anchor words a relaxed search tries: the longest ones. Two keep the cost at two extra
// queries while covering "sign-in cookie" (cookie, sign) and "the index is locked" (locked, index).
const RELAXATION_ANCHORS = 2;

// No name holds every word of a description-style query ("sign in auth cookie browser"), so the
// search falls back to names that contain one of the longest words. Anchoring beats trying word
// subsets: the cost does not grow with the number of words (six subset trials never got past the
// three-word combinations of a five-word query), and "reasoning efforts discovery merge" reaches
// "reasoning + efforts" in the first fallback query.
function relaxationAnchors(segments) {
  return segments
    .map((seg, i) => ({ seg, i }))
    .sort((a, b) => b.seg.length - a.seg.length || a.i - b.i)
    .slice(0, RELAXATION_ANCHORS)
    .map((entry) => entry.seg);
}

// Names that contain `anchor`, ranked in SQL by how many of the other query words they also
// contain, because the pool is cut in SQL. Each LIKE is parenthesised: without them SQLite binds
// the `+` to ESCAPE's operand and the whole key is 0 (`.tmp/e2e/like-precedence.mjs`).
// Parameters follow their position in the SQL text: the anchor predicate, kind (it sits in the
// WHERE clause), one LIKE per other word, the file tier, LIMIT.
function anchoredLevel(db, anchor, segments, { kindClause, kindParams }) {
  const others = segments.filter((seg) => seg !== anchor);
  const [predicate, parameter] = poolPredicate(anchor);
  const contained = others.map(() => "(s.name LIKE ? ESCAPE '\\')").join(' + ');
  return db.prepare(
    'SELECT s.*, f.path AS path FROM symbols s JOIN files f ON f.id = s.file_id' +
    ` WHERE (${predicate})${kindClause}` +
    ` ORDER BY ${contained} DESC, length(s.name), ${PATH_RANK_SQL}, f.path, s.start_line, s.id LIMIT ?`
  ).all(parameter, ...kindParams, ...others.map((seg) => `%${escapeLike(seg)}%`), ...PATH_RANK_PARAMS, LIKE_POOL_MAX);
}

// One relaxation level. Returns at most `limit` rows in relevance order.
function searchLevel(db, segments, { limit, kindClause, kindParams, raw }) {
  const joined = segments.join('');
  // The relevance order has to be the SQL ORDER BY, because that is what decides which rows
  // survive the cut (the sort below only orders the survivors): an exact name first, then
  // source before tests and generated files, then a name that starts with the query before
  // looser ones, then bm25. The CASEs only evaluate over FTS hits, never over the whole table.
  // Parameters follow their position in the SQL text: the tier CASE (select list comes first),
  // MATCH, kind, the file tier, LIMIT.
  const tier = "CASE WHEN s.name = ? COLLATE NOCASE THEN 0 WHEN s.name LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END";
  // More rows than `limit` are read because the word filter removes some of them; cut in SQL
  // first, a good row could only come back from the LIKE pool, with a worse tier.
  const fetch = Math.min(Math.max(limit * LIKE_POOL_FACTOR, LIKE_POOL_MIN), LIKE_POOL_MAX);
  const ftsRows = db.prepare(
    `WITH hit AS (SELECT s.id AS id, bm25(symbols_fts) AS rank, ${tier} AS tier` +
    ' FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid WHERE symbols_fts MATCH ?)' +
    ' SELECT s.*, f.path AS path, hit.rank AS rank, hit.tier AS tier FROM hit' +
    ' JOIN symbols s ON s.id = hit.id JOIN files f ON f.id = s.file_id' +
    ` WHERE 1 = 1${kindClause}` +
    ` ORDER BY hit.tier > 0, ${PATH_RANK_SQL}, hit.tier > 1, hit.tier, hit.rank LIMIT ?`
  ).all(raw, `${escapeLike(raw)}%`, `${escapeLike(joined)}%`, ftsMatchExpression(segments), ...kindParams, ...PATH_RANK_PARAMS, fetch);

  // The tokenizer works on whole names, so "signin*" also reaches signIndex: words decide which
  // FTS rows count, and the rows they remove must not use up the limit.
  const ftsKept = ftsRows.filter((row) => wordDistance(row.name, segments) !== null);

  // One predicate per word, so the words may appear in any order. The pool is cut in SQL, so it
  // must hold every row the word filter could accept (see poolPredicate); it is still read whole,
  // shortest names first, for the rows the filter keeps.
  const predicates = segments.map(poolPredicate);
  const conditions = predicates.map(([sql]) => `(${sql})`).join(' AND ');
  const pool = ftsKept.length < limit
    ? db.prepare(
      'SELECT s.*, f.path AS path FROM symbols s JOIN files f ON f.id = s.file_id' +
      ` WHERE ${conditions}${kindClause} ORDER BY length(s.name), f.path, s.start_line, s.id LIMIT ?`
    ).all(...predicates.flatMap(([, param]) => [param]), ...kindParams, LIKE_POOL_MAX)
    : [];
  const poolOrder = new Map(pool.map((row, i) => [row.id, i]));
  const nearFirst = pool
    .map((row) => ({ row, distance: wordDistance(row.name, segments) }))
    .filter((entry) => entry.distance !== null)
    .sort((a, b) => a.distance[0] - b.distance[0] || a.distance[1] - b.distance[1] || a.row.name.length - b.row.name.length || poolOrder.get(a.row.id) - poolOrder.get(b.row.id));

  const seen = new Set(ftsKept.map((row) => row.id));
  const ranked = ftsKept.map((row, i) => ({ row, tier: row.tier, ord: i }));
  nearFirst.forEach(({ row }, i) => {
    if (seen.has(row.id)) return;
    // A name the tokenizer keeps away from FTS (a leading "_") still earns its exact / prefix tier.
    const lower = row.name.toLowerCase();
    ranked.push({ row, tier: lower === raw ? 0 : lower.startsWith(raw) || lower.startsWith(joined) ? 1 : 3, ord: i });
  });
  for (const entry of ranked) {
    entry.rank = pathRank(entry.row.path);
    delete entry.row.rank;
    delete entry.row.tier;
  }
  // Same order as the SQL: exact name, source before tests and generated files, starts-with
  // before looser, then bm25.
  ranked.sort((a, b) => (a.tier > 0) - (b.tier > 0) || a.rank - b.rank || a.tier - b.tier || a.ord - b.ord);
  return ranked.slice(0, limit).map((entry) => entry.row);
}

/** @returns {object|null} symbol row with `path` */
export function symbolById(db, id) {
  requireDb('symbolById', db);
  requireInteger('symbolById', 'id', id, 1);
  return db.prepare(`${SYMBOL_WITH_PATH} WHERE s.id = ?`).get(id) ?? null;
}

/** @returns {object[]} symbols of the file at `path`, in source order, with `path` */
export function symbolsInFile(db, path) {
  requireDb('symbolsInFile', db);
  requireString('symbolsInFile', 'path', path);
  return db.prepare(`${SYMBOL_WITH_PATH} WHERE f.path = ? ORDER BY s.start_line, s.start_col, s.id`).all(path);
}

/** @returns {object[]} refs whose resolved target is `symbolId`, with `path` */
export function refsTo(db, symbolId) {
  requireDb('refsTo', db);
  requireInteger('refsTo', 'symbolId', symbolId, 1);
  return db.prepare(`${REF_WITH_PATH} WHERE r.target_id = ? ORDER BY f.path, r.start_line, r.id`).all(symbolId);
}

/** @returns {object[]} refs with that name, with `path` */
export function refsByName(db, name) {
  requireDb('refsByName', db);
  requireString('refsByName', 'name', name);
  return db.prepare(`${REF_WITH_PATH} WHERE r.name = ? ORDER BY f.path, r.start_line, r.id`).all(name);
}

/** @returns {object[]} refs of a file, in source order, with `path` */
export function refsInFile(db, fileId) {
  requireDb('refsInFile', db);
  requireInteger('refsInFile', 'fileId', fileId, 1);
  return db.prepare(`${REF_WITH_PATH} WHERE r.file_id = ? ORDER BY r.start_line, r.start_col, r.id`).all(fileId);
}

/**
 * Refs the resolver has not processed yet (`resolution IS NULL`), optionally
 * restricted to one file.
 *
 * @param {DatabaseSync} db
 * @param {{ fileId?: number }} [options]
 * @returns {object[]} with `path`
 */
export function unresolvedRefs(db, options = {}) {
  requireDb('unresolvedRefs', db);
  const { fileId = null } = requireObject('unresolvedRefs', 'options', options);
  if (fileId !== null) requireInteger('unresolvedRefs', 'fileId', fileId, 1);
  const sql = fileId === null
    ? `${REF_WITH_PATH} WHERE r.resolution IS NULL ORDER BY f.path, r.start_line, r.id`
    : `${REF_WITH_PATH} WHERE r.resolution IS NULL AND r.file_id = ? ORDER BY f.path, r.start_line, r.id`;
  return fileId === null ? db.prepare(sql).all() : db.prepare(sql).all(fileId);
}

/** @returns {object[]} imports of the file at `path`, with `path` */
export function importsOfFile(db, path) {
  requireDb('importsOfFile', db);
  requireString('importsOfFile', 'path', path);
  return db.prepare(`${IMPORT_WITH_PATH} WHERE f.path = ? ORDER BY i.start_line, i.id`).all(path);
}

/**
 * Imports that resolve to the file at `path` (`imports.resolved_file_id`, set
 * by the import resolver), with the importing file as `path`.
 *
 * @returns {object[]}
 */
export function importersOfPath(db, path) {
  requireDb('importersOfPath', db);
  requireString('importersOfPath', 'path', path);
  return db.prepare(
    `${IMPORT_WITH_PATH} WHERE i.resolved_file_id = (SELECT id FROM files WHERE path = ?) ORDER BY f.path, i.start_line, i.id`
  ).all(path);
}

// ---------------------------------------------------------------------------
// Dirty files + meta
// ---------------------------------------------------------------------------

/**
 * Mark paths for re-indexing. A path is stored once with its earliest `at`.
 *
 * @param {DatabaseSync} db
 * @param {string[]} paths
 * @returns {number} paths marked
 */
export function markDirty(db, paths) {
  requireDb('markDirty', db);
  requireArray('markDirty', 'paths', paths);
  paths.forEach((p, i) => requireString('markDirty', `paths[${i}]`, p));
  const at = Date.now();
  return inTransaction(db, () => {
    const upsert = db.prepare(
      'INSERT INTO dirty (path, at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET at = MIN(at, excluded.at)'
    );
    for (const p of paths) upsert.run(p, at);
    return paths.length;
  });
}

/**
 * Take and remove up to `limit` dirty paths, oldest first.
 *
 * @param {DatabaseSync} db
 * @param {number} [limit]
 * @returns {{ path: string, at: number }[]}
 */
export function takeDirty(db, limit = 500) {
  requireDb('takeDirty', db);
  requireInteger('takeDirty', 'limit', limit, 1);
  return inTransaction(db, () => {
    const rows = db.prepare('SELECT path, at FROM dirty ORDER BY at, path LIMIT ?').all(limit);
    const remove = db.prepare('DELETE FROM dirty WHERE path = ?');
    for (const row of rows) remove.run(row.path);
    return rows;
  });
}

/** @returns {number} */
export function dirtyCount(db) {
  requireDb('dirtyCount', db);
  return Number(db.prepare('SELECT COUNT(*) AS count FROM dirty').get().count);
}

/**
 * The dirty paths among `paths`, spelled as in `files.path` (the hooks and the tree walk
 * normalize them before they reach `markDirty`). A result that names one of them may predate
 * the file it describes, which is what the per-file staleness line reports (CONTRACTS.md §11).
 * Each path is answered by the primary key: a result that names a few files must not read a
 * table that can hold every file of the tree.
 *
 * @param {DatabaseSync} db
 * @param {string[]} paths  the paths to check
 * @returns {Set<string>}
 */
export function dirtyPaths(db, paths) {
  requireDb('dirtyPaths', db);
  requireArray('dirtyPaths', 'paths', paths);
  const out = new Set();
  for (let at = 0; at < paths.length; at += DIRTY_LOOKUP_CHUNK) {
    const chunk = paths.slice(at, at + DIRTY_LOOKUP_CHUNK);
    const rows = db.prepare(`SELECT path FROM dirty WHERE path IN (${chunk.map(() => '?').join(', ')})`).all(...chunk);
    for (const row of rows) out.add(row.path);
  }
  return out;
}

// Ids bound per IN list of dirtyPaths; far under SQLITE_MAX_VARIABLE_NUMBER (see insertSizes).
const DIRTY_LOOKUP_CHUNK = 500;

/** @returns {string|null} */
export function metaGet(db, key) {
  requireDb('metaGet', db);
  requireString('metaGet', 'key', key);
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

/** Set (or replace) a meta value. @returns {void} */
export function metaSet(db, key, value) {
  requireDb('metaSet', db);
  requireString('metaSet', 'key', key);
  requireString('metaSet', 'value', value, { allowEmpty: true });
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * Upsert the file row and replace its extraction in ONE transaction, so a crash
 * between the two can never leave "new hash, empty extraction" (which later syncs
 * would skip because the hash already matches). The indexer should use this
 * instead of calling upsertFile and replaceAllForFile separately.
 *
 * @returns {{ fileId: number, symbolIds: number[] }}
 */
export function replaceFile(db, file, extracted = {}) {
  requireDb('replaceFile', db);
  return inTransaction(db, () => {
    const { id, created } = upsertFileRow(db, 'replaceFile', file, { purge: false });
    const { symbolIds } = replaceAll(db, id, extracted, { existing: !created });
    return { fileId: id, symbolIds };
  });
}
