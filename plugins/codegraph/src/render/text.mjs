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
  'hint: search matches symbol names only (text, configs and string literals belong to Grep); ' +
  'a word of one or two letters must be a whole word.';
const SEARCH_NEXT_HINT =
  'next: symbol <name> returns the definition with its callers and imports (body=true reads it in one call); ' +
  'impact <name> shows what a change breaks.';
const RELATIONS_EMPTY_HINT =
  'hint: confirm the name with operation=search; dynamic references (reflection, getattr, dynamic import) are never linked.';
const NOT_FOUND_HINT =
  'hint: no unique symbol with this name; operation=search lists the candidates, add file to pick one of them.';
const OUTLINE_EMPTY_HINT =
  'hint: file is not in the index (unsupported language, excluded, or not indexed yet); operation=search finds symbols by name.';
const MAP_EMPTY_HINT = 'hint: no symbols in scope; pass a path or check codegraph_status.';
const MAP_TRUNCATED_HINT = 'hint: raise budget (max 4000) or pass a narrower path to see more.';
const IMPACT_TRUNCATED_HINT = 'hint: impact was cut; raise depth (max 6) or limit (max 200) to see more.';
const EMPTY_INDEX_HINT =
  'hint: use Read/Grep until the project is indexed; auto-index is skipped when autoIndex is off, the root is unsafe ' +
  '(home or drive root) or the supported-file count is outside minFilesToAutoIndex..maxFiles (codegraph.json).';

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
  const stale = count(status.stale ?? status.dirty);
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

function sortRows(rows, fallbackPath = '') {
  const pathOf = (row) => String(row.path ?? fallbackPath);
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
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
function finish({ header, rows, footer = [], budget, more = false, body = null, truncHint = TRUNCATION_HINT }) {
  const maxTokens = budget ?? DEFAULT_CONFIG.defaultBudgetTokens.lookup;
  const entries = rows.map((r) => (typeof r === 'string' ? { line: r, marker: false } : r));
  const rowLines = entries.map((e) => e.line);
  const footerFor = (shown) => (typeof footer === 'function' ? footer(shown) : footer).filter(Boolean);
  // The body's Read line is its smallest representation, so room for it is
  // reserved before rows are fitted; only the inline block competes for the rest.
  const bodyReserve = body && body.fallback ? estimateTokens(body.fallback) + 1 : 0;
  // Rows outrank footer hints: a hint that would leave less room than a few rows
  // take is dropped, last one first.
  const footersFor = (shown) => {
    const lines = footerFor(shown);
    const roomLeft = () => maxTokens - estimateTokens(header) - bodyReserve - (lines.length ? estimateTokens(lines.join('\n')) + 1 : 0);
    while (roomLeft() < FOOTER_MIN_ROOM) {
      const at = lines.findLastIndex(isHintLine);
      if (at < 0) break;
      lines.splice(at, 1);
    }
    return lines;
  };
  const footerLines = footersFor(entries);
  const room = maxTokens - estimateTokens(header) - (footerLines.length ? estimateTokens(footerLines.join('\n')) + 1 : 0) - bodyReserve;
  let fit = fitLines(rowLines, { maxTokens: room });
  let trunc = null;
  let hint = null;
  if (fit.truncated || more) {
    // Reserve the widest truncation line the counts can produce plus the hint.
    const reserve = estimateTokens('(9999 of 9999+ shown)') + 1 + estimateTokens(truncHint) + 1;
    fit = fitLines(rowLines, { maxTokens: room - reserve });
    trunc = more && !fit.truncated ? `(${fit.lines.length} of ${fit.lines.length + 1}+ shown)` : `(${fit.lines.length} of ${entries.length} shown)`;
    hint = truncHint;
  }
  const lines = [header, ...fit.lines, ...footersFor(entries.slice(0, fit.lines.length))];
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
    rows.push(EMPTY_INDEX_HINT);
  }
  if (status.readOnly === true) rows.push('note: read-only; another session holds the index lock, this one only queries');
  if (count(status.parseErrors) > 0) rows.push(`parse errors: ${count(status.parseErrors)} file(s) indexed with syntax errors`);
  return finish({
    header: headerLine('status', args, `${state} · ${summary}`, { freshness }),
    rows,
    budget: Infinity,
  });
}

/**
 * operation=search. `meta`: `{ query, more, matched?, dropped?, budget, freshness }`.
 * Rows arrive best match first and keep that order: the first rows are what a small budget keeps.
 * `dropped` marks a relaxed search (no name has every word): `matched` is what the best row
 * contains. Later rows may contain other words, so the header speaks of the best match only.
 */
export function renderSearch(rows, meta = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const relaxed = Array.isArray(meta.dropped) && meta.dropped.length > 0 && Array.isArray(meta.matched) && meta.matched.length > 0;
  const summary = list.length === 0
    ? 'no matches'
    : relaxed
      ? `${list.length} partial ${plural(list.length, 'match', 'matches')} (no name has all words; best match: ${meta.matched.join(' + ')})`
      : `${list.length} ${plural(list.length, 'match', 'matches')}`;
  const entries = list.map((row) => rowEntry(row));
  return finish({
    header: headerLine('search', argText([meta.query]), summary, meta),
    rows: entries,
    footer: (shown) => [legendIfNeeded(shown), list.length === 0 ? SEARCH_EMPTY_HINT : SEARCH_NEXT_HINT],
    budget: meta.budget,
    more: meta.more === true,
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
