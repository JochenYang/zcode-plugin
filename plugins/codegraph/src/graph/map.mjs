// Reference-ranked repository map (CONTRACTS.md §8/§11): directories -> files
// -> up to six symbols each, ranked by how often the symbol is referenced
// (resolved refs by target, unresolved refs by name), cut to a token budget.
// The text is the map body; the renderer adds header and footer.
//
// Symbols are fetched one file at a time, in output order, and the walk stops at
// the first line that no longer fits: with a 1200-token budget about sixty files
// are read instead of every file of the repository. `total` keeps its meaning
// (the sum of each file's first six symbols over the whole scope) and comes from
// one aggregate query only when the budget actually cut the map.

import { listFiles, symbolsInFile } from '../store/repo.mjs';

const DEFAULT_BUDGET_TOKENS = 1200;
const SYMBOLS_PER_FILE = 6;
const MAX_FILES = 20000;

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const dirOf = (p) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

// `src/`, `./src`, `src\\a.ts` -> `src` / `src/a.ts`
function normalizeScope(value) {
  const s = String(value).split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '');
  return s === '.' || s === '' ? null : s;
}

// Sum of min(SYMBOLS_PER_FILE, symbols per file) and the number of files with
// symbols, for the files in scope (same scope test as the file filter above).
// Used only when the budget cut the map, so the unexamined files can still be counted.
function countScope(db, scope) {
  const prefix = scope === null ? null : `${scope}/`;
  const rows = scope === null
    ? db.prepare('SELECT MIN(COUNT(*), ?) AS n FROM symbols s JOIN files f ON f.id = s.file_id GROUP BY s.file_id').all(SYMBOLS_PER_FILE)
    : db.prepare('SELECT MIN(COUNT(*), ?) AS n FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? OR substr(f.path, 1, ?) = ? GROUP BY s.file_id')
      .all(SYMBOLS_PER_FILE, scope, prefix.length, prefix);
  let total = 0;
  for (const r of rows) total += Number(r.n);
  return { total, files: rows.length };
}

/**
 * Repository map.
 *
 * @param {DatabaseSync} db
 * @param {{ path?: string|null, budgetTokens?: number }} [options]
 * @returns {{ text: string, shown: number, total: number, truncated: boolean, files: number, filesTotal: number }}
 *   `total` / `filesTotal` cover the whole scope: the first six symbols of every
 *   file with symbols, and those files; `shown` / `files` are what fit the budget.
 */
export function repoMap(db, { path = null, budgetTokens = DEFAULT_BUDGET_TOKENS } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError(`repoMap: "db" must be a DatabaseSync (got ${describe(db)})`);
  if (budgetTokens === undefined || budgetTokens === null) budgetTokens = DEFAULT_BUDGET_TOKENS;
  if (!Number.isInteger(budgetTokens) || budgetTokens < 1) {
    throw new TypeError(`repoMap: "budgetTokens" must be a positive integer (got ${describe(budgetTokens)})`);
  }
  if (path !== null && path !== undefined && typeof path !== 'string') {
    throw new TypeError(`repoMap: "path" must be a string (got ${describe(path)})`);
  }
  const scope = path === null || path === undefined ? null : normalizeScope(path);

  const files = listFiles(db).filter((f) => scope === null || f.path === scope || f.path.startsWith(`${scope}/`)).slice(0, MAX_FILES);
  // Files per directory, in path order: the layout is known without reading a symbol.
  const groups = new Map(); // dir -> file rows
  for (const file of files) {
    const dir = dirOf(file.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }

  // Reference counts are looked up per file, only for the files actually rendered: two indexed
  // `IN (…)` queries per file instead of GROUP BY over every ref in the index (3M refs → seconds).
  const countTargets = db.prepare('SELECT target_id, COUNT(*) AS n FROM refs WHERE target_id IN (SELECT value FROM json_each(?)) GROUP BY target_id');
  const countNames = db.prepare('SELECT name, COUNT(*) AS n FROM refs WHERE target_id IS NULL AND name IN (SELECT value FROM json_each(?)) GROUP BY name');
  const scoresFor = (symbols) => {
    const targeted = new Map();
    const byName = new Map();
    if (symbols.length) {
      for (const r of countTargets.all(JSON.stringify(symbols.map((s) => s.id)))) targeted.set(r.target_id, r.n);
      for (const r of countNames.all(JSON.stringify([...new Set(symbols.map((s) => s.name))]))) byName.set(r.name, r.n);
    }
    return (s) => (targeted.get(s.id) ?? 0) + (byName.get(s.name) ?? 0);
  };

  // Emit directory by directory, file by file, fetching a file's symbols only when
  // its turn comes, while the text fits the budget (tokens = bytes / 4, the
  // renderer's estimate).
  const lines = [];
  let bytes = 0; // bytes of lines.join('\n')
  let shown = 0;
  let shownFiles = 0;
  let total = 0;
  let filesTotal = 0;
  let truncated = false;
  const fits = (candidate) => Math.ceil((bytes + (lines.length ? 1 : 0) + Buffer.byteLength(candidate, 'utf8')) / 4) <= budgetTokens;
  const push = (line) => {
    bytes += (lines.length ? 1 : 0) + Buffer.byteLength(line, 'utf8');
    lines.push(line);
  };
  outer: for (const dir of [...groups.keys()].sort()) {
    const header = `${dir === '' ? '.' : dir}/`;
    let headerPushed = false;
    for (const file of groups.get(dir)) {
      const symbols = symbolsInFile(db, file.path);
      if (symbols.length === 0) continue;
      const score = scoresFor(symbols);
      const ranked = symbols
        .map((s) => ({ kind: s.kind, name: s.name, line: s.start_line, score: score(s) }))
        .sort((a, b) => b.score - a.score || a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .slice(0, SYMBOLS_PER_FILE);
      const line = `  ${file.path.slice(dir.length + 1)}  ${ranked.map((s) => `${s.kind} ${s.name}:${s.line}`).join('  ')}`;
      const pending = headerPushed ? line : `${header}\n${line}`;
      if (!fits(pending)) {
        truncated = true;
        break outer;
      }
      if (!headerPushed) {
        push(header);
        headerPushed = true;
      }
      push(line);
      shown += ranked.length;
      shownFiles++;
      total += ranked.length;
      filesTotal++;
    }
  }
  if (truncated) ({ total, files: filesTotal } = countScope(db, scope));
  return { text: lines.join('\n'), shown, total, truncated, files: shownFiles, filesTotal };
}
