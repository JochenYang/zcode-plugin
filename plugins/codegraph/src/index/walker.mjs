// File enumeration for the indexer (CONTRACTS.md §9). Git repositories are
// listed with `git ls-files` so .gitignore applies; everything else gets a
// directory walk. Only files matched by a language pack are returned, after the
// user's `exclude` patterns, the built-in ignore list, and the size / count
// limits. Relative paths use '/', absolute paths stay native for fs calls.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { specForPath } from '../languages/registry.mjs';
import { applyDefaults } from './defaults.mjs';
import { statMany, underLink } from './fsstat.mjs';

// Directory names that never contain indexable sources. Matched at any depth.
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.codegraph', '.tmp',
]);

const GIT_LS_FILES_TIMEOUT_MS = 60_000;
const GIT_CHECK_IGNORE_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

const toRel = (p) => p.split(path.sep).join('/').replace(/^\.\//, '');

/** True when any directory segment of `rel` is in the built-in ignore list. */
export function hasIgnoredDir(rel) {
  for (const segment of rel.split('/')) {
    if (IGNORED_DIRS.has(segment)) return true;
  }
  return false;
}

/**
 * Whether a relative path may be indexed at all: not under an ignored directory
 * and not matched by the user's exclude patterns. Shared by the walker, the
 * dirty-path sync and the watcher so external dirty entries cannot smuggle in
 * files the walker would never list.
 */
export function isIndexablePath(rel, matchers = []) {
  return Boolean(rel) && !hasIgnoredDir(rel) && !isExcluded(rel, matchers);
}

// ---------------------------------------------------------------------------
// exclude patterns: a plain entry is a path or directory prefix relative to the
// root; entries with `*` / `?` are globs matched against the full relative path
// (`**` crosses directories, a lone `*` does not). A glob without a slash also
// matches the basename, so `*.d.ts` works at any depth.
// ---------------------------------------------------------------------------

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      let stars = 1;
      while (glob[i + stars] === '*') stars++;
      if (stars >= 2 && glob[i + stars] === '/') {
        i += stars; // '**/' also matches zero directories
        out += '(?:.*/)?';
      } else if (stars >= 2) {
        i += stars - 1;
        out += '.*'; // bare '**' crosses directories
      } else {
        out += '[^/]*'; // a single '*' stays inside one path segment
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** @returns {{ prefix: string } | { re: RegExp, anyLevel: boolean }[]} */
export function compileExclude(patterns) {
  const matchers = [];
  for (const raw of patterns) {
    // Consecutive '**/' groups are one group semantically, and each compiled group
    // is an optional `(?:.*/)?`: nested in a row they backtrack exponentially on a
    // long non-matching path (8 groups vs 40 segments took seconds), so collapse them.
    const pattern = String(raw)
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\*{3,}/g, '**')
      .replace(/(?:\*\*\/)+/g, '**/')
      .replace(/\/+$/, '');
    if (!pattern) continue;
    if (!/[*?]/.test(pattern)) {
      matchers.push({ prefix: pattern });
      continue;
    }
    matchers.push({ re: globToRegExp(pattern), anyLevel: !pattern.includes('/') });
  }
  return matchers;
}

/** @param {string} rel relative path, '/' separated */
export function isExcluded(rel, matchers) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  for (const m of matchers) {
    if ('prefix' in m) {
      if (rel === m.prefix || rel.startsWith(`${m.prefix}/`)) return true;
    } else if (m.re.test(rel) || (m.anyLevel && m.re.test(base))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// candidate listing
// ---------------------------------------------------------------------------

// `git ls-files -z -c -o --exclude-standard`: tracked plus untracked files that
// respect .gitignore / .git/info/exclude / the global excludes. Returns null
// when git is unavailable or the directory is not a work tree, so the caller
// falls back to a plain walk.
function gitListFiles(root) {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(root, '.git'))) {
      resolve(null);
      return;
    }
    execFile(
      'git',
      ['-C', root, 'ls-files', '-z', '-c', '-o', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, windowsHide: true, timeout: GIT_LS_FILES_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          process.stderr.write(`codegraph: git ls-files failed in ${root} (${err.message}); falling back to a directory walk\n`);
          resolve(null);
          return;
        }
        resolve(stdout.split('\0').filter(Boolean));
      },
    );
  });
}

/**
 * The paths among `rels` that git ignores: the rule `listFiles` gets from
 * `git ls-files --exclude-standard`, for a file that reaches the index between two listings
 * (the watcher, a hook).
 *
 * `rels` must already be in the index's spelling (normalized by `normalizeDirtyPath` or
 * `toRel`, '/' separated): git answers in its own spelling of what it was asked, and the
 * caller looks its paths up in that answer. Tracked files are never reported, whatever
 * .gitignore says, which is what `git ls-files -c` does too.
 *
 * @param {string} root
 * @param {string[]} rels relative paths, '/' separated
 * @returns {Promise<Set<string>|null>} the ignored paths, or null when git could not answer
 *   (unavailable, failed or timed out, or the directory is not a work tree). The caller then
 *   admits the path, as the listing's plain walk does where there is no git. Never rejects.
 */
