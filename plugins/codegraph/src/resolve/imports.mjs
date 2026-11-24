// Import specification resolution (CONTRACTS.md §8). Turns the `spec` a language
// pack recorded for an import into candidate project-relative paths, per
// ecosystem, and matches those against the indexed files.
//
// Pure by default: `resolveSpec` never touches the filesystem. Go needs the
// module path (go.mod); pass `module` explicitly, or `root` to read go.mod once
// (cached), or neither to fall back to matching the tail of the spec against
// indexed directories. `listFiles` (array / Set / () => string[]) turns
// candidates into the paths that really exist.

import fs from 'node:fs';
import path from 'node:path';

/** Language pack id (languages/<id>.mjs) -> ecosystem; anything missing resolves nothing. */
export const ECOSYSTEM_BY_LANG = Object.freeze({
  typescript: 'node', tsx: 'node', javascript: 'node', arkts: 'node', vue: 'node', svelte: 'node', astro: 'node',
  python: 'python',
  go: 'go',
  java: 'jvm', kotlin: 'jvm', scala: 'jvm',
  csharp: 'dotnet', vbnet: 'dotnet',
});

const LANGS_BY_ECOSYSTEM = {
  node: ['typescript', 'tsx', 'javascript', 'arkts', 'vue', 'svelte', 'astro'],
  python: ['python'],
  go: ['go'],
  jvm: ['java', 'kotlin', 'scala'],
  dotnet: ['csharp', 'vbnet'],
};

// Extension preference for an extensionless node specifier. `.d.ts` before `.js`
// mirrors TypeScript's own order; `.js` still wins when the specifier says so.
const NODE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const NODE_SOURCE_EXTENSIONS = new Set([...NODE_EXTENSIONS, '.d.ts']);
const JVM_EXTENSIONS = ['.java', '.kt', '.scala'];
const GO_HOSTS = new Set(['github.com', 'gitlab.com', 'gopkg.in', 'golang.org', 'google.golang.org', 'k8s.io', 'example.com', 'example.org']);

const slash = (p) => String(p ?? '').split('\\').join('/');
const dirName = (p) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

// Resolve `..` / `.` textually and reject anything climbing out of the project.
function joinRelative(dir, rel) {
  const joined = path.posix.normalize(dir ? `${dir}/${rel}` : rel);
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null;
  return joined;
}

function stripUrlPart(spec) {
  const cut = spec.search(/[?#]/);
  return cut < 0 ? spec : spec.slice(0, cut);
}

/** Heuristic ecosystem of a specifier; callers that know the language pass `ecosystem` instead. */
export function detectEcosystem(spec) {
  const s = slash(String(spec ?? '')).trim();
  if (!s) return 'none';
  if (s.startsWith('./') || s.startsWith('../')) return 'node';
  if (s.startsWith('.')) return 'python'; // `.a.b`, `..pkg.mod`
  if (s.startsWith('/')) return 'node';
  const segments = s.split('/');
  if (segments.length > 1) return GO_HOSTS.has(segments[0]) ? 'go' : 'node';
  const parts = s.split('.');
  if (parts.length > 1) {
    if (GO_HOSTS.has(parts[0])) return 'go';
    if (parts.slice(1).some((p) => /^[A-Z]/.test(p))) return 'jvm';
    return 'python';
  }
  return 'none';
}

const goModules = new Map(); // root -> module path (go.mod is read once per root)

function goModuleFor(root) {
  if (!root) return null;
  if (goModules.has(root)) return goModules.get(root);
  let module = null;
  try {
    const m = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(root, 'go.mod'), 'utf8'));
    module = m ? m[1] : null;
  } catch {
    module = null; // no go.mod: the directory heuristic below applies
  }
  goModules.set(root, module);
  return module;
}

// Candidates for a Go import: a directory (trailing '/'), or '' when the
// package is outside the module.
function goCandidates(spec, { module = null, root = null }) {
  const mod = module ?? goModuleFor(root);
  if (mod) {
    if (spec === mod) return ['./'];
    if (spec.startsWith(`${mod}/`)) return [`${spec.slice(mod.length + 1)}/`];
    return [`vendor/${spec}/`];
  }
  // Without go.mod, the module path is unknown: try the longest tail of the
  // spec that is a plausible in-project directory (the matcher only accepts
  // directories that contain indexed files).
  const segments = spec.split('/');
  const out = [];
  for (let i = 1; i < segments.length; i++) out.push(`${segments.slice(i).join('/')}/`);
  return out;
}

