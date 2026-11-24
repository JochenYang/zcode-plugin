// Cross-file reference resolution (CONTRACTS.md §8). Runs in the main thread
// after the indexer wrote a file: imports first, then every ref that is still
// pending (`resolution IS NULL`), including refs in OTHER files whose target
// disappeared when this file was re-indexed (repo nulls target and resolution).
//
// Per ref, in order:
//   (a) scope 'local': locals.scm already decided. local_def_id -> that symbol
//       '='; no local_def_id means a plain local shadows the name -> '?' with
//       no fallback to imports or global names.
//   (b) the name is bound by an import of this file (alias): look in the
//       resolved file for the exported / same-named definition -> '='. A binding
//       whose module is not in the index stays '?' (see resolveImported).
//   (c) member access `recv.m()`: this.m() -> the enclosing class's method '=';
//       an imported class / namespace or a class of this file -> its member '=',
//       and '?' when it has no such member; a variable of this file with a known
//       type -> that type's method '~'; otherwise '~' only when the member name
//       is globally unique.
//   (d) bare name: unique in the file or unique in the index -> '~', else '?'.
//
// Markers: '=' certain, '~' unique by name, '?' unresolved / ambiguous.
//
// Writes: one transaction per resolveFile / resolveAll (a commit per file cost
// more than the statements), and a ref whose recomputed outcome equals its
// stored one is not written at all. Refs that may resolve differently after a
// re-index are re-evaluated in place instead of being reset to NULL first:
// the reset dirtied every page they sat on only to write the same '?' back.

import { ECOSYSTEM_BY_LANG, LANGS_BY_ECOSYSTEM, buildFileIndex, resolveImport } from './imports.mjs';
import {
  clearPendingFiles, clearPurgedSymbols, inTransaction, listFiles, metaGet, pendingFiles, prepare, setRefResolution,
  takePurgedSymbols,
} from '../store/repo.mjs';

const MAX_CANDIDATES = 500;
// Files per bulk query when a pass touches many files (symbols / imports).
const PREFETCH_FILES = 200;
// Names per IN (...) list when refs are picked by name.
const IN_CHUNK = 32;
const CONTAINER_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'enum', 'object', 'record']);
const VALUE_KINDS = ['function', 'method', 'class', 'component', 'variable', 'constant', 'struct', 'interface', 'enum', 'trait', 'object', 'record', 'type'];
const TYPE_KINDS = ['class', 'interface', 'type', 'struct', 'enum', 'trait', 'object', 'record'];

const SYMBOLS_OF_FILE_SQL = 'SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line, start_col, id';
const IMPORTS_OF_FILE_SQL = 'SELECT * FROM imports WHERE file_id = ? ORDER BY start_line, id';
const REFS_OF_FILE_SQL = 'SELECT * FROM refs WHERE file_id = ? ORDER BY start_line, start_col, id';
const PENDING_REFS_OF_FILE_SQL = 'SELECT * FROM refs WHERE file_id = ? AND resolution IS NULL ORDER BY start_line, start_col, id';
const HAS_PENDING_SQL = 'SELECT 1 FROM refs WHERE file_id = ? AND resolution IS NULL LIMIT 1';
const NO_NAMES = new Set();

const ecosystemOf = (lang) => ECOSYSTEM_BY_LANG[lang] ?? null;

// imports.names is a JSON array [{ imported, alias }], a bare string, or null.
function importNames(imp) {
  if (imp.names === null || imp.names === undefined || imp.names === '') return [];
  if (Array.isArray(imp.names)) return imp.names;
  try {
    const parsed = JSON.parse(imp.names);
    if (Array.isArray(parsed)) return parsed.filter((n) => n && typeof n.imported === 'string');
    if (typeof parsed === 'string') return [{ imported: parsed, alias: parsed }];
  } catch {
    // not JSON: treat the raw text as one imported name
  }
  return [{ imported: imp.names, alias: imp.names }];
}

// Group symbols by name; `byId` keeps the parent chain walkable.
function indexSymbols(rows) {
  const byName = new Map();
  const byId = new Map();
  for (const s of rows) {
    byId.set(s.id, s);
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  }
  return { byName, byId };
}