export function gitIgnoredPaths(root, rels) {
  return new Promise((resolve) => {
    if (!Array.isArray(rels) || rels.length === 0 || rels.some((rel) => typeof rel !== 'string' || rel.length === 0 || rel.includes('\0'))) {
      resolve(new Set());
      return;
    }
    if (!fs.existsSync(path.join(root, '.git'))) {
      resolve(null);
      return;
    }
    const child = execFile(
      'git',
      ['-C', root, 'check-ignore', '-z', '--stdin'],
      { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, windowsHide: true, timeout: GIT_CHECK_IGNORE_TIMEOUT_MS },
      (err, stdout) => {
        // Exit status 0: some path is ignored. 1: none is. Anything else: git could not answer
        // (no exit code at all means the timeout killed it).
        if (err && err.code !== 1) {
          process.stderr.write(`codegraph: git check-ignore failed in ${root} (exit ${err.code ?? err.signal}${err.killed ? ' after timeout' : ''}: ${err.message}); ignored paths cannot be told apart\n`);
          resolve(null);
          return;
        }
        resolve(new Set(String(stdout).split('\0').filter(Boolean)));
      },
    );
    // A git that exits before reading closes its stdin; the failure is reported through the callback.
    child.stdin.on('error', () => {});
    child.stdin.end(`${rels.join('\0')}\0`);
  });
}

function walkFs(root, matchers) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      process.stderr.write(`codegraph: cannot read directory ${dir} (${err.message}); skipped\n`);
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toRel(path.relative(root, abs));
      // Symlinks are followed nowhere: a link can escape the root or loop.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || isExcluded(rel, matchers) || isExcluded(`${rel}/`, matchers)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  return out;
}

/**
 * List the indexable files under `root`.
 *
 * @param {string} root
 * @param {{ config: object, specs: object[] }} options
 * @returns {Promise<{ files: { path: string, abs: string, lang: string, size: number, mtimeMs: number }[], truncated: boolean, total: number }>}
 *   `total` counts every enumerated file after ignore/exclude (any language);
 *   `truncated` is set when more supported files existed than `config.maxFiles`
 *   (decided before the size check, so it can be a false positive at the boundary).
 */
export async function listFiles(root, { config, specs = [] } = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('listFiles: "root" must be a non-empty string');
  }
  if (!Array.isArray(specs)) throw new TypeError('listFiles: "specs" must be an array');
  const cfg = applyDefaults(config);
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error(`listFiles: ${root} is not a directory`);

  const activeSpecs = cfg.languages ? specs.filter((s) => cfg.languages.includes(s.id)) : specs;
  const matchers = compileExclude(cfg.exclude);

  const candidates = (await gitListFiles(root)) ?? walkFs(root, matchers);
  candidates.sort();

  // Cheap filters first so only files that can be indexed pay for a stat.
  const wanted = []; // { rel, abs, lang }
  let total = 0;
  let truncated = false;
  for (const raw of candidates) {
    const rel = toRel(raw);
    if (!rel || hasIgnoredDir(rel) || isExcluded(rel, matchers)) continue;
    total++;
    const spec = specForPath(rel, activeSpecs);
    if (!spec) continue;
    if (wanted.length >= cfg.maxFiles) {
      truncated = true;
      continue;
    }
    wanted.push({ rel, abs: path.join(root, rel), lang: spec.id });
  }

  // Every directory between a file and the root, once for the whole batch, then the files: both
  // are lstat, so a link is seen for what it is. git lists a tracked link to a file like any
  // other file, and on Windows it walks into a junction and lists what is behind it as the
  // project's own — down any number of directories; neither is.
  const ancestors = new Set();
  for (const w of wanted) {
    for (let dir = path.dirname(w.abs); dir !== root && dir.length > root.length; dir = path.dirname(dir)) ancestors.add(dir);
  }
  const [stats, dirs] = await Promise.all([statMany(wanted.map((w) => w.abs)), statMany([...ancestors])]);
  const files = [];
  for (const w of wanted) {
    const st = stats.get(w.abs);
    // Vanished (deleted but still tracked), a link — itself, or a directory on the way — a
    // directory (gitlink) or oversized.
    if (!st || !st.isFile() || st.size > cfg.maxFileBytes || underLink(root, w.abs, (dir) => dirs.get(dir)?.isSymbolicLink() === true)) continue;
    files.push({ path: w.rel, abs: w.abs, lang: w.lang, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
  }
  return { files, truncated, total };
}