function nodeCandidates(spec) {
  const s = slash(spec);
  const ext = path.posix.extname(s);
  if (ext && !NODE_SOURCE_EXTENSIONS.has(ext)) return [s]; // assets: ./style.css, ./data.json
  const base = ext ? s.slice(0, -ext.length) : s;
  return [...NODE_EXTENSIONS.map((e) => base + e), ...NODE_EXTENSIONS.map((e) => `${base}/index${e}`)];
}

function pythonCandidates(spec, dir) {
  const s = slash(spec);
  let dots = 0;
  while (s[dots] === '.') dots++;
  const rest = s.slice(dots);
  let base = '';
  if (dots > 0) {
    base = dir;
    for (let i = 1; i < dots; i++) {
      if (!base) return []; // beyond the project root
      base = dirName(base);
    }
  }
  const parts = rest ? rest.split('.').filter(Boolean) : [];
  const rel = parts.join('/');
  if (!rel) return [joinRelative(base, '__init__.py')].filter(Boolean);
  return [joinRelative(base, `${rel}.py`), joinRelative(base, `${rel}/__init__.py`)].filter(Boolean);
}

function jvmCandidates(spec) {
  const s = slash(spec);
  if (/\.\*$/.test(s) || s.endsWith('*')) {
    // `import a.b.*;` names a package: a directory candidate.
    const pkg = s.replace(/\*$/, '').replace(/\.$/, '').split('.').filter(Boolean);
    return pkg.length ? [`${pkg.join('/')}/`] : [];
  }
  const segments = s.split('.').filter(Boolean);
  if (segments.length === 0) return [];
  const dirs = segments.slice(0, -1).join('/');
  const dirPrefix = dirs ? `${dirs}/` : '';
  const out = JVM_EXTENSIONS.map((e) => `${dirPrefix}${segments[segments.length - 1]}${e}`);
  if (segments.length === 1) return out;
  // `a.b.C.D` (nested type): the outer type's file is the fallback.
  const parent = segments.slice(0, -1);
  const parentDirs = parent.slice(0, -1).join('/');
  out.push(...JVM_EXTENSIONS.map((e) => `${parentDirs ? `${parentDirs}/` : ''}${parent[parent.length - 1]}${e}`));
  return out;
}

function dotnetCandidates(spec) {
  const segments = slash(spec).split('.').filter(Boolean);
  if (segments.length === 0) return [];
  const out = [`${segments.join('/')}.cs`];
  if (segments.length > 1) out.push(`${segments[segments.length - 1]}.cs`);
  return out;
}

/**
 * Candidate project-relative paths for an import specifier, best first.
 * Directory candidates end with '/' (Go packages, JVM wildcard imports).
 *
 * @param {string} spec
 * @param {{ kind?: string, fromPath?: string, root?: string, ecosystem?: string, module?: string, listFiles?: Function|Iterable<string> }} [options]
 * @returns {string[]}
 */
