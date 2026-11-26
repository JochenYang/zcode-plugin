// Plain-text rendering of every tool result (CONTRACTS.md §11). Layout:
//
//   # <operation> <args> · <summary> · <freshness>
//   <rows>
//   <footer>                      legend / hints / "(N of M shown)" (always last)
//
// Rows share one format: `<kind> <name> <signature> <path>:<start>-<end>` with
// the kind right-aligned in 9 columns and the signature cut at 80. Everything is
// fitted to a token budget (whole lines are dropped from the end, never split)
// and then hard-capped in bytes by capLines. tests/render/*.test.mjs lock the
// format; change the tests together with this file.
import { capLines, estimateTokens, fitLines } from './budget.mjs';
import { DEFAULT_CONFIG } from '../config.mjs';
import { pathRank } from '../store/repo.mjs';

const KIND_WIDTH = 9;
const SIGNATURE_WIDTH = 80;
const DOC_WIDTH = 240;
const IMPORTS_SHOWN = 30;
const FILES_SHOWN = 30;
/** Bodies up to this many lines are inlined; longer ones get a Read line instead. */
export const INLINE_BODY_MAX_LINES = 30;
export const LEGEND = 'legend: = import-resolved · ~ unique-name · ? unresolved/dynamic';

const RESOLVED = new Set(['=', '~']);
// Footer hints ("hint:" / "next:") advise; rows inform, so hints are the first to go.
const isHintLine = (line) => /^(hint|next): /.test(line);
/** Room (tokens) a footer hint must leave for rows; below it the hint is dropped. */
const FOOTER_MIN_ROOM = 48;
// Kinds whose incoming refs are calls; every other kind (type, class, constant, field...) is "used".
// These four are the only callable kinds the language packs emit.
const CALLABLE_KINDS = new Set(['function', 'method', 'component', 'macro']);
const TRUNCATION_HINT = 'hint: raise budget (max 4000) or limit (max 200) to see more rows';
const SEARCH_EMPTY_HINT =
  'hint: search matches symbol names and names that are used here without a definition (calls, type names, and in JS/TS property reads ' +
  'such as obj.field and object keys such as { field }); text, variables and parameters, and string literals belong to Grep; ' +
  'a word of one or two letters must be a whole word.';
// Nothing anywhere, except that the name is read or used as a key in more JS/TS files than a scan lists.
const SEARCH_EMPTY_HUB_HINT =
  'hint: no symbol, call or type has this name, and it is read or used as a key in more JS/TS files than a search lists. ' +
  'Too common to point anywhere: Grep for it. Words in strings are not in the graph either.';
const SEARCH_NEXT_HINT =
  'next: symbol <name> returns the definition with its callers and imports (body=true reads it in one call); ' +
  'impact <name> shows what a change breaks.';
const TAIL = 'Variables and parameters and words in strings are not in the graph: grep for those.';
// Rows of the index only: what became of the look in the source depends on why the scan has no row.
const SEARCH_REFS_HINT =
  'hint: no symbol carries this name; the rows are places that use it: calls and type names from the index. ' +
  `JS/TS property reads (obj.field) and object keys ({ field }) were looked for in the source: there were none. ${TAIL}`;
const SEARCH_REFS_HUB_HINT =
  'hint: no symbol carries this name; the rows are places that use it: calls and type names from the index. ' +
  `It also appears in more JS/TS files than a search lists, read as a property (obj.field) or as the key of an object ({ field }): too common to point anywhere. ${TAIL}`;
const SEARCH_REFS_LIMIT_HINT =
  'hint: no symbol carries this name; the rows are places that use it: calls and type names from the index. ' +
  `Its JS/TS property reads (obj.field) and object keys ({ field }) are not listed: more of them than a search parses at once, or more source than one scan reads. Grep for them. ${TAIL}`;
const SEARCH_REFS_SKIPPED_HINT =
  'hint: no symbol carries this name; the rows are places that use it: calls and type names from the index. ' +
  `JS/TS property reads (obj.field) and object keys ({ field }) were not looked for in the source this time: the scanner was not ready or its scan timed out, some files could not be read, or the query is not a single name. ${TAIL}`;
// By `refs.skipped` (CONTRACTS.md §8): no reason is "none were found"; a reason that is not
// here is a scan that never looked.
const SEARCH_REFS_HINTS = new Map([[null, SEARCH_REFS_HINT], ['hub', SEARCH_REFS_HUB_HINT], ['limit', SEARCH_REFS_LIMIT_HINT]]);
// Said whenever a total carries a +: what the mark means is written nowhere else in the output.
const LOWER_BOUND_HINT = ' Totals with a + are lower bounds: more places exist than were read.';
// What the rows a scan found are called. `cut` is a lookup of the scan that was cut while the
// other has rows (CONTRACTS.md §8 `cut`): the rows are then one side of the name, and the footer
// says which side is missing — a list that is one side is not "the places that use it".
const SCANNED_ROWS = {
  both: 'property reads (obj.name), object keys ({ name }) and members of types',
  keys: 'property reads (obj.name)',
  reads: 'object keys ({ name }) and members of types',
};
const CUT_IS = {
  keys: ' Its object keys ({ name }) are not listed: the name is on its own in more JS/TS files than a search lists. Grep for them.',
  reads: ' Its property reads (obj.name) are not listed: it is read as a property in more JS/TS files than a search lists. Grep for them.',
};
const scanHint = (cut) =>
  `hint: no symbol carries this name; the rows are ${SCANNED_ROWS[cut ?? 'both']}, found by scanning the JavaScript and TypeScript source just now; ` +
  `the index had no call or type of that name.${CUT_IS[cut] ?? ''} ${TAIL}`;
