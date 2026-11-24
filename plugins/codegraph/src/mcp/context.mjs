// Per-process runtime context for the MCP tools: project root, configuration,
// indexer (Lane A) and the SQLite handle (CONTRACTS.md §2, §7, §9, §12).
//
// Created lazily on the first tool call so `initialize` / `tools/list` never
// touch the disk. Concurrent callers share one in-flight promise; a failed
// creation clears the cache so the next call retries instead of caching the
// failure. `queries` / `map` are injection points for tests and default to the
// real graph modules.
import { dbPath, resolveProjectRoot } from '../paths.mjs';
import { loadConfig } from '../config.mjs';
import { openDatabase } from '../store/db.mjs';

const INDEXER_MODULE = '../index/indexer.mjs';

let pending = null;

/** @returns {Promise<{ root: string, unsafe: boolean, config: object, indexer: object, db: object, queries: object|null, map: object|null }>} */
export function getContext() {
  if (!pending) {
    pending = createContext().catch((err) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}

/** Drop the cached context (tests). Closes the indexer and any handle this module opened itself. */
export async function resetContext() {
  const current = pending;
  pending = null;
  if (!current) return;
  const ctx = await current.catch(() => null);
  if (!ctx) return;
  try {
    if (typeof ctx.indexer?.close === 'function') await ctx.indexer.close();
  } finally {
    if (ctx.ownDb) {
      const { close } = await import('../store/db.mjs');
      close(ctx.ownDb);
    }
  }
}

async function createContext() {
  // The host sets ZCODE_PROJECT_DIR to the session workspace and also starts the
  // server there (zcode-facts.md §1.2); cwd is the fallback for manual runs.
  const start = (process.env.ZCODE_PROJECT_DIR ?? '').trim() || process.cwd();
  const { root, unsafe } = resolveProjectRoot(start);
  const config = loadConfig();
  const indexer = await createIndexer({ root, config });
  // The indexer owns the write connection and exposes it for the query layers;
  // a second connection would only add lock traffic within one process.
  const db = indexer.db ?? openDatabase(dbPath(root));
  const ownDb = indexer.db ? null : db;
  return { root, unsafe, config, indexer, db, ownDb, queries: null, map: null };
}

async function createIndexer({ root, config }) {
  let module;
  try {
    module = await import(INDEXER_MODULE);
  } catch (err) {
    const missing = err?.code === 'ERR_MODULE_NOT_FOUND' && /indexer\.mjs/.test(String(err?.message));
    if (!missing) throw err;
    throw new Error(
      'codegraph: the indexer module (src/index/indexer.mjs) is missing from this installation, ' +
        'so the code graph cannot be built or refreshed; reinstall or update the plugin',
      { cause: err },
    );
  }
  const { Indexer } = module;
  if (typeof Indexer !== 'function') {
    throw new TypeError('codegraph: src/index/indexer.mjs does not export an Indexer class');
  }
  return new Indexer({ root, config });
}
