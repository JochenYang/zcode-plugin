// Generic extraction engine: one pass per file, driven by a LanguageSpec.
// A pack declares node types -> rules; this module knows nothing about any
// language. See CONTRACTS.md §5–§6 for the frozen shapes.
//
// Discovery runs inside the wasm runtime: the spec's node types are compiled
// into one tree-sitter Query and `captures()` returns only the nodes a rule can
// match, so JS never wraps the ~90% of nodes nobody asked for. Packs that need
// every node (`hooks.onNode`) fall back to a full walk.
import crypto from 'node:crypto';
import { parserFor, initTreeSitter, queryTextFor, loadLanguage } from '../../grammars/loader.mjs';
import { loadSpecs, specForPath, specById } from '../languages/registry.mjs';

const MAX_SIGNATURE = 120;
const MAX_DOC = 240;
const MAX_NAME = 200;
// Children of these kinds are reported as `method` instead of their declared kind.
const CONTAINER_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'enum', 'object', 'record', 'namespace', 'module', 'component']);
// Wrappers a docstring may hide behind (Python: block > expression_statement > string).
const DOC_WRAPPERS = /^(block|statements?|_simple_statement|expression_statement|sequence_expression|body)$/;

export async function initEngine({ strict = false } = {}) {
  await initTreeSitter();
  const specs = await loadSpecs({ strict });
  // Strict mode (the contract tests) compiles every pack's query here, so a
  // pattern the compiler rejects (a node type nested inside a pattern, a syntax
  // error) fails the pack at load time instead of throwing for every file.
  // Otherwise queries stay lazy: compiled on the first file that uses the pack.
  if (strict) await compileSpecQueries(specs);
}

/** Compile the discovery query of every grammar-bearing spec; rejects on the first bad pattern. */
export async function compileSpecQueries(specs) {
  for (const spec of specs) {
    if (spec.grammar) await specQuery(spec);
  }
}

export { loadSpecs, specForPath, loadLanguage };
export const listSpecs = loadSpecs;