const mixedHint = (cut) =>
  `hint: no symbol carries this name; the rows are places that use it: calls and type names from the index, and ${SCANNED_ROWS[cut ?? 'both']} ` +
  `found by scanning the JS/TS source just now.${CUT_IS[cut] ?? ''} ${TAIL}`;
const RELATIONS_EMPTY_HINT =
  'hint: confirm the name with operation=search; dynamic references (reflection, getattr, dynamic import) are never linked.';
const NOT_FOUND_HINT =
  'hint: no unique symbol with this name; operation=search lists the candidates, add file to pick one of them.';
const OUTLINE_EMPTY_HINT =
  'hint: file is not in the index (unsupported language, excluded, or not indexed yet); operation=search finds symbols by name.';
const MAP_EMPTY_HINT = 'hint: no symbols in scope; pass a path or check codegraph_status.';
const MAP_TRUNCATED_HINT = 'hint: raise budget (max 4000) or pass a narrower path to see more.';
const IMPACT_TRUNCATED_HINT = 'hint: impact was cut; raise depth (max 6) or limit (max 200) to see more.';
// operation=cycles / operation=affected (CONTRACTS.md §11).
const CYCLE_HINT = 'hint: cycles follow resolved imports only; dynamic imports and unresolved specifiers are not in the graph.';
const CYCLE_CAP_HINT = 'hint: the import graph was cut at the size one walk reads; cycles beyond the cut are not listed.';
const CYCLE_TRUNC_HINT = 'hint: raise limit (max 200) for a longer list, or budget when rows were cut for space.';
const AFFECTED_HINT = "hint: candidates from imports and resolved references; run the project's own test selection for the final list.";
const AFFECTED_TRUNC_HINT = 'hint: raise limit (max 200) to see more test files.';
const affectedCutHint = (depth) => `hint: the walk stopped at depth ${count(depth)} or the file cap; some dependents may not be listed.`;
const EMPTY_INDEX_HINT =
  'hint: use Read/Grep until the project is indexed; auto-index is skipped when autoIndex is off, the root is unsafe ' +
  '(home or drive root) or the supported-file count is outside minFilesToAutoIndex..maxFiles (codegraph.json).';
// A project's file can only switch indexing off, so it is also the only place to switch it back on.
const PROJECT_OFF_HINT =
  'hint: auto-indexing is off in .zcode/codegraph.json of this project; delete "autoIndex": false there to index it. ' +
  'Until then use Read/Grep.';
// A clean request without confirm=true only lists (CONTRACTS.md §10 `clean`).
const CLEAN_CONFIRM_HINT =
  'hint: nothing was removed. Call again with confirm=true, and only when the user asked for it.';
const CLEAN_DONE_HINT =
  'hint: an index that was removed is rebuilt the next time a session opens its project; ' +
  'codegraph_status (storage=true) lists what is left.';

// ---------- small helpers ----------

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

function clip(text, max) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  let head = t.slice(0, max - 1);
  // Never leave a lone high surrogate at the cut (it would render as a broken character).
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}…`;
}

// Join tokens but keep the whole row inside `maxTokens`; the remainder becomes `… (+N more)`.
function joinCapped(tokens, separator, maxTokens) {
  if (estimateTokens(tokens.join(separator)) <= maxTokens) return tokens.join(separator);
  const kept = [];
  let used = 0;
  for (const token of tokens) {
    const cost = estimateTokens(token) + (kept.length ? estimateTokens(separator) : 0);
    if (used + cost > maxTokens - 2) break; // room for " … (+N more)"
    kept.push(token);
    used += cost;
  }
  return `${kept.join(separator)} … (+${tokens.length - kept.length} more)`;
}

// Right-aligned kind; a kind longer than the column keeps its tail.
function kindLabel(kind) {
  const k = oneLine(kind) || 'symbol';
  return (k.length > KIND_WIDTH ? `…${k.slice(-(KIND_WIDTH - 1))}` : k).padStart(KIND_WIDTH);
}

function quoted(text) {
  const t = String(text ?? '');
  return /\s/.test(t) ? JSON.stringify(t) : t;
}

function argText(parts) {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').map(quoted).join(' ');
}

function count(value) {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function plural(n, one, many) {
  if (n === 1) return one;
  return many ?? `${one}s`;
}

function listOrClamp(items, max) {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} … (+${items.length - max} more)`;
}