function kindPreference(ref) {
  if (ref.kind === 'call') return VALUE_KINDS;
  if (ref.kind === 'type' || ref.kind === 'inherit' || ref.kind === 'implement') return TYPE_KINDS;
  return null;
}

// Same-named candidates narrowed by what the occurrence can denote; never empty.
function narrow(rows, ref) {
  const prefs = kindPreference(ref);
  if (!prefs || rows.length === 1) return rows;
  const filtered = rows.filter((r) => prefs.includes(r.kind));
  return filtered.length ? filtered : rows;
}

function exportedFirst(rows) {
  const exported = rows.filter((r) => r.exported === 1);
  return exported.length ? exported : rows;
}

// Exactly one candidate -> '~'; several -> ambiguous (null target).
function uniqueTarget(rows) {
  if (rows.length === 1) return { targetId: rows[0].id, resolution: '~', ambiguous: false };
  return { targetId: null, resolution: '?', ambiguous: rows.length > 1 };
}

const unresolved = () => ({ targetId: null, resolution: '?', ambiguous: false });

// ---------------------------------------------------------------------------
// Environment: one per resolveFile / resolveAll call
// ---------------------------------------------------------------------------

function createEnv(db) {
  const files = listFiles(db);
  const pathIds = new Map(files.map((f) => [f.path, f.id]));
  const fileById = new Map(files.map((f) => [f.id, f]));
  const indexes = new Map();
  const symbolsByFile = new Map();
  const childrenOfSymbol = new Map();
  const globalByName = new Map();
  const root = metaGet(db, 'root');

  const indexFor = (ecosystem) => {
    let index = indexes.get(ecosystem);
    if (!index) {
      const langs = new Set(LANGS_BY_ECOSYSTEM[ecosystem] ?? []);
      index = buildFileIndex(files.filter((f) => langs.has(f.lang)).map((f) => f.path));
      indexes.set(ecosystem, index);
    }
    return index;
  };

  const symbolsOfFile = (fileId) => {
    forgetBeyond(symbolsByFile, 2000);
    let rows = symbolsByFile.get(fileId);
    if (!rows) {
      rows = prepare(db, SYMBOLS_OF_FILE_SQL).all(fileId);
      symbolsByFile.set(fileId, rows);
    }
    return rows;
  };

  const childrenOf = (symbolId) => {
    forgetBeyond(childrenOfSymbol, 5000);
    let rows = childrenOfSymbol.get(symbolId);
    if (!rows) {
      rows = prepare(db, 'SELECT * FROM symbols WHERE parent_id = ? ORDER BY start_line, start_col, id').all(symbolId);
      childrenOfSymbol.set(symbolId, rows);
    }
    return rows;
  };

  // Global candidates for a name, capped so a common name never floods memory;
  // more than MAX_CANDIDATES rows counts as "not unique" without inspection.
  const globalSymbols = (name) => {
    forgetBeyond(globalByName, 5000);
    let rows = globalByName.get(name);
    if (!rows) {
      rows = prepare(
        db,
        'SELECT s.*, f.path AS path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? ORDER BY f.path, s.start_line, s.id LIMIT ?'
      ).all(name, MAX_CANDIDATES + 1);
      globalByName.set(name, rows);
    }
    return rows;
  };

  return { files, fileById, pathIds, indexFor, symbolsOfFile, childrenOf, globalSymbols, root, symbolsByFile };
}

// Everything one file's resolution needs. The pieces are loaded by the caller:
// one query each for resolveFile, bulk queries for a pass over many files.
// `refs` is attached by resolveFileRefs, after the imports are settled.
function buildContext(file, symbols, imports, refs = []) {
  const { byName, byId } = indexSymbols(symbols);
  const aliases = new Map(); // local alias -> { imported, imp }
  for (const imp of imports) for (const n of importNames(imp)) aliases.set(n.alias ?? n.imported, { imported: n.imported, imp });
  return { file, symbols, imports, refs, byName, byId, aliases };
}

