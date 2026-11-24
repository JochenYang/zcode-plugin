// status.json (CONTRACTS.md §3.1): written by the indexer, read by the hooks and
// other sessions. Writes go to a temp file in the same directory and are renamed
// over the target, so a reader never sees a half-written file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { statusPath, normalizeRoot } from '../paths.mjs';
import { PLUGIN_VERSION } from '../version.mjs';

export const STATUS_SCHEMA = 1;
export const STATES = new Set(['empty', 'building', 'ready', 'error']);

const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_MS = 10;

export function defaultStatus(root) {
  return {
    schema: STATUS_SCHEMA,
    pluginVersion: PLUGIN_VERSION,
    root: normalizeRoot(root),
    state: 'empty',
    indexedAt: 0,
    filesTotal: 0,
    filesDone: 0,
    symbols: 0,
    languages: {},
    stale: 0,
    error: null,
    // Additive to §3.1 (see contract-requests.md): machine-readable cause of an
    // 'empty' or 'error' state, e.g. 'below-min-files', 'build-failed'; hooks
    // turn it into text.
    reason: null,
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows can refuse the rename for a moment while another process (hook, virus
// scanner) still holds the destination open; a few short retries turn that
// transient EPERM/EBUSY into success instead of a failed status update.
function renameWithRetry(tmp, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(err.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // the rename failure is the error worth reporting
        }
        throw err;
      }
      sleepSync(RENAME_RETRY_MS);
    }
  }
}

/** Write `data` to `file` atomically (tmp in the same directory + rename). */
export function atomicWriteFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  renameWithRetry(tmp, file);
}

/**
 * @returns {object|null} null when the file is missing or unreadable; the
 *   caller then treats the index as having no status yet and rewrites it.
 */
export function readStatus(root) {
  let text;
  try {
    text = fs.readFileSync(statusPath(root), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // torn or corrupt file: same as absent
    return null;
  }
}

function requireInt(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`writeStatus: "${name}" must be a non-negative integer (got ${typeof value})`);
  }
  return value;
}

/**
 * Merge `patch` over the current status and write it atomically. schema,
 * pluginVersion and root are always rewritten from this process.
 *
 * @param {string} root
 * @param {object} patch
 * @returns {object} the status written
 */
export function writeStatus(root, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('writeStatus: "patch" must be an object');
  }
  const current = readStatus(root) ?? defaultStatus(root);
  const next = { ...current, ...patch, schema: STATUS_SCHEMA, pluginVersion: PLUGIN_VERSION, root: normalizeRoot(root) };
  if (!STATES.has(next.state)) {
    throw new TypeError(`writeStatus: "state" must be one of ${[...STATES].join('|')} (got ${JSON.stringify(next.state)})`);
  }
  for (const key of ['indexedAt', 'filesTotal', 'filesDone', 'symbols', 'stale']) requireInt(key, next[key]);
  if (next.languages === null || typeof next.languages !== 'object' || Array.isArray(next.languages)) {
    throw new TypeError('writeStatus: "languages" must be an object');
  }
  if (next.error !== null && typeof next.error !== 'string') {
    throw new TypeError('writeStatus: "error" must be a string or null');
  }
  if (next.reason !== null && typeof next.reason !== 'string') {
    throw new TypeError('writeStatus: "reason" must be a string or null');
  }
  atomicWriteFile(statusPath(root), JSON.stringify(next));
  return next;
}