function ageText(ms, now) {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown time';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const staleText = (n) => `stale: ${n} files changed since index`;

// The per-file staleness line (CONTRACTS.md §11): the files a result names that changed since
// the index was written. `meta.stale` is `{ paths, more }`, the paths cut to three by the tool
// layer; `more` counts the rest. The header already carries the total count, so this line only
// says which files to read again.
function staleBanner(meta) {
  const stale = meta.stale;
  if (!stale || !Array.isArray(stale.paths)) return null;
  const paths = stale.paths.map((p) => clip(oneLine(p), 100)).filter(Boolean);
  if (paths.length === 0) return null;
  const rest = count(stale.more);
  return `stale: ${paths.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''} changed since index — Read them for the current content`;
}

function progressText(status) {
  const total = count(status.filesTotal);
  const done = count(status.filesDone);
  const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  return total > 0 ? `indexing ${percent}% (results partial)` : 'indexing (results partial)';
}

/**
 * Freshness segment of the header, derived from the indexer status
 * (CONTRACTS.md §3.1). The stale and building markers are the two contract
 * fragments and always end the line.
 *
 * @param {object|null} status
 * @param {{ now?: number }} [options]
 * @returns {string}
 */
export function freshnessLabel(status, { now = Date.now() } = {}) {
  if (!status) return 'index status unknown';
  const state = oneLine(status.state) || 'empty';
  // The live count first: the stored one is written when a build finishes and stays at 0 while
  // files are waiting for the next sync, which is exactly when the model needs the number.
  const stale = count(status.dirty ?? status.stale);
  if (state === 'building') return [stale > 0 ? staleText(stale) : null, progressText(status)].filter(Boolean).join(' · ');
  if (state === 'ready') {
    return [
      `indexed ${ageText(status.indexedAt, now)}`,
      status.syncing ? 'syncing with the working tree, call again for fresh results' : null,
      stale > 0 ? staleText(stale) : null,
    ].filter(Boolean).join(' · ');
  }
  if (state === 'error') return 'index error';
  if (state === 'empty') return 'not indexed';
  return `index ${state}`;
}

function formatLanguages(languages) {
  const LIMIT = 40;
  const finishList = (entries) => (entries.length > LIMIT ? `${entries.slice(0, LIMIT).join(', ')} … (+${entries.length - LIMIT} more)` : entries.join(', '));
  if (Array.isArray(languages)) return finishList(languages.map(oneLine).filter(Boolean));
  if (!languages || typeof languages !== 'object') return '';
  const entries = Object.entries(languages)
    .map(([name, n]) => [oneLine(name), count(n)])
    .filter(([name]) => name)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return finishList(entries.map(([name, n]) => `${name} ${n}`));
}

function headerLine(operation, args, summary, meta = {}) {
  const parts = [`# ${operation}${args ? ` ${args}` : ''}`];
  if (summary) parts.push(summary);
  if (meta.freshness) parts.push(meta.freshness);
  return parts.join(' · ');
}

// Resolution marker glued to the location (`path:line=`). Rows without the
// concept (search results) carry no marker; unprocessed (`null`) reads as `?`.
function marker(resolution, { defaultMark = '' } = {}) {
  if (resolution === undefined) return defaultMark;
  if (resolution === '=' || resolution === '~') return resolution;
  return '?';
}

// `~` and `?` (and an unprocessed null) are the marks the legend explains.
const needsLegend = (resolution) => resolution !== '=';

// Rows handed to finish() are either plain lines or `{ line, marker }`; the
// marker flag drives the legend so a `?` inside a signature never triggers it.
function rowEntry(row, defaultKind, fallbackPath) {
  const marked = (row.resolution !== undefined && needsLegend(row.resolution)) || count(row.usage?.byName) > 0;
  return { line: rowLine(row, defaultKind, fallbackPath), marker: marked };
}

function legendIfNeeded(shownRows) {
  return shownRows.some((r) => typeof r === 'object' && r.marker) ? LEGEND : null;
}

// Path, then line, then name: code-unit order so the output is identical on
// every platform (CONTRACTS.md §11).
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// File tier first (source, tests and scripts, generated) so a list that arrives cut or unsorted
// still shows source rows first, as the queries order them; then path, line and name.
function sortRows(rows, fallbackPath = '') {
  const pathOf = (row) => String(row.path ?? fallbackPath);
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const byRank = pathRank(pathOf(a.row)) - pathRank(pathOf(b.row));
      if (byRank) return byRank;
      const byPath = compareText(pathOf(a.row), pathOf(b.row));
      if (byPath) return byPath;
      const la = count(a.row.startLine ?? a.row.start_line);
      const lb = count(b.row.startLine ?? b.row.start_line);
      if (la !== lb) return la - lb;
      const byName = compareText(String(a.row.name ?? ''), String(b.row.name ?? ''));
      if (byName) return byName;
      return a.i - b.i;
    })
    .map((e) => e.row);
}

// `fallbackPath`: outline rows carry no path (one file), so the renderer supplies it.
// A relation row without a path (callee whose target is unresolved) shows the line alone.
function rowLine(row, defaultKind = 'symbol', fallbackPath = '') {
  const name = oneLine(row.name) || '?';
  const sig = clip(oneLine(row.signature), SIGNATURE_WIDTH);
  const start = row.startLine ?? row.start_line;
  const end = row.endLine ?? row.end_line;
  const file = oneLine(row.path ?? fallbackPath);
  const location = file
    ? `${file}:${start}${Number.isInteger(end) ? `-${end}` : ''}`
    : Number.isInteger(start)
      ? `line ${start}`
      : '';
  const times = count(row.count) > 1 ? ` ×${count(row.count)}` : '';
  const depth = row.depth !== undefined && row.depth !== null ? ` depth ${row.depth}` : '';
  return `${kindLabel(row.kind ?? defaultKind)} ${name}${sig ? ` ${sig}` : ''}${location ? ` ${location}` : ''}${marker(row.resolution)}${times}${depth}${usageSuffix(row.usage)}`;
}

// ` · 12 uses in 4 files (3 in source)`: who depends on this symbol. Search results carry it for
// their leading rows, so the first look already brings a slice of the graph into the context.
// `~` at the end: some references were linked by a unique name rather than by an import, so the
// count is a best effort. A hub (more references than USAGE_MAX_REFS) only gets its count.
function usageSuffix(usage) {
  const refs = count(usage?.refs);
  if (!(refs > 0)) return '';
  if (usage.capped === true) return ` · ${refs} ${plural(refs, 'reference', 'references')} (not broken down by file)`;
  const files = count(usage?.files);
  const inSource = count(usage?.inSource);
  if (!(files > 0)) return '';
  const where = inSource === files ? '' : ` (${inSource} in source)`;
  return ` · ${refs} ${plural(refs, 'use', 'uses')} in ${files} ${plural(files, 'file', 'files')}${where}${count(usage.byName) > 0 ? '~' : ''}`;
}