export function resolveSpec(spec, options = {}) {
  const s = slash(String(spec ?? '')).trim();
  if (!s) return [];
  const ecosystem = options.ecosystem ?? detectEcosystem(s);
  if (ecosystem === 'none') return [];
  const dir = dirName(slash(options.fromPath ?? ''));
  let candidates;
  switch (ecosystem) {
    case 'node': {
      const clean = stripUrlPart(s);
      // Bare names (`react`, `node:fs`, `#internal/x`, `/abs`) are packages or
      // absolute paths: never project files.
      if (!clean.startsWith('./') && !clean.startsWith('../')) return [];
      const rel = clean.replace(/\/+$/, '').replace(/^\.\//, '');
      candidates = rel === '' ? [] : nodeCandidates(rel).map((c) => joinRelative(dir, c)).filter(Boolean);
      break;
    }
    case 'python':
      candidates = pythonCandidates(s, dir);
      break;
    case 'go':
      candidates = goCandidates(s, options);
      break;
    case 'jvm':
      candidates = jvmCandidates(s);
      break;
    case 'dotnet':
      candidates = dotnetCandidates(s);
      break;
    default:
      return [];
  }
  if (options.listFiles === undefined || options.listFiles === null) return candidates;
  const index = options.index ?? buildFileIndex(pathsFrom(options.listFiles));
  return candidates.map((c) => matchCandidate(c, ecosystem, index)).filter((m) => m.path !== null).map((m) => m.path);
}

function pathsFrom(listFiles) {
  const raw = typeof listFiles === 'function' ? listFiles() : listFiles;
  return [...raw].map((p) => slash(typeof p === 'string' ? p : p?.path)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Matching candidates against indexed files
// ---------------------------------------------------------------------------

/**
 * Index for candidate matching: sorted paths, exact set, and the suffix /
 * basename views JVM (source roots) and .NET (one file per type) need.
 *
 * @param {string[]} paths  project-relative, '/'-separated
 */
export function buildFileIndex(paths) {
  const sorted = [...new Set(paths.map(slash).filter(Boolean))].sort();
  const set = new Set(sorted);
  const jvm = new Map(); // "a/b/C.java" -> paths after a src/<sourceSet>/<lang>/ root
  const base2 = new Map(); // "b/C.cs" -> paths whose last two segments are b/C.cs
  const base = new Map(); // "C.cs" -> paths with that basename
  for (const p of sorted) {
    const i = p.lastIndexOf('/');
    const name = i >= 0 ? p.slice(i + 1) : p;
    base.set(name, [...(base.get(name) ?? []), p]);
    if (i >= 0) {
      const j = p.lastIndexOf('/', i - 1);
      const key2 = p.slice(j + 1);
      base2.set(key2, [...(base2.get(key2) ?? []), p]);
    }
    const m = /^(?:.*\/)?src\/(?:main|test)\/(?:java|kotlin|scala)\/(.+)$/.exec(p);
    if (m) jvm.set(m[1], [...(jvm.get(m[1]) ?? []), p]);
    else if (i < 0) jvm.set(p, [...(jvm.get(p) ?? []), p]);
  }
  return { paths: sorted, set, jvm, base2, base };
}

// Last two segments of a candidate, for source-root-agnostic matching.
const tailKey = (candidate) => {
  const i = candidate.lastIndexOf('/');
  if (i < 0) return candidate;
  const j = candidate.lastIndexOf('/', i - 1);
  return candidate.slice(j + 1);
};

// First indexed file inside `dir` ('' = project root), in path order.
function firstUnder(index, dir) {
  const prefix = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  const key = prefix ? `${prefix}/` : '';
  const { paths } = index;
  let lo = 0;
  let hi = paths.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (paths[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo < paths.length && paths[lo].startsWith(key) ? paths[lo] : null;
}

/**
 * Match one candidate. @returns {{ path: string|null, ambiguous: boolean }}
 */
export function matchCandidate(candidate, ecosystem, index) {
  if (candidate.endsWith('/')) {
    const hit = firstUnder(index, candidate);
    return hit ? { path: hit, ambiguous: false } : { path: null, ambiguous: false };
  }
  if (index.set.has(candidate)) return { path: candidate, ambiguous: false };
  if (ecosystem !== 'jvm' && ecosystem !== 'dotnet') return { path: null, ambiguous: false };
  // JVM / .NET: the type's path relative to a source root (src/main/java, a
  // namespace folder), then its last two segments, then its bare file name.
  // Each level must be unique, or the import is ambiguous.
  if (ecosystem === 'jvm') {
    const rooted = index.jvm.get(candidate);
    if (rooted?.length === 1) return { path: rooted[0], ambiguous: false };
    if (rooted?.length > 1) return { path: null, ambiguous: true };
  }
  const two = index.base2.get(tailKey(candidate));
  if (two?.length === 1) return { path: two[0], ambiguous: false };
  if (two?.length > 1) return { path: null, ambiguous: true };
  const hits = index.base.get(candidate.slice(candidate.lastIndexOf('/') + 1));
  if (hits?.length === 1) return { path: hits[0], ambiguous: false };
  if (hits?.length > 1) return { path: null, ambiguous: true };
  return { path: null, ambiguous: false };
}

/**
 * Best existing target for an import. Candidates are tried in order; the first
 * that names exactly one indexed file wins. A candidate matching several files
 * (.NET type name in several folders) is ambiguous and stops the search.
 *
 * @returns {{ path: string|null, ambiguous: boolean, candidates: string[] }}
 */
export function resolveImport(spec, options = {}) {
  const s = slash(String(spec ?? '')).trim();
  const ecosystem = options.ecosystem ?? detectEcosystem(s);
  const candidates = resolveSpec(s, { ...options, ecosystem });
  if (candidates.length === 0) return { path: null, ambiguous: false, candidates };
  const index = options.index ?? buildFileIndex(pathsFrom(options.listFiles ?? []));
  for (const candidate of candidates) {
    const m = matchCandidate(candidate, ecosystem, index);
    if (m.path !== null) return { path: m.path, ambiguous: false, candidates };
    if (m.ambiguous) return { path: null, ambiguous: true, candidates };
  }
  return { path: null, ambiguous: false, candidates };
}

export { LANGS_BY_ECOSYSTEM };