function loadContext(db, fileId, { withRefs = true } = {}) {
  const file = prepare(db, 'SELECT * FROM files WHERE id = ?').get(fileId);
  if (!file) throw new Error(`resolveFile: no file with id ${fileId}`);
  const symbols = prepare(db, SYMBOLS_OF_FILE_SQL).all(fileId);
  const imports = prepare(db, IMPORTS_OF_FILE_SQL).all(fileId);
  const refs = withRefs ? prepare(db, REFS_OF_FILE_SQL).all(fileId) : [];
  return buildContext(file, symbols, imports, refs);
}

// `items` in runs of at most `size`, in order.
function* chunksOf(items, size) {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

// (?, ?, ...) for a list of bound values.
const marks = (values) => values.map(() => '?').join(', ');

// Symbols of several files in one query, seeded into the environment cache so
// lookups for imported files hit it too.
function prefetchSymbols(db, env, fileIds) {
  for (const chunk of chunksOf(fileIds, PREFETCH_FILES)) {
    const list = marks(chunk);
    let current = null;
    let rows = null;
    for (const s of prepare(db, `SELECT * FROM symbols WHERE file_id IN (${list}) ORDER BY file_id, start_line, start_col, id`).all(...chunk)) {
      if (s.file_id !== current) {
        current = s.file_id;
        env.symbolsByFile.set(current, (rows = []));
      }
      rows.push(s);
    }
  }
}

// Imports of several files in one query, grouped per file in source order.
function prefetchImports(db, fileIds) {
  const importsByFile = new Map();
  for (const chunk of chunksOf(fileIds, PREFETCH_FILES)) {
    for (const imp of prepare(db, `SELECT * FROM imports WHERE file_id IN (${marks(chunk)}) ORDER BY file_id, start_line, id`).all(...chunk)) {
      const imported = importsByFile.get(imp.file_id);
      if (imported) imported.push(imp);
      else importsByFile.set(imp.file_id, [imp]);
    }
  }
  return importsByFile;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

// Fill imports.resolved_file_id for one file. Returns the aliases whose binding
// changed; refs depending on them are re-evaluated by resolveFileRefs.
function resolveImports(db, ctx, env) {
  const ecosystem = ecosystemOf(ctx.file.lang);
  const changed = new Set();
  const updates = [];
  for (const imp of ctx.imports) {
    let target = null;
    if (ecosystem && ecosystem !== 'none') {
      const res = resolveImport(imp.spec, {
        kind: imp.kind,
        fromPath: ctx.file.path,
        ecosystem,
        index: env.indexFor(ecosystem),
        root: env.root,
      });
      if (res.path !== null) target = env.pathIds.get(res.path) ?? null;
    }
    if (target !== imp.resolved_file_id) {
      updates.push({ id: imp.id, target });
      for (const n of importNames(imp)) changed.add(n.alias ?? n.imported);
      imp.resolved_file_id = target;
    }
  }
  if (updates.length) {
    const update = prepare(db, 'UPDATE imports SET resolved_file_id = ? WHERE id = ?');
    for (const u of updates) update.run(u.target, u.id);
  }
  return changed;
}

// Other files may import this one by a path that did not exist when they were
// processed: re-run only their still-unresolved imports that mention this
// file's stem, which keeps the scan cheap. Their refs bound to an alias whose
// binding changed join the recheck set.
function recheckImportersOf(db, ctx, env, recheck) {
  const base = ctx.file.path.slice(ctx.file.path.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '');
  if (!stem) return;
  const others = prepare(
    db,
    'SELECT DISTINCT file_id FROM imports WHERE resolved_file_id IS NULL AND file_id != ? AND instr(spec, ?) > 0 LIMIT 500'
  ).all(ctx.file.id, stem);
  for (const { file_id: ownerId } of others) {
    const other = loadContext(db, ownerId, { withRefs: false });
    addRecheck(recheck, ownerId, resolveImports(db, other, env));
  }
}

// Caches are bounded: a huge repository must not hold every symbol row.
function forgetBeyond(map, limit) {
  if (map.size > limit) map.clear();
}

// ---------------------------------------------------------------------------
// Recheck set
// ---------------------------------------------------------------------------

// fileId -> names (as ref name or receiver) whose refs must be re-evaluated.
// Refs that are already pending are re-evaluated anyway; the set adds the
// classified ('?' or '=') ones whose inputs may have changed.
function addRecheck(recheck, fileId, names) {
  if (names.size === 0) return;
  let set = recheck.get(fileId);
  if (!set) recheck.set(fileId, (set = new Set()));
  for (const n of names) set.add(n);
}

// Per name, the multiset of (kind, exported, top-level) of its definitions.
// Everything the resolver decides about a name depends on this multiset, never
// on symbol ids, so two versions of a file with equal shapes per name resolve
// every ref of every other file identically.
function nameShapes(rows) {
  const byName = new Map();
  for (const r of rows) {
    const shape = `${r.kind}\u0000${r.exported === null || r.exported === undefined ? '' : r.exported}\u0000${r.top ?? (r.parent_id === null ? 1 : 0)}`;
    const list = byName.get(r.name);
    if (list) list.push(shape);
    else byName.set(r.name, [shape]);
  }
  for (const [name, list] of byName) byName.set(name, list.sort().join('\u0001'));
  return byName;
}

// Names whose definitions in this file differ from the purged version (all of
// them for a file indexed for the first time).
function changedNames(symbols, purgedRows) {
  const before = nameShapes(purgedRows ?? []);
  const after = nameShapes(symbols);
  const changed = new Set();
  for (const [name, shape] of after) if (shape !== before.get(name)) changed.add(name);
  for (const name of before.keys()) if (!after.has(name)) changed.add(name);
  return changed;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

// (b) name bound by an import of this file.
function resolveImported(env, binding, ref) {
  const fileId = binding.imp.resolved_file_id;
  // The import pins the name to its module. Until that module is in the index
  // (external package, excluded path, file indexed later) the name cannot be
  // resolved and must not fall through to a same-named symbol elsewhere: `import
  // { omit } from 'lodash'` is not the project's own `omit`. The ref is made
  // pending again when the module appears (recheckImportersOf / recheckByName).
  if (fileId === null) return unresolved();
  if (binding.imported === '*') return unresolved(); // the namespace itself is not a symbol
  const rows = env.symbolsOfFile(fileId);
  let candidates;
  if (binding.imported === 'default') {
    // The index has no "is default export" flag: a file with exactly one
    // exported top-level definition is the common shape.
    const exported = rows.filter((s) => s.exported === 1 && s.parent_id === null);
    if (exported.length !== 1) return { targetId: null, resolution: '?', ambiguous: exported.length > 1 };
    candidates = exported;
  } else {
    const named = rows.filter((s) => s.name === binding.imported);
    if (named.length === 0) return unresolved();
    candidates = exportedFirst(named);
  }
  const narrowed = narrow(candidates, ref);
  if (narrowed.length === 1) return { targetId: narrowed[0].id, resolution: '=', ambiguous: false };
  return { targetId: null, resolution: '?', ambiguous: true };
}

// Innermost enclosing class-like symbol of the symbol owning a ref.
function enclosingClass(ctx, symbolId) {
  let current = symbolId === null ? null : ctx.byId.get(symbolId) ?? null;
  while (current && current.parent_id !== null) {
    const parent = ctx.byId.get(current.parent_id);
    if (!parent) return null;
    if (CONTAINER_KINDS.has(parent.kind)) return parent;
    current = parent;
  }
  return null;
}

// Refs of a context by start line, in source order, built on first use from
// every ref of the file, which is loaded on demand: a recheck that names a few
// refs must not pay for all of them, and a type lookup walks one symbol's line
// range instead of scanning every ref per call (O(refs²) on files with many
// member calls).
function refsByLine(ctx) {
  let index = ctx.refsByLine;
  if (!index) {
    const all = ctx.refs ?? ctx.loadRefs();
    ctx.refs = all;
    index = new Map();
    for (const r of all) {
      const list = index.get(r.start_line);
      if (list) list.push(r);
      else index.set(r.start_line, [r]);
    }
    ctx.refsByLine = index;
  }
  return index;
}

// Type denoted by a top-level variable of this file: the first type reference or
// constructor call inside its symbol. Locals are not consulted: the engine drops
// non-call refs of plain locals (CONTRACTS.md §6), so their bindings never reach
// `refs` and the file's symbol table has no row for them.
function receiverType(ctx, receiver, ref) {
  const top = (ctx.byName.get(receiver) ?? []).find((s) => s.parent_id === null);
  if (!top) return null;
  const byLine = refsByLine(ctx);
  let type = null;
  let ctor = null;
  for (let line = top.start_line; line <= top.end_line && (!type || !ctor); line++) {
    const list = byLine.get(line);
    if (!list) continue;
    for (const r of list) {
      // The range starts at the symbol's own start column on its first line.
      if (line === top.start_line && r.start_col < top.start_col) continue;
      if (r.id === ref.id) continue;
      if (!type && r.kind === 'type') type = r;
      else if (!ctor && r.kind === 'call' && r.receiver === '' && r.name !== receiver) ctor = r;
      if (type && ctor) break;
    }
  }
  if (type) return type.name;
  return ctor ? ctor.name : null;
}

// A type name -> its symbol: same file first, then an import binding.
function typeSymbol(db, ctx, env, name) {
  const local = narrow(ctx.byName.get(name) ?? [], { kind: 'type' });
  if (local.length >= 1) return local[0];
  const binding = ctx.aliases.get(name);
  if (binding && binding.imp.resolved_file_id !== null && binding.imported !== '*') {
    const rows = env.symbolsOfFile(binding.imp.resolved_file_id);
    const named = binding.imported === 'default'
      ? rows.filter((s) => s.exported === 1 && s.parent_id === null)
      : rows.filter((s) => s.name === binding.imported);
    const picked = exportedFirst(named);
    return picked.length >= 1 ? picked[0] : null;
  }
  return null;
}

// Member named `name` of `owner` (a class-like symbol), unique or null.
function memberOf(env, owner, name) {
  const members = env.childrenOf(owner.id).filter((s) => s.name === name);
  return members.length === 1 ? members[0] : null;
}

// (c) member access.
function resolveMember(db, ctx, env, ref) {
  const { receiver, name } = ref;
  if (receiver === 'this' || receiver === 'super') {
    const cls = enclosingClass(ctx, ref.symbol_id);
    if (cls) {
      const member = memberOf(env, cls, name);
      if (member) return { targetId: member.id, resolution: '=', ambiguous: false };
    }
    if (receiver === 'super') return unresolved(); // parent class is not modelled
    // `this.x` not declared on the enclosing class may be inherited: fall through to the unique-name rule.
  }
  // `Klass.member()` with Klass declared in this file (static / nested member). The
  // class is known, so a member it does not have is no edge at all, not a
  // same-named symbol elsewhere (`Shape.nope()` is never the global function `nope`).
  const localType = (ctx.byName.get(receiver) ?? []).find((s) => CONTAINER_KINDS.has(s.kind));
  if (localType) {
    const member = memberOf(env, localType, name);
    return member ? { targetId: member.id, resolution: '=', ambiguous: false } : unresolved();
  }
  const binding = ctx.aliases.get(receiver);
  if (binding && binding.imp.resolved_file_id !== null) {
    const rows = env.symbolsOfFile(binding.imp.resolved_file_id);
    let scope = rows;
    let ownerKnown = true;
    if (binding.imported !== '*') {
      const owner = binding.imported === 'default'
        ? exportedFirst(rows.filter((s) => s.exported === 1 && s.parent_id === null))[0]
        : exportedFirst(rows.filter((s) => s.name === binding.imported))[0];
      if (owner) scope = env.childrenOf(owner.id);
      else ownerKnown = false; // default import of a file with zero or several top-level exports
    }
    const named = exportedFirst(scope.filter((s) => s.name === name));
    if (named.length === 1) return { targetId: named[0].id, resolution: '=', ambiguous: false };
    if (named.length > 1) return { targetId: null, resolution: '?', ambiguous: true };
    // An imported class or namespace names its module: a member absent there does not exist.
    if (ownerKnown) return unresolved();
  }
  // Variable of this file with a visible type: the edge is by name only ('~'); a
  // known type without the member is, as above, no edge.
  const typeName = receiverType(ctx, receiver, ref);
  if (typeName) {
    const owner = typeSymbol(db, ctx, env, typeName);
    if (owner) {
      const member = memberOf(env, owner, name);
      return member ? { targetId: member.id, resolution: '~', ambiguous: false } : unresolved();
    }
  }
  const global = env.globalSymbols(name);
  if (global.length > MAX_CANDIDATES) return { targetId: null, resolution: '?', ambiguous: true };
  const narrowed = narrow(global, ref);
  if (narrowed.length === 1) return { targetId: narrowed[0].id, resolution: '~', ambiguous: false };
  return { targetId: null, resolution: '?', ambiguous: narrowed.length > 1 };
}

// (d) bare name.
function resolveBare(env, ctx, ref) {
  const local = narrow(ctx.byName.get(ref.name) ?? [], ref);
  if (local.length >= 1) return uniqueTarget(local);
  const global = env.globalSymbols(ref.name);
  if (global.length > MAX_CANDIDATES) return { targetId: null, resolution: '?', ambiguous: true };
  return uniqueTarget(narrow(global, ref));
}

function resolveOne(db, ctx, env, ref) {
  if (ref.scope === 'local') {
    // (a) decided by locals.scm: a plain local shadows the name, never fall back
    if (ref.local_def_id !== null) return { targetId: ref.local_def_id, resolution: '=', ambiguous: false };
    return unresolved();
  }
  if (ref.receiver === '' || ref.receiver === null) {
    const binding = ctx.aliases.get(ref.name);
    if (binding) return resolveImported(env, binding, ref);
    return resolveBare(env, ctx, ref);
  }
  return resolveMember(db, ctx, env, ref);
}

function resolveRefs(db, ctx, env, refs) {
  const entries = [];
  const counts = { resolved: 0, ambiguous: 0, unresolved: 0 };
  for (const ref of refs) {
    const out = resolveOne(db, ctx, env, ref);
    const targetId = out.targetId ?? null;
    // Same outcome as stored: nothing to write (a re-evaluated '?' stays '?').
    if (targetId !== ref.target_id || out.resolution !== ref.resolution) {
      entries.push({ refId: ref.id, targetId, resolution: out.resolution });
    }
    if (out.targetId) counts.resolved++;
    else if (out.ambiguous) counts.ambiguous++;
    else counts.unresolved++;
  }
  if (entries.length) setRefResolution(db, entries);
  return counts;
}

// Settle the file's imports, then resolve the refs that need it: the pending
// ones, those bound to an alias whose binding changed, and those named in
// `recheck` (see addRecheck) whatever their stored mark: a definition whose id
// survived a re-index (repo keeps ids) leaves '=' refs elsewhere in place, and
// only a re-evaluation notices that it lost its export. Only those refs are
// read: a hub's importers each carry hundreds of refs, of which a handful bind
// to the alias; receiverType loads the whole file when it needs it.
function resolveFileRefs(db, env, ctx, fileId, recheck = NO_NAMES, aliases = NO_NAMES) {
  const changedAliases = resolveImports(db, ctx, env);
  const named = new Set([...recheck, ...aliases, ...changedAliases]);
  let pending;
  if (named.size === 0) {
    pending = prepare(db, PENDING_REFS_OF_FILE_SQL).all(fileId);
  } else {
    const byId = new Map();
    for (const chunk of chunksOf([...named], IN_CHUNK)) {
      const list = marks(chunk);
      for (const r of prepare(
        db,
        `SELECT * FROM refs WHERE file_id = ? AND (resolution IS NULL OR name IN (${list}) OR receiver IN (${list})) ORDER BY start_line, start_col, id`
      ).all(fileId, ...chunk, ...chunk)) {
        byId.set(r.id, r);
      }
    }
    pending = [...byId.values()].filter((r) => r.resolution === null || named.has(r.name) || named.has(r.receiver));
  }
  const context = { ...ctx, refs: null, loadRefs: () => prepare(db, REFS_OF_FILE_SQL).all(fileId) };
  return resolveRefs(db, context, env, pending);
}

// Resolve the pending refs of `fileId` plus, unless `only`, every other file
// that has some (targets lost when this file was re-indexed) or that is in the
// recheck set. `aliases` are the file's own import bindings that changed.
function resolvePending(db, env, fileId, only, recheck = new Map(), aliases = NO_NAMES) {
  const counts = { resolved: 0, ambiguous: 0, unresolved: 0 };
  let fileIds = [fileId];
  const pending = new Set();
  if (prepare(db, HAS_PENDING_SQL).get(fileId)) pending.add(fileId);
  if (!only) {
    // The store records which files' refs it made pending (repo.logPendingFiles);
    // no scan over every ref for `resolution IS NULL` is needed.
    for (const id of pendingFiles(db)) pending.add(id);
    fileIds = [...new Set([...pending, ...recheck.keys()])];
  }
  for (const chunk of chunksOf(fileIds, PREFETCH_FILES)) {
    const importsByFile = prefetchImports(db, chunk);
    prefetchSymbols(db, env, chunk);
    for (const id of chunk) {
      const names = recheck.get(id) ?? NO_NAMES;
      if (!pending.has(id) && names.size === 0) continue;
      // A file recorded as pending and deleted since (its own refs pointed at
      // its symbols) has nothing left to resolve.
      const file = env.fileById.get(id);
      if (!file) continue;
      const ctx = buildContext(file, env.symbolsOfFile(id), importsByFile.get(id) ?? []);
      const c = resolveFileRefs(db, env, ctx, id, names, id === fileId ? aliases : NO_NAMES);
      counts.resolved += c.resolved;
      counts.ambiguous += c.ambiguous;
      counts.unresolved += c.unresolved;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve one file's imports and refs, then every ref still pending anywhere
 * (refs elsewhere whose target lived in this file were reset by the store),
 * and re-evaluate the classified refs elsewhere whose outcome may have changed
 * with this file's new definitions or import bindings.
 *
 * @param {DatabaseSync} db
 * @param {number} fileId
 * @returns {{ resolved: number, ambiguous: number, unresolved: number }}
 */
export function resolveFile(db, fileId) {
  return inTransaction(db, () => {
    const env = createEnv(db);
    const purged = takePurgedSymbols(db);
    const recheck = new Map();
    const ctx = loadContext(db, fileId, { withRefs: false });
    const aliases = resolveImports(db, ctx, env);
    recheckImportersOf(db, ctx, env, recheck);
    recheckByName(db, ctx, recheck, purged);
    recheckImportersResolved(db, ctx, recheck, purged);
    const counts = resolvePending(db, env, fileId, false, recheck, aliases);
    clearPendingFiles(db); // only once the pass succeeded: a failure must find them again
    return counts;
  });
}

// Refs elsewhere that name a definition this file gained, lost or re-shaped
// may resolve differently now. Only those names: for every other name this
// file's contribution to the decision is exactly what it was.
// The files holding such refs join the recheck set under that name, whatever
// the ref's mark: a '=' ref to a definition that kept its id but lost its
// export must be looked at again too. A file removed earlier in the same sync
// (repo.deleteFile logged its definitions) counts as having lost every name
// it defined.
function recheckByName(db, ctx, recheck, purged) {
  const changed = changedNames(ctx.symbols, purged.get(ctx.file.id));
  for (const [fileId, rows] of purged) {
    if (fileId === ctx.file.id) continue;
    for (const r of rows) changed.add(r.name);
  }
  if (changed.size === 0) return;
  for (const chunk of chunksOf([...changed], 32)) {
    const rows = prepare(
      db,
      `SELECT DISTINCT file_id, name FROM refs WHERE file_id != ? AND name IN (${marks(chunk)})`
    ).all(ctx.file.id, ...chunk);
    for (const { file_id: ownerId, name } of rows) addRecheck(recheck, ownerId, new Set([name]));
  }
}

// Importers of this file: their refs bound to an alias may resolve differently
// now. Refs named after a changed definition are covered by recheckByName for
// every file; what only this file knows is the alias:
//   - a named import: the alias, when the imported name changed;
//   - a default import: the alias only when "the single exported top-level
//     definition" moved (that is what it binds to), so a file that merely
//     changed a function does not drag its hundreds of importers in;
//   - a namespace import: nothing (the namespace is not a symbol).
function recheckImportersResolved(db, ctx, recheck, purged) {
  const rows = prepare(db, 'SELECT file_id, names FROM imports WHERE resolved_file_id = ?').all(ctx.file.id);
  if (rows.length === 0) return;
  const old = purged.get(ctx.file.id) ?? null;
  const changed = changedNames(ctx.symbols, old);
  if (changed.size === 0) return;
  const defaultMoved = old === null || exportedTopLevel(old) !== exportedTopLevel(ctx.symbols);
  for (const row of rows) {
    const names = new Set();
    for (const n of importNames(row)) {
      if (n.imported === 'default' ? defaultMoved : n.imported !== '*' && changed.has(n.imported)) names.add(n.alias ?? n.imported);
    }
    addRecheck(recheck, row.file_id, names);
  }
}

// The definitions a default import can bind to, in a comparable form.
function exportedTopLevel(rows) {
  return rows
    .filter((r) => r.exported === 1 && (r.top !== undefined ? r.top === 1 : r.parent_id === null))
    .map((r) => `${r.kind}\u0000${r.name}`)
    .sort()
    .join('\u0001');
}

/**
 * Resolve imports for every file, then every pending ref. Bulk queries replace
 * the per-file ones of resolveFile: the import pass needs nothing but the
 * imports (grouped by file in memory), the ref pass each file's symbols once.
 *
 * @param {DatabaseSync} db
 * @returns {{ resolved: number, ambiguous: number, unresolved: number }}
 */
export function resolveAll(db) {
  return inTransaction(db, () => {
    const env = createEnv(db);
    const counts = { resolved: 0, ambiguous: 0, unresolved: 0 };
    const importsByFile = new Map();
    for (const imp of prepare(db, 'SELECT * FROM imports ORDER BY file_id, start_line, id').all()) {
      const list = importsByFile.get(imp.file_id);
      if (list) list.push(imp);
      else importsByFile.set(imp.file_id, [imp]);
    }
    // Import bindings that moved in this pass: their refs are re-evaluated
    // whatever their stored resolution (a former '=' may have moved).
    const aliasesByFile = new Map();
    const noImports = [];
    for (const file of env.files) {
      const ctx = buildContext(file, [], importsByFile.get(file.id) ?? noImports);
      const changed = resolveImports(db, ctx, env);
      if (changed.size > 0) aliasesByFile.set(file.id, changed);
    }
    const pendingIds = prepare(db, 'SELECT DISTINCT file_id FROM refs WHERE resolution IS NULL').all().map((r) => r.file_id);
    const toVisit = [...new Set([...pendingIds, ...aliasesByFile.keys()])];
    for (const chunk of chunksOf(toVisit, PREFETCH_FILES)) {
      prefetchSymbols(db, env, chunk);
      for (const id of chunk) {
        const file = env.fileById.get(id);
        if (!file) continue; // refs only reference files that exist (FK)
        const ctx = buildContext(file, env.symbolsOfFile(id), importsByFile.get(id) ?? noImports);
        const c = resolveFileRefs(db, env, ctx, id, NO_NAMES, aliasesByFile.get(id) ?? NO_NAMES);
        counts.resolved += c.resolved;
        counts.ambiguous += c.ambiguous;
        counts.unresolved += c.unresolved;
      }
    }
    clearPurgedSymbols(db);
    clearPendingFiles(db);
    return counts;
  });
}