// `name path:line=` — a caller with the call site and its resolution.
function relationToken(row) {
  const name = oneLine(row.name) || '?';
  const start = row.startLine ?? row.start_line;
  const file = oneLine(row.path);
  const times = count(row.count) > 1 ? ` ×${count(row.count)}` : '';
  const where = file ? `${file}:${start}` : Number.isInteger(start) ? `line ${start}` : '';
  return { text: `${name}${where ? ` ${where}` : ''}${marker(row.resolution, { defaultMark: '?' })}${times}`, marker: needsLegend(row.resolution) };
}

// `name=` — a callee (CONTRACTS.md §11 `calls(n): a= b~ c?`); the call site is
// inside the symbol itself, so only the name and the resolution are shown.
function calleeToken(row) {
  const name = oneLine(row.name) || '?';
  const times = count(row.count) > 1 ? ` ×${count(row.count)}` : '';
  return { text: `${name}${marker(row.resolution, { defaultMark: '?' })}${times}`, marker: needsLegend(row.resolution) };
}

// Body section: inline when short enough, otherwise a Read line that names the
// exact range (CONTRACTS.md §11). The renderer decides between the two forms;
// `finish` falls back to the Read line when the block would not fit the budget.
function bodySection(body, { path: file, start }) {
  if (!body || body.error) return { error: body?.error ?? 'body unavailable' };
  const n = body.lines ? body.lines.length : count(body.lineCount);
  const first = Number.isInteger(start) ? start : 1;
  const read = `body: ${n} lines → Read ${file} offset ${first} limit ${n}`;
  if (!body.lines || n > INLINE_BODY_MAX_LINES || n === 0) return { fallback: read };
  return { block: [`body (${n} lines):`, '```', ...body.lines.map(String), '```'], fallback: read };
}

function formatImports(imports) {
  if (!Array.isArray(imports)) return '';
  const specs = [];
  for (const imp of imports) {
    const spec = oneLine(typeof imp === 'string' ? imp : imp?.spec);
    if (spec && !specs.includes(spec)) specs.push(spec);
  }
  return specs.length ? listOrClamp(specs, IMPORTS_SHOWN) : '';
}

/**
 * Assemble header + rows + footer within `budget` tokens, then apply the byte
 * cap. Rows are plain lines or `{ line, marker }` entries; they are fitted twice
 * when anything is cut so the truncation line and its hint are guaranteed to
 * fit as well. `footer` may be a function of the row entries actually shown
 * (the legend only accompanies markers that are visible); the budget is
 * reserved with the full row set, which is the worst case.
 */
function finish({ header, rows, footer = [], budget, more = false, body = null, truncHint = TRUNCATION_HINT, banner = null, total = null }) {
  const maxTokens = budget ?? DEFAULT_CONFIG.defaultBudgetTokens.lookup;
  const entries = rows.map((r) => (typeof r === 'string' ? { line: r, marker: false } : r));
  const rowLines = entries.map((e) => e.line);
  const footerFor = (shown) => (typeof footer === 'function' ? footer(shown) : footer).filter(Boolean);
  // The staleness line sits between the header and the rows, so its room is taken off the top
  // once; it is never dropped (the model has to see it to re-read the file).
  const bannerRoom = banner ? estimateTokens(banner) + 1 : 0;
  // The body's Read line is its smallest representation, so room for it is
  // reserved before rows are fitted; only the inline block competes for the rest.
  const bodyReserve = body && body.fallback ? estimateTokens(body.fallback) + 1 : 0;
  // Rows outrank footer hints: a hint that would leave less room than a few rows
  // take is dropped, last one first.
  const footersFor = (shown) => {
    const lines = footerFor(shown);
    const roomLeft = () => maxTokens - estimateTokens(header) - bannerRoom - bodyReserve - (lines.length ? estimateTokens(lines.join('\n')) + 1 : 0);
    while (roomLeft() < FOOTER_MIN_ROOM) {
      const at = lines.findLastIndex(isHintLine);
      if (at < 0) break;
      lines.splice(at, 1);
    }
    return lines;
  };
  const footerLines = footersFor(entries);
  const room = maxTokens - estimateTokens(header) - bannerRoom - (footerLines.length ? estimateTokens(footerLines.join('\n')) + 1 : 0) - bodyReserve;
  let fit = fitLines(rowLines, { maxTokens: room });
  let trunc = null;
  let hint = null;
  if (fit.truncated || more) {
    // Reserve the widest truncation line the counts can produce plus the hint.
    const reserve = estimateTokens('(9999 of 9999+ shown)') + 1 + estimateTokens(truncHint) + 1;
    fit = fitLines(rowLines, { maxTokens: room - reserve });
    trunc = more && !fit.truncated ? `(${fit.lines.length} of ${total ?? fit.lines.length + 1}${total === null ? '+' : ''} shown)` : `(${fit.lines.length} of ${total ?? entries.length} shown)`;
    hint = truncHint;
  }
  const lines = [header, ...(banner ? [banner] : []), ...fit.lines, ...footersFor(entries.slice(0, fit.lines.length))];
  // Everything except the body is fixed now; the body only goes inline when
  // the whole result (hint and truncation line included) still fits.
  const prefix = [...lines];
  if (hint) prefix.push(hint);
  if (trunc) prefix.push(trunc);
  const used = estimateTokens(prefix.join('\n'));
  if (body) {
    if (body.error) lines.push(`body: ${body.error}`);
    else if (body.block && estimateTokens(body.block.join('\n')) + 1 <= maxTokens - used) lines.push(...body.block);
    else lines.push(body.fallback);
  }
  if (hint) lines.push(hint);
  if (trunc) lines.push(trunc);
  // A budget smaller than header + footer + hint + truncation line keeps the
  // essentials and drops the hint.
  if (hint && estimateTokens(lines.join('\n')) > maxTokens) {
    const at = lines.indexOf(hint);
    if (at >= 0) lines.splice(at, 1);
  }
  // Footer hints yield too when the budget does not cover header plus footer (empty results,
  // tiny budgets); rows and the header stay.
  while (estimateTokens(lines.join('\n')) > maxTokens) {
    const at = lines.findLastIndex(isHintLine);
    if (at < 0) break;
    lines.splice(at, 1);
  }
  const capped = capLines(lines, {
    note: (shown, total) => `(output truncated at 45 KB: ${shown} of ${total} lines shown)`,
  });
  return capped.lines.join('\n');
}

