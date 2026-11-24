// Connection lifecycle for the codegraph index. All DDL lives in schema.sql so
// every process (indexer, MCP server, self-test) creates the same tables; this
// module only owns opening, the PRAGMAs that must run outside a transaction,
// and closing (Windows keeps the file locked until the handle is really closed).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PLUGIN_ROOT } from '../paths.mjs';

const SCHEMA_FILE = path.join(PLUGIN_ROOT, 'src', 'store', 'schema.sql');
const BUSY_TIMEOUT_MS = 5000;

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Open (or create) the index database at `file`.
 *
 * Creates the parent directory, applies schema.sql (idempotent DDL, WAL), and
 * enables foreign keys. The busy timeout covers the two-process design (indexer
 * writing while the MCP server reads): a lock collision becomes a short wait
 * instead of an immediate SQLITE_BUSY.
 *
 * @param {string} file  Absolute path, or ':memory:'.
 * @returns {DatabaseSync}
 */
export function openDatabase(file) {
  if (typeof file !== 'string' || file.trim().length === 0) {
    throw new TypeError(`openDatabase: "file" must be a non-empty string (got ${describe(file)})`);
  }
  // Read the schema first so a missing file fails before any handle is opened.
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);
  try {
    // Before the schema: two sessions opening the same index concurrently must wait, not fail.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // After a checkpoint the WAL file shrinks back to this size instead of keeping the high-water
    // mark of the largest transaction (a bulk build leaves ~70 MB otherwise).
    db.exec('PRAGMA journal_size_limit = 8388608');
    db.exec(schema);
    // schema.sql already sets this; repeating it documents the invariant the
    // repository layer relies on (ON DELETE SET NULL / CASCADE).
    db.exec('PRAGMA foreign_keys = ON');
  } catch (err) {
    try {
      db.close();
    } catch {
      // The half-open handle is being discarded; the original error matters.
    }
    throw new Error(`openDatabase: cannot initialise ${file}: ${err.message}`, { cause: err });
  }
  return db;
}

/**
 * Close the handle. Idempotent: closing twice is a no-op. On Windows the file
 * cannot be deleted while the handle is open, so tests and rebuilds must call
 * this before removing the index directory.
 *
 * @param {DatabaseSync} db
 */
export function close(db) {
  if (!db || typeof db.close !== 'function') {
    throw new TypeError(`close: "db" must be a DatabaseSync (got ${describe(db)})`);
  }
  if (db.isOpen === false) return;
  try {
    db.close();
  } catch (err) {
    // node:sqlite raises ERR_INVALID_STATE ("database is not open") on a second
    // close; that is the idempotent case, not a failure. Older Node versions
    // without `isOpen` take this path too.
    if (err && err.code === 'ERR_INVALID_STATE' && /not open/i.test(err.message)) return;
    throw err;
  }
}