export function hashSource(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------- helpers ----------

function fieldPath(node, p) {
  let n = node;
  for (const part of String(p).split('.')) {
    n = n && n.childForFieldName ? n.childForFieldName(part) : null;
    if (!n) return null;
  }
  return n;
}

function collapse(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// 1-based inclusive lines, 0-based columns; tree-sitter end positions are exclusive,
// so a node ending at column 0 ends on the previous line.
function range(node) {
  const s = node.startPosition;
  const e = node.endPosition;
  return { startLine: s.row + 1, startCol: s.column, endLine: e.column > 0 ? e.row + 1 : e.row, endCol: e.column };
}

const posKey = (line, col) => line * 1e6 + col;

function stripComment(text) {
  return String(text ?? '')
    .replace(/\/\*\*?|\*\//g, ' ')
    .replace(/^\s*(\/\/|#|--|;;;|%+)/gm, '')
    .replace(/^\s*\*\s?/gm, '')
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function stripString(text) {
  return String(text ?? '').replace(/^(?:[rbfu]{0,2})("""|'''|"|')/i, '').replace(/("""|'''|"|')$/, '');
}

// `a.b.c` -> receiver `a.b`, name `c`; bare `c` -> receiver ''.
function splitCallName(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(?:([\s\S]*?)\s*(?:\.|::|->)\s*)?([A-Za-z_$][\w$]*)$/.exec(text);
  if (!m) return { receiver: '', name: text.slice(0, MAX_NAME) };
  return { receiver: (m[1] ?? '').trim(), name: m[2] };
}

// First string node under `body`, descending only through statement wrappers.
function firstStringDescendant(body) {
  const stack = [body];
  while (stack.length) {
    const n = stack.shift();
    if (/string/.test(n.type)) return n;
    if (n === body || DOC_WRAPPERS.test(n.type)) for (const c of n.namedChildren) stack.push(c);
  }
  return null;
}

function docFor(node, rule, ctx) {
  const how = rule.doc ?? { from: 'prevSiblingComment' };
  if (how.from === 'none') return null;
  if (how.from === 'bodyFirstString') {
    const body = fieldPath(node, 'body');
    const first = body ? firstStringDescendant(body) : null;
    if (first && first.startPosition.row > body.startPosition.row + 1) return null;
    const text = first ? stripString(first.text) : null;
    return text ? collapse(text, MAX_DOC) : null;
  }
  if (typeof how.from === 'function') {
    const text = how.from(node, ctx);
    return text ? collapse(text, MAX_DOC) : null;
  }
  // `export function f() {}` stores the comment next to the export wrapper, not the declaration.
  const transparent = ctx.spec.transparentAncestors ?? ['export_statement'];
  let owner = node;
  while (owner.parent && transparent.includes(owner.parent.type)) owner = owner.parent;
  let prev = owner.previousNamedSibling ?? owner.previousSibling;
  if (prev && !ctx.spec.commentTypes.includes(prev.type)) prev = null;
  if (!prev || owner.startPosition.row - prev.endPosition.row > 2) return null;
  const text = stripComment(prev.text);
  return text ? collapse(text, MAX_DOC) : null;
}

function signatureFor(node, rule, ctx) {
  if (!rule.signature) return null;
  if (typeof rule.signature === 'function') return collapse(rule.signature(node, ctx), MAX_SIGNATURE) || null;
  const fields = Array.isArray(rule.signature) ? rule.signature : [rule.signature];
  const parts = [];
  for (const f of fields) {
    const n = fieldPath(node, f);
    if (n?.text) parts.push(n.text);
  }
  if (!parts.length) return null;
  const joined = rule.prefix ? `${rule.prefix} ${parts.join(' ')}` : parts.join(' ');
  return collapse(joined, MAX_SIGNATURE).replace(/\)\s+:/g, '):');
}

const resolveKind = (rule, node, ctx) => (typeof rule.kind === 'function' ? rule.kind(node, ctx) : rule.kind);

// `rule.name` is a field path or a function returning a node (or the name text).
function nameFor(node, rule, ctx) {
  let target;
  if (typeof rule.name === 'function') target = rule.name(node, ctx);
  else target = rule.name === undefined ? node : fieldPath(node, rule.name);
  if (typeof target === 'string') return target.trim().slice(0, MAX_NAME) || null;
  if (!target || !target.isNamed) return null;
  return target.text.trim().slice(0, MAX_NAME) || null;
}

// ---------- locals (implemented by the resolver lane; the stub returns []) ----------

async function mergeLocals(spec, tree, out, lineOffset, skipPositions = new Set()) {
  if (spec.scope !== 'locals') return;
  const queryText = queryTextFor(spec.grammar, 'locals');
  if (!queryText) return;
  const { resolveLocals } = await import('../resolve/locals.mjs');
  const locals = resolveLocals(tree, queryText, out.symbols) ?? [];
  if (!locals.length) return;
  const byPosition = new Map();
  // A call ref and a plain identifier ref can share a position (Ruby `obj.m` callee); apply to all of them.
  for (const r of out.refs) {
    const key = `${r.startLine - lineOffset}:${r.startCol}:${r.name}`;
    const list = byPosition.get(key);
    if (list) list.push(r);
    else byPosition.set(key, [r]);
  }
  for (const item of locals) {
    // Parameter names and other pack-declared exclusions are not references, whichever pass saw them.
    if (skipPositions.has(`${item.startLine ?? 1}:${item.startCol ?? 0}`)) continue;
    const existing = byPosition.get(`${item.startLine ?? 1}:${item.startCol ?? 0}:${item.name}`);
    if (existing) {
      for (const ref of existing) {
        ref.scope = 'local';
        ref.localDef = item.localDef ?? null;
      }
    } else {
      out.refs.push({
        name: item.name,
        receiver: '',
        kind: 'ref',
        startLine: (item.startLine ?? 1) + lineOffset,
        startCol: item.startCol ?? 0,
        endLine: (item.endLine ?? item.startLine ?? 1) + lineOffset,
        scope: 'local',
        localDef: item.localDef ?? null,
      });
    }
  }
}

// ---------- recovery for grammar gaps ----------
//
// Some constructs are not in the shipped grammar (TS 5 `export type *`,
// `importOriginal<typeof import('x')>()`); tree-sitter then folds following statements into an
// ERROR node and they vanish from the index. Packs may declare line-anchored regexes that re-cover
// top-level definitions inside those ranges. Recovered symbols carry startLine only and no refs.
function recoverFromErrors(spec, tree, out, lineOffset, block) {
  const ranges = [];
  const visit = (node, depth) => {
    if (node.type === 'ERROR') {
      ranges.push(node);
      return;
    }
    if (depth < 2) for (const c of node.namedChildren) visit(c, depth + 1);
  };
  visit(tree.rootNode, 0);
  if (!ranges.length) return;
  const seen = new Set(out.symbols.map((s) => `${s.startLine}:${s.name}`));
  const re = spec.recovery.map((rule) => ({ rule, rx: new RegExp(rule.regex, 'gm') }));
  for (const node of ranges) {
    const text = node.text;
    if (text.length > spec.maxParseBytes) continue;
    const baseLine = node.startPosition.row; // 0-based
    for (const { rule, rx } of re) {
      rx.lastIndex = 0;
      for (let m; (m = rx.exec(text)); ) {
        const name = m[1];
        if (!name) continue;
        const line = baseLine + countNewlines(text, m.index) + 1 + lineOffset;
        const key = `${line}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.symbols.push({
          kind: rule.kind,
          name,
          qual: name,
          startLine: line,
          startCol: 0,
          endLine: line,
          signature: null,
          doc: null,
          exported: /^\s*export\b/.test(m[0]) ? true : null,
          parent: null,
          block,
          recovered: true,
        });
      }
    }
  }
}

function countNewlines(text, upto) {
  let n = 0;
  for (let i = 0; i < upto && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// ---------- containment ----------

// Innermost enclosing definition for every ref, plus `parent`/`qual` for every symbol.
function attachContainment(out) {
  const order = out.symbols
    .map((s, i) => ({ i, s, start: posKey(s.startLine, s.startCol), end: posKey(s.endLine, s.endCol ?? 0) }))
    .sort((a, b) => a.start - b.start || b.end - a.start);
  const stack = [];
  for (const item of order) {
    while (stack.length && stack[stack.length - 1].end < item.start) stack.pop();
    const top = stack[stack.length - 1];
    if (top && top.start <= item.start && top.end >= item.end) {
      item.s.parent = top.i;
      item.s.qual = `${top.s.qual}.${item.s.name}`;
      if (CONTAINER_KINDS.has(top.s.kind) && (item.s.kind === 'function' || item.s.kind === 'method')) item.s.kind = 'method';
    } else {
      item.s.parent = null;
      // Pack-supplied qualification for out-of-line members (Go/Rust methods) survives; nested
      // members of an embedded block that lost their parent fall back to the bare name.
      item.s.qual = item.s.qualHint || item.s.name;
    }
    stack.push(item);
  }
  const refOrder = out.refs.map((r, i) => ({ i, p: posKey(r.startLine, r.startCol) })).sort((a, b) => a.p - b.p);
  const open = [];
  let si = 0;
  for (const { i, p } of refOrder) {
    while (si < order.length && order[si].start <= p) open.push(order[si++]);
    for (let k = open.length - 1; k >= 0; k--) if (open[k].end < p) open.splice(k, 1);
    let inner = null;
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].end >= p) {
        inner = open[k];
        break;
      }
    }
    out.refs[i].symbol = inner ? inner.i : null;
  }
  return out;
}

// ---------- per-spec query ----------

const queryCache = new Map(); // `${grammar}/${spec.id}` -> { Query, language }
async function specQuery(spec) {
  const key = `${spec.grammar}/${spec.id}`;
  let entry = queryCache.get(key);
  if (!entry) {
    const language = await loadLanguage(spec.grammar);
    const { Query } = await initTreeSitter();
    const patterns = [
      ...Object.keys(spec.definitions).map((t) => `(${t}) @def`),
      ...spec.calls.map((c) => `(${c.node}) @call`),
      ...spec.imports.map((imp) => `(${imp.node}) @imp`),
      // A skip pattern names its own capture (`... pattern: (identifier) @skip`) so the excluded node is the
      // identifier inside the construct, not the construct itself; bare patterns capture their root.
      ...(spec.skipPatterns ?? []).map((p) => (String(p).includes('@skip') ? String(p) : `(${p}) @skip`)),
      ...spec.references.map((r) => `(${r.node}) @ref`),
    ];
    const dropped = [];
    let query = null;
    // Node types from another grammar revision are rejected by the compiler; drop just those patterns.
    for (let remaining = patterns; remaining.length; ) {
      try {
        query = new Query(language, remaining.join('\n'));
        break;
      } catch (err) {
        const word = err?.info?.word;
        const next = remaining.filter((p) => !word || !p.startsWith(`(${word})`));
        if (next.length === remaining.length) throw err;
        dropped.push(word);
        remaining = next;
      }
    }
    entry = { language, query, dropped };
    queryCache.set(key, entry);
    if (dropped.length) process.stderr.write(`codegraph: "${spec.id}" lists node types absent from grammar "${spec.grammar}": ${dropped.join(', ')}\n`);
  }
  return entry;
}

// ---------- walk ----------

function emptyResult(relPath, spec, text) {
  return {
    path: relPath,
    lang: spec.id,
    hash: hashSource(text),
    size: Buffer.byteLength(text, 'utf8'),
    parseOk: true,
    errorNodes: 0,
    symbols: [],
    refs: [],
    imports: [],
    blocks: [],
  };
}

function countErrors(root) {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'ERROR' || node.isMissing) n++;
    for (const c of node.children) stack.push(c);
  }
  return n;
}

function makeContext(spec, text, tree, out, lineOffset, block, consumed) {
  let lines = null;
  // Whole-construct consumptions (import statements): descendants count as consumed too.
  const containerRanges = [];
  const ctx = {
    spec,
    source: text,
    tree,
    lineOffset,
    block,
    text: (n) => (n ? n.text : ''),
    field: fieldPath,
    get lines() {
      return (lines ??= text.split('\n'));
    },
    isConsumed: (node) =>
      consumed.has(node.id) ||
      containerRanges.some(([s, e]) => node.startIndex >= s && node.endIndex <= e),
    consume: (node) => consumed.add(node.id),
    consumeContainer: (node) => containerRanges.push([node.startIndex, node.endIndex]),
    // True when only transparent wrappers (export_statement, decorators) sit between the node and the file root.
    // Node wrappers are recreated on every access, so compare ids, not object identity.
    isTopLevel: (node) => {
      if (!tree) return true;
      const transparent = spec.transparentAncestors ?? ['export_statement'];
      const rootId = tree.rootNode.id;
      let n = node;
      for (;;) {
        const parent = n.parent;
        if (!parent) return true;
        if (parent.id === rootId) return true;
        if (!transparent.includes(parent.type)) return false;
        n = parent;
      }
    },
    addSymbol: (sym) => {
      const s = { block, parent: null, qual: null, exported: null, signature: null, doc: null, ...sym };
      s.startLine = (s.startLine ?? 1) + lineOffset;
      s.endLine = (s.endLine ?? s.startLine ?? 1) + lineOffset;
      out.symbols.push(s);
      return s;
    },
    addRef: (ref) => {
      const r = { receiver: '', kind: 'ref', symbol: null, scope: null, localDef: null, ...ref };
      r.startLine = (r.startLine ?? 1) + lineOffset;
      r.endLine = (r.endLine ?? r.startLine ?? 1) + lineOffset;
      out.refs.push(r);
      return r;
    },
    addImport: (imp) => {
      const i = { names: null, kind: 'import', block, ...imp };
      i.startLine = (i.startLine ?? 1) + lineOffset;
      out.imports.push(i);
      return i;
    },
  };
  return ctx;
}

// Phase 1 handlers: definitions, calls, imports. `refs` are phase 2 (after everything is consumed).
function handleDeclarative(node, spec, ctx, out, lineOffset, block) {
  const rule = spec.definitions[node.type];
  if (rule && (!rule.when || rule.when(node, ctx))) {
    const name = nameFor(node, rule, ctx);
    if (name) {
      const r = range(node);
      const sym = {
        kind: resolveKind(rule, node, ctx),
        name,
        qual: null,
        qualHint: typeof rule.qual === 'function' ? rule.qual(node, ctx) || null : rule.qual ?? null,
        startLine: r.startLine + lineOffset,
        startCol: r.startCol,
        endLine: r.endLine + lineOffset,
        endCol: r.endCol,
        signature: signatureFor(node, rule, ctx),
        doc: docFor(node, rule, ctx),
        exported: null,
        parent: null,
        block,
      };
      if (spec.isExported) {
        const exported = spec.isExported(node, sym, ctx);
        sym.exported = typeof exported === 'boolean' ? exported : null;
      }
      // Signature fields stay unconsumed so type references inside them still become refs;
      // packs exclude the identifiers they do not want with `when` on the reference rule.
      const nameNode = typeof rule.name === 'function' ? null : rule.name === undefined ? node : fieldPath(node, rule.name);
      if (nameNode) ctx.consume(nameNode);
      out.symbols.push(sym);
    }
    return true;
  }
  for (const c of spec.calls) {
    if (c.node !== node.type || (c.when && !c.when(node, ctx))) continue;
    let fnNode;
    if (typeof c.fn === 'function') {
      const res = c.fn(node, ctx);
      const r = range(node);
      if (typeof res === 'string') {
        const { receiver, name } = splitCallName(res);
        out.refs.push({ name, receiver, kind: c.kind ?? 'call', startLine: r.startLine + lineOffset, startCol: r.startCol, endLine: r.endLine + lineOffset, symbol: null, scope: null, localDef: null });
        ctx.consume(node);
        return true;
      }
      if (res && typeof res === 'object' && 'name' in res) {
        out.refs.push({ name: String(res.name).slice(0, MAX_NAME), receiver: String(res.receiver ?? ''), kind: c.kind ?? 'call', startLine: r.startLine + lineOffset, startCol: r.startCol, endLine: r.endLine + lineOffset, symbol: null, scope: null, localDef: null });
        ctx.consume(node);
        // The callee identifier inside the call node must not surface again as a plain reference
        // (Ruby `obj.m` would otherwise count every call twice: once as call, once as ref).
        // Packs name it with `node`; otherwise a leaf method/function field is the callee. A field
        // with children (PHP's qualified_name) is left alone so packs can post-process the chain.
        const fallback = node.childForFieldName('method') ?? node.childForFieldName('function');
        ctx.consume(res.node ?? (fallback && fallback.childCount === 0 ? fallback : node));
        return true;
      }
      fnNode = res;
    } else {
      fnNode = c.fn ? fieldPath(node, c.fn) : node;
    }
    if (!fnNode) continue;
    const { receiver, name } = splitCallName(fnNode.text);
    const r = range(fnNode);
    out.refs.push({ name, receiver, kind: c.kind ?? 'call', startLine: r.startLine + lineOffset, startCol: r.startCol, endLine: r.endLine + lineOffset, symbol: null, scope: null, localDef: null });
    ctx.consume(fnNode);
    return true;
  }
  for (const imp of spec.imports) {
    if (imp.node !== node.type || (imp.when && !imp.when(node, ctx))) continue;
    const specText = imp.spec ? imp.spec(node, ctx) : null;
    if (typeof specText !== 'string' || !specText) continue;
    const names = imp.names ? imp.names(node, ctx) : null;
    out.imports.push({ spec: specText, names: Array.isArray(names) && names.length ? names : null, kind: imp.kind ?? 'import', startLine: node.startPosition.row + 1 + lineOffset, block });
    ctx.consumeContainer(node);
    return true;
  }
  return false;
}

export async function extractFile({ path: relPath, source, spec, startLine = 1, block = null }) {
  const text = typeof source === 'string' ? source : Buffer.from(source).toString('utf8');
  const lineOffset = startLine - 1;
  const out = emptyResult(relPath, spec, text);
  const consumed = new Set(); // node ids already accounted for by definitions/calls/imports

  // Embedded script blocks (Vue/Svelte/Astro): parse each block with its target pack.
  if (spec.embeddings.length) {
    for (const emb of spec.embeddings) {
      const target = specById(emb.lang);
      if (!target) throw new Error(`language pack "${spec.id}" embeds unknown language "${emb.lang}"`);
      if (target.id === spec.id) throw new Error(`language pack "${spec.id}" embeds itself`);
      for (const blk of emb.extract(text, { source: text, spec })) {
        const idx = out.blocks.push({ lang: emb.lang, startLine: blk.startLine + lineOffset, endLine: (blk.endLine ?? blk.startLine) + lineOffset }) - 1;
        const inner = await extractFile({ path: relPath, source: blk.text, spec: target, startLine: blk.startLine + lineOffset, block: idx });
        out.parseOk = out.parseOk && inner.parseOk;
        out.errorNodes += inner.errorNodes;
        out.symbols.push(...inner.symbols);
        out.refs.push(...inner.refs);
        out.imports.push(...inner.imports);
      }
    }
    if (!spec.grammar) {
      // Script-only packs have no tree; postProcess still runs so packs can clean up block artefacts.
      spec.hooks.postProcess?.(out, makeContext(spec, text, null, out, lineOffset, block, new Set()));
      out.symbols = out.symbols.filter((s) => typeof s.name === 'string' && s.name.length > 0);
      out.refs = out.refs.filter((r) => typeof r.name === 'string' && r.name.length > 0);
      out.imports = out.imports.filter((i) => typeof i.spec === 'string' && i.spec.length > 0);
      return attachContainment(out);
    }
  }

  if (spec.support === 'file-level' || !spec.grammar) return out;
  if (!text.trim()) return out;
  if (Buffer.byteLength(text, 'utf8') > spec.maxParseBytes) {
    out.parseOk = false;
    return out;
  }

  const parser = await parserFor(spec.grammar);
  const tree = parser.parse(text);
  try {
    // Embedded blocks already added their errors; the outer grammar adds its own instead of replacing them.
    out.errorNodes += tree.rootNode.hasError ? countErrors(tree.rootNode) : 0;
    out.parseOk = out.parseOk && out.errorNodes === 0;
    const ctx = makeContext(spec, text, tree, out, lineOffset, block, consumed);
    const skipPositions = new Set(); // `${line}:${col}` (file-relative) of nodes excluded by skipPatterns
    const skip = (node) => {
      consumed.add(node.id); // cheaper than a `when` reading parent
      skipPositions.add(`${node.startPosition.row + 1}:${node.startPosition.column}`);
    };

    if (spec.hooks.onNode) {
      // Packs that need every node get the full walk (definitions/calls/imports first, then refs).
      if (spec.skipPatterns?.length) {
        for (const { name: cap, node } of (await specQuery(spec)).query?.captures(tree.rootNode) ?? []) {
          if (cap === 'skip') skip(node);
        }
      }
      const nodes = [];
      const stack = [tree.rootNode];
      while (stack.length) {
        const node = stack.pop();
        nodes.push(node);
        for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]);
      }
      for (const node of nodes) {
        if (!handleDeclarative(node, spec, ctx, out, lineOffset, block)) spec.hooks.onNode(node, ctx, out);
      }
      for (const node of nodes) for (const refRule of spec.references) {
        if (refRule.node === node.type && (!refRule.when || refRule.when(node, ctx)) && !ctx.isConsumed(node)) {
          const r = range(node);
          out.refs.push({ name: node.text.slice(0, MAX_NAME), receiver: '', kind: refRule.kind ?? 'ref', startLine: r.startLine + lineOffset, startCol: r.startCol, endLine: r.endLine + lineOffset, symbol: null, scope: null, localDef: null });
          break; // one ref per node even when two reference rules name the same node type
        }
      }
    } else {
      // Query path: wasm does the matching; JS only touches nodes a rule can match.
      const { query } = await specQuery(spec);
      if (query) {
        const captures = query.captures(tree.rootNode);
        const handled = new Set(); // a node may match several patterns; handle it once
        for (const { name: cap, node } of captures) {
          if (cap === 'ref') continue;
          if (cap === 'skip') {
            skip(node);
            continue;
          }
          if (handled.has(node.id)) continue;
          if (cap === 'def') {
            const rule = spec.definitions[node.type];
            if (!rule || (rule.when && !rule.when(node, ctx))) continue;
          }
          if (handleDeclarative(node, spec, ctx, out, lineOffset, block)) handled.add(node.id);
        }
        for (const { name: cap, node } of captures) {
          if (cap !== 'ref' || ctx.isConsumed(node)) continue;
          for (const refRule of spec.references) {
            if (refRule.node !== node.type || (refRule.when && !refRule.when(node, ctx))) continue;
            const r = range(node);
            out.refs.push({ name: node.text.slice(0, MAX_NAME), receiver: '', kind: refRule.kind ?? 'ref', startLine: r.startLine + lineOffset, startCol: r.startCol, endLine: r.endLine + lineOffset, symbol: null, scope: null, localDef: null });
            break;
          }
        }
      }
    }

    if (out.errorNodes && spec.recovery?.length) recoverFromErrors(spec, tree, out, lineOffset, block);
    await mergeLocals(spec, tree, out, lineOffset, skipPositions);
    // Uses of locals/parameters carry no graph information (their target is never an indexed symbol);
    // call refs stay because a shadowed callee must not be linked to a same-named global definition.
    out.refs = out.refs.filter((r) => !(r.kind !== 'call' && r.scope === 'local' && r.localDef === null));
    spec.hooks.postProcess?.(out, ctx);
    // Malformed sources (ERROR nodes) and pack bugs can yield empty names; the store rejects them, so drop here.
    out.symbols = out.symbols.filter((s) => typeof s.name === 'string' && s.name.length > 0);
    out.refs = out.refs.filter((r) => typeof r.name === 'string' && r.name.length > 0);
    out.imports = out.imports.filter((i) => typeof i.spec === 'string' && i.spec.length > 0);
  } finally {
    // Trees live on the wasm heap and are not garbage collected; release or the worker leaks per file.
    tree.delete();
  }
  return attachContainment(out);
}