// ---------- renderers ----------

/**
 * Index status. The header carries state and counts; rows add languages and,
 * where applicable, the reason why the project is not indexed.
 *
 * @param {object|null} status  indexer.status()
 * @param {{ refresh?: boolean, now?: number, syncError?: Error|null }} [meta]
 */
export function renderStatus(status, meta = {}) {
  const now = meta.now ?? Date.now();
  const args = meta.refresh ? 'refresh=true' : '';
  if (!status) {
    const why = meta.syncError ? `: ${oneLine(meta.syncError.message ?? meta.syncError)}` : '';
    return finish({
      header: headerLine('status', args, 'unavailable', {}),
      rows: [`index status could not be read${why}; the index directory may be missing or locked`],
      budget: Infinity,
    });
  }
  const state = oneLine(status.state) || 'empty';
  const files = count(status.filesTotal);
  const symbols = count(status.symbols);
  const summary =
    state === 'building'
      ? `${count(status.filesDone)} of ${files} ${plural(files, 'file')} · ${symbols} ${plural(symbols, 'symbol')}`
      : `${files} ${plural(files, 'file')} · ${symbols} ${plural(symbols, 'symbol')}`;
  let freshness = freshnessLabel(status, { now });
  if (meta.syncError) freshness = [freshness, `sync failed: ${oneLine(meta.syncError.message ?? meta.syncError)}`].join(' · ');
  const rows = [];
  const languages = formatLanguages(status.languages);
  if (languages) rows.push(`languages: ${languages}`);
  if (state === 'error') rows.push(`error: ${oneLine(status.error ?? status.reasonDetail ?? status.reason ?? 'unknown error')}`);
  if (state === 'empty') {
    // Lane A reports a machine-readable `reason` plus its text (`reasonDetail`).
    const detail = oneLine(status.reasonDetail ?? status.message ?? status.error);
    const code = oneLine(status.reason);
    if (detail || code) rows.push(`reason: ${detail || code}${detail && code && detail !== code ? ` [${code}]` : ''}`);
    rows.push(meta.offBy === 'project' ? PROJECT_OFF_HINT : EMPTY_INDEX_HINT);
  }
  if (meta.offBy && state !== 'empty') {
    const where = meta.offBy === 'project' ? 'off for this project (.zcode/codegraph.json)' : 'off (codegraph.json)';
    rows.push(`note: auto-indexing is ${where}; the index is only refreshed by codegraph_status (refresh=true)`);
  }
  if (status.readOnly === true) rows.push('note: read-only; another session holds the index lock, this one only queries');
  if (count(status.parseErrors) > 0) rows.push(`parse errors: ${count(status.parseErrors)} file(s) indexed with syntax errors`);
  if (meta.storage) rows.push(...storageRows(meta.storage, now));
  return finish({
    header: headerLine('status', args, `${state} · ${summary}`, { freshness }),
    rows,
    budget: Infinity,
  });
}

