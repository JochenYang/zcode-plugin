// Path conventions shared by the MCP server, the hooks and the indexer.
// Frozen contract: lanes must not change exported names or on-disk locations
// (see CONTRACTS.md). Paths for fs calls stay native; display paths use '/'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // src/
export const PLUGIN_ROOT = path.resolve(HERE, '..');
export const GRAMMARS_DIR = path.join(PLUGIN_ROOT, 'grammars');
export const LANGUAGES_DIR = path.join(PLUGIN_ROOT, 'languages');

const FALLBACK_DATA_DIR = path.join(os.homedir(), '.zcode', 'cli', 'plugins', 'data', 'codegraph@zcode-plugin');

// Resolved lazily so tests can set ZCODE_PLUGIN_DATA before first use.
export function dataDir() {
  const env = process.env.ZCODE_PLUGIN_DATA;
  return env && env.trim() ? path.resolve(env.trim()) : FALLBACK_DATA_DIR;
}

export function configPath() {
  return path.join(dataDir(), 'codegraph.json');
}

// Canonical form for hashing and display: forward slashes, no trailing slash.
export function normalizeRoot(root) {
  let p = path.resolve(root);
  try {
    p = fs.realpathSync.native(p);
  } catch {
    // keep the resolved path when the directory does not exist (yet)
  }
  let s = p.split(path.sep).join('/');
  if (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// Stable per-project key for the index directory. Case-folded on Windows.
export function projectKey(root) {
  const normalized = normalizeRoot(root);
  const folded = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return crypto.createHash('sha256').update(folded).digest('hex').slice(0, 16);
}

function isUnsafeRoot(dir) {
  const norm = normalizeRoot(dir);
  const home = normalizeRoot(os.homedir());
  const parsed = path.parse(path.resolve(dir));
  return norm === home || norm === parsed.root.replace(/\\/g, '/') || norm === parsed.root.replace(/\\/g, '').toLowerCase();
}

// A workspace the host makes itself. ZCode gives a session that was never opened on a folder a
// workspace under a `.zcode` directory's `workspace` folder (`draft-<id>`, `default`, …), in the
// profile or wherever its data was moved to. No project of the user's lives there, so nothing is
// indexed, stored or shown for it. Judged on the path: anything at or below such a folder.
const HOST_WORKSPACE = /(^|\/)\.zcode\/workspace(\/|$)/i;
const slashes = (value) => String(value).split(path.sep).join('/');

/**
 * The rule on a path as it is written, without touching the filesystem: for the index store,
 * which asks it of every stored root and must not make a synchronous call on a project folder it
 * has not probed (`status.json` keeps `root` normalized, with `/`).
 */
export function isHostWorkspacePath(root) {
  return HOST_WORKSPACE.test(slashes(root));
}

/** Whether `root` is a workspace ZCode made itself (see `HOST_WORKSPACE`). */
export function isHostWorkspace(root) {
  // The spelling and the real path are both asked: a data folder reached through a junction
  // spells `.zcode/workspace` where its real path does not.
  return isHostWorkspacePath(path.resolve(root)) || HOST_WORKSPACE.test(normalizeRoot(root));
}

// Project root = nearest ancestor containing .git (dir or file); otherwise the start dir.
// `hostWorkspace` says the session's folder is one ZCode made itself (see `HOST_WORKSPACE`), and
// like `unsafe` it means the folder is never indexed and gets no entry in the store.
export function resolveProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  const hostWorkspace = isHostWorkspace(dir);
  const { root } = path.parse(dir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return { root: dir, reason: 'git', unsafe: isUnsafeRoot(dir), hostWorkspace };
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: path.resolve(start), reason: 'cwd', unsafe: isUnsafeRoot(start), hostWorkspace };
}

export function indexDir(root) {
  return path.join(dataDir(), 'indexes', projectKey(root));
}

export function dbPath(root) {
  return path.join(indexDir(root), 'graph.db');
}

export function statusPath(root) {
  return path.join(indexDir(root), 'status.json');
}

export function dirtyLogPath(root) {
  return path.join(indexDir(root), 'dirty.log');
}

export function dirtyOffsetPath(root) {
  return path.join(indexDir(root), 'dirty.offset');
}

export function lockPath(root) {
  return path.join(indexDir(root), 'lock');
}

// One empty file per session that has already been told the index is ready, so the
// UserPromptSubmit hook announces a build that finished mid-session exactly once.
export function announcedPath(root, sessionId) {
  return path.join(indexDir(root), 'announced', sessionId);
}

// Relative display path with forward slashes; absolute paths outside root are returned as-is.
export function displayPath(root, absolute) {
  const rel = path.relative(root, absolute);
  return rel.startsWith('..') || path.isAbsolute(rel) ? absolute.split(path.sep).join('/') : rel.split(path.sep).join('/');
}

// Whether `absolute` (already resolved) is `root` itself or below it: the check every read of a
// path that came from the index makes. `root` is resolved first, so that its spelling (forward
// slashes on Windows, a trailing separator) does not decide; case-folded where the file system is.
export function isInside(root, absolute) {
  const resolved = path.resolve(root);
  const base = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const target = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}