// `7.6 MB`, `471 MB`, `1.2 GB`: one decimal below ten of a unit, none above.
export function sizeText(bytes) {
  const n = count(bytes);
  const MB = 1024 * 1024;
  if (n <= 0) return '0 KB';
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 10 * MB) return `${(n / MB).toFixed(1)} MB`;
  if (n < 1024 * MB) return `${Math.round(n / MB)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

// One index of the store: where, what state, how big, when it last served a session.
function indexLine(entry, now, reason = null) {
  const parts = [oneLine(entry.root) || entry.key];
  if (entry.orphan) parts.push('project folder missing');
  else if (entry.state === 'ready') parts.push(`${count(entry.files)} ${plural(count(entry.files), 'file')}`);
  else parts.push(oneLine(entry.state) || 'unknown');
  parts.push(sizeText(entry.bytes), `used ${ageText(entry.lastUsedAt, now)}`);
  if (entry.inUse) parts.push('in use');
  if (reason) parts.push(reason);
  return parts.join(' · ');
}

function storageRows(storage, now) {
  const entries = Array.isArray(storage.entries) ? storage.entries : [];
  const total = entries.reduce((sum, entry) => sum + count(entry.bytes), 0);
  const rows = [`indexes: ${entries.length} ${plural(entries.length, 'project', 'projects')} · ${sizeText(total)} in all`];
  if (storage.dir) rows.push(`under ${oneLine(storage.dir)}`);
  for (const entry of entries) rows.push(` ${indexLine(entry, now)}`);
  if (storage.policy) rows.push(`policy: ${oneLine(storage.policy)}`);
  return rows;
}

/**
 * The result of a clean request (CONTRACTS.md §10 `clean`): what went, or what would go.
 *
 * @param {{ target: string, remove: object[], removed?: object[], busy?: object[], total: number, done: boolean, now?: number }} input
 */
export function renderClean({ target, remove, removed = [], busy = [], total, done, now = Date.now() }) {
  const due = Array.isArray(remove) ? remove : [];
  const gone = done ? removed : [];
  const listed = done ? gone : due;
  const size = (entries) => sizeText(entries.reduce((sum, entry) => sum + count(entry.bytes), 0));
  const summary = done
    ? `removed ${gone.length} of ${count(total)} ${plural(count(total), 'index', 'indexes')} · ${size(gone)} freed`
    : `${due.length} of ${count(total)} ${plural(count(total), 'index', 'indexes')} would be removed · ${size(due)}`;
  const rows = listed.map((entry) => ` ${indexLine(entry, now, entry.reason)}`);
  for (const entry of busy) rows.push(` ${indexLine(entry, now, 'kept: in use')}`);
  return finish({
    header: headerLine('status', `clean=${target}`, summary, {}),
    rows,
    footer: [done ? CLEAN_DONE_HINT : CLEAN_CONFIRM_HINT],
    budget: Infinity,
  });
}

// A name on one line, cut with an ellipsis, in quotes when it has spaces (a reference name is
// not always an identifier: the parser keeps the text of a call it could not reduce).
function nameText(name, max) {
  const text = clip(oneLine(name), max);
  return /\s/.test(text) ? `"${text}"` : text;
}

// A place that uses a name no symbol defines: `<kind> <receiver>.<name> ×<count> in <owner> <path>:<line>`.
// Module-level references have no owner and say where they are instead. No marker: a reference
// row carries no resolution.
function refEntry(row) {
  const name = `${row.receiver ? `${nameText(row.receiver, 24)}.` : ''}${nameText(row.name, 60)}`;
  return { line: `${kindLabel(row.kind)} ${name} ×${count(row.count)} ${row.owner ? `in ${oneLine(row.owner)}` : 'at'} ${oneLine(row.path)}:${count(row.startLine)}`, marker: false };
}

/**
 * operation=search. `meta`: `{ query, more, matched?, dropped?, refs?, budget, freshness }`.
 * Rows arrive best match first and keep that order: the first rows are what a small budget keeps.
 * `dropped` marks a relaxed search (no name has every word): `matched` is what the best row
 * contains. Later rows may contain other words, so the header speaks of the best match only.
 * `refs` marks a search whose rows are the places that use the name (no symbol carries it), and
 * `refs.symbols` names the symbols that share a word with it.
 */
export function renderSearch(rows, meta = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const refs = meta.refs && typeof meta.refs === 'object' ? meta.refs : null;
  // Where the rows come from: the index, a scan of the JS/TS source for property reads
  // (`fromScan`), or both.
  const fromScan = refs ? count(refs.fromScan) : 0;
  const onlyScan = fromScan > 0 && count(refs.fromIndex) === 0;
  // A list of nothing but property reads is called that; keys and members of types in it make it uses.
  const onlyReads = onlyScan && (Array.isArray(refs.kinds) ? refs.kinds : ['property']).every((kind) => kind === 'property');
  const relaxed = !refs && Array.isArray(meta.dropped) && meta.dropped.length > 0 && Array.isArray(meta.matched) && meta.matched.length > 0;
  const amount = (n, word) => `${count(n)}${refs?.capped ? '+' : ''} ${plural(count(n), word)}`;
  const listed = (names) => listOrClamp(names.map((name) => nameText(name, 40)), 3);
  // Symbols that share a word with the name: three by name, the rest as a count of what the
  // search found (it looks for as many symbols as the caller asked for rows, so not all of them).
  const others = Array.isArray(refs?.symbols) && refs.symbols.length > 0
    ? ` · also in symbol names: ${listed(refs.symbols)}${count(refs.symbolCount) > refs.symbols.length ? ` (+${count(refs.symbolCount) - refs.symbols.length} more found)` : ''}`
    : '';
  const summary = list.length === 0
    ? 'no matches'
    : refs
      ? `no symbol carries this name; ${amount(refs.uses, onlyReads ? 'property read' : 'use')} in ${amount(refs.files, 'file')} (${listed(refs.names ?? [])})${others}`
      : relaxed
        ? `${list.length} partial ${plural(list.length, 'match', 'matches')} (no name has all words; best match: ${meta.matched.join(' + ')})`
        : `${list.length} ${plural(list.length, 'match', 'matches')}`;
  const entries = list.map((row) => (refs ? refEntry(row) : rowEntry(row)));
  // Rows of the index only: an empty answer of the scan is reported for what it was (a hub, a
  // scan that stopped at a limit, or no look at all).
  // A lookup of the scan that was cut while the other has rows: the footer names the missing side.
  const cut = refs && (refs.cut === 'reads' || refs.cut === 'keys') ? refs.cut : null;
  const indexHint = SEARCH_REFS_HINTS.get(refs?.skipped ?? null) ?? SEARCH_REFS_SKIPPED_HINT;
  const hint = refs
    ? (onlyScan ? scanHint(cut) : fromScan > 0 ? mixedHint(cut) : indexHint) + (refs.capped ? LOWER_BOUND_HINT : '')
    : list.length === 0 ? (meta.hub === true ? SEARCH_EMPTY_HUB_HINT : SEARCH_EMPTY_HINT) : SEARCH_NEXT_HINT;
  return finish({
    header: headerLine('search', argText([meta.query]), summary, meta),
    rows: entries,
    footer: (shown) => [legendIfNeeded(shown), hint],
    budget: meta.budget,
    more: meta.more === true,
    banner: staleBanner(meta),
  });
}

/**
 * operation=symbol (CONTRACTS.md §11 "symbol").
 *
 * @param {{ symbol: object, callers?: object[], callees?: object[], imports?: Array }|null} result
 * @param {{ name?: string, file?: string, body?: { lines?: string[], lineCount?: number, error?: string }|null,
 *   budget?: number, freshness?: string }} [meta]
 */
export function renderSymbol(result, meta = {}) {
  const args = argText([meta.name, meta.file]);
  if (!result || !result.symbol) {
    return finish({ header: headerLine('symbol', args, 'not found', meta), rows: [], footer: [NOT_FOUND_HINT], budget: meta.budget });
  }
  const s = result.symbol;
  const file = oneLine(s.path);
  const start = s.startLine ?? s.start_line;
  const end = s.endLine ?? s.end_line;
  const span = Number.isInteger(start) && Number.isInteger(end) ? end - start + 1 : null;
  const callers = Array.isArray(result.callers) ? result.callers : [];
  const callees = Array.isArray(result.callees) ? result.callees : [];
  const resolved = callers.filter((r) => RESOLVED.has(r.resolution)).length;
  const location = `${file}:${start}${Number.isInteger(end) ? `-${end}` : ''}${span !== null ? ` (${span} lines)` : ''}`;
  const rows = [];
  const sig = oneLine(s.signature);
  if (sig) rows.push(`sig: ${sig}`);
  const doc = oneLine(s.doc);
  if (doc) rows.push(`doc: ${clip(doc, DOC_WIDTH)}`);
  const calleesTokens = callees.map(calleeToken);
  const callerTokens = callers.map(relationToken);
  // Relation rows are single lines; without a cap an over-long one is dropped whole and the model sees no names.
  const rowCap = Math.max(120, Math.floor((meta.budget ?? DEFAULT_CONFIG.defaultBudgetTokens.lookup) * 0.35));
  rows.push({ line: `calls(${callees.length}): ${callees.length ? joinCapped(calleesTokens.map((t) => t.text), ' ', rowCap) : 'none'}`, marker: calleesTokens.some((t) => t.marker) });
  // Refs to a type, constant or field are uses, not calls; the word tells the model it gets every reference.
  const callable = CALLABLE_KINDS.has(s.kind);
  rows.push({ line: `${callable ? 'called by' : 'used by'}(${callers.length}): ${callers.length ? joinCapped(callerTokens.map((t) => t.text), ' · ', rowCap) : 'none'}`, marker: callerTokens.some((t) => t.marker) });
  const imports = formatImports(result.imports);
  if (imports) rows.push(`imports: ${imports}`);
  return finish({
    header: headerLine('symbol', args, `${location} · ${callable ? 'callers' : 'uses'} ${resolved}/${callers.length} resolved`, meta),
    rows,
    footer: (shown) => [legendIfNeeded(shown)],
    budget: meta.budget,
    body: meta.body ? bodySection(meta.body, { path: file, start }) : null,
    banner: staleBanner(meta),
  });
}

/** operation=callers. Rows: `{ name, path, startLine, resolution, count }`. */
export function renderCallers(rows, meta = {}) {
  return renderRelations('callers', rows, meta);
}

/** operation=callees. Same row format as callers. */
export function renderCallees(rows, meta = {}) {
  return renderRelations('callees', rows, meta);
}

function renderRelations(op, rows, meta) {
  const list = Array.isArray(rows) ? rows : [];
  const noun = op === 'callers' ? 'call site' : 'callee';
  const resolved = list.filter((r) => RESOLVED.has(r.resolution)).length;
  const summary =
    list.length === 0 ? `no ${op}` : `${list.length} ${plural(list.length, noun)} (${resolved}/${list.length} resolved)`;
  const entries = sortRows(list).map((row) => rowEntry(row, 'call'));
  return finish({
    header: headerLine(op, argText([meta.name, meta.file]), summary, meta),
    rows: entries,
    footer: (shown) => [legendIfNeeded(shown), list.length === 0 ? RELATIONS_EMPTY_HINT : null],
    budget: meta.budget,
    more: meta.more === true,
    banner: staleBanner(meta),
  });
}

/**
 * operation=impact. `result`: `{ nodes, files, truncated }` (CONTRACTS.md §8).
 *
 * @param {{ nodes?: object[], files?: Array, truncated?: boolean }|null} result
 * @param {{ name?: string, file?: string, depth?: number, more?: boolean, budget?: number, freshness?: string }} [meta]
 */
export function renderImpact(result, meta = {}) {
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  const files = Array.isArray(result?.files) ? result.files : [];
  const summary = `${nodes.length} ${plural(nodes.length, 'node')} in ${files.length} ${plural(files.length, 'file')}`;
  const entries = sortRows(nodes).map((row) => rowEntry(row));
  const paths = files.map((f) => oneLine(typeof f === 'string' ? f : f?.path)).filter(Boolean);
  // Two different cuts: `more` means our own row limit dropped nodes (known
  // count, regular truncation line); `truncated` means the query stopped at the
  // depth or its own cap, which is reported as a hint only.
  const more = meta.more === true;
  return finish({
    header: headerLine('impact', argText([meta.name, meta.file, meta.depth !== undefined ? `depth=${meta.depth}` : null]), summary, meta),
    rows: entries,
    footer: (shown) => [
      legendIfNeeded(shown),
      paths.length ? `files(${paths.length}): ${listOrClamp(paths, FILES_SHOWN)}` : null,
      !more && result?.truncated === true ? IMPACT_TRUNCATED_HINT : null,
    ],
    budget: meta.budget,
    more,
    truncHint: IMPACT_TRUNCATED_HINT,
    banner: staleBanner(meta),
  });
}

/** Paths shown in one cycle row; the rest of a long cycle is counted, so no row outgrows the budget. */
const CYCLE_SHOWN = 20;

// The files a cycle holds: a walk repeats its first path to close, and a dense component
// repeats more, so the list length overcounts.
function cycleFiles(cycle) {
  return cycle.walked === false ? cycle.paths.length : new Set(cycle.paths).size;
}

// One cycle row: the walk with its arrows when the component was walked, the sorted files when
// it was only listed (CONTRACTS.md §11).
function cycleLine(cycle, index) {
  const n = cycleFiles(cycle);
  if (cycle.walked === false) return `cycle ${index} (${n} files, listed not walked): ${listOrClamp(cycle.paths, CYCLE_SHOWN)}`;
  const paths = cycle.paths;
  const walk = paths.length <= CYCLE_SHOWN + 1
    ? paths.join(' → ')
    : `${paths.slice(0, CYCLE_SHOWN).join(' → ')} … (+${paths.length - 1 - CYCLE_SHOWN} more) → ${paths.at(-1)}`;
  return `cycle ${index} (${n} files): ${walk}`;
}

/**
 * operation=cycles (CONTRACTS.md §11). `result`: `{ cycles, total, truncated }`; each cycle is
 * `{ paths, walked }`: a closed walk whose last entry repeats the first, or (not walked) the
 * sorted files of a component too big to walk.
 */
export function renderCycles(result, meta = {}) {
  const cycles = Array.isArray(result?.cycles)
    ? result.cycles.filter((cycle) => cycle && Array.isArray(cycle.paths) && cycle.paths.length > 0)
    : [];
  const total = count(result?.total ?? cycles.length);
  const files = cycles.reduce((sum, cycle) => sum + cycleFiles(cycle), 0);
  const summary = cycles.length === 0
    ? 'no import cycles'
    : `${cycles.length} import ${plural(cycles.length, 'cycle')} in ${files} ${plural(files, 'file')}`;
  const rows = cycles.map((cycle, i) => cycleLine(cycle, i + 1));
  const cut = total > cycles.length;
  return finish({
    header: headerLine('cycles', '', summary, meta),
    rows,
    footer: [CYCLE_HINT, result?.truncated === true && !cut ? CYCLE_CAP_HINT : null],
    budget: meta.budget,
    more: cut,
    total: cut ? total : null,
    truncHint: CYCLE_TRUNC_HINT,
  });
}

/** Input files the `affected` header names; the model sent the list, so the header only confirms it. */
const AFFECTED_FILES_SHOWN = 5;

/**
 * operation=affected (CONTRACTS.md §11). `result`: `{ tests, otherFiles, scanned, truncated,
 * unknown }`. Rows are one test file per line; `unknown` is a footer line (not a hint), so a
 * tight budget cuts rows before it. The header names at most `AFFECTED_FILES_SHOWN` of the input
 * files and cuts each unknown path to 100 characters: it is never dropped, so it must stay small.
 */
export function renderAffected(result, meta = {}) {
  const tests = Array.isArray(result?.tests) ? result.tests : [];
  const files = Array.isArray(meta.files) ? meta.files : [];
  const scanned = count(result?.scanned);
  const unknown = Array.isArray(result?.unknown) ? result.unknown.map((p) => clip(oneLine(p), 100)).filter(Boolean) : [];
  const n = tests.length;
  const who = n === 0 ? 'no test files reach them' : `${n} ${plural(n, 'test file')} ${n === 1 ? 'reaches' : 'reach'} them`;
  const rows = tests.map((path) => oneLine(path));
  return finish({
    header: headerLine('affected', listOrClamp(files, AFFECTED_FILES_SHOWN), `${who} (${scanned} ${plural(scanned, 'file')} scanned)`, meta),
    rows,
    footer: [unknown.length > 0 ? `not in the index: ${listOrClamp(unknown, 5)}` : null, AFFECTED_HINT, result?.truncated === true ? affectedCutHint(meta.depth) : null],
    budget: meta.budget,
    more: meta.more === true,
    truncHint: AFFECTED_TRUNC_HINT,
  });
}

/** operation=outline. Rows: `{ kind, name, startLine, endLine, signature }`. */
export function renderOutline(rows, meta = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const summary = list.length === 0 ? 'no symbols' : `${list.length} ${plural(list.length, 'symbol')}`;
  const entries = sortRows(list, meta.file).map((row) => rowEntry(row, 'symbol', meta.file));
  return finish({
    header: headerLine('outline', argText([meta.file]), summary, meta),
    rows: entries,
    footer: [list.length === 0 ? OUTLINE_EMPTY_HINT : null],
    budget: meta.budget,
    more: meta.more === true,
    banner: staleBanner(meta),
  });
}

/**
 * codegraph_map. `repoMap` (Lane B) already lays the map out by directory within
 * its token budget; this wraps it with the common header and truncation footer
 * and re-fits the text defensively.
 *
 * @param {{ text?: string, shown?: number, total?: number, truncated?: boolean }|null} map
 * @param {{ path?: string, budget?: number, freshness?: string }} [meta]
 */
export function renderMap(map, meta = {}) {
  const text = typeof map?.text === 'string' ? map.text : '';
  const shown = count(map?.shown);
  const total = count(map?.total);
  const truncated = map?.truncated === true || total > shown;
  const summary = truncated ? `${shown} of ${total} ${plural(total, 'symbol')}` : `${shown} ${plural(shown, 'symbol')}`;
  const rows = text ? text.split('\n') : [];
  return finish({
    header: headerLine('map', argText([meta.path]), summary, meta),
    rows,
    footer: [rows.length === 0 ? MAP_EMPTY_HINT : truncated ? MAP_TRUNCATED_HINT : null],
    budget: meta.budget,
  });
}

/** One-line result for conditions that are not query results (not indexed, query failed). */
export function renderNotice({ operation, args, summary, hint, freshness }) {
  return finish({
    header: headerLine(operation, args, summary, { freshness }),
    rows: [],
    footer: [hint ? `hint: ${hint}` : null],
    budget: Infinity,
  });
}
